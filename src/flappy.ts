import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.ts'

export const LEADERBOARD_SIZE = 5

// The game runs 60 updates a second and spawns a pipe every 100 updates, so a point takes
// at least 100/60 seconds. The slack covers the delay before the run ticket is issued.
const MAX_POINTS_PER_SECOND = 60 / 100
const SLACK_POINTS = 2
const RUN_TTL_MS = 3 * 60 * 60 * 1000
const MAX_OPEN_RUNS_PER_USER = 5

export class ScoreRejected extends Error {}

mkdirSync(config.dataDir, { recursive: true })
const db = new DatabaseSync(join(config.dataDir, 'tebonsma.db'))
db.exec(`
  CREATE TABLE IF NOT EXISTS flappy_scores (
    username     TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    score        INTEGER NOT NULL,
    achieved_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS flappy_scores_rank ON flappy_scores (score DESC, achieved_at ASC);
`)

// Run tickets live in memory; a restart only means runs in progress can't be submitted
const runs = new Map<string, { username: string; startedAt: number }>()

export function startRun(username: string) {
  const now = Date.now()
  const own: string[] = []
  for (const [id, run] of runs) {
    if (now - run.startedAt > RUN_TTL_MS) runs.delete(id)
    else if (run.username === username) own.push(id)
  }
  // Map order is insertion order, so the first ones are the oldest
  for (const id of own.slice(0, Math.max(0, own.length - MAX_OPEN_RUNS_PER_USER + 1))) runs.delete(id)

  const id = randomUUID()
  runs.set(id, { username, startedAt: now })
  return id
}

export function submitScore(username: string, displayName: string, runId: string, score: number) {
  const run = runs.get(runId)
  if (!run || run.username !== username) throw new ScoreRejected('Ukjent eller allerede brukt runde')
  runs.delete(runId)

  const seconds = (Date.now() - run.startedAt) / 1000
  if (score > Math.floor(seconds * MAX_POINTS_PER_SECOND) + SLACK_POINTS) {
    throw new ScoreRejected('Poengsummen er ikke mulig på så kort tid')
  }
  if (score === 0) return false

  const current = db.prepare('SELECT score FROM flappy_scores WHERE username = ?').get(username) as
    | { score: number }
    | undefined
  const newBest = !current || score > current.score
  if (newBest) {
    db.prepare(`
      INSERT INTO flappy_scores (username, display_name, score, achieved_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (username) DO UPDATE SET
        display_name = excluded.display_name, score = excluded.score, achieved_at = excluded.achieved_at
    `).run(username, displayName, score, new Date().toISOString())
  } else {
    // Keep the shown name current even when the run wasn't a record
    db.prepare('UPDATE flappy_scores SET display_name = ? WHERE username = ?').run(displayName, username)
  }
  return newBest
}

export function getLeaderboard(username: string) {
  const top = db
    .prepare(
      `SELECT username, display_name, score, achieved_at FROM flappy_scores
       ORDER BY score DESC, achieved_at ASC LIMIT ?`,
    )
    .all(LEADERBOARD_SIZE) as { username: string; display_name: string; score: number; achieved_at: string }[]

  const mine = db.prepare('SELECT score, achieved_at FROM flappy_scores WHERE username = ?').get(username) as
    | { score: number; achieved_at: string }
    | undefined
  const ahead = mine
    ? (db
        .prepare(
          `SELECT COUNT(*) AS n FROM flappy_scores
           WHERE score > ? OR (score = ? AND achieved_at < ?)`,
        )
        .get(mine.score, mine.score, mine.achieved_at) as { n: number })
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
