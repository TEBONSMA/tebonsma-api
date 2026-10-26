import { randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import type { Caller } from './authelia.ts'
import { isAdmin } from './auth.ts'
import { config } from './config.ts'
import { db, transaction } from './db.ts'
import { bad, readText } from './feedRoutes.ts'
import { readLine, readTime } from './marketInput.ts'
import { getMembers } from './members.ts'
import { currentVersion } from './vedtekter.ts'

// Proposals to change the vedtekter, made on the website. § 3 of the vedtekter: proposals are sent
// to the board at least a week before the årsmøte, the full agenda is out two days before, and
// the årsmøte changes the vedtekter with 2/3. A proposal holds one or more changes to paragraphs,
// as they are written in the vedtekter repo (vedtekter.md). An amendment (endringsforslag) is
// another version of a proposal, voted against it. The protocol group runs the list and the
// dates of the årsmøte.
db.exec(`
  CREATE TABLE IF NOT EXISTS vedtekter_arsmoter (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    starts_at  TEXT NOT NULL,
    -- Planned until the protocol group starts it; while it goes on, members check in and vote
    state      TEXT NOT NULL DEFAULT 'planlagt' CHECK (state IN ('planlagt', 'pågår', 'avsluttet')),
    started_at TEXT,
    ended_at   TEXT,
    -- JSON: the order the protocol group put the cases in, as forslag:3 and punkt:<id>
    agenda     TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vedtekter_forslag (
    id           TEXT PRIMARY KEY,
    -- What members call it: forslag 3
    number       INTEGER NOT NULL UNIQUE,
    -- An amendment: another version of this proposal
    parent_id    TEXT REFERENCES vedtekter_forslag (id),
    title        TEXT NOT NULL,
    reason       TEXT NOT NULL,
    -- JSON: the changes, each with the paragraph as it read when the change was written
    changes      TEXT NOT NULL,
    -- The version of the vedtekter it was written against
    base_commit  TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('utkast', 'innsendt', 'trukket', 'vedtatt', 'forkastet')),
    created_by   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    submitted_at TEXT,
    decided_by   TEXT,
    decided_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS vedtekter_kommentarer (
    id         TEXT PRIMARY KEY,
    forslag_id TEXT NOT NULL REFERENCES vedtekter_forslag (id) ON DELETE CASCADE,
    username   TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS vedtekter_kommentarer_forslag ON vedtekter_kommentarer (forslag_id, created_at);
`)

const DAY_MS = 24 * 60 * 60 * 1000
// § 3: proposals a week before, the agenda two days before
const PROPOSAL_DAYS = 7
const AGENDA_DAYS = 2
const MAX_CHANGES = 10
type Status = 'utkast' | 'innsendt' | 'trukket' | 'vedtatt' | 'forkastet'

// --- The vedtekter as published

interface Paragraph {
  id: string
  nummer: string
  tittel: string
  kilde: string
  barn: Paragraph[]
}

interface Place {
  paragraph: Paragraph
  parent: Paragraph | null
}

// Every paragraph in force by id, with the one it is under
function paragraphs() {
  const version = currentVersion() as Record<string, unknown> | null
  const places = new Map<string, Place>()
  const walk = (list: Paragraph[], parent: Paragraph | null) => {
    for (const paragraph of list) {
      places.set(paragraph.id, { paragraph, parent })
      walk(paragraph.barn ?? [], paragraph)
    }
  }
  const roots = (version?.paragrafer ?? []) as Paragraph[]
  walk(roots, null)
  return { commit: (version?.commit as string | undefined) ?? '', roots, places }
}

// --- Changes

// As written in a proposal; endre and slette remember the paragraph as it read
export type Change =
  | { type: 'endre'; target: string; title: string; text: string; original: Original | null }
  | { type: 'legge-til'; parent: string | null; after: string | null; title: string; text: string }
  | { type: 'slette'; target: string; original: Original | null }

interface Original {
  nummer: string
  tittel: string
  kilde: string
}

const originalOf = (paragraph: Paragraph): Original => ({ nummer: paragraph.nummer, tittel: paragraph.tittel, kilde: paragraph.kilde })

function readChanges(raw: unknown, places: Map<string, Place>): Change[] {
  if (!Array.isArray(raw) || raw.length === 0) throw bad('Forslaget må ha minst én endring')
  if (raw.length > MAX_CHANGES) throw bad(`Et forslag kan ha høyst ${MAX_CHANGES} endringer`)
  const target = (id: unknown) => {
    const place = typeof id === 'string' ? places.get(id) : undefined
    if (!place) throw bad('Paragrafen finnes ikke i vedtektene')
    return place.paragraph
  }
  return raw.map((item: Record<string, unknown> | null): Change => {
    if (!item || typeof item !== 'object') throw bad('Ugyldig endring')
    if (item.type === 'endre') {
      const paragraph = target(item.target)
      return {
        type: 'endre',
        target: paragraph.id,
        title: readLine(item.title ?? '', 'Tittelen', 200),
        text: readText(item.text ?? '', 'Teksten', 10_000),
        original: originalOf(paragraph),
      }
    }
    if (item.type === 'slette') {
      const paragraph = target(item.target)
      return { type: 'slette', target: paragraph.id, original: originalOf(paragraph) }
    }
    if (item.type === 'legge-til') {
      const parent = item.parent == null ? null : target(item.parent)
      const siblings = parent ? parent.barn : [...places.values()].filter(place => !place.parent).map(place => place.paragraph)
      let after: string | null = null
      if (item.after != null) {
        after = target(item.after).id
        if (!siblings.some(sibling => sibling.id === after)) throw bad('Plasseringen er ugyldig')
      }
      return {
        type: 'legge-til',
        parent: parent?.id ?? null,
        after,
        title: readLine(item.title ?? '', 'Tittelen', 200),
        text: readText(item.text ?? '', 'Teksten', 10_000),
      }
    }
    throw bad('Ukjent type endring')
  })
}

// Before a proposal is sent in: every change says something, and none touches a paragraph
// that another change in it deletes
function checkComplete(changes: Change[], places: Map<string, Place>) {
  const ancestors = (id: string) => {
    const out = new Set<string>()
    for (let place = places.get(id); place?.parent; place = places.get(place.parent.id)) out.add(place.parent.id)
    return out
  }
  const deleted = new Set(changes.flatMap(change => (change.type === 'slette' ? [change.target] : [])))
  for (const change of changes) {
    if (change.type === 'endre') {
      if (!change.title) throw bad('En paragraf trenger en tittel')
      if (change.original && change.title === change.original.tittel && change.text === change.original.kilde) {
        throw bad(`Endringen av § ${change.original.nummer} endrer ingenting`)
      }
    }
    if (change.type === 'legge-til' && !change.title) throw bad('En ny paragraf trenger en tittel')
    const touched = change.type === 'legge-til' ? change.parent : change.target
    if (touched && [...ancestors(touched)].some(id => deleted.has(id))) throw bad('Forslaget endrer noe under en paragraf det også sletter')
    if (change.type === 'endre' && deleted.has(change.target)) throw bad('Forslaget både endrer og sletter samme paragraf')
  }
  const targets = changes.flatMap(change => (change.type === 'legge-til' ? [] : [change.target]))
  if (new Set(targets).size !== targets.length) throw bad('Forslaget har to endringer av samme paragraf')
}

// --- Rows

interface ForslagRow {
  id: string
  number: number
  parent_id: string | null
  title: string
  reason: string
  changes: string
  base_commit: string
  status: Status
  created_by: string
  created_at: string
  updated_at: string
  submitted_at: string | null
  decided_by: string | null
  decided_at: string | null
}

interface ArsmoteRow {
  id: string
  title: string
  starts_at: string
  state: 'planlagt' | 'pågår' | 'avsluttet'
  started_at: string | null
}

export const canManage = (caller: Caller) => isAdmin(caller) || caller.groups.includes(config.vedtekter.protocolGroup)

const findRow = (number: number) => {
  const row = db.prepare('SELECT * FROM vedtekter_forslag WHERE number = ?').get(number) as ForslagRow | undefined
  if (!row) throw new HTTPException(404, { message: 'Forslaget finnes ikke' })
  return row
}

function toArsmote(row: ArsmoteRow) {
  const starts = Date.parse(row.starts_at)
  return {
    id: row.id,
    title: row.title,
    startsAt: row.starts_at,
    state: row.state,
    startedAt: row.started_at,
    // Proposals sent in later can only be taken up if 3/4 of those present demand it
    forslagFrist: new Date(starts - PROPOSAL_DAYS * DAY_MS).toISOString(),
    sakslisteFrist: new Date(starts - AGENDA_DAYS * DAY_MS).toISOString(),
  }
}

export const arsmoter = () =>
  (db.prepare('SELECT id, title, starts_at, state, started_at FROM vedtekter_arsmoter ORDER BY starts_at').all() as unknown as ArsmoteRow[]).map(toArsmote)

// The årsmøte going on, or else the one planned. It stays planned until it is started or moved,
// also when it starts later than it was set to.
export function currentArsmote() {
  const all = arsmoter()
  return all.find(meeting => meeting.state === 'pågår') ?? all.find(meeting => meeting.state === 'planlagt') ?? null
}

// The årsmøte a proposal is for: the first after it was sent in (or now, for a draft), or the one
// going on when it was sent in. One still open after an årsmøte has ended goes on to the next.
export const arsmoteFor = (row: ForslagRow, all: ReturnType<typeof arsmoter>) => {
  const from = row.status === 'utkast' ? new Date().toISOString() : (row.submitted_at ?? row.created_at)
  const open = row.status === 'utkast' || row.status === 'innsendt'
  return all.find(meeting => (meeting.startsAt > from || meeting.state === 'pågår') && !(open && meeting.state === 'avsluttet')) ?? null
}

// --- Reading

async function summaries(rows: ForslagRow[]) {
  const members = await getMembers(rows.map(row => row.created_by))
  const all = arsmoter()
  const counts = (sql: string) =>
    new Map((db.prepare(sql).all() as { id: string; n: number }[]).map(row => [row.id, row.n]))
  const amendments = counts("SELECT parent_id AS id, COUNT(*) AS n FROM vedtekter_forslag WHERE parent_id IS NOT NULL AND status != 'trukket' GROUP BY parent_id")
  const comments = counts('SELECT forslag_id AS id, COUNT(*) AS n FROM vedtekter_kommentarer GROUP BY forslag_id')
  const parents = new Map(
    (db.prepare('SELECT id, number FROM vedtekter_forslag').all() as { id: string; number: number }[]).map(row => [row.id, row.number]),
  )
  const { places } = paragraphs()
  return rows.map(row => {
    const meeting = arsmoteFor(row, all)
    const changes = JSON.parse(row.changes) as Change[]
    return {
      number: row.number,
      parent: row.parent_id ? (parents.get(row.parent_id) ?? null) : null,
      title: row.title,
      status: row.status,
      author: members.get(row.created_by)!,
      createdAt: row.created_at,
      submittedAt: row.submitted_at,
      arsmote: meeting?.id ?? null,
      // Sent in after the deadline for the årsmøte it is for
      late: !!(row.submitted_at && meeting && row.submitted_at > meeting.forslagFrist),
      // Which paragraphs, in words: "Endrer § 4.2.3"
      changes: changes.map(change => describe(change, places)),
      amendments: amendments.get(row.id) ?? 0,
      comments: comments.get(row.id) ?? 0,
    }
  })
}

function describe(change: Change, places: Map<string, Place>) {
  if (change.type === 'legge-til') {
    const parent = change.parent ? places.get(change.parent)?.paragraph : null
    const after = change.after ? places.get(change.after)?.paragraph : null
    return { type: change.type, title: change.title, parent: parent ? `§ ${parent.nummer}` : null, after: after ? `§ ${after.nummer}` : null }
  }
  const current = places.get(change.target)?.paragraph
  return {
    type: change.type,
    target: change.target,
    // The number it has now, or had when the change was written if it is gone
    paragraph: current ? `§ ${current.nummer}` : change.original ? `§ ${change.original.nummer}` : null,
    title: current?.tittel ?? change.original?.tittel ?? '',
  }
}

export async function listForslag(caller: Caller) {
  const rows = db.prepare('SELECT * FROM vedtekter_forslag ORDER BY number').all() as unknown as ForslagRow[]
  return {
    canManage: canManage(caller),
    // The årsmøte going on or the next one, with the deadlines in § 3
    arsmote: currentArsmote(),
    forslag: await summaries(rows),
  }
}

export async function getForslag(caller: Caller, number: number) {
  const row = findRow(number)
  const [summary] = await summaries([row])
  const { places } = paragraphs()
  const changes = (JSON.parse(row.changes) as Change[]).map(change => {
    const current = change.type === 'legge-til' ? null : (places.get(change.target)?.paragraph ?? null)
    return {
      ...change,
      // The paragraph as it reads now; if it differs from the original, it changed after the
      // proposal was written
      current: current ? originalOf(current) : null,
    }
  })
  const commentRows = db
    .prepare('SELECT id, username, body, created_at FROM vedtekter_kommentarer WHERE forslag_id = ? ORDER BY created_at')
    .all(row.id) as { id: string; username: string; body: string; created_at: string }[]
  const amendmentRows = db.prepare('SELECT * FROM vedtekter_forslag WHERE parent_id = ? ORDER BY number').all(row.id) as unknown as ForslagRow[]
  const members = await getMembers(commentRows.map(comment => comment.username))
  const mine = row.created_by === caller.username
  const manager = canManage(caller)
  const open = row.status === 'utkast' || row.status === 'innsendt'
  return {
    ...summary,
    reason: row.reason,
    baseCommit: row.base_commit,
    changes,
    decidedAt: row.decided_at,
    amendments: await summaries(amendmentRows),
    comments: commentRows.map(comment => ({
      id: comment.id,
      author: members.get(comment.username)!,
      body: comment.body,
      createdAt: comment.created_at,
    })),
    can: {
      edit: open && (manager || (mine && !pastDeadline(row))),
      submit: row.status === 'utkast' && (mine || manager),
      withdraw: open && (mine || manager),
      decide: manager,
      amend: open && !row.parent_id,
    },
  }
}

// After the deadline for its årsmøte, only the protocol group changes a proposal that is in
const pastDeadline = (row: ForslagRow) => {
  if (row.status !== 'innsendt') return false
  const meeting = arsmoteFor(row, arsmoter())
  return !!meeting && new Date().toISOString() > meeting.forslagFrist
}

// --- Writing

export interface ForslagInput {
  title?: unknown
  reason?: unknown
  changes?: unknown
  parent?: unknown
  submit?: unknown
}

export async function createForslag(caller: Caller, input: ForslagInput) {
  const { commit, places } = paragraphs()
  if (!commit) throw bad('Vedtektene er ikke lagt ut ennå')
  const title = readLine(input.title ?? '', 'Tittelen', 140)
  if (!title) throw bad('Forslaget trenger en tittel')
  const reason = readText(input.reason ?? '', 'Begrunnelsen', 5000)
  const changes = readChanges(input.changes, places)
  let parentId: string | null = null
  if (input.parent != null) {
    const parent = findRow(Number(input.parent))
    if (parent.parent_id) throw bad('Et endringsforslag kan ikke få endringsforslag')
    if (parent.status !== 'utkast' && parent.status !== 'innsendt') throw bad('Forslaget er ikke lenger åpent')
    parentId = parent.id
  }
  const submit = input.submit === true
  if (submit) checkComplete(changes, places)
  const now = new Date().toISOString()
  const number = transaction(() => {
    const next = (db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM vedtekter_forslag').get() as { n: number }).n
    db.prepare(
      `INSERT INTO vedtekter_forslag (id, number, parent_id, title, reason, changes, base_commit, status, created_by, created_at, updated_at, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), next, parentId, title, reason, JSON.stringify(changes), commit, submit ? 'innsendt' : 'utkast', caller.username, now, now, submit ? now : null)
    return next
  })
  return getForslag(caller, number)
}

export async function updateForslag(caller: Caller, number: number, input: ForslagInput) {
  const row = findRow(number)
  const detail = await getForslag(caller, number)
  if (!detail.can.edit) throw new HTTPException(403, { message: 'Du kan ikke endre dette forslaget' })
  const { commit, places } = paragraphs()
  const title = readLine(input.title ?? '', 'Tittelen', 140)
  if (!title) throw bad('Forslaget trenger en tittel')
  const reason = readText(input.reason ?? '', 'Begrunnelsen', 5000)
  const changes = readChanges(input.changes, places)
  if (row.status === 'innsendt') checkComplete(changes, places)
  db.prepare('UPDATE vedtekter_forslag SET title = ?, reason = ?, changes = ?, base_commit = ?, updated_at = ? WHERE id = ?').run(
    title,
    reason,
    JSON.stringify(changes),
    commit,
    new Date().toISOString(),
    row.id,
  )
  return getForslag(caller, number)
}

export async function submitForslag(caller: Caller, number: number) {
  const row = findRow(number)
  if (!(await getForslag(caller, number)).can.submit) throw new HTTPException(403, { message: 'Du kan ikke sende inn dette forslaget' })
  // Against the vedtekter as they read now
  const { commit, places } = paragraphs()
  const changes = readChanges(JSON.parse(row.changes), places)
  checkComplete(changes, places)
  const now = new Date().toISOString()
  db.prepare(
    "UPDATE vedtekter_forslag SET status = 'innsendt', changes = ?, base_commit = ?, submitted_at = ?, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(changes), commit, now, now, row.id)
  return getForslag(caller, number)
}

export async function withdrawForslag(caller: Caller, number: number) {
  const row = findRow(number)
  if (!(await getForslag(caller, number)).can.withdraw) throw new HTTPException(403, { message: 'Du kan ikke trekke dette forslaget' })
  db.prepare("UPDATE vedtekter_forslag SET status = 'trukket', updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id)
  return getForslag(caller, number)
}

// The protocol group: back in (innsendt), or decided by the årsmøte
export async function setStatus(caller: Caller, number: number, raw: unknown) {
  if (!canManage(caller)) throw new HTTPException(403, { message: 'Bare protokollfører kan avgjøre forslag' })
  const row = findRow(number)
  if (raw !== 'innsendt' && raw !== 'vedtatt' && raw !== 'forkastet') throw bad('Ugyldig status')
  const now = new Date().toISOString()
  const decided = raw !== 'innsendt'
  db.prepare('UPDATE vedtekter_forslag SET status = ?, submitted_at = COALESCE(submitted_at, ?), decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?').run(
    raw,
    now,
    decided ? caller.username : null,
    decided ? now : null,
    now,
    row.id,
  )
  return getForslag(caller, number)
}

export async function addComment(caller: Caller, number: number, raw: unknown) {
  const row = findRow(number)
  const body = readText(raw ?? '', 'Kommentaren', 2000)
  if (!body) throw bad('Kommentaren er tom')
  db.prepare('INSERT INTO vedtekter_kommentarer (id, forslag_id, username, body, created_at) VALUES (?, ?, ?, ?, ?)').run(
    randomUUID(),
    row.id,
    caller.username,
    body,
    new Date().toISOString(),
  )
  return getForslag(caller, number)
}

// The next årsmøte: set it, or move it. The protocol group only.
export function setArsmote(caller: Caller, input: { title?: unknown; startsAt?: unknown }) {
  if (!canManage(caller)) throw new HTTPException(403, { message: 'Bare protokollfører kan sette årsmøtet' })
  const title = readLine(input.title ?? '', 'Navnet', 100)
  if (!title) throw bad('Årsmøtet trenger et navn')
  const startsAt = readTime(input.startsAt ?? null)
  if (!startsAt) throw bad('Årsmøtet trenger et tidspunkt')
  const current = currentArsmote()
  // The deadlines follow from when it was to start, so that stays once it has started
  if (current?.state === 'pågår' && startsAt !== current.startsAt) throw bad('Tidspunktet kan ikke endres etter at årsmøtet har startet')
  if (current) db.prepare('UPDATE vedtekter_arsmoter SET title = ?, starts_at = ? WHERE id = ?').run(title, startsAt, current.id)
  else db.prepare('INSERT INTO vedtekter_arsmoter (id, title, starts_at, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), title, startsAt, new Date().toISOString())
  return currentArsmote()
}

// The two additions the årsmøte on 20 December 2025 decided (sak 007), which never got a text.
// They start as drafts, by Anders, who put them here; the text is still to be written.
function seedFromArsmote2025() {
  if ((db.prepare('SELECT COUNT(*) AS n FROM vedtekter_forslag').get() as { n: number }).n > 0) return
  const now = new Date().toISOString()
  const reason = 'Årsmøtet 20.12.2025 vedtok dette under sak 007 (revisjon av vedtekter), men det kom aldri inn i vedtektene, og ingen tekst er funnet. Teksten må skrives før forslaget sendes inn.'
  const drafts: [string, Change][] = [
    ['Kriseteam på alle fester', { type: 'legge-til', parent: null, after: 'bedrukkenhet', title: 'Kriseteam', text: '' }],
    [
      'Mangfold- og inkluderingsansvarlig',
      { type: 'legge-til', parent: 'styretitler', after: 'prop-hunter', title: 'Mangfold- og inkluderingsansvarlig / Styremedlem', text: '' },
    ],
  ]
  transaction(() => {
    drafts.forEach(([title, change], i) =>
      db
        .prepare(
          `INSERT INTO vedtekter_forslag (id, number, parent_id, title, reason, changes, base_commit, status, created_by, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, '', 'utkast', 'anders', ?, ?)`,
        )
        .run(randomUUID(), i + 1, title, reason, JSON.stringify([change]), now, now),
    )
  })
}

seedFromArsmote2025()
