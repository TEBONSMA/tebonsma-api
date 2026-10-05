import { HTTPException } from 'hono/http-exception'
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
import { getProfile } from '../lldap.ts'
import { backend, type Account, type Address, type FolderInfo, type Head, type SearchQuery } from './backend.ts'
import { groupHeads, plainSubject } from './grouping.ts'
import { sanitizeIncoming, textToHtml } from './html.ts'

// --- Whose mailbox ---

// The address in LLDAP is the mail login. It rarely changes, so it is asked for now and then.
const ADDRESS_TTL_MS = 10 * 60 * 1000
const addresses = new Map<string, { email: string; until: number }>()

export async function accountFor(username: string, token: string): Promise<Account> {
  let known = addresses.get(username)
  if (!known || known.until < Date.now()) {
    const { email } = await getProfile(username)
    known = { email, until: Date.now() + ADDRESS_TTL_MS }
    addresses.set(username, known)
  }
  if (!known.email) throw new HTTPException(409, { message: 'Kontoen din har ingen e-postadresse' })
  return { email: known.email, token }
}

// --- Folders ---

export type Role = 'inbox' | 'sent' | 'drafts' | 'archive' | 'junk' | 'trash' | 'snoozed' | 'scheduled'

interface RoleDefinition {
  name: string
  specialUse: string | null
  // Names the folder is known by on servers that don't say what it is for
  aliases: string[]
  // What to call it when it has to be made
  create: string
}

export const ROLES: Record<Role, RoleDefinition> = {
  inbox: { name: 'Innboks', specialUse: null, aliases: ['INBOX'], create: 'INBOX' },
  sent: { name: 'Sendt', specialUse: '\\Sent', aliases: ['Sent', 'Sent Items', 'Sent Messages', 'Sendt'], create: 'Sent' },
  drafts: { name: 'Kladder', specialUse: '\\Drafts', aliases: ['Drafts', 'Kladder'], create: 'Drafts' },
  archive: { name: 'Arkiv', specialUse: '\\Archive', aliases: ['Archive', 'Arkiv'], create: 'Archive' },
  junk: { name: 'Søppelpost', specialUse: '\\Junk', aliases: ['Junk', 'Spam', 'Junk E-mail', 'Søppelpost'], create: 'Junk' },
  trash: { name: 'Papirkurv', specialUse: '\\Trash', aliases: ['Trash', 'Deleted Items', 'Deleted Messages', 'Papirkurv'], create: 'Trash' },
  snoozed: { name: 'Utsatt', specialUse: null, aliases: ['Utsatt', 'Snoozed'], create: 'Utsatt' },
  scheduled: { name: 'Planlagt', specialUse: null, aliases: ['Planlagt', 'Scheduled'], create: 'Planlagt' },
}

export const ROLE_ORDER = Object.keys(ROLES) as Role[]
export const isRole = (key: string): key is Role => Object.hasOwn(ROLES, key)

export interface FolderView {
  // What the site calls the folder: its role, or the server's name for a folder of the member's own
  key: string
  name: string
  role: Role | null
  unseen: number
  total: number
}

// The member's folders, with each role matched to the folder that plays it
export interface Mailbox {
  paths: Map<Role, FolderInfo>
  own: FolderInfo[]
}

const lastPart = (path: string) => path.split(/[/.]/).pop()!.toLowerCase()

export async function openMailbox(account: Account): Promise<Mailbox> {
  const folders = await backend().listFolders(account)
  const paths = new Map<Role, FolderInfo>()
  const taken = new Set<string>()
  const take = (role: Role, folder: FolderInfo) => {
    paths.set(role, folder)
    taken.add(folder.path)
  }

  for (const folder of folders) if (folder.path.toUpperCase() === 'INBOX') take('inbox', folder)
  for (const role of ROLE_ORDER) {
    if (paths.has(role)) continue
    const { specialUse, aliases } = ROLES[role]
    const byUse = specialUse && folders.find(f => !taken.has(f.path) && f.specialUse === specialUse)
    const byName = folders.find(f => !taken.has(f.path) && aliases.some(alias => alias.toLowerCase() === lastPart(f.path)))
    const found = byUse || byName
    if (found) take(role, found)
  }
  return { paths, own: folders.filter(f => !taken.has(f.path)) }
}

export function folderViews(mailbox: Mailbox): FolderView[] {
  const roles = ROLE_ORDER.map(role => {
    const folder = mailbox.paths.get(role)
    return { key: role, name: ROLES[role].name, role, unseen: folder?.unseen ?? 0, total: folder?.total ?? 0 }
  })
  const own = mailbox.own.map(f => ({ key: f.path, name: f.path.split(/[/.]/).pop()!, role: null, unseen: f.unseen, total: f.total }))
  return [...roles, ...own]
}

