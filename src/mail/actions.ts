import { HTTPException } from 'hono/http-exception'
import { db } from '../db.ts'
import { backend, type Account } from './backend.ts'
import { labelIds } from './labels.ts'
import {
  ensureFolder,
  FLAGGED,
  groupIds,
  isRole,
  isVirtual,
  LABEL_PREFIX,
  openMailbox,
  requireFolder,
  ROLES,
  SEEN,
  type Mailbox,
} from './mail.ts'

export const MAX_IDS = 500

// Where a mail was before it went to the bin, so it can be put back. It is found by the
// mail's Message-ID, since a mail gets a new UID whenever it moves.
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_trash_origin (
    owner      TEXT NOT NULL,
    message_id TEXT NOT NULL,
    folder     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner, message_id)
  );
`)

const KEEP_ORIGIN_MS = 90 * 24 * 60 * 60 * 1000

export function readIds(raw: unknown) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some(id => typeof id !== 'string')) {
    throw new HTTPException(400, { message: 'Velg minst én mail' })
  }
  if (raw.length > MAX_IDS) throw new HTTPException(400, { message: `Du kan velge opptil ${MAX_IDS} mails om gangen` })
  return [...new Set(raw as string[])]
}

// --- Flags ---

export async function setSeenAndFlagged(account: Account, ids: string[], change: { seen?: boolean; flagged?: boolean }) {
  const add: string[] = []
  const remove: string[] = []
  if (change.seen !== undefined) (change.seen ? add : remove).push(SEEN)
  if (change.flagged !== undefined) (change.flagged ? add : remove).push(FLAGGED)
  if (add.length === 0 && remove.length === 0) throw new HTTPException(400, { message: 'Ingenting å endre' })

  const mailbox = await openMailbox(account)
  for (const { folder, uids } of groupIds(mailbox, ids)) await backend().setFlags(account, folder.path, uids, { add, remove })
}

// --- Labels ---

export async function changeLabels(account: Account, owner: string, ids: string[], add: string[], remove: string[]) {
  const known = labelIds(owner)
  // A label that is added has to exist; one that is taken off may already be deleted
  if (add.some(id => !known.has(id))) throw new HTTPException(400, { message: 'Ukjent etikett' })
  const keyword = (id: string) => `${LABEL_PREFIX}${id}`
  if (add.length + remove.length === 0) throw new HTTPException(400, { message: 'Ingenting å endre' })

  const mailbox = await openMailbox(account)
  for (const { folder, uids } of groupIds(mailbox, ids)) {
    await backend().setFlags(account, folder.path, uids, { add: add.map(keyword), remove: remove.map(keyword) })
  }
}

export function readLabelIds(raw: unknown) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}$/.test(id))) {
    throw new HTTPException(400, { message: 'Ugyldig etikett' })
  }
  return [...new Set(raw as string[])]
}

// --- Moving ---

const rememberOrigin = (owner: string, entries: { messageId: string; folder: string }[]) => {
  const now = new Date()
  db.prepare('DELETE FROM mail_trash_origin WHERE owner = ? AND created_at < ?').run(owner, new Date(now.getTime() - KEEP_ORIGIN_MS).toISOString())
  const insert = db.prepare(
    'INSERT OR REPLACE INTO mail_trash_origin (owner, message_id, folder, created_at) VALUES (?, ?, ?, ?)',
  )
  for (const entry of entries) insert.run(owner, entry.messageId, entry.folder, now.toISOString())
}

const originOf = (owner: string, messageId: string | null) =>
  messageId
    ? ((db.prepare('SELECT folder FROM mail_trash_origin WHERE owner = ? AND message_id = ?').get(owner, messageId) as
        | { folder: string }
        | undefined)?.folder ?? null)
    : null

// Mails are only moved into folders members can pick: the ones every mailbox has, and their own.
// Snoozing and scheduling have their own routes.
async function destinationOf(account: Account, mailbox: Mailbox, key: string) {
  if (isVirtual(key) || key === 'snoozed' || key === 'scheduled' || key === 'drafts') {
    throw new HTTPException(400, { message: 'Mailen kan ikke flyttes dit' })
  }
  if (isRole(key)) return ensureFolder(account, mailbox, key)
  return requireFolder(mailbox, key)
}

export async function moveMessages(account: Account, owner: string, ids: string[], key: string) {
  const mailbox = await openMailbox(account)
  const destination = await destinationOf(account, mailbox, key)
  const toTrash = mailbox.paths.get('trash')?.path === destination.path || key === 'trash'

  let moved = 0
  for (const { folder, uids } of groupIds(mailbox, ids)) {
    if (folder.path === destination.path) continue
    if (toTrash) {
      const heads = await backend().heads(account, folder.path, uids)
      rememberOrigin(
        owner,
        heads.flatMap(head => (head.messageId ? [{ messageId: head.messageId, folder: folder.path }] : [])),
      )
    }
    await backend().move(account, folder.path, uids, destination.path)
    moved += uids.length
  }
  return moved
}

// Mails in the bin go back to where they came from, or to the inbox when that isn't known
// or the folder is gone
export async function restoreMessages(account: Account, owner: string, ids: string[]) {
  const mailbox = await openMailbox(account)
  const trash = mailbox.paths.get('trash')
  const inbox = mailbox.paths.get('inbox')!
  const folders = new Set([...mailbox.paths.values(), ...mailbox.own].map(f => f.path))

  let moved = 0
  for (const { folder, uids } of groupIds(mailbox, ids)) {
    if (!trash || folder.path !== trash.path) continue
    const byTarget = new Map<string, number[]>()
    for (const head of await backend().heads(account, folder.path, uids)) {
      const origin = originOf(owner, head.messageId)
      const target = origin && folders.has(origin) && origin !== trash.path ? origin : inbox.path
      byTarget.set(target, [...(byTarget.get(target) ?? []), head.uid])
    }
    for (const [target, targetUids] of byTarget) {
      await backend().move(account, folder.path, targetUids, target)
      moved += targetUids.length
    }
  }
  return moved
}

// --- Deleting for good ---

export async function deleteForever(account: Account, ids: string[]) {
  const mailbox = await openMailbox(account)
  const trash = mailbox.paths.get('trash')
  const groups = groupIds(mailbox, ids)
  if (!trash || groups.some(({ folder }) => folder.path !== trash.path)) {
    throw new HTTPException(400, { message: 'Bare mail i papirkurven kan slettes for godt' })
  }
  for (const { folder, uids } of groups) await backend().expunge(account, folder.path, uids)
  return groups.reduce((sum, group) => sum + group.uids.length, 0)
}

export async function emptyTrash(account: Account) {
  const trash = (await openMailbox(account)).paths.get('trash')
  if (!trash) return 0
  const uids = await backend().search(account, trash.path, {})
  if (uids.length > 0) await backend().expunge(account, trash.path, uids)
  return uids.length
}

// --- Folders ---

const MAX_FOLDER_NAME = 60

export async function createOwnFolder(account: Account, raw: unknown) {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!name) throw new HTTPException(400, { message: 'Mappen trenger et navn' })
  if (name.length > MAX_FOLDER_NAME) throw new HTTPException(400, { message: `Navnet kan ikke være lengre enn ${MAX_FOLDER_NAME} tegn` })
  // Folder names are paths on the server, so separators and control characters are out
  if (/[/\\.\u0000-\u001f\u007f*%&]/.test(name)) throw new HTTPException(400, { message: 'Navnet har ugyldige tegn' })

  const lower = name.toLowerCase()
  const mailbox = await openMailbox(account)
  const reserved = Object.values(ROLES).some(role => role.aliases.some(alias => alias.toLowerCase() === lower) || role.name.toLowerCase() === lower)
  if (reserved || mailbox.own.some(f => f.path.toLowerCase() === lower)) {
    throw new HTTPException(409, { message: 'Du har allerede en mappe med det navnet' })
  }
  await backend().createFolder(account, name)
  return name
}
