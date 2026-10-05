import { simpleParser, type ParsedMail } from 'mailparser'
import MailComposer from 'nodemailer/lib/mail-composer'
import { previewOf } from '../src/mail/html.ts'
import type { Account, Address, FolderInfo, Head, MailBackend, SearchQuery } from '../src/mail/backend.ts'

// Stands in for the mail server (Dovecot and Postfix) during local development: every
// member's mailbox lives in memory, holds real RFC 822 messages, and starts out with a few
// mails to look at. Mail sent between the mock users arrives in the other's inbox; mail to
// anyone else goes nowhere. Never deployed: the Docker image only contains src/.

interface Stored {
  uid: number
  raw: Buffer
  flags: Set<string>
  date: Date
  parsed?: ParsedMail
}

interface Folder {
  specialUse: string | null
  uidValidity: number
  nextUid: number
  messages: Map<number, Stored>
}

const FOLDERS: [path: string, specialUse: string | null][] = [
  ['INBOX', null],
  ['Sent', '\\Sent'],
  ['Drafts', '\\Drafts'],
  ['Trash', '\\Trash'],
  ['Junk', '\\Junk'],
]

const boxes = new Map<string, Promise<Map<string, Folder>>>()
let nextValidity = 1000

const newFolder = (specialUse: string | null): Folder => ({
  specialUse,
  uidValidity: nextValidity++,
  nextUid: 1,
  messages: new Map(),
})

const addToFolder = (folder: Folder, raw: Buffer, flags: string[], date: Date) => {
  const uid = folder.nextUid++
  folder.messages.set(uid, { uid, raw, flags: new Set(flags), date })
  return uid
}

// --- The mails each user starts with ---

interface Draft {
  from: string
  to: string
  subject: string
  text?: string
  html?: string
  hoursAgo: number
  messageId?: string
  inReplyTo?: string
  references?: string[]
  attachments?: { filename: string; content: string | Buffer; contentType?: string; cid?: string }[]
}

const DEV = 'Dev Bruker <dev@tebonsma.test>'
const ADMIN = 'Admin Bruker <admin@tebonsma.test>'

const build = (draft: Draft) =>
  new MailComposer({
    from: draft.from,
    to: draft.to,
    subject: draft.subject,
    text: draft.text,
    html: draft.html,
    date: new Date(Date.now() - draft.hoursAgo * 3_600_000),
    messageId: draft.messageId,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    attachments: draft.attachments,
  })
    .compile()
    .build()

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

// The first two mails are a thread, with the replies in the mailbox of whoever wrote them
const THREAD = ['<sommerfest-1@tebonsma.test>', '<sommerfest-2@tebonsma.test>', '<sommerfest-3@tebonsma.test>']

