import { randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import MailComposer from 'nodemailer/lib/mail-composer'
import { findByMemberId } from '../members.ts'
import { getProfile } from '../lldap.ts'
import { backend, type Account, type Address } from './backend.ts'
import { isReply } from './grouping.ts'
import { sanitizeCompose, toText } from './html.ts'
import { ensureFolder, load, openMailbox } from './mail.ts'
import { MAX_MAIL_BYTES, saveUpload, takeUploads, type Upload } from './uploads.ts'

export const MAX_RECIPIENTS = 50
const MAX_SUBJECT_LENGTH = 250
const MAX_HTML_LENGTH = 200_000
const MAX_ADDRESS_LENGTH = 254
const ADDRESS = /^[^\s@<>,;"()[\]\\]+@[^\s@<>,;"()[\]\\]+\.[^\s@<>,;"()[\]\\]+$/
const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const DRAFT_HEADER = 'X-Teb-Draft'

const bad = (message: string) => new HTTPException(400, { message })

// --- What the member sends in ---

// Where a mail goes: an address, or a member of the site, whose address only the API knows
export type Recipient = string | { memberId: string }

export interface Threading {
  inReplyTo: string | null
  references: string[]
}

export interface ComposeInput {
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  html: string
  uploadIds: string[]
  draftId: string | null
  // The mail being answered or forwarded: its headers go on the new mail, and it is marked as answered
  replyTo: string | null
  forwardOf: string | null
  // The same headers, for a reply that was saved as a draft and opened again
  threading: Threading | null
}

async function resolve(raw: unknown, what: string): Promise<Address[]> {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw bad(`${what} er ugyldig`)
  const resolved: Address[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const address = entry.trim()
      if (address.length > MAX_ADDRESS_LENGTH || !ADDRESS.test(address)) throw bad(`«${address.slice(0, 60)}» er ikke en gyldig e-postadresse`)
      resolved.push({ name: '', address })
    } else if (entry && typeof entry === 'object' && typeof (entry as { memberId?: unknown }).memberId === 'string') {
      const username = findByMemberId((entry as { memberId: string }).memberId)
      if (!username) throw bad('Et av medlemmene finnes ikke lenger')
      const profile = await getProfile(username)
      if (!profile.email) throw bad(`${profile.displayName || 'Medlemmet'} har ingen e-postadresse`)
      resolved.push({ name: profile.displayName, address: profile.email })
    } else {
      throw bad(`${what} er ugyldig`)
    }
  }
  return resolved
}

function readThreading(raw: unknown): Threading | null {
  if (raw === undefined || raw === null) return null
  const { inReplyTo = null, references = [] } = raw as Record<string, unknown>
  const id = (value: unknown) => typeof value === 'string' && /^<[^\s<>]{1,500}>$/.test(value)
  if ((inReplyTo !== null && !id(inReplyTo)) || !Array.isArray(references) || references.length > 30 || !references.every(id)) {
    throw bad('Ugyldig svar')
  }
  return { inReplyTo: inReplyTo as string | null, references: references as string[] }
}

// A draft can be saved half done, so only a mail that is sent has to have someone to go to
export async function readCompose(body: Record<string, unknown>, options: { forSending: boolean }): Promise<ComposeInput> {
  const [to, cc, bcc] = await Promise.all([resolve(body.to, 'Til'), resolve(body.cc, 'Kopi'), resolve(body.bcc, 'Blindkopi')])
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw bad(`En mail kan ha opptil ${MAX_RECIPIENTS} mottakere`)

  // A subject is one line, and a line break in it could add headers to the mail
  const subject = (typeof body.subject === 'string' ? body.subject : '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
  if (subject.length > MAX_SUBJECT_LENGTH) throw bad(`Emnet kan ikke være lengre enn ${MAX_SUBJECT_LENGTH} tegn`)

  const rawHtml = typeof body.html === 'string' ? body.html : ''
  if (rawHtml.length > MAX_HTML_LENGTH) throw bad('Mailen er for lang')

  const { uploadIds = [], draftId = null, replyTo = null, forwardOf = null } = body
  if (!Array.isArray(uploadIds) || uploadIds.some(id => typeof id !== 'string') || uploadIds.length > 30) throw bad('Ugyldige vedlegg')
  if (draftId !== null && (typeof draftId !== 'string' || !DRAFT_ID.test(draftId))) throw bad('Ugyldig kladd')
  for (const id of [replyTo, forwardOf]) if (id !== null && typeof id !== 'string') throw bad('Ugyldig forespørsel')

  const input: ComposeInput = {
    to,
    cc,
    bcc,
    subject,
    html: sanitizeCompose(rawHtml),
    uploadIds: [...new Set(uploadIds as string[])],
    draftId: draftId as string | null,
    replyTo: replyTo as string | null,
    forwardOf: forwardOf as string | null,
    threading: readThreading(body.threading),
  }
  if (options.forSending) {
    if (to.length + cc.length + bcc.length === 0) throw bad('Legg til minst én mottaker')
    if (!subject && !toText(input.html) && input.uploadIds.length === 0 && !input.forwardOf) throw bad('Mailen er tom')
  }
  return input
}

// --- The mail itself ---

const isInlinePart = (attachment: { cid?: string; contentDisposition?: string }) =>
  !!attachment.cid && attachment.contentDisposition !== 'attachment'

export interface Built {
  raw: Buffer
  from: string
  // Everyone it goes to, including those in blind copy
  recipients: string[]
  messageId: string
}

export async function buildMessage(account: Account, owner: string, input: ComposeInput, options: { draft: boolean; messageId?: string }): Promise<Built> {
  const files: { filename: string; content: Buffer; contentType: string }[] = takeUploads(owner, input.uploadIds).map(
    ({ upload, content }) => ({ filename: upload.name, content, contentType: upload.mime }),
  )

  // The attachments of a mail that is forwarded go along with it
  if (input.forwardOf) {
    const { parsed } = await load(account, input.forwardOf)
    for (const attachment of parsed.attachments) {
      if (isInlinePart(attachment)) continue
      files.push({ filename: attachment.filename || 'vedlegg', content: attachment.content, contentType: attachment.contentType })
    }
  }
  if (files.reduce((sum, file) => sum + file.content.length, 0) > MAX_MAIL_BYTES) {
    throw new HTTPException(413, { message: 'Vedleggene er til sammen større enn 25 MB' })
  }

  let threading = input.threading
  if (input.replyTo) {
    const { parsed } = await load(account, input.replyTo)
    const original = parsed.messageId ?? null
    threading = { inReplyTo: original, references: [...[parsed.references ?? []].flat(), ...(original ? [original] : [])].slice(-30) }
  }

  const messageId = options.messageId ?? `<${randomUUID()}@${account.email.split('@')[1]}>`
  const message = new MailComposer({
    messageId,
    from: { name: account.name ?? '', address: account.email },
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    html: input.html || undefined,
    text: toText(input.html),
    attachments: files,
    inReplyTo: threading?.inReplyTo ?? undefined,
    references: threading?.references.length ? threading.references : undefined,
    headers: input.draftId ? { [DRAFT_HEADER]: input.draftId } : undefined,
  }).compile()
  // A draft has to remember who is in blind copy; a mail that is sent must not tell
  message.keepBcc = options.draft
  return {
    raw: await message.build(),
    from: account.email,
    recipients: [...input.to, ...input.cc, ...input.bcc].map(a => a.address),
    messageId,
  }
}

// --- Drafts ---

const FLAG_DRAFT = '\\Draft'
const FLAG_SEEN = '\\Seen'

async function draftUids(account: Account, path: string, draftId: string) {
  return backend().search(account, path, { header: [DRAFT_HEADER, draftId] })
}

// A saved mail can't be changed on an IMAP server, so the old copy is replaced by a new one
export async function saveDraft(account: Account, owner: string, input: ComposeInput) {
  const draftId = input.draftId ?? randomUUID()
  const withId = { ...input, draftId }
  const built = await buildMessage(account, owner, withId, { draft: true })

  const mailbox = await openMailbox(account)
  const folder = await ensureFolder(account, mailbox, 'drafts')
  const old = await draftUids(account, folder.path, draftId)
  await backend().append(account, folder.path, built.raw, [FLAG_DRAFT, FLAG_SEEN])
  if (old.length > 0) await backend().expunge(account, folder.path, old)
  return draftId
}

export async function deleteDraft(account: Account, draftId: string) {
  const folder = (await openMailbox(account)).paths.get('drafts')
  if (!folder) return
  const uids = await draftUids(account, folder.path, draftId)
  if (uids.length > 0) await backend().expunge(account, folder.path, uids)
}

// --- Starting a mail from another ---

export type ComposeMode = 'reply' | 'replyAll' | 'forward' | 'draft'

export interface ComposeStart {
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  html: string
  replyTo: string | null
  forwardOf: string | null
  draftId: string | null
  threading: Threading | null
  attachments: Upload[]
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const escape = (text: string) => text.replace(/[&<>"]/g, ch => ESCAPES[ch])
const paragraphs = (text: string) =>
  text
    .trim()
    .split(/\n{2,}/)
    .map(part => `<p>${escape(part).replace(/\n/g, '<br>')}</p>`)
    .join('')

const when = new Intl.DateTimeFormat('nb', { dateStyle: 'long', timeStyle: 'short' })
const person = (a: Address) => (a.name ? `${a.name} &lt;${escape(a.address)}&gt;` : escape(a.address))

const addressesOf = (value: unknown): Address[] =>
  [(value as { value: { name?: string; address?: string }[] } | { value: { name?: string; address?: string }[] }[] | undefined) ?? []]
    .flat()
    .flatMap(object => object.value)
    .filter(a => a.address)
    .map(a => ({ name: a.name ?? '', address: a.address! }))

export async function composeFrom(account: Account, owner: string, id: string, mode: ComposeMode): Promise<ComposeStart> {
  const { parsed } = await load(account, id)
  const from = addressesOf(parsed.from)
  const to = addressesOf(parsed.to)
  const cc = addressesOf(parsed.cc)
  const date = parsed.date ?? new Date()
  const originalHtml = sanitizeCompose(parsed.html || paragraphs(parsed.text ?? ''))
  const subject = parsed.subject ?? ''

  if (mode === 'draft') {
    const attachments: Upload[] = []
    for (const attachment of parsed.attachments) {
      if (isInlinePart(attachment)) continue
      attachments.push(saveUpload(owner, { name: attachment.filename || 'vedlegg', type: attachment.contentType, bytes: attachment.content }))
    }
    const draftId = parsed.headers.get(DRAFT_HEADER.toLowerCase())
    const references = [parsed.references ?? []].flat()
    return {
      to,
      cc,
      bcc: addressesOf(parsed.bcc),
      subject,
      html: originalHtml,
      replyTo: null,
      forwardOf: null,
      draftId: typeof draftId === 'string' && DRAFT_ID.test(draftId) ? draftId : null,
      threading: parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo, references } : null,
      attachments,
    }
  }

  if (mode === 'forward') {
    const header =
      `<p>---------- Videresendt melding ----------</p><p>Fra: ${from.map(person).join(', ')}<br>Dato: ${escape(when.format(date))}` +
      `<br>Emne: ${escape(subject)}<br>Til: ${to.map(person).join(', ')}</p>`
    return {
      to: [],
      cc: [],
      bcc: [],
      subject: /^(fwd?|vs|vl):/i.test(subject.trim()) ? subject : `Fwd: ${subject}`,
      html: `<p></p>${header}<blockquote>${originalHtml}</blockquote>`,
      replyTo: null,
      forwardOf: id,
      draftId: null,
      threading: null,
      attachments: [],
    }
  }

  // An answer goes to whoever the sender asked answers to, and to the recipients of a mail the member wrote themselves
  const own = (a: Address) => a.address.toLowerCase() === account.email.toLowerCase()
  const replyAddresses = addressesOf(parsed.replyTo)
  const first = from.every(own) && from.length > 0 ? to : replyAddresses.length > 0 ? replyAddresses : from
  const seen = new Set(first.map(a => a.address.toLowerCase()))
  const others =
    mode === 'replyAll'
      ? [...to, ...cc].filter(a => {
          const key = a.address.toLowerCase()
          if (own(a) || seen.has(key)) return false
          seen.add(key)
          return true
        })
      : []

  const sender = from[0] ? from[0].name || from[0].address : 'avsenderen'
  return {
    to: first,
    cc: others,
    bcc: [],
    subject: isReply(subject) ? subject : `Re: ${subject}`,
    html: `<p></p><p>${escape(when.format(date))} skrev ${escape(sender)}:</p><blockquote>${originalHtml}</blockquote>`,
    replyTo: id,
    forwardOf: null,
    draftId: null,
    threading: null,
    attachments: [],
  }
}
