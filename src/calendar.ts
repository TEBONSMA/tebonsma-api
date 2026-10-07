import { randomBytes } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { config } from './config.ts'
import { db } from './db.ts'
import { listEvents, type Post, type Viewer } from './feed.ts'
import { getProfile } from './lldap.ts'

// The calendar as an iCalendar feed that Google Calendar, Apple Calendar and Outlook
// subscribe to and fetch again on their own, so new and changed events show up by themselves.
// Calendar apps can't log in, so a member's feed is opened by a secret in its address.

db.exec(`
  CREATE TABLE IF NOT EXISTS calendar_tokens (
    username   TEXT PRIMARY KEY,
    token      TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
`)

const pathOf = (token: string) => `/calendar/${token}.ics`

function newToken(username: string) {
  const token = randomBytes(24).toString('base64url')
  db.prepare(`
    INSERT INTO calendar_tokens (username, token, created_at) VALUES (?, ?, ?)
    ON CONFLICT (username) DO UPDATE SET token = excluded.token, created_at = excluded.created_at
  `).run(username, token, new Date().toISOString())
  return token
}

// Where the member's own feed is, made the first time it is asked for
export function calendarPath(username: string) {
  const row = db.prepare('SELECT token FROM calendar_tokens WHERE username = ?').get(username) as { token: string } | undefined
  return pathOf(row?.token ?? newToken(username))
}

// A new address, for when the old one has got out. Calendars using the old one stop updating.
export const resetCalendarPath = (username: string) => pathOf(newToken(username))

// Checking with LLDAP that the member is still one, but not on every fetch
const MEMBER_CHECK_MS = 10 * 60 * 1000
const checkedAt = new Map<string, number>()

export async function calendarViewer(token: string): Promise<Viewer> {
  const row = db.prepare('SELECT username FROM calendar_tokens WHERE token = ?').get(token) as { username: string } | undefined
  if (!row) throw new HTTPException(404, { message: 'Kalenderen finnes ikke' })

  if (Date.now() - (checkedAt.get(row.username) ?? 0) > MEMBER_CHECK_MS) {
    try {
      await getProfile(row.username)
    } catch (err) {
      // Gone from LLDAP or LLDAP is down. Either way the calendar app keeps what it has.
      console.error(`Could not check calendar owner ${row.username}:`, err)
      throw new HTTPException(503, { message: 'Kalenderen er ikke tilgjengelig' })
    }
    checkedAt.set(row.username, Date.now())
  }
  return { username: row.username, admin: false }
}

// Older events fall out of the feed, which keeps it short and inside the limit on listed events
const KEPT_MS = 365 * 24 * 60 * 60 * 1000
// A line in an iCalendar file is at most 75 bytes, not counting the line break
const MAX_LINE_BYTES = 75

// 2026-10-04T18:00:00.000Z becomes 20261004T180000Z
const utcStamp = (time: string) =>
  new Date(time)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')

const escapeText = (text: string) =>
  text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')

// Long lines continue on the next one after a space, and are never split inside a character
function fold(line: string) {
  const lines: string[] = []
  let current = ''
  let bytes = 0

  for (const char of line) {
    const size = Buffer.byteLength(char)
    if (bytes + size > MAX_LINE_BYTES) {
      lines.push(current)
      current = ' '
      bytes = 1
    }
    current += char
    bytes += size
  }

  lines.push(current)
  return lines.join('\r\n')
}

function toVevent(post: Post) {
  const event = post.event
  if (!event?.startsAt || !event.endsAt) return []

  const url = `${config.siteUrl}/feed/${post.id}`
  const changed = utcStamp(post.editedAt ?? post.createdAt)
  return [
    'BEGIN:VEVENT',
    // The same as in the files the site makes, so an event imported from one isn't doubled
    `UID:${post.id}@tebonsma.no`,
    `DTSTAMP:${changed}`,
    `LAST-MODIFIED:${changed}`,
    `DTSTART:${utcStamp(event.startsAt)}`,
    `DTEND:${utcStamp(event.endsAt)}`,
    `SUMMARY:${escapeText(event.title)}`,
    `DESCRIPTION:${escapeText([post.body.trim(), url].filter(Boolean).join('\n\n'))}`,
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    `URL:${url}`,
    'END:VEVENT',
  ]
}

// The dated events the viewer can see. Visitors get the public ones.
export async function calendarFeed(viewer: Viewer | null) {
  const posts = await listEvents(viewer, new Date(Date.now() - KEPT_MS).toISOString(), null)
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TEBONSMA//tebonsma.no//NO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:TEBONSMA',
    // How often calendar apps are asked to look again. Google decides for itself.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...posts.flatMap(toVevent),
    'END:VCALENDAR',
  ]
    .map(fold)
    .join('\r\n')
    .concat('\r\n')
}
