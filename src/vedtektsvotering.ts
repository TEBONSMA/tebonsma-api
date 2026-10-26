import { randomInt, randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import type { Caller } from './authelia.ts'
import { db, transaction } from './db.ts'
import { bad } from './feedRoutes.ts'
import { readLine } from './marketInput.ts'
import { findByMemberId, getMembers } from './members.ts'
import {
  arsmoteFor,
  arsmoter,
  canManage,
  currentArsmote,
  findRow,
  fullChanges,
  liveParent,
  paragraphs,
  summaries,
  type Change,
  type ForslagRow,
  type Place,
} from './vedtektsforslag.ts'

// The årsmøte deciding the proposals. Members check in and vote on their phones; votes counted
// by hand in the room are added by the protocol group. As § 3 has it and Norwegian meetings do it:
// proposals to the same paragraphs are one case (sak); an amendment is voted against its proposal
// and competing proposals against each other (kontravotering, simple majority), and the one left
// against the vedtekter as they are (2/3, § 3.3). A tie waits for the protocol group: a vote again
// (gjenvalg), maybe without the options with the fewest votes, or the lot drawn (§ 3). A proposal
// sent in after the deadline is not on the agenda, and can only be taken up if 3/4 of those present
// demand it (opptak). The protocol group can also put anything else to a vote, with its own
// question and options.
db.exec(`
  CREATE TABLE IF NOT EXISTS vedtekter_oppmote (
    arsmote_id    TEXT NOT NULL REFERENCES vedtekter_arsmoter (id) ON DELETE CASCADE,
    username      TEXT NOT NULL,
    checked_in_at TEXT NOT NULL,
    PRIMARY KEY (arsmote_id, username)
  );

  -- Other cases on the agenda than the proposals, like the accounts or the election of the board
  CREATE TABLE IF NOT EXISTS vedtekter_sakspunkter (
    id         TEXT PRIMARY KEY,
    arsmote_id TEXT NOT NULL REFERENCES vedtekter_arsmoter (id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vedtekter_voteringer (
    id         TEXT PRIMARY KEY,
    arsmote_id TEXT NOT NULL REFERENCES vedtekter_arsmoter (id) ON DELETE CASCADE,
    -- kontra: two proposals against each other; endelig: one against the vedtekter as they are;
    -- opptak: whether a proposal sent in too late is taken up; fri: anything else, with its own
    -- question and options
    kind       TEXT NOT NULL CHECK (kind IN ('kontra', 'endelig', 'opptak', 'fri')),
    title      TEXT,
    -- JSON: the options of a fri vote. The others have the two proposals, or for and against.
    options    TEXT,
    forslag_a  TEXT REFERENCES vedtekter_forslag (id),
    forslag_b  TEXT REFERENCES vedtekter_forslag (id),
    -- The case on the agenda a fri vote belongs to, if any
    sak_id     TEXT REFERENCES vedtekter_sakspunkter (id) ON DELETE SET NULL,
    -- flertall: the most votes, a tie decided by lot (§ 3); to-tredjedeler: 2/3 of the votes cast;
    -- tre-fjerdedeler: 3/4 of those present
    rule       TEXT NOT NULL CHECK (rule IN ('flertall', 'to-tredjedeler', 'tre-fjerdedeler')),
    -- likt: closed with a tie, until the protocol group has it voted on again or drawn by lot
    status     TEXT NOT NULL CHECK (status IN ('åpen', 'likt', 'lukket')),
    -- JSON: counted by hand in the room for each option, on top of the votes on phones
    hand       TEXT NOT NULL DEFAULT '[]',
    hand_blank INTEGER NOT NULL DEFAULT 0,
    -- The option that won; none when no option got what it needed
    result     INTEGER,
    by_lot     INTEGER NOT NULL DEFAULT 0,
    -- How many were there when it closed, for 3/4 of those present
    present    INTEGER,
    -- A vote again after a tie in this one
    gjenvalg_av TEXT REFERENCES vedtekter_voteringer (id),
    opened_at  TEXT NOT NULL,
    closed_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS vedtekter_stemmer (
    votering_id TEXT NOT NULL REFERENCES vedtekter_voteringer (id) ON DELETE CASCADE,
    username    TEXT NOT NULL,
    -- The option, or -1 for a blank vote
    choice      INTEGER NOT NULL CHECK (choice >= -1),
    PRIMARY KEY (votering_id, username)
  );
`)

const BLANK = -1
const MAX_OPTIONS = 10

type Rule = 'flertall' | 'to-tredjedeler' | 'tre-fjerdedeler'

interface VoteRow {
  id: string
  arsmote_id: string
  kind: 'kontra' | 'endelig' | 'opptak' | 'fri'
  title: string | null
  options: string | null
  forslag_a: string | null
  forslag_b: string | null
  sak_id: string | null
  rule: Rule
  status: 'åpen' | 'likt' | 'lukket'
  hand: string
  hand_blank: number
  result: number | null
  by_lot: number
  present: number | null
  gjenvalg_av: string | null
  opened_at: string
  closed_at: string | null
}

const forbidden = (message: string) => new HTTPException(403, { message })

function requireManager(caller: Caller) {
  if (!canManage(caller)) throw forbidden('Bare protokollfører kan styre årsmøtet')
}

function running() {
  const meeting = currentArsmote()
  if (meeting?.state !== 'pågår') throw bad('Årsmøtet har ikke startet')
  return meeting
}

// --- The meeting

export function startArsmote(caller: Caller) {
  requireManager(caller)
  const meeting = currentArsmote()
  if (!meeting) throw bad('Sett årsmøtet først')
  if (meeting.state === 'pågår') throw bad('Årsmøtet er allerede i gang')
  db.prepare("UPDATE vedtekter_arsmoter SET state = 'pågår', started_at = ? WHERE id = ?").run(new Date().toISOString(), meeting.id)
  return currentArsmote()
}

export function endArsmote(caller: Caller) {
  requireManager(caller)
  const meeting = running()
  if (db.prepare("SELECT 1 FROM vedtekter_voteringer WHERE arsmote_id = ? AND status != 'lukket'").get(meeting.id)) {
    throw bad('Lukk og avgjør voteringen først')
  }
  db.prepare("UPDATE vedtekter_arsmoter SET state = 'avsluttet', ended_at = ? WHERE id = ?").run(new Date().toISOString(), meeting.id)
  return { id: meeting.id, state: 'avsluttet' as const }
}

// A member checks in on their phone, or the protocol group checks in someone (by member id)
export function checkIn(caller: Caller, memberId?: string) {
  const meeting = running()
  let username = caller.username
  if (memberId !== undefined) {
    requireManager(caller)
    const member = findByMemberId(memberId)
    if (!member) throw bad('Fant ikke medlemmet')
    username = member
  }
  db.prepare('INSERT OR IGNORE INTO vedtekter_oppmote (arsmote_id, username, checked_in_at) VALUES (?, ?, ?)').run(
    meeting.id,
    username,
    new Date().toISOString(),
  )
}

export function checkOut(caller: Caller, memberId: string) {
  requireManager(caller)
  const meeting = running()
  const username = findByMemberId(memberId)
  if (!username) throw bad('Fant ikke medlemmet')
  db.prepare('DELETE FROM vedtekter_oppmote WHERE arsmote_id = ? AND username = ?').run(meeting.id, username)
}

const isPresent = (meetingId: string, username: string) =>
  !!db.prepare('SELECT 1 FROM vedtekter_oppmote WHERE arsmote_id = ? AND username = ?').get(meetingId, username)

// --- Cases: proposals that cannot both be adopted

// What a proposal does to the vedtekter: the paragraphs whose text it changes, those it deletes
// (with everything under them), and the paragraphs it places new ones at
function footprint(changes: Change[], places: Map<string, Place>) {
  const edits = new Set<string>()
  const removes = new Set<string>()
  const anchors = new Set<string>()
  const under = (id: string) => {
    removes.add(id)
    for (const place of places.values()) if (place.parent?.id === id) under(place.paragraph.id)
  }
  for (const change of changes) {
    if (change.type === 'endre') edits.add(change.target)
    else if (change.type === 'slette') under(change.target)
    else for (const id of [change.parent, change.after]) if (id) anchors.add(id)
  }
  return { edits, removes, anchors }
}

type Footprint = ReturnType<typeof footprint>
const meets = (a: Set<string>, b: Set<string>) => [...a].some(id => b.has(id))

// Two changes to the same text, or a change to something the other deletes. Two new paragraphs
// at the same place can both go in.
const clash = (a: Footprint, b: Footprint) =>
  meets(new Set([...a.edits, ...a.removes]), new Set([...b.edits, ...b.removes])) || meets(a.anchors, b.removes) || meets(b.anchors, a.removes)

// The proposals for this årsmøte, as cases: each proposal with its amendments, and proposals
// that clash together. Those still open are for the årsmøte they were sent in for; those voted
// on, for the årsmøte that voted on them.
function cases(meetingId: string) {
  const all = arsmoter()
  // Also one left out here, which goes on to the next årsmøte
  const rows = (db.prepare("SELECT * FROM vedtekter_forslag WHERE status IN ('innsendt', 'vedtatt', 'forkastet') ORDER BY number").all() as unknown as ForslagRow[]).filter(
    row => votedIn(row.id, meetingId) || (row.status === 'innsendt' && arsmoteFor(row, all)?.id === meetingId),
  )
  const { places } = paragraphs()
  const byId = new Map(rows.map(row => [row.id, row]))
  const root = (row: ForslagRow): ForslagRow => (row.parent_id && byId.has(row.parent_id) ? root(byId.get(row.parent_id)!) : row)
  const groups: { rows: ForslagRow[]; prints: Footprint[] }[] = []
  for (const row of rows) {
    const print = footprint(JSON.parse(row.changes) as Change[], places)
    const joined = groups.filter(group => group.rows.some(other => root(other) === root(row)) || group.prints.some(other => clash(print, other)))
    for (const group of joined) groups.splice(groups.indexOf(group), 1)
    groups.push({ rows: [...joined.flatMap(group => group.rows), row], prints: [...joined.flatMap(group => group.prints), print] })
  }
  return groups
    .map(group => {
      const roots = group.rows.filter(row => root(row) === row).sort((a, b) => a.number - b.number)
      // Each proposal followed by its amendments
      return roots.flatMap(row => [row, ...group.rows.filter(item => item !== row && root(item) === row).sort((a, b) => a.number - b.number)])
    })
    .sort((a, b) => a[0].number - b[0].number)
}

const votedIn = (forslagId: string, meetingId: string) =>
  !!db.prepare('SELECT 1 FROM vedtekter_voteringer WHERE arsmote_id = ? AND (forslag_a = ? OR forslag_b = ?)').get(meetingId, forslagId, forslagId)

// A proposal sent in after the deadline is not on the agenda (§ 3). A motforslag to one that is
// can be made in the meeting.
const late = (row: ForslagRow, meetingId: string) => {
  const meeting = arsmoter().find(item => item.id === meetingId)
  return !liveParent(row) && !!meeting && !!row.submitted_at && row.submitted_at > meeting.forslagFrist
}

// For a late proposal: still to be decided, taken up, or not (then it goes on to the next årsmøte).
// A motforslag goes with its proposal: left out if that is.
function opptakOf(row: ForslagRow, meetingId: string): 'kreves' | 'tatt-opp' | 'ikke-tatt-opp' | null {
  const parent = liveParent(row)
  if (parent) return opptakOf(parent, meetingId) === 'ikke-tatt-opp' ? 'ikke-tatt-opp' : null
  if (!late(row, meetingId)) return null
  const vote = db
    .prepare("SELECT result FROM vedtekter_voteringer WHERE arsmote_id = ? AND kind = 'opptak' AND forslag_a = ? AND status = 'lukket' ORDER BY closed_at DESC")
    .get(meetingId, row.id) as { result: number } | undefined
  return !vote ? 'kreves' : vote.result === 0 ? 'tatt-opp' : 'ikke-tatt-opp'
}

// The proposals in a case still to be voted on: sent in, and not left out by the årsmøte
const inPlay = (rows: ForslagRow[], meetingId: string) => rows.filter(row => row.status === 'innsendt' && opptakOf(row, meetingId) !== 'ikke-tatt-opp')

// The next vote in a case: first whether a late proposal is taken up: an amendment against its proposal, then competing proposals against
// each other, then the one left against the vedtekter as they are
function nextVote(rows: ForslagRow[], meetingId: string): { a: ForslagRow; b: ForslagRow | null; opptak: boolean } | null {
  const open = inPlay(rows, meetingId)
  const unsettled = open.find(row => opptakOf(row, meetingId) === 'kreves')
  if (unsettled) return { a: unsettled, b: null, opptak: true }
  return proposalVote(open)
}

function proposalVote(open: ForslagRow[]) {
  const amendment = open.find(row => row.parent_id && open.some(parent => parent.id === row.parent_id))
  if (amendment) return { a: open.find(parent => parent.id === amendment.parent_id)!, b: amendment, opptak: false }
  if (open.length >= 2) return { a: open[0], b: open[1], opptak: false }
  if (open.length === 1) return { a: open[0], b: null, opptak: false }
  return null
}

// --- The agenda: the cases with proposals, and the others the protocol group adds

interface Punkt {
  id: string
  title: string
}

const punkter = (meetingId: string) =>
  db.prepare('SELECT id, title FROM vedtekter_sakspunkter WHERE arsmote_id = ? ORDER BY created_at').all(meetingId) as unknown as Punkt[]

const MAX_PUNKTER = 50

export function addPunkt(caller: Caller, raw: unknown) {
  requireManager(caller)
  const meeting = currentArsmote()
  if (!meeting) throw bad('Sett årsmøtet først')
  const title = readLine(raw ?? '', 'Saken', 140)
  if (!title) throw bad('Saken trenger en tittel')
  if (punkter(meeting.id).length >= MAX_PUNKTER) throw bad(`Sakslisten kan ha høyst ${MAX_PUNKTER} andre saker`)
  db.prepare('INSERT INTO vedtekter_sakspunkter (id, arsmote_id, title, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), meeting.id, title, new Date().toISOString())
}

export function removePunkt(caller: Caller, id: string) {
  requireManager(caller)
  if (db.prepare('SELECT 1 FROM vedtekter_voteringer WHERE sak_id = ?').get(id)) throw bad('Saken er stemt over')
  db.prepare('DELETE FROM vedtekter_sakspunkter WHERE id = ?').run(id)
}

// The order of the cases, as forslag:3 (any proposal in the case) and punkt:<id>
export function setAgenda(caller: Caller, raw: unknown) {
  requireManager(caller)
  const meeting = currentArsmote()
  if (!meeting) throw bad('Sett årsmøtet først')
  if (!Array.isArray(raw) || raw.length > 500 || raw.some(key => typeof key !== 'string' || !/^(forslag:\d+|punkt:[\w-]+)$/.test(key))) {
    throw bad('Ugyldig rekkefølge')
  }
  db.prepare('UPDATE vedtekter_arsmoter SET agenda = ? WHERE id = ?').run(JSON.stringify(raw), meeting.id)
}

// The cases in the order the protocol group put them; new ones last, proposals before the others
function agenda(meetingId: string) {
  const order = JSON.parse((db.prepare('SELECT agenda FROM vedtekter_arsmoter WHERE id = ?').get(meetingId) as { agenda: string }).agenda) as string[]
  const items = [
    ...cases(meetingId).map(rows => ({ key: `forslag:${rows[0].number}`, keys: rows.map(row => `forslag:${row.number}`), rows, punkt: null })),
    ...punkter(meetingId).map(punkt => ({ key: `punkt:${punkt.id}`, keys: [`punkt:${punkt.id}`], rows: [] as ForslagRow[], punkt })),
  ]
  const position = (keys: string[]) => Math.min(...keys.map(key => order.indexOf(key)).map(i => (i < 0 ? Infinity : i)))
  return items.map((item, i) => ({ item, at: position(item.keys), i })).sort((a, b) => a.at - b.at || a.i - b.i).map(({ item }) => item)
}

// --- Votes

function noneOpen(meetingId: string) {
  const busy = db.prepare("SELECT status FROM vedtekter_voteringer WHERE arsmote_id = ? AND status != 'lukket'").get(meetingId) as { status: string } | undefined
  if (busy) throw bad(busy.status === 'likt' ? 'Avgjør den like voteringen først' : 'En votering er allerede åpen')
}

// Forslag a against forslag b, or against the vedtekter as they are when b is null; or, with
// opptak, whether forslag a, sent in too late, is taken up
export function openVote(caller: Caller, a: unknown, b: unknown, opptak = false) {
  requireManager(caller)
  const meeting = running()
  noneOpen(meeting.id)
  const first = findRow(Number(a))
  const second = b == null ? null : findRow(Number(b))
  for (const row of [first, second]) {
    if (row && row.status !== 'innsendt') throw bad(`Forslag ${row.number} er ikke til behandling`)
  }
  if (second && second.id === first.id) throw bad('Et forslag kan ikke stemmes mot seg selv')
  const saker = cases(meeting.id)
  const sak = saker.find(rows => rows.some(row => row.id === first.id))
  if (!sak || (second && !saker.some(rows => rows.some(row => row.id === second.id)))) throw bad('Forslaget hører ikke til dette årsmøtet')
  if (opptak) {
    if (opptakOf(first, meeting.id) !== 'kreves') throw bad(`Forslag ${first.number} trenger ikke å tas opp`)
    const id = randomUUID()
    db.prepare(
      `INSERT INTO vedtekter_voteringer (id, arsmote_id, kind, forslag_a, rule, status, opened_at)
       VALUES (?, ?, 'opptak', ?, 'tre-fjerdedeler', 'åpen', ?)`,
    ).run(id, meeting.id, first.id, new Date().toISOString())
    return id
  }
  for (const row of [first, second]) {
    const state = row && opptakOf(row, meeting.id)
    if (state === 'kreves') throw bad(`Forslag ${row!.number} kom etter fristen; stem først over om det skal tas opp`)
    if (state === 'ikke-tatt-opp') throw bad(`Forslag ${row!.number} ble ikke tatt opp`)
  }
  // Only one of the proposals in a case can be adopted, so the others must fall first
  const rivals = inPlay(sak, meeting.id).filter(row => row.id !== first.id)
  if (!second && rivals.length) {
    throw bad(`Stem først over ${rivals.map(row => `forslag ${row.number}`).join(' og ')}, som gjelder det samme`)
  }
  const id = randomUUID()
  db.prepare(
    `INSERT INTO vedtekter_voteringer (id, arsmote_id, kind, forslag_a, forslag_b, rule, status, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, 'åpen', ?)`,
  ).run(id, meeting.id, second ? 'kontra' : 'endelig', first.id, second?.id ?? null, second ? 'flertall' : 'to-tredjedeler', new Date().toISOString())
  return id
}

// Anything else on the agenda: { title, options, rule }
export function openFreeVote(caller: Caller, input: { title?: unknown; options?: unknown; rule?: unknown; sak?: unknown }) {
  requireManager(caller)
  const meeting = running()
  noneOpen(meeting.id)
  const title = readLine(input.title ?? '', 'Spørsmålet', 140)
  if (!title) throw bad('Avstemningen trenger et spørsmål')
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > MAX_OPTIONS) {
    throw bad(`En avstemning har fra 2 til ${MAX_OPTIONS} alternativer`)
  }
  const options = input.options.map(option => readLine(option ?? '', 'Alternativet', 80))
  if (options.some(option => !option)) throw bad('Et alternativ er tomt')
  if (new Set(options.map(option => option.toLowerCase())).size !== options.length) throw bad('To alternativer er like')
  const rule = input.rule ?? 'flertall'
  if (rule !== 'flertall' && rule !== 'to-tredjedeler') throw bad('Ukjent krav til flertall')
  const sak = input.sak == null ? null : punkter(meeting.id).find(punkt => punkt.id === input.sak)
  if (sak === undefined) throw bad('Saken finnes ikke på sakslisten')
  const id = randomUUID()
  db.prepare(
    `INSERT INTO vedtekter_voteringer (id, arsmote_id, kind, title, options, sak_id, rule, status, opened_at)
     VALUES (?, ?, 'fri', ?, ?, ?, ?, 'åpen', ?)`,
  ).run(id, meeting.id, title, JSON.stringify(options), sak?.id ?? null, rule, new Date().toISOString())
  return id
}

const findVote = (id: string) => {
  const row = db.prepare('SELECT * FROM vedtekter_voteringer WHERE id = ?').get(id) as VoteRow | undefined
  if (!row) throw new HTTPException(404, { message: 'Voteringen finnes ikke' })
  return row
}

// What the options are called: the two proposals, for and against, or as the protocol group wrote them
function labelsOf(vote: VoteRow) {
  if (vote.kind === 'fri') return JSON.parse(vote.options ?? '[]') as string[]
  if (vote.kind === 'endelig') return ['For', 'Mot']
  if (vote.kind === 'opptak') return ['Ja', 'Nei']
  return [vote.forslag_a!, vote.forslag_b!].map(id => `Forslag ${rowById(id).number}`)
}

// Until the vote is closed a member can change their mind. choice: the option, or 'blank'.
export function castVote(caller: Caller, id: string, choice: unknown) {
  const vote = findVote(id)
  if (vote.status !== 'åpen') throw bad('Voteringen er lukket')
  const count = labelsOf(vote).length
  if (choice !== 'blank' && !(Number.isInteger(choice) && (choice as number) >= 0 && (choice as number) < count)) throw bad('Ugyldig stemme')
  if (!isPresent(vote.arsmote_id, caller.username)) throw forbidden('Sjekk inn på årsmøtet for å stemme')
  db.prepare(
    `INSERT INTO vedtekter_stemmer (votering_id, username, choice) VALUES (?, ?, ?)
     ON CONFLICT (votering_id, username) DO UPDATE SET choice = excluded.choice`,
  ).run(id, caller.username, choice === 'blank' ? BLANK : (choice as number))
}

function countsOf(vote: VoteRow) {
  const count = labelsOf(vote).length
  const phone = Array<number>(count).fill(0)
  let phoneBlank = 0
  for (const row of db.prepare('SELECT choice, COUNT(*) AS n FROM vedtekter_stemmer WHERE votering_id = ? GROUP BY choice').all(vote.id) as {
    choice: number
    n: number
  }[]) {
    if (row.choice === BLANK) phoneBlank = row.n
    else phone[row.choice] = row.n
  }
  const stored = JSON.parse(vote.hand) as number[]
  const hand = phone.map((_, i) => stored[i] ?? 0)
  return {
    phone,
    hand,
    total: phone.map((n, i) => n + hand[i]),
    blank: { phone: phoneBlank, hand: vote.hand_blank, total: phoneBlank + vote.hand_blank },
  }
}

const handCount = (raw: unknown) => {
  const value = raw == null || raw === '' ? 0 : Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 1000) throw bad('Ugyldig antall stemmer')
  return value
}

