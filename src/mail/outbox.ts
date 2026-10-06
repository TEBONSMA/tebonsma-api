import { randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { db } from '../db.ts'
import { backend, type Account } from './backend.ts'
import { buildMessage, deleteDraft, saveDraft, type ComposeInput } from './compose.ts'
import { ANSWERED, FORWARDED, markOriginals } from './actions.ts'
import { ensureFolder, openMailbox } from './mail.ts'
import { addFailure } from './notifications.ts'
import { getSettings } from './settings.ts'
import { deleteUploads } from './uploads.ts'

// Sending waits a few seconds so it can be taken back. The mail is kept in Drafts meanwhile,
// so if the API is restarted before it goes out, it is still there instead of being lost or
// sent twice.

export const MAX_SENDS_PER_HOUR = 60
const HOUR_MS = 60 * 60 * 1000

db.exec(`
  CREATE TABLE IF NOT EXISTS mail_sent_log (
    id      TEXT PRIMARY KEY,
    owner   TEXT NOT NULL,
    sent_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mail_sent_log_owner ON mail_sent_log (owner, sent_at);
`)

// Counts a send against the member's hour, or refuses when they have used it up
export function reserveSend(owner: string) {
  db.prepare('DELETE FROM mail_sent_log WHERE sent_at < ?').run(Date.now() - HOUR_MS)
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM mail_sent_log WHERE owner = ? AND sent_at >= ?').get(owner, Date.now() - HOUR_MS) as {
    n: number
  }
  if (n >= MAX_SENDS_PER_HOUR) {
    throw new HTTPException(429, { message: `Du kan sende opptil ${MAX_SENDS_PER_HOUR} mails i timen. Prøv igjen senere.` })
  }
  const id = randomUUID()
  db.prepare('INSERT INTO mail_sent_log (id, owner, sent_at) VALUES (?, ?, ?)').run(id, owner, Date.now())
  return id
}

export const releaseSend = (reservation: string) => db.prepare('DELETE FROM mail_sent_log WHERE id = ?').run(reservation)

interface Pending {
  owner: string
  account: Account
  input: ComposeInput
  draftId: string
  wire: Buffer
  sentCopy: Buffer
  from: string
  recipients: string[]
  repliesTo: string | null
  forwards: string | null
  reservation: string
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()

const SEEN = '\\Seen'

// The mail has been accepted by the mail server: file a copy under Sent, drop the draft and the
// uploads, and mark what it answered or forwarded
async function deliver(job: Pending) {
  const { account, owner, input } = job
  await backend().submit(account, { from: job.from, to: job.recipients, raw: job.wire })

  // From here the mail is out, so nothing below may make it look like it failed
  try {
    const mailbox = await openMailbox(account)
    const sent = await ensureFolder(account, mailbox, 'sent')
    await backend().append(account, sent.path, job.sentCopy, [SEEN])
    await deleteDraft(account, job.draftId)
    deleteUploads(owner, input.uploadIds)
    await markOriginals(account, [
      { messageId: job.repliesTo, flag: ANSWERED },
      { messageId: job.forwards, flag: FORWARDED },
    ])
  } catch (err) {
    console.error('A mail was sent, but filing it afterwards failed:', err)
  }
}

async function run(id: string, job: Pending) {
  pending.delete(id)
  try {
    await deliver(job)
  } catch (err) {
    console.error('Sending a mail failed:', err)
    releaseSend(job.reservation)
    addFailure(job.owner, job.input.subject)
  }
}

export interface Queued {
  // Until this time the sending can be taken back. With no undo time the mail has already gone.
  outboxId: string | null
  sendAt: string
  // The draft the mail is kept in until it has gone, which is where it is if sending is taken back
  draftId: string
}

export async function sendMail(account: Account, owner: string, input: ComposeInput): Promise<Queued> {
  const reservation = reserveSend(owner)
  try {
    // The full copy keeps who was in blind copy; the one that goes out doesn't say
    const full = await buildMessage(account, owner, input, { draft: true })
    const wire = await buildMessage(account, owner, input, { draft: false, messageId: full.messageId })
    const draftId = await saveDraft(account, owner, input)

    const seconds = getSettings(owner).undoSeconds
    const job: Pending = {
      owner,
      account,
      input,
      draftId,
      wire: wire.raw,
      sentCopy: full.raw,
      from: wire.from,
      recipients: wire.recipients,
      repliesTo: full.repliesTo,
      forwards: full.forwards,
      reservation,
      timer: undefined as unknown as NodeJS.Timeout,
    }

    if (seconds === 0) {
      await deliver(job)
      return { outboxId: null, sendAt: new Date().toISOString(), draftId }
    }
    const outboxId = randomUUID()
    job.timer = setTimeout(() => void run(outboxId, job), seconds * 1000)
    pending.set(outboxId, job)
    return { outboxId, sendAt: new Date(Date.now() + seconds * 1000).toISOString(), draftId }
  } catch (err) {
    releaseSend(reservation)
    throw err
  }
}

// Takes sending back. The mail stays in Drafts, so the member can go on writing it.
export function cancelSend(owner: string, outboxId: string) {
  const job = pending.get(outboxId)
  if (!job || job.owner !== owner) throw new HTTPException(409, { message: 'Mailen er allerede sendt' })
  clearTimeout(job.timer)
  pending.delete(outboxId)
  releaseSend(job.reservation)
  return { draftId: job.draftId }
}
