import { randomUUID } from 'node:crypto'
import { db } from '../db.ts'
import { findMemberByEmail, getMembers, type PublicMember } from '../members.ts'
import { backend, type Account } from './backend.ts'
import { encodeId } from './mail.ts'

// Notifications about mail. They live here rather than with the feed's, whose table only
// allows the kinds the feed makes.
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_notifications (
    id         TEXT PRIMARY KEY,
    recipient  TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('mail', 'mail_share', 'mail_failed')),
    mail_id    TEXT,
    -- The Message-ID the notification is about, so the same mail is only announced once
    message_key TEXT,
    sender     TEXT NOT NULL DEFAULT '',
    actor      TEXT,
    excerpt    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    read_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS mail_notifications_recipient ON mail_notifications (recipient, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS mail_notifications_once ON mail_notifications (recipient, kind, message_key) WHERE message_key IS NOT NULL;
`)

// A mail that was sent (or scheduled) in the member's name never left. It is kept in Drafts.
export function addFailure(recipient: string, subject: string) {
  db.prepare(
    "INSERT INTO mail_notifications (id, recipient, kind, excerpt, created_at) VALUES (?, ?, 'mail_failed', ?, ?)",
  ).run(randomUUID(), recipient, subject || '(uten emne)', new Date().toISOString())
}

// Tells the member about a mail in their inbox. A mail that has been announced before is skipped.
export function addMailNotice(
  recipient: string,
  notice: { mailId: string; messageKey: string; sender: string; subject: string; actor?: string | null },
) {
  db.prepare(
    `INSERT OR IGNORE INTO mail_notifications (id, recipient, kind, mail_id, message_key, sender, actor, excerpt, created_at)
     VALUES (?, ?, 'mail', ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    recipient,
    notice.mailId,
    notice.messageKey,
    notice.sender,
    notice.actor ?? null,
    notice.subject || '(uten emne)',
    new Date().toISOString(),
  )
}

// --- New mail in the inbox ---

// The inbox is looked at every so often for mail that has arrived since last time. Only mail that
// is still unread is announced, and only the newest few, so a long unread backlog doesn't flood the bell.
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_inbox_state (
    owner        TEXT PRIMARY KEY,
    uid_validity INTEGER NOT NULL,
    uid_next     INTEGER NOT NULL
  );
`)

const CHECK_MS = 30_000
const MAX_NEW_NOTICES = 20
const checked = new Map<string, { at: number; unseen: number }>()

// After something changed in the inbox here, the count is worked out again at the next look
export const forgetInboxCount = (owner: string) => checked.delete(owner)

// How many mails in the inbox are unread, after announcing the ones that came since last time
export async function checkInbox(account: Account, owner: string): Promise<number> {
  const hit = checked.get(owner)
  if (hit && Date.now() - hit.at < CHECK_MS) return hit.unseen

  const status = await backend().status(account, 'INBOX')
  const state = db.prepare('SELECT uid_validity, uid_next FROM mail_inbox_state WHERE owner = ?').get(owner) as
    | { uid_validity: number; uid_next: number }
    | undefined

  // The first look only notes where the inbox is, so what was there before isn't announced
  if (state && state.uid_validity === status.uidValidity && status.uidNext > state.uid_next) {
    const unseen = await backend().search(account, 'INBOX', { unseen: true })
    const fresh = unseen.filter(uid => uid >= state.uid_next).slice(-MAX_NEW_NOTICES)
    for (const head of await backend().heads(account, 'INBOX', fresh)) {
      if (!head.messageId) continue
      const actor = head.from ? await findMemberByEmail(head.from.address).catch(() => null) : null
      addMailNotice(owner, {
        mailId: encodeId({ path: 'INBOX', uidValidity: status.uidValidity }, head.uid),
        messageKey: head.messageId,
        sender: head.from?.name || head.from?.address || '',
        subject: head.subject,
        actor,
      })
    }
  }
  if (!state || state.uid_validity !== status.uidValidity || status.uidNext !== state.uid_next) {
    db.prepare(
      `INSERT INTO mail_inbox_state (owner, uid_validity, uid_next) VALUES (?, ?, ?)
       ON CONFLICT (owner) DO UPDATE SET uid_validity = excluded.uid_validity, uid_next = excluded.uid_next`,
    ).run(owner, status.uidValidity, status.uidNext)
  }
  checked.set(owner, { at: Date.now(), unseen: status.unseen })
  return status.unseen
}

// --- What the bell shows ---

const NOTIFICATIONS_SHOWN = 30

export interface MailNotification {
  id: string
  kind: 'mail' | 'mail_share' | 'mail_failed'
  // A member the mail is from or was shared by. Without one the bell shows a mail icon and sender names the person.
  actor: PublicMember | null
  sender: string
  postId: null
  commentId: null
  mailId: string | null
  excerpt: string
  createdAt: string
  read: boolean
}

interface NotificationRow {
  id: string
  kind: MailNotification['kind']
  mail_id: string | null
  sender: string
  actor: string | null
  excerpt: string
  created_at: string
  read_at: string | null
}

export async function listMailNotifications(owner: string) {
  const rows = db
    .prepare(
      `SELECT id, kind, mail_id, sender, actor, excerpt, created_at, read_at FROM mail_notifications
       WHERE recipient = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(owner, NOTIFICATIONS_SHOWN) as unknown as NotificationRow[]
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM mail_notifications WHERE recipient = ? AND read_at IS NULL').get(owner) as { n: number }
  const actors = await getMembers(rows.flatMap(row => (row.actor ? [row.actor] : [])))

  const items: MailNotification[] = rows.map(row => ({
    id: row.id,
    kind: row.kind,
    actor: row.actor ? (actors.get(row.actor) ?? null) : null,
    sender: row.sender,
    postId: null,
    commentId: null,
    mailId: row.mail_id,
    excerpt: row.excerpt,
    createdAt: row.created_at,
    read: row.read_at !== null,
  }))
  return { unread: n, items }
}

// Without ids, everything is marked as read
export function markMailNotificationsRead(owner: string, ids: string[] | null) {
  const now = new Date().toISOString()
  if (ids === null) {
    db.prepare('UPDATE mail_notifications SET read_at = ? WHERE recipient = ? AND read_at IS NULL').run(now, owner)
    return
  }
  for (const id of ids) {
    db.prepare('UPDATE mail_notifications SET read_at = ? WHERE id = ? AND recipient = ? AND read_at IS NULL').run(now, id, owner)
  }
}

// Opening a mail reads its notification, wherever the mail has been moved to since
export function markMailOpened(owner: string, mails: { id: string; messageId: string | null }[]) {
  forgetInboxCount(owner)
  const now = new Date().toISOString()
  for (const mail of mails) {
    db.prepare(
      'UPDATE mail_notifications SET read_at = ? WHERE recipient = ? AND read_at IS NULL AND (mail_id = ? OR (message_key IS NOT NULL AND message_key = ?))',
    ).run(now, owner, mail.id, mail.messageId ?? '')
  }
}
