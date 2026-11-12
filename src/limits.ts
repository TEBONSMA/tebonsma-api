import { HTTPException } from 'hono/http-exception'
import { addDays, osloDate, osloMidnight, weekday } from './bots/time.ts'
import { db, transaction } from './db.ts'

// Spillepause: limits a member sets on themselves, on what they stake and how long they play in a
// day, week or month, and breaks they take. A stricter limit holds at once and a looser one only
// after a day, so a limit can't be lifted on a whim. A member who has set none is asked, on a day
// they have played a lot, whether they want one. Only the member and the admins see it, and an
// admin can take it all away at once, as at a party everyone is at; the member is told.

db.exec(`
  -- Every limit a member has set, and from when it holds: the newest that holds is the one that counts
  CREATE TABLE IF NOT EXISTS bet_limits (
    username   TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('stake', 'time')),
    period     TEXT NOT NULL CHECK (period IN ('day', 'week', 'month')),
    -- Coins for stakes, minutes for time; null for none
    amount     INTEGER,
    from_at    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bet_limits_member ON bet_limits (username, kind, period, from_at);
  CREATE TABLE IF NOT EXISTS bet_pauses (
    username   TEXT NOT NULL,
    until      TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bet_pauses_member ON bet_pauses (username, until);
  -- Time in TebBet per member and day in Norway, and when the app last said they were there
  CREATE TABLE IF NOT EXISTS bet_play_time (
    username  TEXT NOT NULL,
    day       TEXT NOT NULL,
    seconds   REAL NOT NULL,
    last_beat TEXT NOT NULL,
    PRIMARY KEY (username, day)
  );
  -- When an admin took away a member's limits and break, and who
  CREATE TABLE IF NOT EXISTS bet_limit_resets (
    username TEXT NOT NULL,
    by       TEXT NOT NULL,
    at       TEXT NOT NULL
  );
  -- The days a member said not now to the question about a limit
  CREATE TABLE IF NOT EXISTS bet_nudges (
    username TEXT NOT NULL,
    day      TEXT NOT NULL,
    PRIMARY KEY (username, day)
  );
`)

export type LimitKind = 'stake' | 'time'
export type LimitPeriod = 'day' | 'week' | 'month'
// Stakes by the day, week or month; time by the day or week
export const PERIODS: Record<LimitKind, LimitPeriod[]> = { stake: ['day', 'week', 'month'], time: ['day', 'week'] }
// The highest limit there can be: coins, and minutes in the period
export const MAX_LIMIT: Record<LimitKind, Partial<Record<LimitPeriod, number>>> = {
  stake: { day: 1_000_000, week: 1_000_000, month: 1_000_000 },
  time: { day: 24 * 60, week: 7 * 24 * 60 },
}