export function keyOf(mailbox: Mailbox, path: string): string {
  for (const [role, folder] of mailbox.paths) if (folder.path === path) return role
  return path
}

// The folder behind a key, or null for a role the server has no folder for yet
export function findFolder(mailbox: Mailbox, key: string): FolderInfo | null {
  if (isRole(key)) return mailbox.paths.get(key) ?? null
  return mailbox.own.find(f => f.path === key) ?? null
}

export function requireFolder(mailbox: Mailbox, key: string) {
  const folder = findFolder(mailbox, key)
  if (!folder) throw new HTTPException(404, { message: 'Mappen finnes ikke' })
  return folder
}

// The folder for a role, made first when the server doesn't have one
export async function ensureFolder(account: Account, mailbox: Mailbox, role: Role) {
  const known = mailbox.paths.get(role)
  if (known) return known
  await backend().createFolder(account, ROLES[role].create)
  const folder = (await openMailbox(account)).paths.get(role)
  if (!folder) throw new HTTPException(502, { message: 'Kunne ikke lage mappen' })
  mailbox.paths.set(role, folder)
  return folder
}

// --- Message ids ---

// Names a message in one folder: which folder it is in, whether the folder has been rebuilt
// since (a new UID validity makes old UIDs mean something else), and its UID
export const encodeId = (folder: Pick<FolderInfo, 'path' | 'uidValidity'>, uid: number) =>
  Buffer.from(`${folder.uidValidity}:${uid}:${folder.path}`).toString('base64url')

export interface MessageRef {
  path: string
  uidValidity: number
  uid: number
}

export function decodeId(id: string): MessageRef {
  const match = /^(\d+):(\d+):(.+)$/s.exec(Buffer.from(id, 'base64url').toString())
  if (!match) throw new HTTPException(404, { message: 'Mailen finnes ikke' })
  return { uidValidity: Number(match[1]), uid: Number(match[2]), path: match[3] }
}

// Ids grouped by folder, for the operations that take several at once. An id from a folder
// that has been rebuilt is left out, since its UID may belong to another message now.
export function groupIds(mailbox: Mailbox, ids: string[]) {
  const groups = new Map<string, { folder: FolderInfo; uids: number[] }>()
  for (const id of ids) {
    const ref = decodeId(id)
    const folder = [...mailbox.paths.values(), ...mailbox.own].find(f => f.path === ref.path)
    if (!folder || folder.uidValidity !== ref.uidValidity) continue
    const group = groups.get(folder.path) ?? { folder, uids: [] }
    group.uids.push(ref.uid)
    groups.set(folder.path, group)
  }
  if (ids.length > 0 && groups.size === 0) throw new HTTPException(404, { message: 'Mailen finnes ikke lenger' })
  return [...groups.values()]
}

// --- Message lists ---

export const SEEN = '\\Seen'
export const FLAGGED = '\\Flagged'
export const LABEL_PREFIX = '$teb_'

export interface MessageSummary {
  // For a conversation, the id of its newest mail
  id: string
  // Every mail in the row: just this one, or the whole conversation. Changes to the row apply to all of them.
  ids: string[]
  count: number
  unreadCount: number
  participants: Address[]
  folder: string
  from: Address | null
  to: Address[]
  subject: string
  preview: string
  date: string
  seen: boolean
  flagged: boolean
  hasAttachments: boolean
  labels: string[]
  size: number
}

export function summarize(mailbox: Mailbox, head: Head): MessageSummary {
  const folder = [...mailbox.paths.values(), ...mailbox.own].find(f => f.path === head.folder)!
  const id = encodeId({ path: head.folder, uidValidity: head.uidValidity }, head.uid)
  return {
    id,
    ids: [id],
    count: 1,
    unreadCount: head.flags.includes(SEEN) ? 0 : 1,
    participants: head.from ? [head.from] : [],
    folder: keyOf(mailbox, folder.path),
    from: head.from,
    to: head.to,
    subject: head.subject,
    preview: head.preview,
    date: head.date,
    seen: head.flags.includes(SEEN),
    flagged: head.flags.includes(FLAGGED),
    hasAttachments: head.hasAttachments,
    labels: head.flags.filter(flag => flag.startsWith(LABEL_PREFIX)).map(flag => flag.slice(LABEL_PREFIX.length)),
    size: head.size,
  }
}

export async function headsInOrder(account: Account, path: string, uids: number[]) {
  const heads = await backend().heads(account, path, uids)
  const position = new Map(uids.map((uid, index) => [uid, index]))
  return heads.sort((a, b) => position.get(a.uid)! - position.get(b.uid)!)
}

export type Sort = 'new' | 'old' | 'sender' | 'subject' | 'size'
export const SORTS: Sort[] = ['new', 'old', 'sender', 'subject', 'size']