const SEED: { owner: 'dev' | 'admin'; folder: string; flags: string[]; draft: Draft }[] = [
  {
    owner: 'dev',
    folder: 'INBOX',
    flags: [],
    draft: {
      from: 'Teb Styret <styret@tebonsma.test>',
      to: DEV,
      subject: 'Velkommen til TEBONSMA-mailen',
      text: 'Hei!\n\nDette er mailen din på tebonsma.no. Her kan du lese, skrive og dele mail, akkurat som i en vanlig mailklient.\n\nHilsen styret',
      hoursAgo: 1,
    },
  },
  {
    owner: 'dev',
    folder: 'INBOX',
    flags: ['\\Seen'],
    draft: {
      from: ADMIN,
      to: DEV,
      subject: 'Sommerfest: hva skal vi gjøre?',
      html: '<p>Hei!</p><p>Vi må bestemme <strong>dato</strong> og sted for sommerfesten. Har du noen ideer?</p><p>Admin</p>',
      hoursAgo: 52,
      messageId: THREAD[0],
    },
  },
  {
    owner: 'dev',
    folder: 'INBOX',
    flags: [],
    draft: {
      from: ADMIN,
      to: DEV,
      subject: 'Re: Sommerfest: hva skal vi gjøre?',
      html: '<p>Lørdag 14. juni passer bra. Jeg booker plassen.</p>',
      hoursAgo: 20,
      messageId: THREAD[2],
      inReplyTo: THREAD[1],
      references: [THREAD[0], THREAD[1]],
    },
  },
  {
    owner: 'dev',
    folder: 'Sent',
    flags: ['\\Seen'],
    draft: {
      from: DEV,
      to: ADMIN,
      subject: 'Re: Sommerfest: hva skal vi gjøre?',
      text: 'Kan vi ta det i juni? Jeg kan ordne grillen.',
      hoursAgo: 30,
      messageId: THREAD[1],
      inReplyTo: THREAD[0],
      references: [THREAD[0]],
    },
  },
  {
    owner: 'dev',
    folder: 'INBOX',
    flags: ['\\Flagged'],
    draft: {
      from: 'Pia Hansen <pia@example.com>',
      to: DEV,
      subject: 'Bilder og referat fra generalforsamlingen',
      text: 'Hei, her er referatet og et par bilder fra generalforsamlingen.',
      hoursAgo: 80,
      attachments: [
        { filename: 'referat.txt', content: 'Referat fra generalforsamlingen\n\n1. Åpning\n2. Regnskap\n3. Valg\n' },
        { filename: 'bord.png', content: PIXEL, contentType: 'image/png' },
      ],
    },
  },
  {
    owner: 'dev',
    folder: 'INBOX',
    flags: [],
    draft: {
      from: 'Test Avsender <test@example.com>',
      to: DEV,
      subject: 'Sikkerhetstest: script, onerror og eksternt bilde',
      html:
        '<p style="color:#0a7a3d;position:fixed;top:0">Denne mailen skal vises uten at noe kjøres.</p>' +
        '<script>document.title="HACKED"; fetch("https://example.com/steal")</script>' +
        '<img src="x" onerror="document.title=\'HACKED\'">' +
        '<img src="https://example.com/tracking.png" alt="sporingsbilde">' +
        '<img src="cid:pixel@tebonsma.test" alt="innebygd bilde" width="40" height="40">' +
        '<form action="https://example.com"><input name="x"></form>' +
        '<a href="javascript:alert(1)">Farlig lenke</a> <a href="https://tebonsma.no">Trygg lenke</a>' +
        '<iframe src="https://example.com"></iframe>',
      hoursAgo: 3,
      attachments: [{ filename: 'pixel.png', content: PIXEL, contentType: 'image/png', cid: 'pixel@tebonsma.test' }],
    },
  },
  {
    owner: 'dev',
    folder: 'INBOX',
    flags: ['\\Seen'],
    draft: {
      from: 'TEBONSMA Nyhetsbrev <nyheter@tebonsma.test>',
      to: DEV,
      subject: 'Nyhetsbrev oktober',
      html: '<h1>Nyhetsbrev</h1><p>Her er <em>siste nytt</em> fra foreningen.</p><ul><li>Ny feed</li><li>Kalender</li><li>Mail</li></ul>',
      hoursAgo: 120,
    },
  },
  {
    owner: 'admin',
    folder: 'INBOX',
    flags: ['\\Seen'],
    draft: {
      from: DEV,
      to: ADMIN,
      subject: 'Re: Sommerfest: hva skal vi gjøre?',
      text: 'Kan vi ta det i juni? Jeg kan ordne grillen.',
      hoursAgo: 30,
      messageId: THREAD[1],
      inReplyTo: THREAD[0],
      references: [THREAD[0]],
    },
  },
  {
    owner: 'admin',
    folder: 'Sent',
    flags: ['\\Seen'],
    draft: {
      from: ADMIN,
      to: DEV,
      subject: 'Sommerfest: hva skal vi gjøre?',
      html: '<p>Hei!</p><p>Vi må bestemme <strong>dato</strong> og sted for sommerfesten. Har du noen ideer?</p><p>Admin</p>',
      hoursAgo: 52,
      messageId: THREAD[0],
    },
  },
  {
    owner: 'admin',
    folder: 'Sent',
    flags: ['\\Seen'],
    draft: {
      from: ADMIN,
      to: DEV,
      subject: 'Re: Sommerfest: hva skal vi gjøre?',
      html: '<p>Lørdag 14. juni passer bra. Jeg booker plassen.</p>',
      hoursAgo: 20,
      messageId: THREAD[2],
      inReplyTo: THREAD[1],
      references: [THREAD[0], THREAD[1]],
    },
  },
  {
    owner: 'admin',
    folder: 'INBOX',
    flags: [],
    draft: {
      from: 'Leverandør AS <post@example.com>',
      to: ADMIN,
      subject: 'Tilbud på telt og benkesett',
      text: 'Hei,\n\nHer er tilbudet vi snakket om. Gi beskjed hvis dere vil ha det.\n\nMvh Leverandør AS',
      hoursAgo: 6,
    },
  },
]

