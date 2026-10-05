import { HTTPException } from 'hono/http-exception'

// Everything the mail code needs from a mail server, at the level of IMAP, SMTP and Sieve.
// src/mail/imapBackend.ts talks to the real server; dev/mock-mail.ts keeps it all in memory.

// Which mailbox to open, and how to log in to it: the member's address and their own access token
export interface Account {
  email: string
  token: string
}

export interface Address {
  name: string
  address: string
}

export interface FolderInfo {
  path: string
  // \Sent, \Drafts, \Trash, \Junk or \Archive when the server says so
  specialUse: string | null
  total: number
  unseen: number
  uidValidity: number
}

// What a message list needs, without fetching the whole message
export interface Head {
  folder: string
  uid: number
  uidValidity: number
  flags: string[]
  size: number
  date: string
  subject: string
  from: Address | null
  to: Address[]
  cc: Address[]
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  hasAttachments: boolean
  preview: string
}

export interface SearchQuery {
  text?: string
  from?: string
  to?: string
  subject?: string
  unseen?: boolean
  flagged?: boolean
  hasAttachment?: boolean
  keyword?: string
  since?: Date
  before?: Date
  // A header that contains the value, such as Message-ID or References
  header?: [name: string, value: string]
}

export interface MailBackend {
  listFolders(account: Account): Promise<FolderInfo[]>
  createFolder(account: Account, path: string): Promise<void>
  status(account: Account, folder: string): Promise<{ total: number; unseen: number; uidValidity: number }>
  // Matching UIDs, oldest first
  search(account: Account, folder: string, query: SearchQuery): Promise<number[]>
  heads(account: Account, folder: string, uids: number[]): Promise<Head[]>
  fetchRaw(account: Account, folder: string, uid: number): Promise<Buffer | null>
  setFlags(account: Account, folder: string, uids: number[], change: { add?: string[]; remove?: string[] }): Promise<void>
  move(account: Account, folder: string, uids: number[], destination: string): Promise<void>
  // The UID the message got
  append(account: Account, folder: string, raw: Buffer, flags: string[], date?: Date): Promise<number>
  expunge(account: Account, folder: string, uids: number[]): Promise<void>
  submit(account: Account, message: { from: string; to: string[]; raw: Buffer }): Promise<void>
}

let current: MailBackend | null = null

export const useBackend = (backend: MailBackend) => {
  current = backend
}

export const hasBackend = () => current !== null

export function backend() {
  if (!current) throw new HTTPException(503, { message: 'Mail er ikke satt opp' })
  return current
}

export const unavailable = () => new HTTPException(502, { message: 'Fikk ikke kontakt med postserveren' })
