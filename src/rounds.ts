import { randomInt, randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { addCasinoRow, balanceOf } from './bets.ts'
import { drawCrash, MAX_CRASH, multiplierAt, timeAt } from './crash.ts'
import { db, transaction } from './db.ts'
import { takeGift } from './gifts.ts'
import type { Viewer } from './feed.ts'
import { MEMBERS } from './flaksGames.ts'
import { usernameOf } from './members.ts'
import { payoutOf, playSlot, type SlotResult } from './slot.ts'

// Two more casino games, kept in one table of rounds: Sponsorjakten (the collector slot in slot.ts)
// and Fyllekjøring (the crash game in crash.ts). Coins move through the ledger like the other games
// of luck. A slot spin is decided at once; a Fyllekjøring round drives on until the member jumps off
// or the car crashes. Free
// rounds (trial) play the same, but take and pay nothing and aren't kept.

db.exec(`
  CREATE TABLE IF NOT EXISTS flaks_rounds (
    id         TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    game       TEXT NOT NULL CHECK (game IN ('sponsorjakten', 'fyllekjoring')),
    stake      INTEGER NOT NULL,
    payout     INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('playing', 'done')),
    -- What happened, for the lists (JSON); Fyllekjøring's crash point is only in it once it is done
    detail     TEXT NOT NULL,
    -- Fyllekjøring while it drives: the crash point (hundredths) and the member's target, if any
    crash      INTEGER,
    target     INTEGER,
    created_at TEXT NOT NULL,
    done_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS flaks_rounds_member ON flaks_rounds (username, status, created_at);
  CREATE INDEX IF NOT EXISTS flaks_rounds_done ON flaks_rounds (status, done_at);
`)

export const ROUND_GAMES = { sponsorjakten: 'Sponsorjakten', fyllekjoring: 'Fyllekjøring' } as const
export type RoundGame = keyof typeof ROUND_GAMES

const DONE_SHOWN = 100
const bad = (message: string) => new HTTPException(400, { message })
const now = () => new Date().toISOString()

interface RoundRow {
  id: string
  username: string
  game: RoundGame
  stake: number
  payout: number
  status: 'playing' | 'done'
  detail: string
  crash: number | null
  target: number | null
  created_at: string
  done_at: string | null
}

const toRound = (row: RoundRow) => ({
  id: row.id,
  game: row.game,
  status: row.status,
  stake: row.stake,
  payout: row.payout,
  detail: JSON.parse(row.detail) as Record<string, unknown>,
  createdAt: row.created_at,
  doneAt: row.done_at,
})
export type Round = ReturnType<typeof toRound>

function insertRound(row: RoundRow) {
  db.prepare(
    `INSERT INTO flaks_rounds (id, username, game, stake, payout, status, detail, crash, target, created_at, done_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.username, row.game, row.stake, row.payout, row.status, row.detail, row.crash, row.target, row.created_at, row.done_at)
}

const ensureCoins = (viewer: Viewer, stake: number) => {
  if (stake > balanceOf(viewer.username)) throw bad('Du har ikke nok TEB-mynter')
}

// --- Sponsorjakten

// Four of the members are the collectors, one for each colour, new ones every spin
const collectorsFor = () => {
  const pool = [...MEMBERS] as string[]
  return [0, 1, 2, 3].map(() => pool.splice(randomInt(pool.length), 1)[0])
}

const slotDetail = (result: SlotResult, members: string[]) => ({
  members,
  freeSpins: result.freeSpins,
  topLevel: result.topLevel,
  // In stakes, for the lists: 12.5 is 12,5x
  times: Math.min(result.win, 500_000) / 100,
})

// gift: a spin on the house, at its own stake, with nothing taken from the member
export function spinSlot(viewer: Viewer, stake: number, trial: boolean, gift = false) {
  const result = playSlot(randomInt)
  const members = collectorsFor()
  if (trial) return { frames: result.frames, members, payout: payoutOf(stake, result.win), round: null }
  return transaction(() => {
    const played = gift ? takeGift(viewer.username, 'sponsorjakten') : stake
    const payout = payoutOf(played, result.win)
    const detail = { ...slotDetail(result, members), ...(gift && { gift: true }) }
    if (!gift) {
      ensureCoins(viewer, played)
      addCasinoRow(viewer.username, -played, ROUND_GAMES.sponsorjakten, 'Spinn')
    }
    const won = result.freeSpins > 0 ? `Vant ${payout}, med gratisspinn` : `Vant ${payout}`
    if (payout > 0) addCasinoRow(viewer.username, payout, ROUND_GAMES.sponsorjakten, gift ? `${won}, på huset` : won)
    const row: RoundRow = {
      id: randomUUID(),
      username: viewer.username,
      game: 'sponsorjakten',
      stake: played,
      payout,
      status: 'done',
      detail: JSON.stringify(detail),
      crash: null,
      target: null,
      created_at: now(),
      done_at: now(),
    }
    insertRound(row)
    return { frames: result.frames, members, payout, round: toRound(row) }
  })
}

// --- Fyllekjøring

const findRound = (id: string) => db.prepare('SELECT * FROM flaks_rounds WHERE id = ?').get(id) as RoundRow | undefined
const launchedAt = (row: RoundRow) => Date.parse(row.created_at)

// A round that is over: taken out at a multiplier, or blown up. at: when it ended.
function land(row: RoundRow, takenAt: number | null, at: number) {
  const payout = takenAt === null ? 0 : Math.floor((row.stake * takenAt) / 100)
  // What it was started with (a drive on the house), and how it went
  const started = JSON.parse(row.detail) as { gift?: boolean }
  const detail = { ...started, crash: row.crash, takenAt, target: row.target }
  db.prepare("UPDATE flaks_rounds SET status = 'done', payout = ?, detail = ?, done_at = ? WHERE id = ? AND status = 'playing'").run(
    payout,
    JSON.stringify(detail),
    new Date(at).toISOString(),
    row.id,
  )
  const jumped = `Hoppet av ved ${(takenAt! / 100).toFixed(2).replace('.', ',')}x`
  if (payout > 0) addCasinoRow(row.username, payout, ROUND_GAMES.fyllekjoring, started.gift ? `${jumped}, på huset` : jumped)
}

// A round whose car has crashed by now ends there, paid at the target if it got that far. One
// that got all the way to Palanga lands there and pays the most there is.
function settleIfLanded(row: RoundRow, time = Date.now()) {
  if (row.status !== 'playing') return
  const blownAt = launchedAt(row) + timeAt(row.crash!)
  if (row.target !== null && row.target < row.crash!) {
    const reached = launchedAt(row) + timeAt(row.target)
    if (reached <= time) land(row, row.target, reached)
    return
  }
  if (blownAt <= time) land(row, row.crash === MAX_CRASH * 100 ? row.crash : null, blownAt)
}

// Every round that has crashed or reached its target by now, also of members who left the page
export function settleLandedRounds() {
  const rows = db.prepare("SELECT * FROM flaks_rounds WHERE game = 'fyllekjoring' AND status = 'playing'").all() as unknown as RoundRow[]
  transaction(() => rows.forEach(row => settleIfLanded(row)))
}

// What the site may know of a round on the road: never the crash point until it is over. elapsed:
// ms since launch by the server's clock, so the site can fly it on from where it is.
const toFlight = (row: RoundRow) => ({
  ...toRound(row),
  launchedAt: row.created_at,
  elapsed: Date.now() - launchedAt(row),
  target: row.target,
  detail: row.status === 'done' ? (JSON.parse(row.detail) as Record<string, unknown>) : {},
})

export function currentFlight(viewer: Viewer) {
  const row = db.prepare("SELECT * FROM flaks_rounds WHERE username = ? AND game = 'fyllekjoring' AND status = 'playing'").get(viewer.username) as
    | RoundRow
    | undefined
  if (!row) return null
  transaction(() => settleIfLanded(row))
  const fresh = findRound(row.id)!
  return fresh.status === 'playing' ? toFlight(fresh) : null
}

// target: take out by itself at this multiplier (hundredths), or null
// gift: a drive on the house, at its own stake, with nothing taken from the member
export function launch(viewer: Viewer, stake: number, target: number | null, gift = false) {
  return transaction(() => {
    const flying = db.prepare("SELECT * FROM flaks_rounds WHERE username = ? AND game = 'fyllekjoring' AND status = 'playing'").all(viewer.username) as unknown as RoundRow[]
    flying.forEach(row => settleIfLanded(row))
    if (db.prepare("SELECT 1 FROM flaks_rounds WHERE username = ? AND game = 'fyllekjoring' AND status = 'playing'").get(viewer.username)) {
      throw new HTTPException(409, { message: 'Du er allerede ute og kjører' })
    }
    const played = gift ? takeGift(viewer.username, 'fyllekjoring') : stake
    if (!gift) {
      ensureCoins(viewer, played)
      addCasinoRow(viewer.username, -played, ROUND_GAMES.fyllekjoring, 'Kjøretur')
    }
    const row: RoundRow = {
      id: randomUUID(),
      username: viewer.username,
      game: 'fyllekjoring',
      stake: played,
      payout: 0,
      status: 'playing',
      detail: gift ? JSON.stringify({ gift: true }) : '{}',
      crash: drawCrash(randomInt),
      target,
      created_at: now(),
      done_at: null,
    }
    insertRound(row)
    return toFlight(row)
  })
}

function ownRound(viewer: Viewer, id: string) {
  const row = findRound(id)
  if (!row || row.username !== viewer.username || row.game !== 'fyllekjoring') throw new HTTPException(404, { message: 'Runden finnes ikke' })
  return row
}

// Taking out: at the multiplier the car has reached by the server's clock, if it is still going
export function takeOut(viewer: Viewer, id: string) {
  return transaction(() => {
    const row = ownRound(viewer, id)
    if (row.status === 'playing') {
      const time = Date.now()
      settleIfLanded(row, time)
      const fresh = findRound(id)!
      if (fresh.status === 'playing') land(fresh, multiplierAt(time - launchedAt(fresh)), time)
    }
    return toFlight(findRound(id)!)
  })
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Waits until the round is over, at the latest when the car crashes, and tells how it went
export async function waitForLanding(viewer: Viewer, id: string) {
  const row = ownRound(viewer, id)
  if (row.status === 'playing') {
    const end = launchedAt(row) + timeAt(row.target !== null && row.target < row.crash! ? row.target : row.crash!)
    await sleep(Math.max(0, end - Date.now()))
    transaction(() => settleIfLanded(findRound(id)!))
  }
  return toFlight(findRound(id)!)
}

// A free round: the crash point comes along, since nothing is at stake, and the site drives it
export const tryFlight = () => ({ crash: drawCrash(randomInt) })

// --- Lists

// Everyone's rounds that are over before a time, for the activity log
export const roundsBefore = (until: string, limit: number) =>
  (
    db
      .prepare("SELECT * FROM flaks_rounds WHERE status = 'done' AND done_at < ? ORDER BY done_at DESC LIMIT ?")
      .all(until, limit) as unknown as RoundRow[]
  ).map(row => ({ username: row.username, round: toRound(row) }))

const roundsOf = (username: string) =>
  (
    db
      .prepare("SELECT * FROM flaks_rounds WHERE username = ? AND status = 'done' ORDER BY done_at DESC LIMIT ?")
      .all(username, DONE_SHOWN) as unknown as RoundRow[]
  ).map(toRound)

export const rounds = (viewer: Viewer) => roundsOf(viewer.username)

export function roundsOfMember(id: string) {
  const username = usernameOf(id)
  return username ? roundsOf(username) : []
}
