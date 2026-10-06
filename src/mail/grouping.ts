import type { Head } from './backend.ts'

// Mails that belong to the same conversation. The server's own THREAD command isn't used, so
// this works the same against the mock and the real server.

const REPLY_PREFIX = /^(re|sv|vs|aw|odp)(\[\d+\])?:/i
const ANY_PREFIX = /^((re|fwd?|fw|sv|vs|vl|aw|odp)(\[\d+\])?:\s*)+/i
// Without references, mails with the same subject only count as one conversation when they
// are this close together
const SUBJECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export const isReply = (subject: string) => REPLY_PREFIX.test(subject.trim())
export const plainSubject = (subject: string) => subject.replace(ANY_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase()

class Groups {
  private parent: number[]

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index)
  }

  find(index: number): number {
    while (this.parent[index] !== index) {
      this.parent[index] = this.parent[this.parent[index]]
      index = this.parent[index]
    }
    return index
  }

  union(a: number, b: number) {
    this.parent[this.find(a)] = this.find(b)
  }
}

const idsOf = (head: Head) => [head.messageId, head.inReplyTo, ...head.references].filter((id): id is string => !!id)

// Splits the mails into conversations: mails that share a Message-ID, In-Reply-To or References
// entry are one conversation, and so are replies with the same subject close in time. Each
// conversation is oldest first, and a mail that is in several folders (a reply in Sent, the
// original in the inbox) is in the same conversation as the rest.
export function groupHeads(heads: Head[]): Head[][] {
  const groups = new Groups(heads.length)

  const seen = new Map<string, number>()
  heads.forEach((head, index) => {
    for (const id of idsOf(head)) {
      const earlier = seen.get(id)
      if (earlier === undefined) seen.set(id, index)
      else groups.union(index, earlier)
    }
  })

  const bySubject = new Map<string, number[]>()
  heads.forEach((head, index) => {
    const subject = plainSubject(head.subject)
    if (subject) bySubject.set(subject, [...(bySubject.get(subject) ?? []), index])
  })
  for (const indexes of bySubject.values()) {
    const ordered = [...indexes].sort((a, b) => heads[a].date.localeCompare(heads[b].date))
    for (let i = 1; i < ordered.length; i++) {
      const [earlier, later] = [heads[ordered[i - 1]], heads[ordered[i]]]
      const close = new Date(later.date).getTime() - new Date(earlier.date).getTime() <= SUBJECT_WINDOW_MS
      if (close && (isReply(earlier.subject) || isReply(later.subject))) groups.union(ordered[i - 1], ordered[i])
    }
  }

  const byRoot = new Map<number, Head[]>()
  heads.forEach((head, index) => {
    const root = groups.find(index)
    byRoot.set(root, [...(byRoot.get(root) ?? []), head])
  })
  return [...byRoot.values()].map(group => group.sort((a, b) => a.date.localeCompare(b.date) || a.uid - b.uid))
}