// Blank votes are not cast. The vedtekter change if 2/3 vote for (§ 3.3); otherwise they stand.
// A late proposal is taken up if 3/4 of those present want it (§ 3). A tie for the most votes is
// left to the protocol group.
function decide(vote: VoteRow, total: number[], present: number): { result: number | null; tie: boolean } {
  const cast = total.reduce((sum, n) => sum + n, 0)
  if (vote.kind === 'endelig') return { result: total[0] > 0 && total[0] * 3 >= cast * 2 ? 0 : 1, tie: false }
  if (vote.kind === 'opptak') return { result: total[0] > 0 && total[0] * 4 >= present * 3 ? 0 : 1, tie: false }
  const leaders = leadersOf(total)
  if (vote.rule === 'to-tredjedeler') return { result: total[leaders[0]] * 3 >= cast * 2 && cast > 0 && leaders.length === 1 ? leaders[0] : null, tie: false }
  if (vote.kind === 'fri' && cast === 0) return { result: null, tie: false }
  return leaders.length === 1 ? { result: leaders[0], tie: false } : { result: null, tie: true }
}

// The options with the most votes
const leadersOf = (total: number[]) => {
  const top = Math.max(...total)
  return total.flatMap((n, i) => (n === top ? [i] : []))
}

// What a result does to the proposals: the loser of a kontra vote falls, the one in an endelig
// vote is adopted or falls
function settle(vote: VoteRow, result: number | null, caller: Caller, now: string) {
  const decide = (forslagId: string, status: 'vedtatt' | 'forkastet') =>
    db.prepare('UPDATE vedtekter_forslag SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?').run(status, caller.username, now, now, forslagId)
  if (vote.kind === 'endelig') decide(vote.forslag_a!, result === 0 ? 'vedtatt' : 'forkastet')
  if (vote.kind === 'kontra' && result !== null) decide(result === 0 ? vote.forslag_b! : vote.forslag_a!, 'forkastet')
}

