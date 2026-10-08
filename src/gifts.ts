import { HTTPException } from 'hono/http-exception'
import { db } from './db.ts'
import { pushToAll } from './push.ts'

// Rounds on the house ("på huset"): plays of a casino game a member gets for nothing, at a set
// stake, with what they win theirs to keep. Given for a reason, once per member and game: so far
// the launch of Sponsorjakten and Fyllekjøring, ten of each at 25 coins.

export type GiftGame = 'sponsorjakten' | 'fyllekjoring'

db.exec(`
  CREATE TABLE IF NOT EXISTS casino_gifts (
    username   TEXT NOT NULL,
    game       TEXT NOT NULL,
    reason     TEXT NOT NULL,
    stake      INTEGER NOT NULL,
    plays      INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (username, game, reason)
  );
  CREATE TABLE IF NOT EXISTS push_checks (
    name       TEXT PRIMARY KEY,
    checked_at TEXT NOT NULL
  );
`)

const LAUNCH = { reason: 'lansering', stake: 25, plays: 10, games: ['sponsorjakten', 'fyllekjoring'] as GiftGame[] }

// Gives the member the rounds they have coming and don't have yet: everyone gets the launch's,
// also members who first open TebBet later. Safe to call any number of times.
export function giveGifts(username: string) {
  const add = db.prepare('INSERT OR IGNORE INTO casino_gifts (username, game, reason, stake, plays, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  for (const game of LAUNCH.games) add.run(username, game, LAUNCH.reason, LAUNCH.stake, LAUNCH.plays, new Date().toISOString())
}

// What the member has left on the house in each game: how many plays, and at what stake
export function giftsOf(username: string) {
  const rows = db
    .prepare('SELECT game, stake, plays - used AS left FROM casino_gifts WHERE username = ? AND used < plays ORDER BY created_at')
    .all(username) as { game: GiftGame; stake: number; left: number }[]
  const gifts: Partial<Record<GiftGame, { left: number; stake: number }>> = {}
  for (const row of rows) gifts[row.game] ??= { left: 0, stake: row.stake }
  for (const row of rows) gifts[row.game]!.left += row.left
  return gifts
}

// Takes one play on the house of a game, the oldest gift first, and gives its stake. Call inside a
// transaction with the play.
export function takeGift(username: string, game: GiftGame) {
  const gift = db
    .prepare('SELECT reason, stake FROM casino_gifts WHERE username = ? AND game = ? AND used < plays ORDER BY created_at LIMIT 1')
    .get(username, game) as { reason: string; stake: number } | undefined
  if (!gift) throw new HTTPException(400, { message: 'Du har ingen runder på huset igjen' })
  db.prepare('UPDATE casino_gifts SET used = used + 1 WHERE username = ? AND game = ? AND reason = ?').run(username, game, gift.reason)
  return gift.stake
}

// Once, when the games come out: a push to everyone with notifications on in TebBet
export function announceLaunch() {
  const first = db.prepare('INSERT OR IGNORE INTO push_checks (name, checked_at) VALUES (?, ?)').run('casino-launch', new Date().toISOString())
  if (first.changes === 0) return
  pushToAll('tebbet', '', {
    title: 'To nye spill på TebBet',
    body: `Sponsorjakten og Fyllekjøring er ute, og du har ${LAUNCH.plays} runder på huset i hvert av dem.`,
    url: '/',
    tag: 'casino-launch',
  })
}