// What to pick out of the folders: every field narrows the list further
export interface Filter {
  unread?: boolean
  flagged?: boolean
  text?: string
  from?: string
  to?: string
  subject?: string
  attachment?: boolean
  // A label's keyword
  keyword?: string
  since?: Date
  before?: Date
}

export interface ListOptions {
  // A folder key, or one of the lists that cut across folders: all, favorites, unread
  folder: string
  offset: number
  limit: number
  sort: Sort
  filter: Filter
  // Mails of one conversation are one row. Searches by words always list single mails.
  conversations: boolean
}

export const VIRTUAL = ['all', 'favorites', 'unread'] as const
export const isVirtual = (key: string) => (VIRTUAL as readonly string[]).includes(key)

// Sorting by anything but date means looking at this many of the newest mails and sorting them here
const WINDOW = 1000
// Mails in the bin and in junk only show up where they are
const HIDDEN_FROM_LISTS: Role[] = ['trash', 'junk']
const NOT_UNREAD_LISTS: Role[] = [...HIDDEN_FROM_LISTS, 'sent', 'drafts', 'scheduled']

function toQuery(filter: Filter): SearchQuery {
  return {
    unseen: filter.unread || undefined,
    flagged: filter.flagged || undefined,
    text: filter.text,
    from: filter.from,
    to: filter.to,
    subject: filter.subject,
    hasAttachment: filter.attachment || undefined,
    keyword: filter.keyword,
    since: filter.since,
    before: filter.before,
  }
}

function foldersFor(mailbox: Mailbox, key: string) {
  const all = [...mailbox.paths.values(), ...mailbox.own]
  const without = (roles: Role[]) => all.filter(f => !roles.some(role => mailbox.paths.get(role) === f))
  if (key === 'all' || key === 'favorites') return without(HIDDEN_FROM_LISTS)
  if (key === 'unread') return without(NOT_UNREAD_LISTS)
  const folder = findFolder(mailbox, key)
  if (!folder) {
    // A role the server has no folder for yet is an empty folder
    if (isRole(key)) return []
    throw new HTTPException(404, { message: 'Mappen finnes ikke' })
  }
  return [folder]
}

const who = (head: Head) => (head.from?.name || head.from?.address || '').toLowerCase()

const COMPARE: Record<Sort, (a: Head, b: Head) => number> = {
  new: (a, b) => b.date.localeCompare(a.date),
  old: (a, b) => a.date.localeCompare(b.date),
  sender: (a, b) => who(a).localeCompare(who(b), 'nb') || b.date.localeCompare(a.date),
  subject: (a, b) => plainSubject(a.subject).localeCompare(plainSubject(b.subject), 'nb') || b.date.localeCompare(a.date),
  size: (a, b) => b.size - a.size,
}

// One row for a whole conversation: the newest mail's look, the conversation's counts
function conversationRow(mailbox: Mailbox, group: Head[]): MessageSummary {
  const newest = group[group.length - 1]
  const row = summarize(mailbox, newest)
  const people = new Map<string, Address>()
  for (const head of group) if (head.from) people.set(head.from.address.toLowerCase(), head.from)
  const rows = group.map(head => summarize(mailbox, head))
  return {
    ...row,
    // Newest first, as the list is
    ids: rows.map(r => r.id).reverse(),
    count: group.length,
    unreadCount: rows.filter(r => !r.seen).length,
    seen: rows.every(r => r.seen),
    flagged: rows.some(r => r.flagged),
    hasAttachments: rows.some(r => r.hasAttachments),
    labels: [...new Set(rows.flatMap(r => r.labels))],
    size: group.reduce((sum, head) => sum + head.size, 0),
    subject: group[0].subject,
    participants: [...people.values()],
  }
}

const SEARCHES = ['text', 'from', 'to', 'subject'] as const