// Closed with what was counted by hand: { options: [n, …], blank: n }. The proposal that loses a
// kontra vote falls; the one in an endelig vote is adopted or falls.
export function closeVote(caller: Caller, id: string, hand: { options?: unknown; blank?: unknown } = {}) {
  requireManager(caller)
  const vote = findVote(id)
  if (vote.status !== 'åpen') throw bad('Voteringen er allerede lukket')
  const counted = Array.isArray(hand.options) ? hand.options : []
  const options = labelsOf(vote).map((_, i) => handCount(counted[i]))
  const now = new Date().toISOString()
  transaction(() => {
    db.prepare('UPDATE vedtekter_voteringer SET hand = ?, hand_blank = ? WHERE id = ?').run(JSON.stringify(options), handCount(hand.blank), id)
    const counts = countsOf(findVote(id))
    // Those checked in, and never fewer than voted
    const checkedIn = (db.prepare('SELECT COUNT(*) AS n FROM vedtekter_oppmote WHERE arsmote_id = ?').get(vote.arsmote_id) as { n: number }).n
    const present = Math.max(checkedIn, counts.total.reduce((sum, n) => sum + n, counts.blank.total))
    const { result, tie } = decide(vote, counts.total, present)
    db.prepare('UPDATE vedtekter_voteringer SET status = ?, result = ?, present = ?, closed_at = ? WHERE id = ?').run(tie ? 'likt' : 'lukket', result, present, now, id)
    if (!tie) settle(vote, result, caller, now)
  })
}