const OWNER_ADDRESS = { dev: 'dev@tebonsma.test', admin: 'admin@tebonsma.test' } as const

async function createBox(email: string) {
  const box = new Map<string, Folder>(FOLDERS.map(([path, use]) => [path, newFolder(use)]))
  const owner = (Object.keys(OWNER_ADDRESS) as (keyof typeof OWNER_ADDRESS)[]).find(name => OWNER_ADDRESS[name] === email)
  // Oldest first, so UIDs follow the order mails arrived in
  const mine = SEED.filter(s => s.owner === owner).sort((a, b) => b.draft.hoursAgo - a.draft.hoursAgo)
  for (const seed of mine) {
    const raw = await build(seed.draft)
    addToFolder(box.get(seed.folder)!, raw, seed.flags, new Date(Date.now() - seed.draft.hoursAgo * 3_600_000))
  }
  return box
}

const boxOf = (email: string) => {
  const key = email.toLowerCase()
  let box = boxes.get(key)
  if (!box) {
    box = createBox(key)
    boxes.set(key, box)
  }
  return box
}

async function folderOf(account: Account, path: string) {
  const folder = (await boxOf(account.email)).get(path)
  if (!folder) throw new Error(`The mock mailbox has no folder ${path}`)
  return folder
}

const parse = async (message: Stored) => (message.parsed ??= await simpleParser(message.raw))

const toAddresses = (value: ParsedMail['to']): Address[] =>
  [value ?? []]
    .flat()
    .flatMap(object => object.value)
    .filter(a => a.address)
    .map(a => ({ name: a.name ?? '', address: a.address! }))

const unfolded = (raw: Buffer) => raw.toString().split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ')

async function matches(message: Stored, query: SearchQuery) {
  const has = (flag: string) => message.flags.has(flag)
  if (query.unseen && has('\\Seen')) return false
  if (query.flagged && !has('\\Flagged')) return false
  if (query.keyword && !has(query.keyword)) return false
  if (query.since && message.date < query.since) return false
  if (query.before && message.date >= query.before) return false
  if (query.header) {
    const [name, value] = query.header
    const line = unfolded(message.raw)
      .split(/\r?\n/)
      .find(l => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    if (!line || !line.toLowerCase().includes(value.toLowerCase())) return false
  }
  if (query.text && !message.raw.toString().toLowerCase().includes(query.text.toLowerCase())) return false
  if (query.from || query.to || query.subject || query.hasAttachment !== undefined) {
    const parsed = await parse(message)
    const includes = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.toLowerCase())
    const names = (list: Address[]) => list.map(a => `${a.name} ${a.address}`).join(' ')
    if (query.from && !includes(names(toAddresses(parsed.from)), query.from)) return false
    if (query.to && !includes(names([...toAddresses(parsed.to), ...toAddresses(parsed.cc)]), query.to)) return false
    if (query.subject && !includes(parsed.subject ?? '', query.subject)) return false
    if (query.hasAttachment !== undefined) {
      const attached = parsed.attachments.some(a => a.contentDisposition === 'attachment')
      if (attached !== query.hasAttachment) return false
    }
  }
  return true
}

