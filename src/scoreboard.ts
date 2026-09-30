import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.ts'

export const LEADERBOARD_SIZE = 5

// The run ticket is issued a moment after the game actually starts
const SLACK_SECONDS = 4
const RUN_TTL_MS = 3 * 60 * 60 * 1000
const MAX_OPEN_RUNS_PER_USER = 5

// 2048 has no clock of its own, so assume nobody makes more moves than this
const MAX_2048_MOVES_PER_SECOND = 15

// The highest score each game can reach in a given number of seconds. It only has to be
// an upper bound: the point is to reject impossible scores, not to judge good ones.
const GAMES: Record<string, { maxScore: (seconds: number) => number }> = {
  // 60 updates a second and a pipe at most every 100 updates
  'flappy-teb': { maxScore: seconds => seconds * 0.6 },
  // A move at most every 8 frames at 60 a second, and a move eats at most one bottle
  'snake-teb': { maxScore: seconds => seconds * 7.5 },
  // Every move adds one tile worth at most 4, and a board whose tiles add up to T cannot
  // have earned more than T * (log2(T) - 1) points from merging
  '2048-teb': {
    maxScore: seconds => {
      const total = 4 * (seconds * MAX_2048_MOVES_PER_SECOND + 2)
      return total * (Math.log2(total) - 1)
    },
  },
}

export const isGame = (game: string) => Object.hasOwn(GAMES, game)

export class ScoreRejected extends Error {}

mkdirSync(config.dataDir, { recursive: true })
const db = new DatabaseSync(join(config.dataDir, 'tebonsma.db'))
db.exec(`
  CREATE TABLE IF NOT EXISTS game_scores (
    game         TEXT NOT NULL,
    username     TEXT NOT NULL,
    display_name TEXT NOT NULL,
    score        INTEGER NOT NULL,
    achieved_at  TEXT NOT NULL,
    PRIMARY KEY (game, username)
  );
  CREATE INDEX IF NOT EXISTS game_scores_rank ON game_scores (game, score DESC, achieved_at ASC);
`)

// Flappy was the first game and had a table of its own; carry those scores over once
if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'flappy_scores'").get()) {
  db.exec(`
    BEGIN;
    INSERT OR IGNORE INTO game_scores (game, username, display_name, score, achieved_at)
      SELECT 'flappy-teb', username, display_name, score, achieved_at FROM flappy_scores;
    DROP TABLE flappy_scores;
    COMMIT;
  `)
}

// Run tickets live in memory; a restart only means runs in progress can't be submitted
const runs = new Map<string, { game: string; username: string; startedAt: number }>()

export function startRun(game: string, username: string) {
  const now = Date.now()
  const own: string[] = []
  for (const [id, run] of runs) {
    if (now - run.startedAt > RUN_TTL_MS) runs.delete(id)
    else if (run.username === username) own.push(id)
  }
  // Map order is insertion order, so the first ones are the oldest
  for (const id of own.slice(0, Math.max(0, own.length - MAX_OPEN_RUNS_PER_USER + 1))) runs.delete(id)

  const id = randomUUID()
  runs.set(id, { game, username, startedAt: now })
  return id
}

export function submitScore(game: string, username: string, displayName: string, runId: string, score: number) {
  const run = runs.get(runId)
  if (!run || run.username !== username || run.game !== game) {
    throw new ScoreRejected('Ukjent eller allerede brukt runde')
  }
  runs.delete(runId)

  const seconds = (Date.now() - run.startedAt) / 1000 + SLACK_SECONDS
  if (score > Math.floor(GAMES[game].maxScore(seconds))) {
    throw new ScoreRejected('Poengsummen er ikke mulig på så kort tid')
  }
  if (score === 0) return false

  const current = db.prepare('SELECT score FROM game_scores WHERE game = ? AND username = ?').get(game, username) as
    | { score: number }
    | undefined
  const newBest = !current || score > current.score
  if (newBest) {
    db.prepare(`
      INSERT INTO game_scores (game, username, display_name, score, achieved_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (game, username) DO UPDATE SET
        display_name = excluded.display_name, score = excluded.score, achieved_at = excluded.achieved_at
    `).run(game, username, displayName, score, new Date().toISOString())
  } else {
    // Keep the shown name current even when the run wasn't a record
    db.prepare('UPDATE game_scores SET display_name = ? WHERE game = ? AND username = ?').run(displayName, game, username)
  }
  return newBest
}

export function getLeaderboard(game: string, username: string) {
  const top = db
    .prepare(
      `SELECT username, display_name, score, achieved_at FROM game_scores
       WHERE game = ? ORDER BY score DESC, achieved_at ASC LIMIT ?`,
    )
    .all(game, LEADERBOARD_SIZE) as { username: string; display_name: string; score: number; achieved_at: string }[]

  const mine = db.prepare('SELECT score, achieved_at FROM game_scores WHERE game = ? AND username = ?').get(game, username) as
    | { score: number; achieved_at: string }
    | undefined
  const ahead = mine
    ? (db
        .prepare(
          `SELECT COUNT(*) AS n FROM game_scores
           WHERE game = ? AND (score > ? OR (score = ? AND achieved_at < ?))`,
        )
        .get(game, mine.score, mine.score, mine.achieved_at) as { n: number })
    : null

  return {
    // Other members are only shown by display name, never by username
    top: top.map(row => ({
      name: row.display_name,
      score: row.score,
      date: row.achieved_at,
      isYou: row.username === username,
    })),
    you: mine && ahead ? { score: mine.score, date: mine.achieved_at, rank: ahead.n + 1 } : null,
  }
}
