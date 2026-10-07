import { HTTPException } from 'hono/http-exception'
import { backend, type Account, type Head } from './backend.ts'
import { groupHeads, plainSubject } from './grouping.ts'
import {
  decodeId,
  headsInOrder,
  openMailbox,
  SEEN,
  summarize,
  type Mailbox,
  type MessageSummary,
  type Role,
} from './mail.ts'

// The conversation a mail is part of can have mails in other folders: the replies are in Sent,
// older ones may be archived. Mails in the bin and in junk aren't looked through.
const SEARCHED: Role[] = ['inbox', 'sent', 'archive']
const MAX_MESSAGES = 50
const ROUNDS = 3
const MAX_IDS_PER_ROUND = 20
const MAX_SAME_SUBJECT = 50

const headerIds = (head: Head) => [head.messageId, head.inReplyTo, ...head.references].filter((id): id is string => !!id)

export interface Conversation {
  // The mails oldest first, as they were found. Mails that were unread when the conversation
  // was opened say so, and have been marked as read since.
  messages: MessageSummary[]
}

export async function openConversation(account: Account, id: string): Promise<Conversation> {
  const ref = decodeId(id)
  const mailbox: Mailbox = await openMailbox(account)
  const own = [...mailbox.paths.values(), ...mailbox.own].find(f => f.path === ref.path)
  if (!own || own.uidValidity !== ref.uidValidity) throw new HTTPException(404, { message: 'Mailen finnes ikke lenger' })
  const [start] = await backend().heads(account, own.path, [ref.uid])
  if (!start) throw new HTTPException(404, { message: 'Mailen finnes ikke lenger' })

  // Looked through: the usual folders, and the one the mail is in
  const folders = SEARCHED.flatMap(role => mailbox.paths.get(role) ?? [])
  if (!folders.some(f => f.path === own.path)) folders.push(own)

  const known = new Map<string, Head>([[`${start.folder}:${start.uid}`, start]])
  const asked = new Set<string>()
  const add = (heads: Head[]) => {
    let added = false
    for (const head of heads) {
      const key = `${head.folder}:${head.uid}`
      if (known.has(key) || known.size >= MAX_MESSAGES) continue
      known.set(key, head)
      added = true
    }
    return added
  }

  // Replies with the same subject are one conversation even without references
  if (plainSubject(start.subject)) {
    for (const folder of folders) {
      const uids = (await backend().search(account, folder.path, { subject: plainSubject(start.subject) })).slice(-MAX_SAME_SUBJECT)
      add(await backend().heads(account, folder.path, uids))
    }
  }

  // Then the mails that mention each other, a few rounds out
  for (let round = 0; round < ROUNDS; round++) {
    const wanted = [...new Set([...known.values()].flatMap(headerIds))].filter(wantedId => !asked.has(wantedId)).slice(0, MAX_IDS_PER_ROUND)
    if (wanted.length === 0) break
    let added = false
    for (const wantedId of wanted) {
      asked.add(wantedId)
      for (const folder of folders) {
        // Mails that are the one asked for, and mails that refer to it
        const found = new Set<number>()
        for (const header of ['Message-ID', 'References', 'In-Reply-To'] as const) {
          for (const uid of await backend().search(account, folder.path, { header: [header, wantedId] })) found.add(uid)
        }
        if (found.size > 0) added = add(await headsInOrder(account, folder.path, [...found])) || added
      }
    }
    if (!added) break
  }

  const group = groupHeads([...known.values()]).find(g => g.some(head => head.folder === start.folder && head.uid === start.uid))!
  const messages = group.map(head => summarize(mailbox, head))

  // Opening the conversation reads the mails of it that are in the folder it was opened from
  const unread = group.filter(head => head.folder === start.folder && !head.flags.includes(SEEN))
  if (unread.length > 0) await backend().setFlags(account, start.folder, unread.map(head => head.uid), { add: [SEEN] })
  return { messages }
}
