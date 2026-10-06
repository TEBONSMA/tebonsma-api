import { ImapFlow, type FetchMessageObject, type MessageStructureObject, type SearchObject } from 'imapflow'
import { HTTPException } from 'hono/http-exception'
import { simpleParser } from 'mailparser'
import { createTransport } from 'nodemailer'
import { config } from '../config.ts'
import { unavailable, type Account, type Address, type FolderInfo, type Head, type MailBackend, type SearchQuery } from './backend.ts'
import { previewOf } from './html.ts'
import * as sieve from './sieve.ts'

// The real mail server: IMAP for reading and filing mail, SMTP for sending, ManageSieve for filters.
// Every connection is made as the member, with their own access token, which the server checks
// against the login provider. No password and no master account are involved.

const IDLE_MS = 2 * 60 * 1000
// The first part of a mail is enough for a preview; more is only fetched for mails that are opened
const PREVIEW_BYTES = 6 * 1024

interface Connection {
  client: ImapFlow
  token: string
  timer: NodeJS.Timeout | null
}

// One connection per member, kept while it is used with the same token and closed after two idle minutes
const connections = new Map<string, Connection>()
// A connection that is being made, so two requests at once share it
const connecting = new Map<string, Promise<Connection>>()

function release(email: string, connection: Connection) {
  if (connections.get(email) === connection) connections.delete(email)
  if (connection.timer) clearTimeout(connection.timer)
  connection.timer = null
}

async function open(account: Account): Promise<Connection> {
  const key = account.email.toLowerCase()
  const existing = connections.get(key)
  if (existing && existing.token === account.token && existing.client.usable) return existing
  // A new token (the login was renewed) means a new connection; the old one is closed
  if (existing) {
    release(key, existing)
    existing.client.logout().catch(() => existing.client.close())
  }

  const pendingConnection = connecting.get(key)
  if (pendingConnection) return pendingConnection

  const made = (async () => {
    const client = new ImapFlow({
      host: config.mail.imapHost,
      port: config.mail.imapPort,
      secure: true,
      auth: { user: account.email, accessToken: account.token },
      logger: false,
      // Nothing here waits for new mail, so the connection is not kept in IDLE
      disableAutoIdle: true,
    })
    const connection: Connection = { client, token: account.token, timer: null }
    // Errors after the connection is up show as failed commands; this only keeps them from crashing the API
    client.on('error', err => console.error(`Mail connection for ${key} had an error:`, err))
    client.on('close', () => release(key, connection))
    try {
      await client.connect()
    } catch (err) {
      console.error(`Could not open ${key}'s mailbox:`, err)
      if ((err as { authenticationFailed?: boolean }).authenticationFailed) {
        // The server said no to the token. That is not the same as the login on the site having run out.
        throw new HTTPException(502, { message: 'Postserveren avviste innloggingen. Logg inn på nytt.' })
      }
      throw unavailable()
    }
    connections.set(key, connection)
    return connection
  })()
  connecting.set(key, made)
  try {
    return await made
  } finally {
    connecting.delete(key)
  }
}

async function withClient<T>(account: Account, work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const connection = await open(account)
  if (connection.timer) clearTimeout(connection.timer)
  try {
    return await work(connection.client)
  } catch (err) {
    if (err instanceof HTTPException) throw err
    console.error(`A mail command for ${account.email} failed:`, err)
    throw unavailable()
  } finally {
    connection.timer = setTimeout(() => {
      release(account.email.toLowerCase(), connection)
      connection.client.logout().catch(() => connection.client.close())
    }, IDLE_MS)
    connection.timer.unref()
  }
}

// Runs something with a folder open, and lets go of it afterwards
async function inFolder<T>(account: Account, path: string, work: (client: ImapFlow) => Promise<T>, readOnly = false): Promise<T> {
  return withClient(account, async client => {
    const lock = await client.getMailboxLock(path, { readOnly })
    try {
      return await work(client)
    } finally {
      lock.release()
    }
  })
}

