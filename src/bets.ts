import { randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { config } from './config.ts'
import { db, transaction } from './db.ts'
import type { Viewer } from './feed.ts'
import { listGroupMembers } from './lldap.ts'
import { getMembers, usernameOf } from './members.ts'
import {
  combine,
  DEFAULT_LIQUIDITY,
  countProbabilities,
  oddsAt,
  type Spread,
  oddsFor,
  openingShares,
  payoutFor,
  prices,
  probabilitiesFromOdds,
  sharesFor,
} from './odds.ts'

// TebBet (bet.tebonsma.no): members bet TEB coins on things that may happen at an event.
// No real money is involved. Every member gets coins to start with and more every Monday.
//
// A market is a question on an event with two or more outcomes. The organizer of the event
// and admins open markets and decide them. A slip is one bet: a stake on one outcome
// (single) or on outcomes in several markets that must all happen (combination). The odds
// are locked when the slip is played.
//
// Coins only move through the ledger, so a member's balance is the sum of their rows.

export const START_BALANCE = 1000
export const WEEKLY_ALLOWANCE = 100
// Mondays are counted in Norwegian time
const TIME_ZONE = 'Europe/Oslo'
// How long a decided market stays on the front page after its event
const RECENT_MS = 14 * 24 * 60 * 60 * 1000
const BETS_SHOWN = 100
const SLIPS_SHOWN = 100
const LEDGER_SHOWN = 100

// overunder: how many of something, bet over or under a line the member picks
export type MarketKind = 'yesno' | 'choice' | 'overunder'
export type Side = 'over' | 'under'
export type MarketState = 'open' | 'closed' | 'settled' | 'void'
export type SelectionResult = 'pending' | 'won' | 'lost' | 'void'

db.exec(`
  -- event_id is the event's post, and missing for markets that aren't about an event, which
  -- only admins open. It has no foreign key, because a market outlives its event: when the
  -- event is deleted, the market is called off and the stakes paid back.
  CREATE TABLE IF NOT EXISTS bet_markets (
    id         TEXT PRIMARY KEY,
    event_id   TEXT,
    question   TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('yesno', 'choice', 'overunder')),
    liquidity  INTEGER NOT NULL,
    -- Over/under: the organizer's line, where over and under start out even
    line       REAL,
    -- Betting stops at this time; without one it stays open until it is closed by hand
    closes_at  TEXT,
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'void')),
    winner_id  TEXT,
    -- Over/under: the number it ended on. winner_id is its outcome, or the highest one.
    result_value INTEGER,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    settled_by TEXT,
    settled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS bet_markets_event ON bet_markets (event_id);

  CREATE TABLE IF NOT EXISTS bet_outcomes (
    id             TEXT PRIMARY KEY,
    market_id      TEXT NOT NULL REFERENCES bet_markets (id) ON DELETE CASCADE,
    position       INTEGER NOT NULL,
    label          TEXT NOT NULL,
    -- Over/under: the number this outcome stands for
    value          INTEGER,
    -- As the organizer set them, in hundredths
    opening_odds   INTEGER NOT NULL,
    -- Where the market maker starts; every selection adds the shares it bought
    opening_shares REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bet_outcomes_market ON bet_outcomes (market_id, position);

  -- Members who may not play on a market, typically the one it is about
  CREATE TABLE IF NOT EXISTS bet_exclusions (
    market_id TEXT NOT NULL REFERENCES bet_markets (id) ON DELETE CASCADE,
    username  TEXT NOT NULL,
    PRIMARY KEY (market_id, username)
  );

  CREATE TABLE IF NOT EXISTS bet_slips (
    id         TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    stake      INTEGER NOT NULL CHECK (stake > 0),
    -- All selections multiplied, in hundredths, as locked when the slip was played
    odds       INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost', 'void')),
    payout     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    settled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS bet_slips_member ON bet_slips (username, created_at DESC);

  -- A pick of one outcome, or on an over/under market a side of a line, which covers every
  -- number above or below it
  CREATE TABLE IF NOT EXISTS bet_selections (
    slip_id    TEXT NOT NULL REFERENCES bet_slips (id) ON DELETE CASCADE,
    market_id  TEXT NOT NULL REFERENCES bet_markets (id),
    outcome_id TEXT REFERENCES bet_outcomes (id),
    side       TEXT CHECK (side IN ('over', 'under')),
    line       REAL,
    odds       INTEGER NOT NULL,
    shares     REAL NOT NULL,
    PRIMARY KEY (slip_id, market_id)
  );
  CREATE INDEX IF NOT EXISTS bet_selections_market ON bet_selections (market_id);
  CREATE INDEX IF NOT EXISTS bet_selections_outcome ON bet_selections (outcome_id);

  -- start: the coins every member begins with. allowance: the Monday coins, one row per
  -- Monday (period). stake: a slip played. payout, refund and correction: what a slip has
  -- paid back, kept equal to what it should pay as markets are decided or reopened.
  CREATE TABLE IF NOT EXISTS bet_ledger (
    id         TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    amount     INTEGER NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('start', 'allowance', 'stake', 'payout', 'refund', 'correction')),
    slip_id    TEXT,
    period     TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bet_ledger_member ON bet_ledger (username, created_at);
  CREATE INDEX IF NOT EXISTS bet_ledger_slip ON bet_ledger (slip_id);
  CREATE UNIQUE INDEX IF NOT EXISTS bet_ledger_start ON bet_ledger (username) WHERE kind = 'start';
  CREATE UNIQUE INDEX IF NOT EXISTS bet_ledger_allowance ON bet_ledger (username, period) WHERE kind = 'allowance';
`)

const now = () => new Date().toISOString()
const bad = (message: string) => new HTTPException(400, { message })
const toOdds = (hundredths: number) => hundredths / 100

// --- Accounts ---

// The date in Norway, as YYYY-MM-DD
const localDate = (time: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE }).format(time)