const referencesOf = (parsed: ParsedMail) => [parsed.references ?? []].flat()

async function headOf(path: string, folder: Folder, message: Stored): Promise<Head> {
  const parsed = await parse(message)
  return {
    folder: path,
    uid: message.uid,
    uidValidity: folder.uidValidity,
    flags: [...message.flags],
    size: message.raw.length,
    date: (parsed.date ?? message.date).toISOString(),
    subject: parsed.subject ?? '',
    from: toAddresses(parsed.from)[0] ?? null,
    to: toAddresses(parsed.to),
    cc: toAddresses(parsed.cc),
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: referencesOf(parsed),
    hasAttachments: parsed.attachments.some(a => a.contentDisposition === 'attachment'),
    preview: previewOf(parsed.text, parsed.html),
  }
}

export const mockMail: MailBackend = {
  async listFolders(account) {
    const box = await boxOf(account.email)
    return [...box].map(([path, folder]): FolderInfo => {
      const messages = [...folder.messages.values()]
      return {
        path,
        specialUse: folder.specialUse,
        total: messages.length,
        unseen: messages.filter(m => !m.flags.has('\\Seen')).length,
        uidValidity: folder.uidValidity,
      }
    })
  },

  async createFolder(account, path) {
    const box = await boxOf(account.email)
    if (!box.has(path)) box.set(path, newFolder(null))
  },

  async status(account, path) {
    const folder = await folderOf(account, path)
    const messages = [...folder.messages.values()]
    return {
      total: messages.length,
      unseen: messages.filter(m => !m.flags.has('\\Seen')).length,
      uidValidity: folder.uidValidity,
    }
  },

  async search(account, path, query) {
    const folder = await folderOf(account, path)
    const found: number[] = []
    for (const message of folder.messages.values()) if (await matches(message, query)) found.push(message.uid)
    return found.sort((a, b) => a - b)
  },

  async heads(account, path, uids) {
    const folder = await folderOf(account, path)
    const heads: Head[] = []
    for (const uid of uids) {
      const message = folder.messages.get(uid)
      if (message) heads.push(await headOf(path, folder, message))
    }
    return heads
  },

  async fetchRaw(account, path, uid) {
    return (await folderOf(account, path)).messages.get(uid)?.raw ?? null
  },

  async setFlags(account, path, uids, change) {
    const folder = await folderOf(account, path)
    for (const uid of uids) {
      const message = folder.messages.get(uid)
      if (!message) continue
      for (const flag of change.add ?? []) message.flags.add(flag)
      for (const flag of change.remove ?? []) message.flags.delete(flag)
    }
  },

  async move(account, path, uids, destination) {
    const source = await folderOf(account, path)
    const target = await folderOf(account, destination)
    for (const uid of uids) {
      const message = source.messages.get(uid)
      if (!message) continue
      source.messages.delete(uid)
      addToFolder(target, message.raw, [...message.flags], message.date)
    }
  },

  async append(account, path, raw, flags, date = new Date()) {
    return addToFolder(await folderOf(account, path), raw, flags, date)
  },

  async expunge(account, path, uids) {
    const folder = await folderOf(account, path)
    for (const uid of uids) folder.messages.delete(uid)
  },

  async submit(account, { from, to, raw }) {
    for (const recipient of to) {
      const address = recipient.toLowerCase()
      if (!address.endsWith('@tebonsma.test')) {
        console.log(`[mock mail] ${from} -> ${recipient}: not delivered, only the mock users get mail`)
        continue
      }
      const inbox = (await boxOf(address)).get('INBOX')!
      addToFolder(inbox, raw, [], new Date())
    }
  },
}
