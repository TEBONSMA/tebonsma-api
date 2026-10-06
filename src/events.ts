import { HTTPException } from 'hono/http-exception'
import { hasOpenMarkets } from './bets.ts'
import { db } from './db.ts'
import { getMembers, type PublicMember } from './members.ts'
import type { Viewer, Visibility } from './feed.ts'

// An event is a feed post with a title, a place and a time. Everything else (who can see
// it, pictures, comments, editing and deleting) is the post's.

export type Answer = 'yes' | 'no'

export interface EventInput {
  title: string
  location: string
  // Both or neither; an event without them has no date yet
  startsAt: string | null
  endsAt: string | null
  // Whether members can bet on it on TebBet. Left out when editing: stays as it was.
  betting?: boolean
}

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    post_id   TEXT PRIMARY KEY REFERENCES feed_posts (id) ON DELETE CASCADE,
    title     TEXT NOT NULL,
    location  TEXT NOT NULL,
    starts_at TEXT,
    ends_at   TEXT,
    betting   INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS events_starts ON events (starts_at);

  CREATE TABLE IF NOT EXISTS event_rsvps (
    post_id    TEXT NOT NULL REFERENCES events (post_id) ON DELETE CASCADE,
    username   TEXT NOT NULL,
    answer     TEXT NOT NULL CHECK (answer IN ('yes', 'no')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (post_id, username)
  );
`)

// Betting came after the first events were made; they were open for it
const eventColumns = db.prepare('PRAGMA table_info(events)').all() as { name: string }[]
if (!eventColumns.some(column => column.name === 'betting')) {
  db.exec('ALTER TABLE events ADD COLUMN betting INTEGER NOT NULL DEFAULT 1')
}

interface EventRow {
  title: string
  location: string
  starts_at: string | null
  ends_at: string | null
  betting: number
}

const findEvent = (postId: string) =>
  db.prepare('SELECT title, location, starts_at, ends_at, betting FROM events WHERE post_id = ?').get(postId) as
    | EventRow
    | undefined

// Runs inside the transaction that saves the post
export function saveEvent(postId: string, input: EventInput) {
  const before = findEvent(postId)
  const betting = input.betting ?? (before ? before.betting === 1 : true)
  if (!betting && hasOpenMarkets(postId)) {
    throw new HTTPException(400, {
      message: 'Arrangementet har spill på TebBet som ikke er avgjort. Avgjør eller annuller dem der før du slår av spill.',
    })
  }

  db.prepare(`
    INSERT INTO events (post_id, title, location, starts_at, ends_at, betting) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (post_id) DO UPDATE SET
      title = excluded.title, location = excluded.location,
      starts_at = excluded.starts_at, ends_at = excluded.ends_at, betting = excluded.betting
  `).run(postId, input.title, input.location, input.startsAt, input.endsAt, betting ? 1 : 0)
}

export const isEvent = (postId: string) => !!findEvent(postId)

// Members answer whether they are coming to closed events; public ones have no sign-up
export function eventOf(postId: string, viewer: Viewer | null, visibility: Visibility) {
  const row = findEvent(postId)
  if (!row) return null

  let rsvp: { yes: number; no: number; mine: Answer | null } | null = null
  if (viewer && visibility === 'members') {
    const count = (answer: Answer) =>
      (db.prepare('SELECT COUNT(*) AS n FROM event_rsvps WHERE post_id = ? AND answer = ?').get(postId, answer) as { n: number }).n
    const mine = db.prepare('SELECT answer FROM event_rsvps WHERE post_id = ? AND username = ?').get(postId, viewer.username) as
      | { answer: Answer }
      | undefined
    rsvp = { yes: count('yes'), no: count('no'), mine: mine?.answer ?? null }
  }
  return {
    title: row.title,
    location: row.location,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    betting: row.betting === 1,
    rsvp,
  }
}

// The caller has already checked that the viewer can see the post. Passing no answer
// takes it back.
export function setRsvp(postId: string, viewer: Viewer, visibility: Visibility, answer: Answer | null) {
  const row = findEvent(postId)
  if (!row) throw new HTTPException(404, { message: 'Arrangementet finnes ikke' })
  if (visibility !== 'members') throw new HTTPException(400, { message: 'Bare lukkede arrangementer har påmelding' })
  if (row.ends_at && row.ends_at < new Date().toISOString()) throw new HTTPException(400, { message: 'Arrangementet er over' })

  if (answer === null) {
    db.prepare('DELETE FROM event_rsvps WHERE post_id = ? AND username = ?').run(postId, viewer.username)
  } else {
    db.prepare(`
      INSERT INTO event_rsvps (post_id, username, answer, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (post_id, username) DO UPDATE SET answer = excluded.answer, created_at = excluded.created_at
    `).run(postId, viewer.username, answer, new Date().toISOString())
  }
  return eventOf(postId, viewer, visibility)!.rsvp
}

export async function listRsvps(postId: string, visibility: Visibility): Promise<Record<Answer, PublicMember[]>> {
  if (!findEvent(postId)) throw new HTTPException(404, { message: 'Arrangementet finnes ikke' })
  if (visibility !== 'members') return { yes: [], no: [] }

  const rows = db.prepare('SELECT username, answer FROM event_rsvps WHERE post_id = ? ORDER BY created_at').all(postId) as {
    username: string
    answer: Answer
  }[]
  const members = await getMembers(rows.map(row => row.username))
  const answered = (answer: Answer) => rows.filter(row => row.answer === answer).map(row => members.get(row.username)!)
  return { yes: answered('yes'), no: answered('no') }
}