// --- Reading what the server says about a mail ---

const person = (a: { name?: string; address?: string }): Address => ({ name: a.name ?? '', address: a.address ?? '' })
const people = (list: { name?: string; address?: string }[] | undefined) => (list ?? []).filter(a => a.address).map(person)

const iso = (value: Date | string | undefined) => {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : new Date(0).toISOString()
}

// Whether a mail has files attached, from the way it is put together
function hasAttachment(node: MessageStructureObject | undefined): boolean {
  if (!node) return false
  if (node.disposition?.toLowerCase() === 'attachment') return true
  return (node.childNodes ?? []).some(hasAttachment)
}

// The mail ids in a References header, which can run over several lines
const referencesIn = (headers: Buffer | undefined) =>
  [...(headers?.toString('utf8').replace(/\r?\n[ \t]+/g, ' ').matchAll(/<[^<>\s]+>/g) ?? [])].map(match => match[0])

function toHead(path: string, uidValidity: number, message: FetchMessageObject, preview: string): Head {
  const envelope = message.envelope
  return {
    folder: path,
    uid: message.uid,
    uidValidity,
    flags: [...(message.flags ?? [])],
    size: message.size ?? 0,
    date: iso(envelope?.date ?? message.internalDate),
    subject: envelope?.subject ?? '',
    from: people(envelope?.from)[0] ?? null,
    to: people(envelope?.to),
    cc: people(envelope?.cc),
    messageId: envelope?.messageId ?? null,
    inReplyTo: envelope?.inReplyTo ?? null,
    references: referencesIn(message.headers),
    hasAttachments: hasAttachment(message.bodyStructure),
    preview,
  }
}

function toSearch(query: SearchQuery): SearchObject {
  const search: SearchObject = {}
  if (query.unseen) search.seen = false
  if (query.flagged) search.flagged = true
  if (query.text) search.text = query.text
  if (query.from) search.from = query.from
  if (query.to) search.to = query.to
  if (query.subject) search.subject = query.subject
  if (query.keyword) search.keyword = query.keyword
  if (query.since) search.since = query.since
  if (query.before) search.before = query.before
  const headers: Record<string, string> = {}
  if (query.header) headers[query.header[0]] = query.header[1]
  // IMAP can't ask whether a mail has attachments; mails with files are nearly always multipart/mixed
  if (query.hasAttachment) headers['Content-Type'] = 'multipart/mixed'
  if (Object.keys(headers).length > 0) search.header = headers
  return Object.keys(search).length > 0 ? search : { all: true }
}

const MESSAGE_ID = /^Message-ID:\s*(<[^<>\s]+>)/im