export async function listMessages(account: Account, options: ListOptions) {
  const mailbox = await openMailbox(account)
  const folders = foldersFor(mailbox, options.folder)
  const filter: Filter = { ...options.filter }
  if (options.folder === 'favorites') filter.flagged = true
  if (options.folder === 'unread') filter.unread = true
  const query = toQuery(filter)

  // One folder, by date: the server's own order is the answer, so only the page is fetched
  const conversational = options.conversations && !SEARCHES.some(field => options.filter[field])
  if (!conversational && folders.length === 1 && (options.sort === 'new' || options.sort === 'old')) {
    const uids = await backend().search(account, folders[0].path, query)
    const ordered = options.sort === 'old' ? uids : [...uids].reverse()
    const page = ordered.slice(options.offset, options.offset + options.limit)
    const heads = await headsInOrder(account, folders[0].path, page)
    const end = options.offset + page.length
    return {
      messages: heads.map(head => summarize(mailbox, head)),
      nextOffset: end < ordered.length ? end : null,
      total: ordered.length,
    }
  }

  const found: Head[] = []
  for (const folder of folders) {
    const uids = (await backend().search(account, folder.path, query)).slice(-WINDOW)
    found.push(...(await backend().heads(account, folder.path, uids)))
  }

  if (conversational) {
    // Each conversation is sorted as its newest mail, with the conversation's total size
    const groups = groupHeads(found)
    const stand = (group: Head[]): Head => ({
      ...group[group.length - 1],
      subject: group[0].subject,
      size: group.reduce((sum, head) => sum + head.size, 0),
    })
    const sorted = groups
      .map(group => ({ group, head: stand(group) }))
      .sort((a, b) => COMPARE[options.sort](a.head, b.head))
      .slice(0, WINDOW)
    const page = sorted.slice(options.offset, options.offset + options.limit)
    const end = options.offset + page.length
    return {
      messages: page.map(({ group }) => conversationRow(mailbox, group)),
      nextOffset: end < sorted.length ? end : null,
      total: sorted.length,
    }
  }

  const ordered = found.sort(COMPARE[options.sort]).slice(0, WINDOW)
  const page = ordered.slice(options.offset, options.offset + options.limit)
  const end = options.offset + page.length
  return {
    messages: page.map(head => summarize(mailbox, head)),
    nextOffset: end < ordered.length ? end : null,
    total: ordered.length,
  }
}

// --- Reading ---

const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024
const INLINE_IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp)$/i

const toAddresses = (value: AddressObject | AddressObject[] | undefined): Address[] =>
  [value ?? []]
    .flat()
    .flatMap(object => object.value)
    .filter(a => a.address)
    .map(a => ({ name: a.name ?? '', address: a.address! }))

export interface MessageView extends MessageSummary {
  cc: Address[]
  text: string
  html: string
  blockedImages: number
  attachments: { n: number; name: string; mime: string; size: number }[]
  messageId: string | null
  inReplyTo: string | null
  references: string[]
}

// Attachments that are only there to be shown inside the mail itself aren't listed
const isListed = (attachment: ParsedMail['attachments'][number]) =>
  !(attachment.cid && attachment.contentDisposition !== 'attachment')

export const safeMime = (type: string) => (/^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream')

async function load(account: Account, id: string) {
  const ref = decodeId(id)
  const mailbox = await openMailbox(account)
  const folder = [...mailbox.paths.values(), ...mailbox.own].find(f => f.path === ref.path)
  if (!folder || folder.uidValidity !== ref.uidValidity) throw new HTTPException(404, { message: 'Mailen finnes ikke lenger' })
  const raw = await backend().fetchRaw(account, folder.path, ref.uid)
  if (!raw) throw new HTTPException(404, { message: 'Mailen finnes ikke lenger' })
  const [head] = await backend().heads(account, folder.path, [ref.uid])
  return { mailbox, folder, ref, head, parsed: await simpleParser(raw) }
}

export async function readMessage(account: Account, id: string, showImages: boolean): Promise<MessageView> {
  const { mailbox, folder, ref, head, parsed } = await load(account, id)

  const inline = new Map<string, string>()
  for (const attachment of parsed.attachments) {
    if (!attachment.cid || !INLINE_IMAGE_TYPES.test(attachment.contentType) || attachment.size > MAX_INLINE_IMAGE_BYTES) continue
    inline.set(attachment.cid.replace(/^<|>$/g, ''), `data:${attachment.contentType.toLowerCase()};base64,${attachment.content.toString('base64')}`)
  }

  const text = parsed.text ?? ''
  const { html, blockedImages } = parsed.html
    ? sanitizeIncoming(parsed.html, { inline, showImages })
    : { html: textToHtml(text), blockedImages: 0 }

  // Opening a mail reads it
  if (!head.flags.includes(SEEN)) {
    await backend().setFlags(account, folder.path, [ref.uid], { add: [SEEN] })
    head.flags.push(SEEN)
  }

  const references = [parsed.references ?? []].flat()
  return {
    ...summarize(mailbox, head),
    cc: toAddresses(parsed.cc),
    text,
    html,
    blockedImages,
    attachments: parsed.attachments.flatMap((attachment, n) =>
      isListed(attachment)
        ? [{ n, name: attachment.filename || 'vedlegg', mime: safeMime(attachment.contentType), size: attachment.size }]
        : [],
    ),
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references,
  }
}

export async function readAttachment(account: Account, id: string, n: number) {
  const { parsed } = await load(account, id)
  const attachment = parsed.attachments[n]
  if (!attachment) throw new HTTPException(404, { message: 'Vedlegget finnes ikke' })
  return {
    name: attachment.filename || 'vedlegg',
    mime: safeMime(attachment.contentType),
    content: attachment.content,
  }
}