const DAY_MS = 24 * 60 * 60 * 1000
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS
const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10)

// The Mondays after one date, up to and including another
function mondaysBetween(after: string, upTo: string) {
  let day = dayNumber(after) + 1
  // Day 0 (1 January 1970) was a Thursday, so Mondays are the days where day % 7 is 4
  day += (4 - (day % 7) + 7) % 7
  const mondays: string[] = []
  for (; day <= dayNumber(upTo); day += 7) mondays.push(dateOf(day))
  return mondays
}

// Opens the account on the member's first visit and pays any Mondays that have passed
// since they were last here. Safe to call any number of times.
export function ensureAccount(username: string) {
  transaction(() => {
    const start = db.prepare("SELECT created_at FROM bet_ledger WHERE username = ? AND kind = 'start'").get(username) as
      | { created_at: string }
      | undefined
    const openedAt = start?.created_at ?? now()
    if (!start) {
      db.prepare("INSERT INTO bet_ledger (id, username, amount, kind, created_at) VALUES (?, ?, ?, 'start', ?)").run(
        randomUUID(),
        username,
        START_BALANCE,
        openedAt,
      )
    }

    const { period } = db
      .prepare("SELECT MAX(period) AS period FROM bet_ledger WHERE username = ? AND kind = 'allowance'")
      .get(username) as { period: string | null }
    for (const monday of mondaysBetween(period ?? localDate(new Date(openedAt)), localDate(new Date()))) {
      db.prepare(
        "INSERT OR IGNORE INTO bet_ledger (id, username, amount, kind, period, created_at) VALUES (?, ?, ?, 'allowance', ?, ?)",
      ).run(randomUUID(), username, WEEKLY_ALLOWANCE, monday, now())
    }
  })
}

