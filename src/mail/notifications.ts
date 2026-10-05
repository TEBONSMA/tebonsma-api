import { randomUUID } from 'node:crypto'
import { db } from '../db.ts'

// Notifications about mail. They live here rather than with the feed's, whose table only
// allows the kinds the feed makes.
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_notifications (
    id         TEXT PRIMARY KEY,
    recipient  TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('mail', 'mail_share', 'mail_failed')),
    mail_id    TEXT,
    sender     TEXT NOT NULL DEFAULT '',
    actor      TEXT,
    excerpt    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    read_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS mail_notifications_recipient ON mail_notifications (recipient, created_at DESC);
`)

// A mail that was sent (or scheduled) in the member's name never left. It is kept in Drafts.
export function addFailure(recipient: string, subject: string) {
  db.prepare(
    "INSERT INTO mail_notifications (id, recipient, kind, excerpt, created_at) VALUES (?, ?, 'mail_failed', ?, ?)",
  ).run(randomUUID(), recipient, subject || '(uten emne)', new Date().toISOString())
}
