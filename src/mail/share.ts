import { randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { db, transaction } from '../db.ts'
import { createPost, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, saveAttachment, type Viewer, type Visibility } from '../feed.ts'
import { findByMemberId, getMembers } from '../members.ts'
import type { Account, Address } from './backend.ts'
import { MAX_POST_LENGTH } from '../feedRoutes.ts'
import { safeMime, snapshotMessage, type MessageSummary } from './mail.ts'
import { toText } from './html.ts'
import { addShareNotice } from './notifications.ts'

// Sharing a mail takes a copy of it, which lives in the API's database. The API can't write in
// anyone else's mailbox, so the member it is shared with sees the copy under "Delt med meg" and
// not as a mail of their own. Only the copy leaves the sender's mailbox.
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_shares (
    id         TEXT PRIMARY KEY,
    recipient  TEXT NOT NULL,
    sharer     TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    subject    TEXT NOT NULL,
    headers    TEXT NOT NULL,
    html       TEXT NOT NULL,
    text       TEXT NOT NULL,
    seen       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mail_shares_recipient ON mail_shares (recipient, created_at DESC);

  CREATE TABLE IF NOT EXISTS mail_share_files (
    share_id TEXT NOT NULL REFERENCES mail_shares (id) ON DELETE CASCADE,
    n        INTEGER NOT NULL,
    name     TEXT NOT NULL,
    mime     TEXT NOT NULL,
    size     INTEGER NOT NULL,
    data     BLOB NOT NULL,
    PRIMARY KEY (share_id, n)
  );
`)

const MAX_NOTE_LENGTH = 500
const MAX_SHARES_PER_HOUR = 30
const MAX_SHARED_BYTES = 25 * 1024 * 1024
const HOUR_MS = 60 * 60 * 1000

export const readNote = (raw: unknown) => {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') throw new HTTPException(400, { message: 'Notatet må være tekst' })
  const note = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  if (note.length > MAX_NOTE_LENGTH) throw new HTTPException(400, { message: `Notatet kan ikke være lengre enn ${MAX_NOTE_LENGTH} tegn` })
  return note
}

interface Headers {
  from: Address | null
  to: Address[]
  cc: Address[]
  date: string
}

// --- Sharing with a member ---

export async function shareWithMember(account: Account, sharer: string, id: string, memberId: string, note: string) {
  const recipient = findByMemberId(memberId)
  if (!recipient) throw new HTTPException(404, { message: 'Medlemmet finnes ikke' })
  if (recipient === sharer) throw new HTTPException(400, { message: 'Du kan ikke dele en mail med deg selv' })

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM mail_shares WHERE sharer = ? AND created_at >= ?').get(
    sharer,
    new Date(Date.now() - HOUR_MS).toISOString(),
  ) as { n: number }
  if (n >= MAX_SHARES_PER_HOUR) throw new HTTPException(429, { message: 'Du har delt mange mails den siste timen. Prøv igjen senere.' })

  const snapshot = await snapshotMessage(account, id)
  if (snapshot.files.reduce((sum, file) => sum + file.content.length, 0) > MAX_SHARED_BYTES) {
    throw new HTTPException(413, { message: 'Vedleggene er til sammen større enn 25 MB' })
  }

  const shareId = randomUUID()
  const headers: Headers = { from: snapshot.from, to: snapshot.to, cc: snapshot.cc, date: snapshot.date }
  transaction(() => {
    db.prepare(
      'INSERT INTO mail_shares (id, recipient, sharer, note, subject, headers, html, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(shareId, recipient, sharer, note, snapshot.subject, JSON.stringify(headers), snapshot.html, snapshot.text, new Date().toISOString())
    snapshot.files.forEach((file, index) => {
      db.prepare('INSERT INTO mail_share_files (share_id, n, name, mime, size, data) VALUES (?, ?, ?, ?, ?, ?)').run(
        shareId,
        index,
        file.name,
        file.mime,
        file.content.length,
        file.content,
      )
    })
  })

  const [name] = [...(await getMembers([sharer])).values()].map(member => member.name)
  addShareNotice(recipient, { shareId, sharer, sharerName: name ?? '', subject: snapshot.subject })
}

// --- What the member it was shared with sees ---

interface ShareRow {
  id: string
  sharer: string
  note: string
  subject: string
  headers: string
  html: string
  text: string
  seen: number
  created_at: string
}

export interface SharedFilter {
  unread?: boolean
  q?: string
}

const attachmentCount = db.prepare('SELECT COUNT(*) AS n FROM mail_share_files WHERE share_id = ?')

// Shared mails listed the way the folders list mail, so the same list shows them
export async function listShared(owner: string, offset: number, limit: number, sort: 'new' | 'old', filter: SharedFilter) {
  const where = ['recipient = ?']
  const params: (string | number)[] = [owner]
  if (filter.unread) where.push('seen = 0')
  if (filter.q) {
    where.push("(subject LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')")
    const like = `%${filter.q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`
    params.push(like, like, like)
  }
  const rows = db
    .prepare(`SELECT * FROM mail_shares WHERE ${where.join(' AND ')} ORDER BY created_at ${sort === 'old' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`)
    .all(...params, limit + 1, offset) as unknown as ShareRow[]
  const page = rows.slice(0, limit)
  const sharers = await getMembers(page.map(row => row.sharer))

  const messages: MessageSummary[] = page.map(row => {
    const sharer = sharers.get(row.sharer)
    const person: Address = { name: sharer?.name ?? 'Medlem', address: '' }
    const headers = JSON.parse(row.headers) as Headers
    const files = (attachmentCount.get(row.id) as { n: number }).n
    return {
      id: row.id,
      messageId: null,
      ids: [row.id],
      count: 1,
      unreadCount: row.seen ? 0 : 1,
      participants: [person],
      folder: 'shared',
      from: person,
      to: headers.to,
      subject: row.subject,
      preview: row.note || row.text.replace(/\s+/g, ' ').trim().slice(0, 140),
      date: row.created_at,
      seen: row.seen === 1,
      flagged: false,
      answered: false,
      forwarded: false,
      hasAttachments: files > 0,
      labels: [],
      size: row.html.length,
    }
  })
  return { messages, nextOffset: rows.length > limit ? offset + limit : null, total: offset + rows.length }
}

export function countShared(owner: string) {
  const row = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(seen = 0), 0) AS unseen FROM mail_shares WHERE recipient = ?').get(owner) as {
    total: number
    unseen: number
  }
  return { total: row.total, unseen: row.unseen }
}

function findShare(owner: string, id: string) {
  const row = db.prepare('SELECT * FROM mail_shares WHERE id = ? AND recipient = ?').get(id, owner) as unknown as ShareRow | undefined
  if (!row) throw new HTTPException(404, { message: 'Mailen finnes ikke lenger' })
  return row
}

// Opening it reads it
export async function readShared(owner: string, id: string) {
  const row = findShare(owner, id)
  db.prepare('UPDATE mail_shares SET seen = 1 WHERE id = ?').run(id)
  const headers = JSON.parse(row.headers) as Headers
  const files = db.prepare('SELECT n, name, mime, size FROM mail_share_files WHERE share_id = ? ORDER BY n').all(id) as unknown as {
    n: number
    name: string
    mime: string
    size: number
  }[]
  const sharer = (await getMembers([row.sharer])).get(row.sharer) ?? null
  return {
    id: row.id,
    sharedBy: sharer,
    sharedAt: row.created_at,
    note: row.note,
    subject: row.subject,
    ...headers,
    html: row.html,
    text: row.text,
    attachments: files,
  }
}

export function readSharedFile(owner: string, id: string, n: number) {
  findShare(owner, id)
  const file = db.prepare('SELECT name, mime, data FROM mail_share_files WHERE share_id = ? AND n = ?').get(id, n) as
    | { name: string; mime: string; data: Uint8Array }
    | undefined
  if (!file) throw new HTTPException(404, { message: 'Vedlegget finnes ikke' })
  return { name: file.name, mime: safeMime(file.mime), content: Buffer.from(file.data) }
}

export function deleteShared(owner: string, ids: string[]) {
  for (const id of ids) db.prepare('DELETE FROM mail_shares WHERE id = ? AND recipient = ?').run(id, owner)
}

// --- Sharing to the feed ---

export interface FeedShare {
  comment: string
  visibility: Visibility
}

const quoteLine = (line: string) => (line ? `> ${line}` : '>')
const person = (a: Address | null) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : 'ukjent avsender')

// The feed is plain text, so the mail is quoted under the member's comment, cut to what a post can hold.
// Its files are copied as far as the feed's own limits allow, and the ones left out are named.
export async function shareToFeed(account: Account, viewer: Viewer, id: string, share: FeedShare) {
  const snapshot = await snapshotMessage(account, id)
  const body = toText(snapshot.html) || snapshot.text

  const header = [`Fra: ${person(snapshot.from)}`, `Emne: ${snapshot.subject || '(uten emne)'}`, `Dato: ${new Date(snapshot.date).toLocaleString('nb')}`]
  const quoted = [...header, '', ...body.split('\n')].map(quoteLine)
  const lead = share.comment ? `${share.comment}\n\n` : ''
  const room = MAX_POST_LENGTH - lead.length
  let text = quoted.join('\n')
  if (text.length > room) text = `${text.slice(0, Math.max(0, room - 2)).trimEnd()} …`

  const attachmentIds: string[] = []
  const skipped: string[] = []
  for (const file of snapshot.files) {
    if (attachmentIds.length >= MAX_ATTACHMENTS || file.content.length > MAX_ATTACHMENT_BYTES) {
      skipped.push(file.name)
      continue
    }
    try {
      attachmentIds.push(saveAttachment(viewer, { name: file.name, type: file.mime, bytes: new Uint8Array(file.content) }).id)
    } catch {
      skipped.push(file.name)
    }
  }

  const post = await createPost(viewer, { body: `${lead}${text}`, visibility: share.visibility, attachmentIds, event: null }, null)
  return { post, skipped }
}
