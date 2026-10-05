import { randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { simpleParser } from 'mailparser'
import { db } from '../db.ts'
import { ANSWERED, FORWARDED, markOriginals } from './actions.ts'
import { backend, type Account } from './backend.ts'
import { buildMessage, deleteDraft, DRAFT_HEADER, type ComposeInput } from './compose.ts'
import { accountFor, decodeId, encodeId, ensureFolder, openMailbox } from './mail.ts'
import { addFailure } from './notifications.ts'
import { accessTokenFor, hasOfflineToken, offlineAvailable, offlineOwners, TokenRefused } from './offline.ts'
import { releaseSend, reserveSend } from './outbox.ts'
import { releaseDue } from './snooze.ts'
import { deleteUploads } from './uploads.ts'

// A mail that is to be sent later waits in the folder Scheduled on the mail server, where other mail
// clients see it too, with a row here saying when. A timer in the API sends it at the time, using a
// token fetched with the permission the member gave (src/mail/offline.ts), so the member doesn't have
// to be on the site.
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_scheduled (
    id         TEXT PRIMARY KEY,
    owner      TEXT NOT NULL,
    message_id TEXT NOT NULL,
    send_at    TEXT NOT NULL,
    subject    TEXT NOT NULL DEFAULT '',
    -- The Message-IDs of what the mail answers or forwards, to mark them once it has gone
    replies_to TEXT,
    forwards   TEXT,
    attempts   INTEGER NOT NULL DEFAULT 0,
    -- Set while a send is under way, so the same mail is never sent twice
    sending_at TEXT,
    -- Set when the mail could not be sent. It is moved to Drafts the next time the mailbox can be opened.
    failed_at  TEXT,
    UNIQUE (owner, message_id)
  );
  CREATE INDEX IF NOT EXISTS mail_scheduled_due ON mail_scheduled (send_at);
`)

// Tables made before the columns for answered and forwarded mail was added
for (const column of ['replies_to', 'forwards']) {
  const columns = db.prepare('PRAGMA table_info(mail_scheduled)').all() as unknown as { name: string }[]
  if (!columns.some(c => c.name === column)) db.exec(`ALTER TABLE mail_scheduled ADD COLUMN ${column} TEXT`)
}

const TICK_MS = 30_000
const MIN_AHEAD_MS = 30_000
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000
const MAX_ATTEMPTS = 3
const STUCK_MS = 10 * 60 * 1000

interface Row {
  id: string
  owner: string
  message_id: string
  send_at: string
  subject: string
  replies_to: string | null
  forwards: string | null
  attempts: number
}

export function readSendAt(raw: unknown) {
  const time = typeof raw === 'string' ? new Date(raw) : null
  if (!time || Number.isNaN(time.getTime())) throw new HTTPException(400, { message: 'Ugyldig tidspunkt' })
  if (time.getTime() < Date.now() + MIN_AHEAD_MS) throw new HTTPException(400, { message: 'Tidspunktet må være fram i tid' })
  if (time.getTime() > Date.now() + MAX_AHEAD_MS) throw new HTTPException(400, { message: 'Mailen kan ikke planlegges mer enn ett år fram' })
  return time.toISOString()
}

// --- Editing the headers of a saved mail without touching the rest of it ---

function rewriteHeaders(raw: Buffer, change: { drop: string[]; set: Record<string, string> }) {
  const end = raw.indexOf('\r\n\r\n')
  const head = (end === -1 ? raw : raw.subarray(0, end)).toString('latin1')
  const body = end === -1 ? Buffer.alloc(0) : raw.subarray(end)
  const names = new Set([...change.drop, ...Object.keys(change.set)].map(name => name.toLowerCase()))

  // A header can continue on the lines after it, which start with a space or a tab
  const kept = head
    .split(/\r\n(?=\S)/)
    .filter(header => !names.has(header.slice(0, header.indexOf(':')).toLowerCase()))
  for (const [name, value] of Object.entries(change.set)) kept.push(`${name}: ${value}`)
  return Buffer.concat([Buffer.from(kept.join('\r\n'), 'latin1'), body])
}

// --- Scheduling ---

export async function scheduleMail(account: Account, owner: string, input: ComposeInput, sendAt: string) {
  if (!offlineAvailable()) throw new HTTPException(503, { message: 'Send senere er ikke slått på' })
  if (!hasOfflineToken(owner)) throw new HTTPException(409, { message: 'Gi tillatelse til send senere først' })

  // Kept with who is in blind copy. The one that goes out is made from this when it is time.
  const full = await buildMessage(account, owner, { ...input, draftId: null }, { draft: true })
  const mailbox = await openMailbox(account)
  const folder = await ensureFolder(account, mailbox, 'scheduled')
  await backend().append(account, folder.path, full.raw, ['\\Seen'])
  const id = randomUUID()
  db.prepare('INSERT INTO mail_scheduled (id, owner, message_id, send_at, subject, replies_to, forwards) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    owner,
    full.messageId,
    sendAt,
    input.subject,
    full.repliesTo,
    full.forwards,
  )

  // The mail now lives in Scheduled; its draft and uploads have done their job
  if (input.draftId) await deleteDraft(account, input.draftId)
  deleteUploads(owner, input.uploadIds)
  return { scheduledId: id, sendAt }
}

// The send times of the member's scheduled mails, by Message-ID, for the list to show
export function scheduledTimes(owner: string) {
  const rows = db.prepare('SELECT message_id, send_at FROM mail_scheduled WHERE owner = ?').all(owner) as unknown as { message_id: string; send_at: string }[]
  return new Map(rows.map(row => [row.message_id, row.send_at]))
}

async function rowFor(account: Account, owner: string, id: string) {
  const ref = decodeId(id)
  const mailbox = await openMailbox(account)
  const planned = mailbox.paths.get('scheduled')
  if (!planned || planned.path !== ref.path || planned.uidValidity !== ref.uidValidity) {
    throw new HTTPException(404, { message: 'Mailen er ikke planlagt' })
  }
  const [head] = await backend().heads(account, planned.path, [ref.uid])
  const row = head?.messageId
    ? (db.prepare('SELECT * FROM mail_scheduled WHERE owner = ? AND message_id = ?').get(owner, head.messageId) as unknown as Row | undefined)
    : undefined
  if (!row) throw new HTTPException(404, { message: 'Mailen er ikke planlagt' })
  return { row, planned, uid: ref.uid, mailbox }
}

export async function rescheduleMail(account: Account, owner: string, id: string, sendAt: string) {
  const { row } = await rowFor(account, owner, id)
  const { changes } = db.prepare('UPDATE mail_scheduled SET send_at = ? WHERE id = ? AND sending_at IS NULL').run(sendAt, row.id)
  if (changes === 0) throw new HTTPException(409, { message: 'Mailen blir sendt akkurat nå' })
}

// Moves a scheduled mail to Drafts, where it can be edited. Returns the id of the draft.
async function intoDrafts(account: Account, owner: string, planned: { path: string }, uid: number, mailbox: Awaited<ReturnType<typeof openMailbox>>) {
  const raw = await backend().fetchRaw(account, planned.path, uid)
  if (!raw) throw new HTTPException(404, { message: 'Mailen finnes ikke lenger' })
  const drafts = await ensureFolder(account, mailbox, 'drafts')
  const draft = rewriteHeaders(raw, { drop: [], set: { [DRAFT_HEADER]: randomUUID() } })
  const newUid = await backend().append(account, drafts.path, draft, ['\\Draft', '\\Seen'])
  await backend().expunge(account, planned.path, [uid])
  return encodeId(drafts, newUid)
}

// "Cancel and edit": the mail goes back to Drafts and the sending is off
export async function cancelScheduled(account: Account, owner: string, id: string) {
  const { row, planned, uid, mailbox } = await rowFor(account, owner, id)
  const { changes } = db.prepare('DELETE FROM mail_scheduled WHERE id = ? AND sending_at IS NULL').run(row.id)
  if (changes === 0) throw new HTTPException(409, { message: 'Mailen blir sendt akkurat nå' })
  return { draftId: await intoDrafts(account, owner, planned, uid, mailbox) }
}

// --- Sending at the time ---

const markFailed = (row: Row) => {
  db.prepare('UPDATE mail_scheduled SET failed_at = ?, sending_at = NULL WHERE id = ?').run(new Date().toISOString(), row.id)
  addFailure(row.owner, row.subject)
}

// Mails that could not be sent are moved to Drafts when the mailbox can be opened: right away if the
// member's permission still works, otherwise the next time they are on the site
export async function settleFailed(account: Account, owner: string) {
  const rows = db.prepare('SELECT * FROM mail_scheduled WHERE owner = ? AND failed_at IS NOT NULL').all(owner) as unknown as Row[]
  if (rows.length === 0) return
  const mailbox = await openMailbox(account)
  const planned = mailbox.paths.get('scheduled')
  for (const row of rows) {
    if (planned) {
      const uids = await backend().search(account, planned.path, { header: ['Message-ID', row.message_id] })
      if (uids.length > 0) await intoDrafts(account, owner, planned, uids[uids.length - 1], mailbox)
    }
    db.prepare('DELETE FROM mail_scheduled WHERE id = ?').run(row.id)
  }
}

const SEEN = '\\Seen'

async function deliver(row: Row) {
  const token = await accessTokenFor(row.owner)
  const account = await accountFor(row.owner, token)
  const mailbox = await openMailbox(account)
  const planned = mailbox.paths.get('scheduled')
  const uids = planned ? await backend().search(account, planned.path, { header: ['Message-ID', row.message_id] }) : []
  // The member deleted it from the folder themselves
  if (!planned || uids.length === 0) {
    db.prepare('DELETE FROM mail_scheduled WHERE id = ?').run(row.id)
    return
  }
  const uid = uids[uids.length - 1]
  const raw = await backend().fetchRaw(account, planned.path, uid)
  if (!raw) {
    db.prepare('DELETE FROM mail_scheduled WHERE id = ?').run(row.id)
    return
  }

  const parsed = await simpleParser(raw)
  const toAddresses = (value: typeof parsed.to) => [value ?? []].flat().flatMap(o => o.value).flatMap(a => (a.address ? [a.address] : []))
  const recipients = [...toAddresses(parsed.to), ...toAddresses(parsed.cc), ...toAddresses(parsed.bcc)]

  const reservation = reserveSend(row.owner)
  try {
    // It goes out with the time it is sent, and without saying who was in blind copy
    const date = new Date().toUTCString()
    await backend().submit(account, {
      from: account.email,
      to: recipients,
      raw: rewriteHeaders(raw, { drop: ['Bcc'], set: { Date: date } }),
    })
  } catch (err) {
    releaseSend(reservation)
    throw err
  }

  try {
    const sent = await ensureFolder(account, mailbox, 'sent')
    await backend().append(account, sent.path, rewriteHeaders(raw, { drop: [], set: { Date: new Date().toUTCString() } }), [SEEN])
    await backend().expunge(account, planned.path, [uid])
    await markOriginals(account, [
      { messageId: row.replies_to, flag: ANSWERED },
      { messageId: row.forwards, flag: FORWARDED },
    ])
  } catch (err) {
    console.error('A scheduled mail was sent, but filing it afterwards failed:', err)
  }
  db.prepare('DELETE FROM mail_scheduled WHERE id = ?').run(row.id)
}

async function send(row: Row) {
  try {
    await deliver(row)
  } catch (err) {
    console.error(`Sending a scheduled mail failed (attempt ${row.attempts + 1}):`, err)
    // A refused permission or a used-up hour won't be better in half a minute; a mail server that
    // didn't answer might be
    const final = err instanceof TokenRefused ? err.permanent : err instanceof HTTPException
    if (final || row.attempts + 1 >= MAX_ATTEMPTS) {
      markFailed(row)
      // Moved to Drafts now if the mailbox can still be opened, otherwise when the member next visits
      try {
        const account = await accountFor(row.owner, await accessTokenFor(row.owner))
        await settleFailed(account, row.owner)
      } catch {
        // Left for settleFailed
      }
    } else {
      db.prepare('UPDATE mail_scheduled SET attempts = attempts + 1, sending_at = NULL WHERE id = ?').run(row.id)
    }
  }
}

// Snoozed mail of members who gave permission comes back on time too
async function releaseSnoozed() {
  const due = new Set(
    (db.prepare('SELECT DISTINCT owner FROM mail_snoozed WHERE until <= ?').all(new Date().toISOString()) as unknown as { owner: string }[]).map(r => r.owner),
  )
  for (const owner of offlineOwners().filter(o => due.has(o))) {
    try {
      await releaseDue(await accountFor(owner, await accessTokenFor(owner)), owner)
    } catch (err) {
      console.error(`Bringing back ${owner}'s snoozed mail failed:`, err)
    }
  }
}

let running = false

export async function tick() {
  if (running) return
  running = true
  try {
    const now = new Date()
    db.prepare('UPDATE mail_scheduled SET sending_at = NULL WHERE sending_at < ?').run(new Date(now.getTime() - STUCK_MS).toISOString())
    const due = db
      .prepare('SELECT * FROM mail_scheduled WHERE send_at <= ? AND failed_at IS NULL AND sending_at IS NULL ORDER BY send_at LIMIT 20')
      .all(now.toISOString()) as unknown as Row[]
    for (const row of due) {
      const claimed = db.prepare('UPDATE mail_scheduled SET sending_at = ? WHERE id = ? AND sending_at IS NULL').run(now.toISOString(), row.id)
      if (claimed.changes > 0) await send(row)
    }
    await releaseSnoozed()
  } catch (err) {
    console.error('The mail timer failed:', err)
  } finally {
    running = false
  }
}

export function startScheduler() {
  if (!offlineAvailable()) return
  setInterval(() => void tick(), TICK_MS).unref()
}