const findTie = (caller: Caller, id: string) => {
  requireManager(caller)
  const vote = findVote(id)
  if (vote.status !== 'likt') throw bad('Voteringen er ikke likt')
  return vote
}

// The lot drawn in the room between those with the most votes, or drawn here: { option } or 'tilfeldig'
export function drawLot(caller: Caller, id: string, raw: unknown) {
  const vote = findTie(caller, id)
  const leaders = leadersOf(countsOf(vote).total)
  const result = raw === 'tilfeldig' ? leaders[randomInt(leaders.length)] : (raw as number)
  if (!leaders.includes(result)) throw bad('Bare de med flest stemmer kan vinne loddtrekningen')
  const now = new Date().toISOString()
  transaction(() => {
    db.prepare("UPDATE vedtekter_voteringer SET status = 'lukket', result = ?, by_lot = 1 WHERE id = ?").run(result, id)
    settle(vote, result, caller, now)
  })
}

// Vote again, with the options to keep: a kontra vote between the same two proposals, a fri vote
// maybe without those with the fewest votes
export function revote(caller: Caller, id: string, raw: unknown) {
  const vote = findTie(caller, id)
  const labels = labelsOf(vote)
  const keep = Array.isArray(raw) ? [...new Set(raw)].sort((a, b) => a - b) : []
  if (keep.length < 2 || keep.some(i => !Number.isInteger(i) || i < 0 || i >= labels.length)) throw bad('Velg minst to alternativer')
  if (vote.kind === 'kontra' && keep.length !== 2) throw bad('En kontravotering er mellom to forslag')
  const next = randomUUID()
  transaction(() => {
    db.prepare("UPDATE vedtekter_voteringer SET status = 'lukket' WHERE id = ?").run(id)
    db.prepare(
      `INSERT INTO vedtekter_voteringer (id, arsmote_id, kind, title, options, forslag_a, forslag_b, sak_id, rule, status, gjenvalg_av, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'åpen', ?, ?)`,
    ).run(
      next,
      vote.arsmote_id,
      vote.kind,
      vote.title,
      vote.kind === 'fri' ? JSON.stringify(keep.map(i => labels[i])) : null,
      vote.forslag_a,
      vote.forslag_b,
      vote.sak_id,
      vote.rule,
      id,
      new Date().toISOString(),
    )
  })
  return next
}

