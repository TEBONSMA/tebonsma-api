import { HTTPException } from 'hono/http-exception'
import { db } from '../db.ts'
import { backend, type Account } from './backend.ts'
import { encodeId, ensureFolder, groupIds, openMailbox, SEEN } from './mail.ts'
import { addMailNotice } from './notifications.ts'

// A snoozed mail is moved to the folder Snoozed and comes back to the inbox, unread, when its
// time is up. The server has no timer for this, so it is done when the member asks for their
// folders: the first time they are on the site after the time.
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_snoozed (
    owner      TEXT NOT NULL,
    message_id TEXT NOT NULL,
    until      TEXT NOT NULL,
    PRIMARY KEY (owner, message_id)
  );
`)

const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000

export function readUntil(raw: unknown) {
  if (raw === null) return null
  const time = typeof raw === 'string' ? new Date(raw) : null
  if (!time || Number.isNaN(time.getTime())) throw new HTTPException(400, { message: 'Ugyldig tidspunkt' })
  if (time.getTime() <= Date.now()) throw new HTTPException(400, { message: 'Tidspunktet må være fram i tid' })
  if (time.getTime() > Date.now() + MAX_AHEAD_MS) throw new HTTPException(400, { message: 'Mailen kan ikke utsettes mer enn ett år' })
  return time.toISOString()
}

// With a time, the mails are moved to Snoozed. With null, snoozing is taken off and they go back to the inbox.
export async function snoozeMessages(account: Account, owner: string, ids: string[], until: string | null) {
  const mailbox = await openMailbox(account)
  const inbox = mailbox.paths.get('inbox')!
  const snoozed = until ? await ensureFolder(account, mailbox, 'snoozed') : mailbox.paths.get('snoozed')
  let moved = 0

  for (const { folder, uids } of groupIds(mailbox, ids)) {
    const heads = await backend().heads(account, folder.path, uids)
    if (until) {
      // A mail is found again by its Message-ID, since it gets a new UID when it moves
      const trackable = heads.filter(head => head.messageId)
      if (trackable.length < heads.length) throw new HTTPException(400, { message: 'En av mailene har ingen Message-ID og kan ikke utsettes' })
      for (const head of trackable) setRow(owner, head.messageId!, until)
      // Already snoozed: only the time changes
      if (folder.path === snoozed!.path) continue
      await backend().move(account, folder.path, uids, snoozed!.path)
      moved += uids.length
    } else if (snoozed && folder.path === snoozed.path) {
      for (const head of heads) if (head.messageId) clearRow(owner, head.messageId)
      await backend().move(account, folder.path, uids, inbox.path)
      moved += uids.length
    }
  }
  return moved
}

const setRow = (owner: string, messageId: string, until: string) =>
  db.prepare('INSERT OR REPLACE INTO mail_snoozed (owner, message_id, until) VALUES (?, ?, ?)').run(owner, messageId, until)

const clearRow = (owner: string, messageId: string) =>
  db.prepare('DELETE FROM mail_snoozed WHERE owner = ? AND message_id = ?').run(owner, messageId)

// Moves the mails whose time is up back to the inbox as unread, with a notification for each. A
// mail the member has moved out of Snoozed themselves is forgotten.
export async function releaseDue(account: Account, owner: string) {
  const due = db
    .prepare('SELECT message_id, until FROM mail_snoozed WHERE owner = ? AND until <= ?')
    .all(owner, new Date().toISOString()) as unknown as { message_id: string; until: string }[]
  if (due.length === 0) return

  const mailbox = await openMailbox(account)
  const snoozed = mailbox.paths.get('snoozed')
  const inbox = mailbox.paths.get('inbox')!

  for (const row of due) {
    const uids = snoozed ? await backend().search(account, snoozed.path, { header: ['Message-ID', row.message_id] }) : []
    clearRow(owner, row.message_id)
    if (uids.length === 0) continue
    const [head] = await backend().heads(account, snoozed!.path, uids)
    await backend().setFlags(account, snoozed!.path, uids, { remove: [SEEN] })
    await backend().move(account, snoozed!.path, uids, inbox.path)

    // The mail has a new UID in the inbox, which is what the notification opens it by
    const back = await backend().search(account, inbox.path, { header: ['Message-ID', row.message_id] })
    const uid = back[back.length - 1]
    if (uid === undefined) continue
    const fresh = await backend().status(account, inbox.path)
    addMailNotice(owner, {
      mailId: encodeId({ path: inbox.path, uidValidity: fresh.uidValidity }, uid),
      messageKey: row.message_id,
      sender: head.from?.name || head.from?.address || '',
      subject: head.subject,
    })
  }
}