const DAY_MS = 24 * 60 * 60 * 1000
// How long a looser limit waits
const LOOSEN_AFTER_MS = DAY_MS
export const PAUSES = { 'rest-of-day': 0, '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS } as const
export type PauseLength = keyof typeof PAUSES
// The app says the member is there every 30 seconds while they use it. A beat counts for the time
// since the last one, at most 30 seconds, and nothing after a gap, when the app was closed or out of
// sight. PLAY_TIME_SPEED counts faster, for the tests.
const BEAT_SECONDS = 30
const GAP_MS = 60_000
const SPEED = Number(process.env.PLAY_TIME_SPEED ?? 1)
// When a member who has set no limits is asked whether they want one: an hour, or 300 coins, in a day
const NUDGE_SECONDS = 60 * 60
const NUDGE_STAKE = 300

const PER: Record<LimitPeriod, string> = { day: 'per dag', week: 'per uke', month: 'per måned' }

// "fredag 13. november kl. 00:00"
const when = (time: string) =>
  new Intl.DateTimeFormat('nb-NO', { timeZone: 'Europe/Oslo', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(
    new Date(time),
  )

// "1 t 30 min"
function duration(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return [hours && `${hours} t`, (rest || !hours) && `${rest} min`].filter(Boolean).join(' ')
}

// The day, week (from Monday) or month in Norway that a time is in: its first day, and when it
// starts and the next one starts
function bounds(period: LimitPeriod, time: Date) {
  const today = osloDate(time)
  const first = period === 'day' ? today : period === 'week' ? addDays(today, -weekday(today)) : `${today.slice(0, 8)}01`
  const [year, month] = first.split('-').map(Number)
  const next =
    period === 'day'
      ? addDays(first, 1)
      : period === 'week'
        ? addDays(first, 7)
        : month === 12
          ? `${year + 1}-01-01`
          : `${year}-${String(month + 1).padStart(2, '0')}-01`
  return { firstDay: first, start: osloMidnight(first), end: osloMidnight(next) }
}

// Coins staked since a time: on slips and in the casino, also stakes that were paid back later
const staked = (username: string, since: string) =>
  (
    db
      .prepare("SELECT COALESCE(SUM(-amount), 0) AS n FROM bet_ledger WHERE username = ? AND kind IN ('stake', 'casino-stake') AND created_at >= ?")
      .get(username, since) as { n: number }
  ).n

// Seconds in TebBet from a day in Norway on
const played = (username: string, fromDay: string) =>
  (db.prepare('SELECT COALESCE(SUM(seconds), 0) AS n FROM bet_play_time WHERE username = ? AND day >= ?').get(username, fromDay) as { n: number }).n

// --- Limits

// The limit that holds now, or null, and a looser one waiting to take over, if any
function limitOf(username: string, kind: LimitKind, period: LimitPeriod, now: string) {
  const rows = db
    .prepare('SELECT amount, from_at FROM bet_limits WHERE username = ? AND kind = ? AND period = ? ORDER BY from_at DESC, created_at DESC')
    .all(username, kind, period) as { amount: number | null; from_at: string }[]
  const current = rows.find(row => row.from_at <= now)
  const waiting = rows.find(row => row.from_at > now)
  return { amount: current?.amount ?? null, pending: waiting ? { amount: waiting.amount, from: waiting.from_at } : null }
}

// A new limit, or null for none: a stricter one holds at once, a looser one after a day. Asking
// again for what is already waiting leaves it waiting from when it was first asked for.
function setLimit(username: string, kind: LimitKind, period: LimitPeriod, amount: number | null) {
  const time = new Date()
  const now = time.toISOString()
  const { amount: current, pending } = limitOf(username, kind, period, now)
  if (pending && pending.amount === amount) return
  db.prepare('DELETE FROM bet_limits WHERE username = ? AND kind = ? AND period = ? AND from_at > ?').run(username, kind, period, now)
  if (amount === current) return
  const stricter = current === null || (amount !== null && amount < current)
  const from = stricter ? now : new Date(time.getTime() + LOOSEN_AFTER_MS).toISOString()
  db.prepare('INSERT INTO bet_limits (username, kind, period, amount, from_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    username,
    kind,
    period,
    amount,
    from,
    now,
  )
}

export type LimitChange = [LimitKind, LimitPeriod, number | null]

export const setLimits = (username: string, changes: LimitChange[]) =>
  transaction(() => changes.forEach(([kind, period, amount]) => setLimit(username, kind, period, amount)))

// --- Breaks

const pauseUntil = (username: string, now: string) => {
  const { until } = db.prepare('SELECT MAX(until) AS until FROM bet_pauses WHERE username = ?').get(username) as { until: string | null }
  return until && until > now ? until : null
}

// A break for the rest of the day in Norway, or a day, a week or a month. It can't be cut short:
// a shorter one taken during a longer one changes nothing.
export function startPause(username: string, length: PauseLength) {
  const time = new Date()
  const until = length === 'rest-of-day' ? bounds('day', time).end : new Date(time.getTime() + PAUSES[length]).toISOString()
  db.prepare('INSERT INTO bet_pauses (username, until, created_at) VALUES (?, ?, ?)').run(username, until, time.toISOString())
}

// --- Whether a member may play

export interface Blocked {
  // A break, a time limit reached, or a stake limit used up
  reason: 'pause' | 'time' | 'stake'
  until: string
  message: string
}

// Why the member may not play now, if they may not: the block that lasts the longest
function blockedOf(username: string, time: Date): Blocked | null {
  const now = time.toISOString()
  const blocks: Blocked[] = []
  const pause = pauseUntil(username, now)
  if (pause) blocks.push({ reason: 'pause', until: pause, message: `Du har tatt spillepause til ${when(pause)}.` })
  for (const period of PERIODS.time) {
    const { amount } = limitOf(username, 'time', period, now)
    const { firstDay, end } = bounds(period, time)
    if (amount !== null && played(username, firstDay) >= amount * 60) {
      blocks.push({
        reason: 'time',
        until: end,
        message: `Du har nådd grensen din på ${duration(amount)} spilletid ${PER[period]}. Du kan spille igjen ${when(end)}.`,
      })
    }
  }
  for (const period of PERIODS.stake) {
    const { amount } = limitOf(username, 'stake', period, now)
    const { start, end } = bounds(period, time)
    if (amount !== null && staked(username, start) >= amount) {
      blocks.push({
        reason: 'stake',
        until: end,
        message: `Du har nådd grensen din på ${amount} ₮ i innsats ${PER[period]}. Du kan satse igjen ${when(end)}.`,
      })
    }
  }
  return blocks.reduce<Blocked | null>((longest, block) => (!longest || block.until > longest.until ? block : longest), null)
}

// Throws when the member may not play: on a break or out of time, and for a stake, when it would
// go past a stake limit. Free plays (stake 0) don't count against the stake limits.
export function assertCanPlay(username: string, stake = 0) {
  const time = new Date()
  const blocked = blockedOf(username, time)
  if (blocked && (blocked.reason !== 'stake' || stake > 0)) throw new HTTPException(423, { message: blocked.message })
  if (stake > 0) assertStakeRoom(username, stake, time)
}

// Only the stake limits: for more coins in a round already going, as when doubling in blackjack,
// which a break or a time limit doesn't stop
export function assertStakeRoom(username: string, stake: number, time = new Date()) {
  const now = time.toISOString()
  for (const period of PERIODS.stake) {
    const { amount } = limitOf(username, 'stake', period, now)
    if (amount === null) continue
    const { start, end } = bounds(period, time)
    const left = Math.max(0, amount - staked(username, start))
    if (stake > left) {
      throw new HTTPException(423, {
        message: `Grensen din er ${amount} ₮ i innsats ${PER[period]}, og du har ${left} ₮ igjen til ${when(end)}.`,
      })
    }
  }
}

// --- Time in TebBet

// The app saying the member is using it. Tells whether they may still play.
export function recordPlay(username: string) {
  const time = new Date()
  const { at } = db.prepare('SELECT MAX(last_beat) AS at FROM bet_play_time WHERE username = ?').get(username) as { at: string | null }
  const gap = at ? time.getTime() - Date.parse(at) : Infinity
  const seconds = gap <= GAP_MS ? Math.min((gap / 1000) * SPEED, BEAT_SECONDS) : 0
  db.prepare(
    `INSERT INTO bet_play_time (username, day, seconds, last_beat) VALUES (?, ?, ?, ?)
     ON CONFLICT (username, day) DO UPDATE SET seconds = seconds + excluded.seconds, last_beat = excluded.last_beat`,
  ).run(username, osloDate(time), seconds, time.toISOString())
  return blockedOf(username, time)
}

// --- Asking about a limit

// For a member with no limits, on a day they have played a lot and not said not now: how long they
// have played and what they have staked today
function nudgeOf(username: string, time: Date) {
  const now = time.toISOString()
  const today = osloDate(time)
  const limited = (Object.keys(PERIODS) as LimitKind[]).some(kind =>
    PERIODS[kind].some(period => {
      const { amount, pending } = limitOf(username, kind, period, now)
      return amount !== null || (pending !== null && pending.amount !== null)
    }),
  )
  if (limited || pauseUntil(username, now)) return null
  if (db.prepare('SELECT 1 FROM bet_nudges WHERE username = ? AND day = ?').get(username, today)) return null
  const seconds = Math.round(played(username, today))
  const stake = staked(username, bounds('day', time).start)
  return seconds >= NUDGE_SECONDS || stake >= NUDGE_STAKE ? { seconds, stake } : null
}

export const dismissNudge = (username: string) =>
  db.prepare('INSERT OR IGNORE INTO bet_nudges (username, day) VALUES (?, ?)').run(username, osloDate(new Date()))

// --- An admin taking it away

// Every limit and the break of a member, gone at once, also limits waiting to change. They aren't
// asked about a limit again that day.
export function resetLimits(username: string, by: string) {
  const now = new Date().toISOString()
  transaction(() => {
    db.prepare('DELETE FROM bet_limits WHERE username = ? AND from_at > ?').run(username, now)
    for (const kind of Object.keys(PERIODS) as LimitKind[]) {
      for (const period of PERIODS[kind]) {
        if (limitOf(username, kind, period, now).amount === null) continue
        db.prepare('INSERT INTO bet_limits (username, kind, period, amount, from_at, created_at) VALUES (?, ?, ?, NULL, ?, ?)').run(
          username,
          kind,
          period,
          now,
          now,
        )
      }
    }
    db.prepare('UPDATE bet_pauses SET until = ? WHERE username = ? AND until > ?').run(now, username, now)
    db.prepare('INSERT INTO bet_limit_resets (username, by, at) VALUES (?, ?, ?)').run(username, by, now)
    dismissNudge(username)
  })
}

// The last time an admin took away the member's limits, in the last 30 days
export function lastReset(username: string) {
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString()
  return (
    (db.prepare('SELECT by, at FROM bet_limit_resets WHERE username = ? AND at >= ? ORDER BY at DESC LIMIT 1').get(username, since) as
      | { by: string; at: string }
      | undefined) ?? null
  )
}

// What an admin sees of a member: their limits, what is waiting, and their break; not what they have used
export function limitsForAdmin(username: string) {
  const now = new Date().toISOString()
  const view = (kind: LimitKind) => Object.fromEntries(PERIODS[kind].map(period => [period, limitOf(username, kind, period, now)]))
  return { stake: view('stake'), time: view('time'), pause: pauseUntil(username, now) }
}

// --- What the member sees

// For every page: whether they may play, and whether to ask about a limit
export function playOf(username: string) {
  const time = new Date()
  return { blocked: blockedOf(username, time), nudge: nudgeOf(username, time) }
}

// The Spillepause page: each limit with what it holds now and what is waiting, what is used of it
// (coins, or seconds for time) and when it starts over; the break; and the same as on every page
export function limitsOf(username: string) {
  const time = new Date()
  const now = time.toISOString()
  const view = (kind: LimitKind) =>
    Object.fromEntries(
      PERIODS[kind].map(period => {
        const { firstDay, start, end } = bounds(period, time)
        const { amount, pending } = limitOf(username, kind, period, now)
        const used = kind === 'stake' ? staked(username, start) : Math.round(played(username, firstDay))
        return [period, { limit: amount, pending, used, resetsAt: end }]
      }),
    )
  return { stake: view('stake'), time: view('time'), pause: pauseUntil(username, now), ...playOf(username) }
}