// How a vote is decided, in words
function requiredOf(vote: VoteRow) {
  if (vote.kind === 'endelig') return '2/3 av de avgitte stemmene for å endre vedtektene (§ 3.3)'
  if (vote.kind === 'opptak') return 'Forslaget kom etter fristen og står ikke på sakslisten. Det tas opp hvis 3/4 av de fremmøtte vil (§ 3).'
  if (vote.rule === 'to-tredjedeler') return '2/3 av de avgitte stemmene'
  return 'Flest stemmer. Blir det likt, avgjøres det med gjenvalg eller loddtrekning (§ 3).'
}

// --- What everyone sees

export async function liveArsmote(caller: Caller) {
  const meeting = currentArsmote() ?? lastMeeting()
  const manager = canManage(caller)
  if (!meeting) return { arsmote: null, canManage: manager, present: false, attendees: [], voteringer: [], saker: [] }
  const voteRows = db.prepare('SELECT * FROM vedtekter_voteringer WHERE arsmote_id = ? ORDER BY opened_at').all(meeting.id) as unknown as VoteRow[]
  const revoted = new Set(voteRows.flatMap(vote => (vote.gjenvalg_av ? [vote.gjenvalg_av] : [])))
  const items = agenda(meeting.id)
  const sakRows = items.map(item => item.rows)
  const voted = voteRows.flatMap(vote => [vote.forslag_a, vote.forslag_b]).filter(id => id !== null)
  const allRows = [...new Map([...sakRows.flat(), ...voted.map(id => rowById(id))].map(row => [row.id, row])).values()]
  const summary = new Map((await summaries(allRows)).map((item, i) => [allRows[i].id, item]))
  const attendeeRows = db.prepare('SELECT username FROM vedtekter_oppmote WHERE arsmote_id = ? ORDER BY checked_in_at').all(meeting.id) as { username: string }[]
  const members = await getMembers(attendeeRows.map(row => row.username))
  const mine = new Map(
    (db.prepare('SELECT votering_id, choice FROM vedtekter_stemmer WHERE username = ?').all(caller.username) as { votering_id: string; choice: number }[]).map(row => [
      row.votering_id,
      row.choice,
    ]),
  )
  return {
    arsmote: meeting,
    canManage: manager,
    present: isPresent(meeting.id, caller.username),
    // Everyone can see who is there; the protocol group checks people in and out
    attendees: attendeeRows.map(row => members.get(row.username)!),
    voteringer: voteRows.map(vote => {
      const counts = countsOf(vote)
      const a = vote.forslag_a ? summary.get(vote.forslag_a)! : null
      const b = vote.forslag_b ? summary.get(vote.forslag_b)! : null
      const choice = mine.get(vote.id)
      const open = vote.status === 'åpen'
      return {
        id: vote.id,
        kind: vote.kind,
        // "Forslag 3 mot forslag 4", "Forslag 3 mot vedtektene slik de er", or the question asked
        title:
          vote.title ??
          (vote.kind === 'opptak' ? `Skal forslag ${a!.number} tas opp?` : `Forslag ${a!.number} mot ${b ? `forslag ${b.number}` : 'vedtektene slik de er'}`),
        options: labelsOf(vote),
        a,
        b,
        // What is voted on, in full, while it is open
        changes: open && vote.forslag_a ? { a: fullChanges(rowById(vote.forslag_a)), b: vote.forslag_b ? fullChanges(rowById(vote.forslag_b)) : null } : null,
        rule: vote.rule,
        required: requiredOf(vote),
        present: vote.present,
        status: vote.status,
        mine: choice === undefined ? null : choice === BLANK ? 'blank' : choice,
        // While it is open only the protocol group sees how it goes; afterwards everyone does
        counts: !open || manager ? counts : null,
        voted: counts.phone.reduce((sum, n) => sum + n, counts.blank.phone),
        result: vote.result,
        // The options that had the same, most votes: to vote on again, or to draw between
        tied: vote.status === 'likt' || vote.by_lot === 1 || revoted.has(vote.id) ? leadersOf(counts.total) : null,
        byLot: vote.by_lot === 1,
        // A vote again after a tie, and a tie that was voted on again
        gjenvalgAv: vote.gjenvalg_av,
        gjenvalg: revoted.has(vote.id),
        openedAt: vote.opened_at,
        closedAt: vote.closed_at,
      }
    }),
    // The agenda in order: proposals to the same paragraphs as one case, and the other cases
    saker: items.map(item => {
      const next = nextVote(item.rows, meeting.id)
      const votes = voteRows.filter(vote =>
        item.punkt ? vote.sak_id === item.punkt.id : item.rows.some(row => row.id === vote.forslag_a || row.id === vote.forslag_b),
      )
      return {
        key: item.key,
        // The other cases have their own title; a case with proposals is called by its first
        title: item.punkt?.title ?? item.rows[0].title,
        punkt: item.punkt?.id ?? null,
        // Each with whether it must be, was or was not taken up, if it came too late
        forslag: item.rows.map(row => ({ ...summary.get(row.id)!, opptak: opptakOf(row, meeting.id) })),
        next: next ? { a: next.a.number, b: next.b?.number ?? null, opptak: next.opptak } : null,
        // Being voted on now, and done: nothing left to vote on
        current: votes.some(vote => vote.status !== 'lukket'),
        done: item.punkt ? votes.some(vote => vote.status === 'lukket' && !revoted.has(vote.id)) : inPlay(item.rows, meeting.id).length === 0,
      }
    }),
  }
}

