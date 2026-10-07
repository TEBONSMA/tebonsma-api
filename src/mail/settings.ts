import { HTTPException } from 'hono/http-exception'
import { db } from '../db.ts'
import { sanitizeCompose } from './html.ts'

// How each member wants their mail: the signature added to new mails, how long sending can be
// taken back, and whether mails of one conversation are listed together
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_settings (
    owner         TEXT PRIMARY KEY,
    signature     TEXT NOT NULL DEFAULT '',
    undo_seconds  INTEGER NOT NULL DEFAULT 10,
    conversations INTEGER NOT NULL DEFAULT 1
  );
`)

export const UNDO_CHOICES = [0, 5, 10, 30]
export const MAX_SIGNATURE_LENGTH = 2000

export interface MailSettings {
  // HTML, cleaned the same way as what is written in the editor
  signature: string
  undoSeconds: number
  conversations: boolean
}

export function getSettings(owner: string): MailSettings {
  const row = db.prepare('SELECT signature, undo_seconds, conversations FROM mail_settings WHERE owner = ?').get(owner) as
    | { signature: string; undo_seconds: number; conversations: number }
    | undefined
  return row
    ? { signature: row.signature, undoSeconds: row.undo_seconds, conversations: row.conversations === 1 }
    : { signature: '', undoSeconds: 10, conversations: true }
}

export function saveSettings(owner: string, input: Record<string, unknown>): MailSettings {
  const { signature, undoSeconds, conversations } = input
  if (typeof signature !== 'string' || signature.length > MAX_SIGNATURE_LENGTH * 4) {
    throw new HTTPException(400, { message: 'Ugyldig signatur' })
  }
  if (typeof undoSeconds !== 'number' || !UNDO_CHOICES.includes(undoSeconds)) {
    throw new HTTPException(400, { message: 'Velg 0, 5, 10 eller 30 sekunder' })
  }
  if (typeof conversations !== 'boolean') throw new HTTPException(400, { message: 'Ugyldig forespørsel' })

  const clean = sanitizeCompose(signature)
  if (clean.length > MAX_SIGNATURE_LENGTH) throw new HTTPException(400, { message: 'Signaturen er for lang' })
  db.prepare(
    `INSERT INTO mail_settings (owner, signature, undo_seconds, conversations) VALUES (?, ?, ?, ?)
     ON CONFLICT (owner) DO UPDATE SET signature = excluded.signature, undo_seconds = excluded.undo_seconds, conversations = excluded.conversations`,
  ).run(owner, clean, undoSeconds, conversations ? 1 : 0)
  return getSettings(owner)
}