const balanceOf = (username: string) =>
  (db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM bet_ledger WHERE username = ?').get(username) as { n: number }).n

const inPlayOf = (username: string) =>
  (
    db.prepare("SELECT COALESCE(SUM(stake), 0) AS n FROM bet_slips WHERE username = ? AND status = 'open'").get(username) as {
      n: number
    }
  ).n

export async function getAccount(viewer: Viewer) {
  const members = await getMembers([viewer.username])
  const today = localDate(new Date())
  return {
    member: members.get(viewer.username)!,
    admin: viewer.admin,
    balance: balanceOf(viewer.username),
    inPlay: inPlayOf(viewer.username),
    weeklyAllowance: WEEKLY_ALLOWANCE,
    nextAllowance: mondaysBetween(today, dateOf(dayNumber(today) + 7))[0],
  }
}

// --- Events and markets ---

interface EventRow {
  id: string
  title: string
  location: string
  starts_at: string | null
  ends_at: string | null
  betting: number
  author: string
}

interface MarketRow {
  id: string
  event_id: string | null
  question: string
  kind: MarketKind
  liquidity: number
  line: number | null
  closes_at: string | null
  status: 'open' | 'settled' | 'void'
  winner_id: string | null
  result_value: number | null
  created_at: string
  settled_at: string | null
}

interface OutcomeRow {
  id: string
  label: string
  value: number | null
  opening_odds: number
  shares: number
  staked: number
  bets: number
}

const EVENT_SELECT = `
  SELECT e.post_id AS id, e.title, e.location, e.starts_at, e.ends_at, e.betting, p.author
  FROM events e JOIN feed_posts p ON p.id = e.post_id
`

function findEvent(id: string) {
  const row = db.prepare(`${EVENT_SELECT} WHERE e.post_id = ?`).get(id) as EventRow | undefined
  if (!row) throw new HTTPException(404, { message: 'Arrangementet finnes ikke' })
  return row
}

function findMarket(id: string) {
  const row = db.prepare('SELECT * FROM bet_markets WHERE id = ?').get(id) as MarketRow | undefined
  if (!row) throw new HTTPException(404, { message: 'Spillet finnes ikke' })
  return row
}

const canManage = (viewer: Viewer, event: EventRow) => viewer.admin || event.author === viewer.username

// Markets on an event are run by its organizer and admins, the other markets by admins
function assertCanManage(viewer: Viewer, eventId: string | null) {
  if (eventId === null) {
    if (!viewer.admin) throw new HTTPException(403, { message: 'Bare administratorer kan styre spill utenom arrangementer' })
    return null
  }
  const event = findEvent(eventId)
  if (!canManage(viewer, event)) {
    throw new HTTPException(403, { message: 'Bare arrangøren og administratorer kan styre spillene' })
  }
  return event
}

function stateOf(market: MarketRow): MarketState {
  if (market.status !== 'open') return market.status
  return market.closes_at && market.closes_at <= now() ? 'closed' : 'open'
}

// Whether a selection covers an outcome: it picked it, or it is a side of a line the
// outcome's number is on
const COVERS = `(s.outcome_id = o.id OR (s.side = 'over' AND o.value > s.line) OR (s.side = 'under' AND o.value < s.line))`

// Each outcome with the shares the market maker holds in it, what has been staked on it and
// how many slips picked it. A combination counts its whole stake on every selection.
const outcomesOf = (marketId: string) =>
  db
    .prepare(
      `SELECT o.id, o.label, o.value, o.opening_odds,
         o.opening_shares + COALESCE((SELECT SUM(s.shares) FROM bet_selections s WHERE s.market_id = o.market_id AND ${COVERS}), 0) AS shares,
         COALESCE((SELECT SUM(sl.stake) FROM bet_selections s JOIN bet_slips sl ON sl.id = s.slip_id WHERE s.outcome_id = o.id), 0) AS staked,
         (SELECT COUNT(*) FROM bet_selections s WHERE s.outcome_id = o.id) AS bets
       FROM bet_outcomes o
       WHERE o.market_id = ?
       ORDER BY o.position`,
    )
    .all(marketId) as unknown as OutcomeRow[]

// "Over 4,5"
const lineLabel = (side: Side, line: number) => `${side === 'over' ? 'Over' : 'Under'} ${String(line).replace('.', ',')}`

// The chance of the outcomes a pick covers, from the outcomes' prices in order
function chanceOf(outcomes: { id: string; value: number | null }[], current: number[], pick: Pick) {
  let chance = 0
  outcomes.forEach((o, i) => {
    const covered =
      pick.outcomeId !== null
        ? o.id === pick.outcomeId
        : o.value !== null && (pick.side === 'over' ? o.value > pick.line! : o.value < pick.line!)
    if (covered) chance += current[i]
  })
  return chance
}

const isExcluded = (marketId: string, username: string) =>
  !!db.prepare('SELECT 1 FROM bet_exclusions WHERE market_id = ? AND username = ?').get(marketId, username)

// The members kept out of a market, as those who run it see them
const excludedFrom = (marketId: string) =>
  db
    .prepare(
      `SELECT m.id, m.display_name AS name FROM bet_exclusions x JOIN members m ON m.username = x.username
       WHERE x.market_id = ? ORDER BY m.display_name`,
    )
    .all(marketId) as { id: string; name: string }[]

// manage: the viewer runs the market, and sees who is kept out of it
function toMarket(market: MarketRow, viewer: Viewer, manage: boolean) {
  const outcomes = outcomesOf(market.id)
  const current = prices(
    outcomes.map(o => o.shares),
    market.liquidity,
  )
  const mine = db
    .prepare(
      `SELECT s.outcome_id, s.side, s.line, SUM(sl.stake) AS stake FROM bet_selections s JOIN bet_slips sl ON sl.id = s.slip_id
       WHERE s.market_id = ? AND sl.username = ? GROUP BY s.outcome_id, s.side, s.line`,
    )
    .all(market.id, viewer.username) as { outcome_id: string | null; side: Side | null; line: number | null; stake: number }[]
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(sl.stake), 0) AS staked, COUNT(*) AS bets
       FROM bet_selections s JOIN bet_slips sl ON sl.id = s.slip_id WHERE s.market_id = ?`,
    )
    .get(market.id) as { staked: number; bets: number }

  return {
    id: market.id,
    // Missing when the market isn't about an event
    eventId: market.event_id,
    question: market.question,
    kind: market.kind,
    state: stateOf(market),
    closesAt: market.closes_at,
    liquidity: market.liquidity,
    winnerId: market.winner_id,
    createdAt: market.created_at,
    settledAt: market.settled_at,
    // Over/under: the organizer's line, the lowest and highest numbers, and what it ended on
    line: market.line,
    lowest: market.kind === 'overunder' ? outcomes[0].value : null,
    highest: market.kind === 'overunder' ? outcomes[outcomes.length - 1].value : null,
    result: market.result_value,
    outcomes: outcomes.map((o, i) => ({
      id: o.id,
      label: o.label,
      value: o.value,
      // What the market maker thinks the chance is; the site works out a stake's odds from it
      price: current[i],
      odds: toOdds(oddsAt(current[i])),
      openingOdds: toOdds(o.opening_odds),
      staked: o.staked,
      bets: o.bets,
    })),
    staked: totals.staked,
    bets: totals.bets,
    // What the viewer has on it: by outcome id, or "over:4.5" for a side of a line
    mine: Object.fromEntries(mine.map(row => [row.outcome_id ?? `${row.side}:${row.line}`, row.stake])),
    // The viewer is kept out of this market
    blocked: isExcluded(market.id, viewer.username),
    excluded: manage ? excludedFrom(market.id) : null,
  }
}

export type Market = ReturnType<typeof toMarket>

const marketsOf = (eventId: string) =>
  db.prepare('SELECT * FROM bet_markets WHERE event_id = ? ORDER BY created_at').all(eventId) as unknown as MarketRow[]

async function toEvents(rows: EventRow[], viewer: Viewer) {
  const members = await getMembers(rows.map(row => row.author))
  return rows.map(row => {
    const manage = canManage(viewer, row)
    return {
      id: row.id,
      title: row.title,
      location: row.location,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      // The organizer can turn betting off on tebonsma.no
      betting: row.betting === 1,
      organizer: members.get(row.author)!,
      canManage: manage,
      markets: marketsOf(row.id).map(market => toMarket(market, viewer, manage)),
    }
  })
}

const recently = () => new Date(Date.now() - RECENT_MS).toISOString()

// Events open for betting that are coming up or going on, and past ones whose markets are
// still open or were decided lately. Soonest first, the ones without a date last.
export function listEvents(viewer: Viewer) {
  const rows = db
    .prepare(
      `${EVENT_SELECT}
       WHERE e.betting = 1 AND (
         e.ends_at IS NULL OR e.ends_at >= ?
         OR EXISTS (SELECT 1 FROM bet_markets m WHERE m.event_id = e.post_id AND (m.status = 'open' OR m.settled_at >= ?))
       )
       ORDER BY e.starts_at IS NULL, e.starts_at, p.created_at`,
    )
    .all(now(), recently()) as unknown as EventRow[]
  return toEvents(rows, viewer)
}

// The latest bets on the markets that match the condition
async function latestBets(condition: string, ...params: string[]) {
  const rows = db
    .prepare(
      `SELECT s.slip_id, s.market_id, s.outcome_id, s.side, s.line, s.odds, sl.username, sl.stake, sl.created_at, o.label,
         (SELECT COUNT(*) FROM bet_selections x WHERE x.slip_id = s.slip_id) AS legs
       FROM bet_selections s
       JOIN bet_slips sl ON sl.id = s.slip_id
       JOIN bet_markets m ON m.id = s.market_id
       LEFT JOIN bet_outcomes o ON o.id = s.outcome_id
       WHERE ${condition}
       ORDER BY sl.created_at DESC LIMIT ?`,
    )
    .all(...params, BETS_SHOWN) as {
    slip_id: string
    market_id: string
    outcome_id: string | null
    side: Side | null
    line: number | null
    label: string | null
    odds: number
    username: string
    stake: number
    created_at: string
    legs: number
  }[]
  const members = await getMembers(rows.map(row => row.username))
  return rows.map(row => ({
    id: `${row.slip_id}:${row.market_id}`,
    member: members.get(row.username)!,
    marketId: row.market_id,
    outcomeId: row.outcome_id,
    label: labelOf(row),
    stake: row.stake,
    odds: toOdds(row.odds),
    combination: row.legs > 1,
    createdAt: row.created_at,
  }))
}

// One event with every market on it and the latest bets
export async function getEvent(viewer: Viewer, id: string) {
  const [event] = await toEvents([findEvent(id)], viewer)
  return { ...event, bets: await latestBets('m.event_id = ?', id) }
}

// The markets admins open that aren't about an event: the undecided ones and those decided
// lately, the ones closing first at the top
export async function listOther(viewer: Viewer) {
  const rows = db
    .prepare(
      `SELECT * FROM bet_markets WHERE event_id IS NULL AND (status = 'open' OR settled_at >= ?)
       ORDER BY closes_at IS NULL, closes_at, created_at`,
    )
    .all(recently()) as unknown as MarketRow[]
  return {
    canManage: viewer.admin,
    markets: rows.map(market => toMarket(market, viewer, viewer.admin)),
    bets: await latestBets('m.event_id IS NULL'),
  }
}

export const hasOpenMarkets = (eventId: string) =>
  !!db.prepare("SELECT 1 FROM bet_markets WHERE event_id = ? AND status = 'open'").get(eventId)

// The members of TEBONSMA: everyone who can be kept out of a market, or added as outcomes.
// The member group leaves out LLDAP's own admin, the API's service account and other accounts.
export async function listMembers() {
  const members = await getMembers(await listGroupMembers(config.memberGroup))
  return [...members.values()].sort((a, b) => a.name.localeCompare(b.name, 'nb'))
}

function usernamesOf(memberIds: string[]) {
  return [...new Set(memberIds)].map(id => {
    const username = usernameOf(id)
    if (!username) throw bad('Et av medlemmene finnes ikke')
    return username
  })
}

function setExclusions(marketId: string, usernames: string[]) {
  db.prepare('DELETE FROM bet_exclusions WHERE market_id = ?').run(marketId)
  for (const username of usernames) {
    db.prepare('INSERT INTO bet_exclusions (market_id, username) VALUES (?, ?)').run(marketId, username)
  }
}

export interface MarketInput {
  question: string
  kind: MarketKind
  // Not for over/under, which gets one outcome per number
  outcomes: { label: string; odds: number }[]
  // Over/under: the line where over and under start out even, the lowest and highest numbers,
  // and how far from the line the count may well end up
  line?: number
  lowest?: number
  highest?: number
  spread?: Spread
  // Missing: when the event starts (or ends, if it is already going on)
  closesAt?: string | null
  // Members who may not play on it, by their public id
  excluded: string[]
}

// eventId is null for a market that isn't about an event, which only admins open
export function createMarket(viewer: Viewer, eventId: string | null, input: MarketInput) {
  const event = assertCanManage(viewer, eventId)
  const time = now()
  if (event && !event.betting) throw bad('Arrangøren har slått av spill på dette arrangementet')
  if (event?.ends_at && event.ends_at <= time) throw bad('Arrangementet er over')

  let closesAt = input.closesAt
  if (closesAt === undefined) {
    closesAt = [event?.starts_at, event?.ends_at].find(t => t && t > time) ?? null
  }
  if (closesAt && closesAt <= time) throw bad('Stengetiden har allerede vært')

  const excluded = usernamesOf(input.excluded)
  const overUnder = input.kind === 'overunder'
  // Over/under has an outcome per number; the lowest one stands for it or fewer, the highest
  // for it or more
  const lowest = input.lowest ?? 0
  const highest = input.highest!
  const outcomes = overUnder
    ? countProbabilities(input.line!, lowest, highest, input.spread ?? 'medium').map((chance, i) => {
        const value = lowest + i
        const label =
          value === highest ? `${value} eller mer` : value === lowest && lowest > 0 ? `${value} eller færre` : String(value)
        return { label, value, chance }
      })
    : (() => {
        const chances = probabilitiesFromOdds(input.outcomes.map(o => o.odds))
        return input.outcomes.map((o, i) => ({ label: o.label, value: null, chance: chances[i] }))
      })()
  const id = randomUUID()
  transaction(() => {
    db.prepare(
      'INSERT INTO bet_markets (id, event_id, question, kind, liquidity, line, closes_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, eventId, input.question, input.kind, DEFAULT_LIQUIDITY, overUnder ? input.line! : null, closesAt, viewer.username, time)
    outcomes.forEach((outcome, position) => {
      db.prepare(
        'INSERT INTO bet_outcomes (id, market_id, position, label, value, opening_odds, opening_shares) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        randomUUID(),
        id,
        position,
        outcome.label,
        outcome.value,
        oddsAt(outcome.chance),
        openingShares(outcome.chance, DEFAULT_LIQUIDITY),
      )
    })
    setExclusions(id, excluded)
  })
  return toMarket(findMarket(id), viewer, true)
}

function managedMarket(viewer: Viewer, id: string) {
  const market = findMarket(id)
  assertCanManage(viewer, market.event_id)
  return market
}

export interface MarketChanges {
  question?: string
  closesAt?: string | null
  excluded?: string[]
}

// The question, the closing time and who is kept out can change while the market is
// undecided. Bets already placed by someone who is kept out stand.
export function updateMarket(viewer: Viewer, id: string, changes: MarketChanges) {
  const market = managedMarket(viewer, id)
  if (market.status !== 'open') throw bad('Spillet er allerede avgjort')
  if (changes.closesAt && changes.closesAt <= now()) throw bad('Stengetiden må være frem i tid. Bruk «Steng nå» for å stenge.')
  const excluded = changes.excluded && usernamesOf(changes.excluded)

  transaction(() => {
    db.prepare('UPDATE bet_markets SET question = ?, closes_at = ? WHERE id = ?').run(
      changes.question ?? market.question,
      changes.closesAt === undefined ? market.closes_at : changes.closesAt,
      id,
    )
    if (excluded) setExclusions(id, excluded)
  })
  return toMarket(findMarket(id), viewer, true)
}

export function closeMarket(viewer: Viewer, id: string) {
  const market = managedMarket(viewer, id)
  if (stateOf(market) !== 'open') throw bad('Spillet er allerede stengt')
  db.prepare('UPDATE bet_markets SET closes_at = ? WHERE id = ?').run(now(), id)
  return toMarket(findMarket(id), viewer, true)
}

// Brings every slip on the market up to date: what it should pay now and the ledger
// rows that make the member's balance match
function settleSlipsOn(marketId: string) {
  const slips = db.prepare('SELECT DISTINCT slip_id FROM bet_selections WHERE market_id = ?').all(marketId) as {
    slip_id: string
  }[]
  for (const { slip_id } of slips) settleSlip(slip_id)
}

interface LegResultRow {
  outcome_id: string | null
  side: Side | null
  line: number | null
  status: string
  winner_id: string | null
  // Over/under: the number the market ended on
  result_value: number | null
}

function resultOf(leg: LegResultRow): SelectionResult {
  if (leg.status === 'void') return 'void'
  if (leg.status !== 'settled') return 'pending'
  if (leg.side) {
    const over = leg.result_value! > leg.line!
    return (leg.side === 'over') === over ? 'won' : 'lost'
  }
  return leg.winner_id === leg.outcome_id ? 'won' : 'lost'
}

function settleSlip(slipId: string) {
  const slip = db.prepare('SELECT username, stake, status, settled_at FROM bet_slips WHERE id = ?').get(slipId) as {
    username: string
    stake: number
    status: string
    settled_at: string | null
  }
  const legs = db
    .prepare(
      `SELECT s.outcome_id, s.side, s.line, s.odds, m.status, m.winner_id, m.result_value
       FROM bet_selections s JOIN bet_markets m ON m.id = s.market_id
       WHERE s.slip_id = ?`,
    )
    .all(slipId) as unknown as (LegResultRow & { odds: number })[]
  const results = legs.map(resultOf)

  let status: 'open' | 'won' | 'lost' | 'void'
  let payout = 0
  if (results.includes('lost')) status = 'lost'
  else if (results.includes('pending')) status = 'open'
  else if (results.every(result => result === 'void')) {
    status = 'void'
    payout = slip.stake
  } else {
    status = 'won'
    // A void selection in a combination counts as odds 1,00
    payout = payoutFor(slip.stake, combine(legs.filter((_, i) => results[i] === 'won').map(leg => leg.odds)))
  }

  const time = now()
  const { paid } = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS paid FROM bet_ledger WHERE slip_id = ? AND kind != 'stake'")
    .get(slipId) as { paid: number }
  if (payout !== paid) {
    const kind = paid !== 0 ? 'correction' : status === 'void' ? 'refund' : 'payout'
    db.prepare('INSERT INTO bet_ledger (id, username, amount, kind, slip_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      randomUUID(),
      slip.username,
      payout - paid,
      kind,
      slipId,
      time,
    )
  }
  if (status !== slip.status || payout !== paid) {
    db.prepare('UPDATE bet_slips SET status = ?, payout = ?, settled_at = ? WHERE id = ?').run(
      status,
      payout,
      status === 'open' ? null : time,
      slipId,
    )
  }
}

// Deciding a market also stops the betting on it, so it stays closed if it is reopened
function decide(viewer: Viewer | null, id: string, status: 'settled' | 'void', winnerId: string | null, value: number | null = null) {
  const time = now()
  db.prepare(
    `UPDATE bet_markets SET status = ?, winner_id = ?, result_value = ?, settled_by = ?, settled_at = ?,
       closes_at = CASE WHEN closes_at IS NULL OR closes_at > ? THEN ? ELSE closes_at END
     WHERE id = ?`,
  ).run(status, winnerId, value, viewer?.username ?? null, time, time, time, id)
  settleSlipsOn(id)
}

// What happened: the winning outcome, or for over/under the number it ended on
export type Decision = { outcomeId: string } | { value: number }

export function settleMarket(viewer: Viewer, id: string, decision: Decision) {
  const market = managedMarket(viewer, id)
  if (market.status !== 'open') throw bad('Spillet er allerede avgjort. Gjør om avgjørelsen først.')

  let winnerId: string
  let value: number | null = null
  if (market.kind === 'overunder') {
    if (!('value' in decision)) throw bad('Skriv inn tallet det endte på')
    value = decision.value
    // Anything above the highest number is the highest outcome, and anything below the
    // lowest the lowest
    const outcome = db
      .prepare('SELECT id FROM bet_outcomes WHERE market_id = ? ORDER BY ABS(value - ?) LIMIT 1')
      .get(id, value) as { id: string }
    winnerId = outcome.id
  } else {
    if (!('outcomeId' in decision)) throw bad('Velg hva som skjedde')
    if (!db.prepare('SELECT 1 FROM bet_outcomes WHERE id = ? AND market_id = ?').get(decision.outcomeId, id)) throw bad('Ukjent utfall')
    winnerId = decision.outcomeId
  }
  transaction(() => decide(viewer, id, 'settled', winnerId, value))
  return toMarket(findMarket(id), viewer, true)
}

// Calls the market off: every stake on it is paid back, and in a combination it counts as 1,00
export function voidMarket(viewer: Viewer, id: string) {
  const market = managedMarket(viewer, id)
  if (market.status !== 'open') throw bad('Spillet er allerede avgjort. Gjør om avgjørelsen først.')
  transaction(() => decide(viewer, id, 'void', null))
  return toMarket(findMarket(id), viewer, true)
}

// Takes a decision back, for when the wrong outcome was picked. What it paid out is taken
// back from the members again, which can leave someone below zero.
export function reopenMarket(viewer: Viewer, id: string) {
  const market = managedMarket(viewer, id)
  if (market.status === 'open') throw bad('Spillet er ikke avgjort')
  transaction(() => {
    db.prepare(
      "UPDATE bet_markets SET status = 'open', winner_id = NULL, result_value = NULL, settled_by = NULL, settled_at = NULL WHERE id = ?",
    ).run(id)
    settleSlipsOn(id)
  })
  return toMarket(findMarket(id), viewer, true)
}

// Only a market nobody has played on can be removed; others are called off instead
export function deleteMarket(viewer: Viewer, id: string) {
  managedMarket(viewer, id)
  if (db.prepare('SELECT 1 FROM bet_selections WHERE market_id = ?').get(id)) {
    throw bad('Noen har spilt på dette. Annuller spillet i stedet, så får de myntene tilbake.')
  }
  db.prepare('DELETE FROM bet_markets WHERE id = ?').run(id)
}

// Called in the same transaction that deletes an event: its undecided markets are called
// off, so nobody loses the coins they had on them
export function voidEventMarkets(eventId: string) {
  const markets = db.prepare("SELECT id FROM bet_markets WHERE event_id = ? AND status = 'open'").all(eventId) as {
    id: string
  }[]
  for (const { id } of markets) decide(null, id, 'void', null)
}

// --- Playing ---

// One outcome, or on an over/under market a side of a line
export type Pick = { outcomeId: string; side: null; line: null } | { outcomeId: null; side: Side; line: number }

export interface SlipInput {
  stake: number
  // odds is what the member saw on the pick, so a change since then is noticed
  selections: (({ outcomeId: string } | { marketId: string; side: Side; line: number }) & { odds: number })[]
}

interface Target {
  market_id: string
  pick: Pick
}

// The chance of a pick right now, from the market maker's prices
const priceOf = (marketId: string, pick: Pick) => {
  const market = findMarket(marketId)
  const outcomes = outcomesOf(marketId)
  const current = prices(
    outcomes.map(o => o.shares),
    market.liquidity,
  )
  return { market, price: chanceOf(outcomes, current, pick) }
}

function targetOf(selection: SlipInput['selections'][number]): Target {
  if ('outcomeId' in selection) {
    const row = db.prepare('SELECT market_id FROM bet_outcomes WHERE id = ?').get(selection.outcomeId) as
      | { market_id: string }
      | undefined
    if (!row) throw bad('Et av utfallene finnes ikke lenger')
    return { market_id: row.market_id, pick: { outcomeId: selection.outcomeId, side: null, line: null } }
  }
  const market = db.prepare('SELECT kind FROM bet_markets WHERE id = ?').get(selection.marketId) as { kind: MarketKind } | undefined
  if (!market) throw bad('Et av spillene finnes ikke lenger')
  if (market.kind !== 'overunder') throw bad('Ugyldig kupong')
  const { lowest, highest } = db
    .prepare('SELECT MIN(value) AS lowest, MAX(value) AS highest FROM bet_outcomes WHERE market_id = ?')
    .get(selection.marketId) as { lowest: number; highest: number }
  // Lines lie halfway between two numbers, so the result is always over or under
  if (selection.line % 1 !== 0.5 || selection.line < lowest + 0.5 || selection.line > highest - 0.5) throw bad('Ugyldig linje')
  return { market_id: selection.marketId, pick: { outcomeId: null, side: selection.side, line: selection.line } }
}

// Plays the slips together: all of them or, if any can't be played, none
export function placeSlips(viewer: Viewer, slips: SlipInput[]) {
  return transaction(() => {
    const total = slips.reduce((sum, slip) => sum + slip.stake, 0)
    if (total > balanceOf(viewer.username)) throw bad('Du har ikke nok TEB-mynter')

    const targets = slips.map(slip => {
      const legs = slip.selections.map(selection => {
        const target = targetOf(selection)
        const { market, price } = priceOf(target.market_id, target.pick)
        if (stateOf(market) !== 'open') throw bad(`«${market.question}» er stengt for spill`)
        if (isExcluded(market.id, viewer.username)) throw bad(`Du kan ikke spille på «${market.question}»`)
        if (oddsAt(price) !== Math.round(selection.odds * 100)) {
          throw new HTTPException(409, { message: 'Oddsen har endret seg. Se over kupongen og spill igjen.' })
        }
        return target
      })
      if (new Set(legs.map(leg => leg.market_id)).size !== legs.length) {
        throw bad('En kombinasjon kan bare ha ett utfall fra hvert spill')
      }
      return legs
    })

    // Each stake moves the odds for the ones after it, so they are worked out one by one
    const time = now()
    return slips.map((slip, i) => {
      const id = randomUUID()
      const legs = targets[i].map(target => {
        const { market, price } = priceOf(target.market_id, target.pick)
        return {
          ...target,
          odds: oddsFor(slip.stake, price, market.liquidity),
          shares: sharesFor(slip.stake, price, market.liquidity),
        }
      })
      const odds = combine(legs.map(leg => leg.odds))
      db.prepare('INSERT INTO bet_slips (id, username, stake, odds, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        viewer.username,
        slip.stake,
        odds,
        time,
      )
      for (const leg of legs) {
        db.prepare(
          'INSERT INTO bet_selections (slip_id, market_id, outcome_id, side, line, odds, shares) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(id, leg.market_id, leg.pick.outcomeId, leg.pick.side, leg.pick.line, leg.odds, leg.shares)
      }
      db.prepare("INSERT INTO bet_ledger (id, username, amount, kind, slip_id, created_at) VALUES (?, ?, ?, 'stake', ?, ?)").run(
        randomUUID(),
        viewer.username,
        -slip.stake,
        id,
        time,
      )
      return id
    })
  })
}

interface SlipRow {
  id: string
  stake: number
  odds: number
  status: 'open' | 'won' | 'lost' | 'void'
  payout: number
  created_at: string
  settled_at: string | null
}

interface LegRow extends LegResultRow {
  slip_id: string
  market_id: string
  odds: number
  question: string
  event_id: string | null
  event_title: string | null
  label: string | null
}

// What a selection is on, as members read it: "Ja", "Lag 2" or "Over 4,5"
const labelOf = (row: { label: string | null; side: Side | null; line: number | null }) =>
  row.side ? lineLabel(row.side, row.line!) : row.label!

function legsOf(slipIds: string[]) {
  if (slipIds.length === 0) return []
  return db
    .prepare(
      `SELECT s.slip_id, s.market_id, s.outcome_id, s.side, s.line, s.odds, m.question, m.status, m.winner_id,
         m.result_value, m.event_id, e.title AS event_title, o.label
       FROM bet_selections s
       JOIN bet_markets m ON m.id = s.market_id
       LEFT JOIN bet_outcomes o ON o.id = s.outcome_id
       LEFT JOIN events e ON e.post_id = m.event_id
       WHERE s.slip_id IN (${slipIds.map(() => '?').join(', ')})
       ORDER BY m.created_at`,
    )
    .all(...slipIds) as unknown as LegRow[]
}

function toSlips(rows: SlipRow[]) {
  const legs = legsOf(rows.map(row => row.id))
  return rows.map(row => ({
    id: row.id,
    stake: row.stake,
    odds: toOdds(row.odds),
    potentialPayout: payoutFor(row.stake, row.odds),
    status: row.status,
    payout: row.payout,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    selections: legs
      .filter(leg => leg.slip_id === row.id)
      .map(leg => ({
        marketId: leg.market_id,
        eventId: leg.event_id,
        // Missing for markets that aren't about an event, or when the event has been deleted
        eventTitle: leg.event_title,
        question: leg.question,
        outcomeId: leg.outcome_id,
        label: labelOf(leg),
        odds: toOdds(leg.odds),
        result: resultOf(leg),
      })),
  }))
}

export type Slip = ReturnType<typeof toSlips>[number]

export function getSlips(viewer: Viewer, ids: string[]) {
  if (ids.length === 0) return []
  const rows = db
    .prepare(`SELECT * FROM bet_slips WHERE username = ? AND id IN (${ids.map(() => '?').join(', ')}) ORDER BY created_at DESC`)
    .all(viewer.username, ...ids) as unknown as SlipRow[]
  return toSlips(rows)
}

// The member's own slips: the ones still running, or the ones that are done
export function listSlips(viewer: Viewer, settled: boolean) {
  const rows = db
    .prepare(
      `SELECT * FROM bet_slips WHERE username = ? AND (status = 'open') = ?
       ORDER BY COALESCE(settled_at, created_at) DESC LIMIT ?`,
    )
    .all(viewer.username, settled ? 0 : 1, SLIPS_SHOWN) as unknown as SlipRow[]
  return toSlips(rows)
}

// --- Ledger and leaderboard ---

// The latest movements on the member's account, newest first, with the balance after each
export function listLedger(viewer: Viewer) {
  const rows = db
    .prepare(
      `SELECT id, amount, kind, slip_id, period, created_at FROM bet_ledger WHERE username = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(viewer.username, LEDGER_SHOWN) as {
    id: string
    amount: number
    kind: string
    slip_id: string | null
    period: string | null
    created_at: string
  }[]
  const legs = legsOf([...new Set(rows.flatMap(row => (row.slip_id ? [row.slip_id] : [])))])

  let balance = balanceOf(viewer.username)
  return rows.map(row => {
    const entry = {
      id: row.id,
      amount: row.amount,
      kind: row.kind,
      period: row.period,
      createdAt: row.created_at,
      balance,
      slip: row.slip_id
        ? {
            id: row.slip_id,
            selections: legs
              .filter(leg => leg.slip_id === row.slip_id)
              .map(leg => ({ question: leg.question, label: labelOf(leg), eventTitle: leg.event_title })),
          }
        : null,
    }
    balance -= row.amount
    return entry
  })
}