const rowById = (id: string) => db.prepare('SELECT * FROM vedtekter_forslag WHERE id = ?').get(id) as unknown as ForslagRow

// The årsmøte that ended last
const lastMeeting = () => {
  const last = db.prepare("SELECT id FROM vedtekter_arsmoter WHERE state = 'avsluttet' ORDER BY ended_at DESC LIMIT 1").get() as { id: string } | undefined
  return arsmoter().find(meeting => meeting.id === last?.id) ?? null
}

// --- What the årsmøte decided, for the vedtekter repo

const MONTHS = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember']

// The proposals adopted at the årsmøte going on or the last one, in the order they were adopted,
// with their changes and the line for the front page: "Sist endret på ordinært årsmøte 20. desember 2026"
export function adopted() {
  const meeting = currentArsmote()?.state === 'pågår' ? currentArsmote() : lastMeeting()
  if (!meeting) throw new HTTPException(404, { message: 'Ingen årsmøter ennå' })
  const rows = db
    .prepare(
      `SELECT f.* FROM vedtekter_voteringer v JOIN vedtekter_forslag f ON f.id = v.forslag_a
       WHERE v.arsmote_id = ? AND v.kind = 'endelig' AND v.result = 0 AND f.status = 'vedtatt'
       ORDER BY v.closed_at`,
    )
    .all(meeting.id) as unknown as ForslagRow[]
  const day = new Date(meeting.startedAt ?? meeting.startsAt)
  const name = meeting.title.replace(/\s*\d{4}$/, '')
  return {
    arsmote: { title: meeting.title, startsAt: meeting.startsAt, state: meeting.state },
    vedtatt: `Sist endret på ${name.charAt(0).toLowerCase()}${name.slice(1)} ${day.getDate()}. ${MONTHS[day.getMonth()]} ${day.getFullYear()}`,
    forslag: rows.map(row => ({ number: row.number, title: row.title, changes: JSON.parse(row.changes) as Change[] })),
  }
}