export const imapBackend: MailBackend = {
  listFolders: account =>
    withClient(account, async client => {
      const list = await client.list({ statusQuery: { messages: true, unseen: true, uidValidity: true } })
      return list
        // A folder that only holds other folders can't be opened
        .filter(entry => !entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent'))
        .map(
          (entry): FolderInfo => ({
            path: entry.path,
            specialUse: entry.specialUse ?? null,
            total: entry.status?.messages ?? 0,
            unseen: entry.status?.unseen ?? 0,
            uidValidity: Number(entry.status?.uidValidity ?? 0),
          }),
        )
    }),

  createFolder: (account, path) =>
    withClient(account, async client => {
      await client.mailboxCreate(path)
      // Folders that aren't subscribed to are hidden by some mail clients
      await client.mailboxSubscribe(path).catch(() => {})
    }),

  status: (account, path) =>
    withClient(account, async client => {
      const status = await client.status(path, { messages: true, unseen: true, uidValidity: true, uidNext: true })
      if (!status) throw new HTTPException(404, { message: 'Mappen finnes ikke' })
      return {
        total: status.messages ?? 0,
        unseen: status.unseen ?? 0,
        uidValidity: Number(status.uidValidity ?? 0),
        uidNext: status.uidNext ?? 0,
      }
    }),

  search: (account, path, query) =>
    inFolder(
      account,
      path,
      async client => {
        const found = await client.search(toSearch(query), { uid: true })
        return found ? [...found].sort((a, b) => a - b) : []
      },
      true,
    ),

  heads: (account, path, uids, options) =>
    uids.length === 0
      ? Promise.resolve([])
      : inFolder(
          account,
          path,
          async client => {
            const uidValidity = Number(client.mailbox && typeof client.mailbox === 'object' ? client.mailbox.uidValidity : 0)
            const heads: Head[] = []
            const wantPreview = options?.preview !== false
            for await (const message of client.fetch(
              uids,
              {
                uid: true,
                flags: true,
                size: true,
                internalDate: true,
                envelope: true,
                bodyStructure: true,
                headers: ['references'],
                ...(wantPreview && { source: { start: 0, maxLength: PREVIEW_BYTES } }),
              },
              { uid: true },
            )) {
              let preview = ''
              if (wantPreview && message.source) {
                // Only the start of the mail was fetched, which the parser copes with
                const parsed = await simpleParser(message.source).catch(() => null)
                preview = parsed ? previewOf(parsed.text, parsed.html) : ''
              }
              heads.push(toHead(path, uidValidity, message, preview))
            }
            return heads
          },
          true,
        ),

  fetchRaw: (account, path, uid) =>
    inFolder(
      account,
      path,
      async client => {
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true })
        return message && message.source ? message.source : null
      },
      true,
    ),

  setFlags: (account, path, uids, change) =>
    inFolder(account, path, async client => {
      if (change.add?.length) await client.messageFlagsAdd(uids, change.add, { uid: true })
      if (change.remove?.length) await client.messageFlagsRemove(uids, change.remove, { uid: true })
    }),

  move: (account, path, uids, destination) =>
    inFolder(account, path, async client => {
      // MOVE where the server has it, copy and delete where it doesn't
      await client.messageMove(uids, destination, { uid: true })
    }),

  append: (account, path, raw, flags, date) =>
    withClient(account, async client => {
      const result = await client.append(path, raw, flags, date)
      if (result && result.uid) return result.uid

      // A server without UIDPLUS doesn't say which UID the mail got, so it is found by its Message-ID
      const id = MESSAGE_ID.exec(raw.subarray(0, 8192).toString('latin1'))?.[1]
      if (!id) throw new Error('The mail was saved, but its UID could not be found')
      const lock = await client.getMailboxLock(path, { readOnly: true })
      try {
        const found = await client.search({ header: { 'Message-ID': id } }, { uid: true })
        const uid = found ? Math.max(...found) : undefined
        if (uid === undefined) throw new Error('The mail was saved, but its UID could not be found')
        return uid
      } finally {
        lock.release()
      }
    }),

  expunge: (account, path, uids) =>
    inFolder(account, path, async client => {
      await client.messageDelete(uids, { uid: true })
    }),

  async submit(account, message) {
    // Port 465 is encrypted from the start; other ports switch to it
    const transport = createTransport({
      host: config.mail.smtpHost,
      port: config.mail.smtpPort,
      secure: config.mail.smtpPort === 465,
      requireTLS: true,
      auth: { type: 'OAuth2', user: account.email, accessToken: account.token },
    })
    try {
      await transport.sendMail({ envelope: { from: message.from, to: message.to }, raw: message.raw })
    } catch (err) {
      console.error(`Sending a mail for ${account.email} failed:`, err)
      const code = (err as { responseCode?: number }).responseCode
      // The server said no to the mail itself (a bad address, too big), which the member can fix
      if (code && code >= 500 && code < 600) {
        throw new HTTPException(422, { message: `Postserveren avviste mailen: ${(err as Error).message}` })
      }
      throw unavailable()
    } finally {
      transport.close()
    }
  },

  listSieve: sieve.listSieve,
  getSieve: sieve.getSieve,
  putSieve: sieve.putSieve,
  activateSieve: sieve.activateSieve,
}