// Everyone who has played, by what they are worth: coins in hand and coins in play
export async function getLeaderboard() {
  const usernames = (db.prepare('SELECT DISTINCT username FROM bet_ledger').all() as { username: string }[]).map(
    row => row.username,
  )
  // Members who haven't been here for a while are owed their Mondays too
  for (const username of usernames) ensureAccount(username)

  const balances = db.prepare('SELECT username, SUM(amount) AS n FROM bet_ledger GROUP BY username').all() as {
    username: string
    n: number
  }[]
  const slips = db
    .prepare(
      `SELECT username,
         COALESCE(SUM(CASE WHEN status = 'open' THEN stake END), 0) AS in_play,
         COUNT(*) AS played,
         COUNT(CASE WHEN status = 'won' THEN 1 END) AS won
       FROM bet_slips GROUP BY username`,
    )
    .all() as { username: string; in_play: number; played: number; won: number }[]
  const members = await getMembers(usernames)

  return balances
    .map(row => {
      const stats = slips.find(s => s.username === row.username)
      const inPlay = stats?.in_play ?? 0
      return {
        member: members.get(row.username)!,
        balance: row.n,
        inPlay,
        total: row.n + inPlay,
        played: stats?.played ?? 0,
        won: stats?.won ?? 0,
      }
    })
    .sort((a, b) => b.total - a.total || a.member.name.localeCompare(b.member.name, 'nb'))
}
