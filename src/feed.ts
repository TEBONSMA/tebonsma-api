import { randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { db, transaction } from './db.ts'
import { voidEventMarkets } from './bets.ts'
import { eventOf, isEvent, saveEvent, type EventInput } from './events.ts'
import { getMembers, type PublicMember } from './members.ts'

// Who is looking. Visitors who aren't logged in are null and only see public posts.
export interface Viewer {
  username: string
  admin: boolean
}

export type Visibility = 'public' | 'members'

export const SORTS = {
  new: 'p.created_at DESC',
  old: 'p.created_at ASC',
  likes: 'like_count DESC, p.created_at DESC',
  comments: 'comment_count DESC, p.created_at DESC',
} as const
export type Sort = keyof typeof SORTS

export const MAX_ATTACHMENTS = 10
export const MAX_COMMENT_ATTACHMENTS = 4
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
// Uploads that never ended up in a post are removed after this long
const UNATTACHED_TTL_MS = 24 * 60 * 60 * 1000
const MAX_UNATTACHED_PER_MEMBER = 30
const NOTIFICATIONS_SHOWN = 30
const EXCERPT_LENGTH = 120

db.exec(`
  CREATE TABLE IF NOT EXISTS feed_posts (
    id         TEXT PRIMARY KEY,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('public', 'members')),
    created_at TEXT NOT NULL,
    edited_at  TEXT,
    pinned_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS feed_posts_created ON feed_posts (created_at DESC);

  -- A file is in a post (post_id) or on a comment (comment_id; its post is the comment's).
  -- Both are empty from the upload until the post or comment is saved.
  CREATE TABLE IF NOT EXISTS feed_attachments (
    id         TEXT PRIMARY KEY,
    post_id    TEXT REFERENCES feed_posts (id) ON DELETE CASCADE,
    comment_id TEXT REFERENCES feed_comments (id) ON DELETE CASCADE,
    owner      TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    name       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    is_image   INTEGER NOT NULL,
    data       BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS feed_attachments_post ON feed_attachments (post_id);
  CREATE INDEX IF NOT EXISTS feed_attachments_comment ON feed_attachments (comment_id);

  CREATE TABLE IF NOT EXISTS feed_poll_options (
    id       TEXT PRIMARY KEY,
    post_id  TEXT NOT NULL REFERENCES feed_posts (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    text     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS feed_poll_options_post ON feed_poll_options (post_id);

  CREATE TABLE IF NOT EXISTS feed_poll_votes (
    post_id   TEXT NOT NULL REFERENCES feed_posts (id) ON DELETE CASCADE,
    username  TEXT NOT NULL,
    option_id TEXT NOT NULL REFERENCES feed_poll_options (id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, username)
  );

  CREATE TABLE IF NOT EXISTS feed_post_likes (
    post_id    TEXT NOT NULL REFERENCES feed_posts (id) ON DELETE CASCADE,
    username   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (post_id, username)
  );

  -- A comment that is deleted while it has replies stays as an empty placeholder
  CREATE TABLE IF NOT EXISTS feed_comments (
    id         TEXT PRIMARY KEY,
    post_id    TEXT NOT NULL REFERENCES feed_posts (id) ON DELETE CASCADE,
    parent_id  TEXT REFERENCES feed_comments (id) ON DELETE CASCADE,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS feed_comments_post ON feed_comments (post_id, created_at);

  CREATE TABLE IF NOT EXISTS feed_comment_likes (
    comment_id TEXT NOT NULL REFERENCES feed_comments (id) ON DELETE CASCADE,
    username   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (comment_id, username)
  );

  CREATE TABLE IF NOT EXISTS feed_reports (
    post_id    TEXT NOT NULL REFERENCES feed_posts (id) ON DELETE CASCADE,
    reporter   TEXT NOT NULL,
    reason     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (post_id, reporter)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         TEXT PRIMARY KEY,
    recipient  TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('comment', 'reply')),
    actor      TEXT NOT NULL,
    post_id    TEXT NOT NULL REFERENCES feed_posts (id) ON DELETE CASCADE,
    comment_id TEXT NOT NULL REFERENCES feed_comments (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    read_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS notifications_recipient ON notifications (recipient, created_at DESC);

  -- Notifications for every member at once: a new event, or a message from its organizer.
  -- Kept as one row, with a note of who has read it, so the API needn't know every member.
  CREATE TABLE IF NOT EXISTS announcements (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('event', 'announcement')),
    actor      TEXT NOT NULL,
    post_id    TEXT NOT NULL REFERENCES feed_posts (id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS announcements_created ON announcements (created_at DESC);

  CREATE TABLE IF NOT EXISTS announcement_reads (
    announcement_id TEXT NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
    username        TEXT NOT NULL,
    PRIMARY KEY (announcement_id, username)
  );
`)

// An upload that is neither in a post nor on a comment yet
const UNATTACHED = 'post_id IS NULL AND comment_id IS NULL'

const now = () => new Date().toISOString()
const notFound = () => new HTTPException(404, { message: 'Innlegget finnes ikke' })

// --- Posts ---

interface PostRow {
  id: string
  author: string
  body: string
  visibility: Visibility
  created_at: string
  edited_at: string | null
  pinned_at: string | null
  like_count: number
  comment_count: number
}

interface AttachmentRow {
  id: string
  name: string
  mime: string
  size: number
  is_image: number
}

const POST_SELECT = `
  SELECT p.*,
    (SELECT COUNT(*) FROM feed_post_likes l WHERE l.post_id = p.id) AS like_count,
    (SELECT COUNT(*) FROM feed_comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count
  FROM feed_posts p
`

function findPost(viewer: Viewer | null, id: string) {
  const row = db.prepare(`${POST_SELECT} WHERE p.id = ?`).get(id) as PostRow | undefined
  if (!row) throw notFound()
  if (row.visibility === 'members' && !viewer) {
    throw new HTTPException(401, { message: 'Logg inn for å se dette innlegget' })
  }
  return row
}

function pollOf(postId: string, viewer: Viewer | null) {
  const options = db
    .prepare(
      `SELECT o.id, o.text, (SELECT COUNT(*) FROM feed_poll_votes v WHERE v.option_id = o.id) AS votes
       FROM feed_poll_options o WHERE o.post_id = ? ORDER BY o.position`,
    )
    .all(postId) as { id: string; text: string; votes: number }[]
  if (options.length === 0) return null

  const mine = viewer
    ? (db.prepare('SELECT option_id FROM feed_poll_votes WHERE post_id = ? AND username = ?').get(postId, viewer.username) as
        | { option_id: string }
        | undefined)
    : undefined
  return {
    options,
    totalVotes: options.reduce((sum, option) => sum + option.votes, 0),
    myVote: mine?.option_id ?? null,
  }
}

const toAttachment = (a: AttachmentRow) => ({
  id: a.id,
  name: a.name,
  mime: a.mime,
  size: a.size,
  isImage: a.is_image === 1,
  url: `/feed/attachments/${a.id}`,
})

async function toPosts(rows: PostRow[], viewer: Viewer | null) {
  const members = await getMembers(rows.map(row => row.author))
  const has = (table: string, column: string, postId: string) =>
    !!viewer && !!db.prepare(`SELECT 1 FROM ${table} WHERE post_id = ? AND ${column} = ?`).get(postId, viewer.username)

  return rows.map(row => {
    const attachments = db
      .prepare('SELECT id, name, mime, size, is_image FROM feed_attachments WHERE post_id = ? ORDER BY position')
      .all(row.id) as unknown as AttachmentRow[]
    return {
      id: row.id,
      author: members.get(row.author)!,
      body: row.body,
      visibility: row.visibility,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      pinned: row.pinned_at !== null,
      attachments: attachments.map(toAttachment),
      poll: pollOf(row.id, viewer),
      event: eventOf(row.id, viewer, row.visibility),
      likeCount: row.like_count,
      liked: has('feed_post_likes', 'username', row.id),
      commentCount: row.comment_count,
      mine: viewer?.username === row.author,
      reported: has('feed_reports', 'reporter', row.id),
    }
  })
}

export type Post = Awaited<ReturnType<typeof toPosts>>[number]

export async function getPost(viewer: Viewer | null, id: string) {
  return (await toPosts([findPost(viewer, id)], viewer))[0]
}

export async function listPosts(viewer: Viewer | null, sort: Sort, offset: number, limit: number) {
  // Pinned posts come first whatever the order is. One row more than asked for tells
  // whether there is another page.
  const rows = db
    .prepare(
      `${POST_SELECT} WHERE (? = 1 OR p.visibility = 'public')
       ORDER BY p.pinned_at IS NULL, p.pinned_at DESC, ${SORTS[sort]} LIMIT ? OFFSET ?`,
    )
    .all(viewer ? 1 : 0, limit + 1, offset) as unknown as PostRow[]

  const hasMore = rows.length > limit
  return { posts: await toPosts(rows.slice(0, limit), viewer), nextOffset: hasMore ? offset + limit : null }
}

// What a member has posted, newest first: their events, or everything else. Only for members,
// who see closed posts too.
export async function listPostsBy(viewer: Viewer, author: string, events: boolean, offset: number, limit: number) {
  const rows = db
    .prepare(
      `${POST_SELECT} LEFT JOIN events e ON e.post_id = p.id
       WHERE p.author = ? AND (e.post_id IS NOT NULL) = ?
       ORDER BY ${events ? 'e.starts_at IS NULL DESC, e.starts_at DESC,' : ''} p.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(author, events ? 1 : 0, limit + 1, offset) as unknown as PostRow[]

  const hasMore = rows.length > limit
  return { posts: await toPosts(rows.slice(0, limit), viewer), nextOffset: hasMore ? offset + limit : null }
}

export function countPostsBy(author: string) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, COUNT(e.post_id) AS events FROM feed_posts p
       LEFT JOIN events e ON e.post_id = p.id WHERE p.author = ?`,
    )
    .get(author) as { total: number; events: number }
  return { posts: row.total - row.events, events: row.events }
}

const MAX_EVENTS_LISTED = 200

// Events in the order they take place, the ones without a date last. With a period, only
// the events that overlap it.
export async function listEvents(viewer: Viewer | null, from: string | null, to: string | null) {
  // Read the other way round, so that past the limit it is the oldest events that are left
  // out and never the coming ones, then turned the right way
  const rows = db
    .prepare(
      `${POST_SELECT} JOIN events e ON e.post_id = p.id
       WHERE (? = 1 OR p.visibility = 'public')
         AND (? IS NULL OR e.ends_at >= ?) AND (? IS NULL OR e.starts_at <= ?)
       ORDER BY e.starts_at IS NULL DESC, e.starts_at DESC, p.created_at DESC LIMIT ?`,
    )
    .all(viewer ? 1 : 0, from, from, to, to, MAX_EVENTS_LISTED) as unknown as PostRow[]
  return toPosts(rows.reverse(), viewer)
}

export interface PostInput {
  body: string
  visibility: Visibility
  attachmentIds: string[]
  // Makes the post an event
  event: EventInput | null
}

// Puts the listed uploads on the post in the given order and drops the ones left out.
// Only the member's own uploads count, and never ones that belong to another post.
function setAttachments(postId: string, owner: string, ids: string[]) {
  ids.forEach((id, position) => {
    const { changes } = db
      .prepare(
        'UPDATE feed_attachments SET post_id = ?, position = ? WHERE id = ? AND owner = ? AND comment_id IS NULL AND (post_id IS NULL OR post_id = ?)',
      )
      .run(postId, position, id, owner, postId)
    if (changes === 0) throw new HTTPException(400, { message: 'Et vedlegg finnes ikke lenger. Last det opp på nytt.' })
  })
  const kept = ids.map(() => '?').join(', ')
  db.prepare(`DELETE FROM feed_attachments WHERE post_id = ? AND id NOT IN (${kept})`).run(postId, ...ids)
}

export function createPost(viewer: Viewer, input: PostInput, pollOptions: string[]) {
  const id = randomUUID()
  transaction(() => {
    db.prepare('INSERT INTO feed_posts (id, author, body, visibility, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      viewer.username,
      input.body,
      input.visibility,
      now(),
    )
    setAttachments(id, viewer.username, input.attachmentIds)
    pollOptions.forEach((text, position) => {
      db.prepare('INSERT INTO feed_poll_options (id, post_id, position, text) VALUES (?, ?, ?, ?)').run(randomUUID(), id, position, text)
    })
    if (input.event) {
      saveEvent(id, input.event)
      announce('event', viewer.username, id, input.event.title)
    }
  })
  return getPost(viewer, id)
}

export function updatePost(viewer: Viewer, id: string, input: PostInput) {
  const post = findPost(viewer, id)
  if (post.author !== viewer.username) throw new HTTPException(403, { message: 'Du kan bare redigere egne innlegg' })
  // An event stays an event, and a post a post
  if (isEvent(id) !== (input.event !== null)) throw new HTTPException(400, { message: 'Ugyldig forespørsel' })

  transaction(() => {
    db.prepare('UPDATE feed_posts SET body = ?, visibility = ?, edited_at = ? WHERE id = ?').run(input.body, input.visibility, now(), id)
    setAttachments(id, post.author, input.attachmentIds)
    if (input.event) saveEvent(id, input.event)
  })
  return getPost(viewer, id)
}

export function deletePost(viewer: Viewer, id: string) {
  const post = findPost(viewer, id)
  if (post.author !== viewer.username && !viewer.admin) {
    throw new HTTPException(403, { message: 'Du kan bare slette egne innlegg' })
  }
  transaction(() => {
    // Bets on an event are paid back before it goes
    voidEventMarkets(id)
    db.prepare('DELETE FROM feed_posts WHERE id = ?').run(id)
  })
}

export function setPinned(viewer: Viewer, id: string, pinned: boolean) {
  if (!viewer.admin) throw new HTTPException(403, { message: 'Bare administratorer kan feste innlegg' })
  findPost(viewer, id)
  db.prepare('UPDATE feed_posts SET pinned_at = ? WHERE id = ?').run(pinned ? now() : null, id)
  return getPost(viewer, id)
}

export function setPostLike(viewer: Viewer, id: string, liked: boolean) {
  findPost(viewer, id)
  if (liked) {
    db.prepare('INSERT OR IGNORE INTO feed_post_likes (post_id, username, created_at) VALUES (?, ?, ?)').run(id, viewer.username, now())
  } else {
    db.prepare('DELETE FROM feed_post_likes WHERE post_id = ? AND username = ?').run(id, viewer.username)
  }
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM feed_post_likes WHERE post_id = ?').get(id) as { n: number }
  return { liked, likeCount: n }
}

async function likers(table: string, column: string, id: string): Promise<PublicMember[]> {
  const rows = db.prepare(`SELECT username FROM ${table} WHERE ${column} = ? ORDER BY created_at`).all(id) as { username: string }[]
  const members = await getMembers(rows.map(row => row.username))
  return rows.map(row => members.get(row.username)!)
}

export function getPostLikers(viewer: Viewer, id: string) {
  findPost(viewer, id)
  return likers('feed_post_likes', 'post_id', id)
}

// One vote per member. Passing no option takes the vote back.
export function vote(viewer: Viewer, id: string, optionId: string | null) {
  findPost(viewer, id)
  if (optionId === null) {
    db.prepare('DELETE FROM feed_poll_votes WHERE post_id = ? AND username = ?').run(id, viewer.username)
  } else {
    if (!db.prepare('SELECT 1 FROM feed_poll_options WHERE id = ? AND post_id = ?').get(optionId, id)) {
      throw new HTTPException(400, { message: 'Ukjent svaralternativ' })
    }
    db.prepare(`
      INSERT INTO feed_poll_votes (post_id, username, option_id) VALUES (?, ?, ?)
      ON CONFLICT (post_id, username) DO UPDATE SET option_id = excluded.option_id
    `).run(id, viewer.username, optionId)
  }
  return pollOf(id, viewer)
}

// --- Reports ---

export function reportPost(viewer: Viewer, id: string, reason: string) {
  findPost(viewer, id)
  db.prepare(`
    INSERT INTO feed_reports (post_id, reporter, reason, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (post_id, reporter) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at
  `).run(id, viewer.username, reason, now())
}

const requireAdmin = (viewer: Viewer) => {
  if (!viewer.admin) throw new HTTPException(403, { message: 'Bare for administratorer' })
}

export async function listReports(viewer: Viewer) {
  requireAdmin(viewer)
  const reports = db.prepare('SELECT post_id, reporter, reason, created_at FROM feed_reports ORDER BY created_at DESC').all() as {
    post_id: string
    reporter: string
    reason: string
    created_at: string
  }[]
  const postIds = [...new Set(reports.map(report => report.post_id))]
  const posts = await toPosts(postIds.map(id => findPost(viewer, id)), viewer)
  const members = await getMembers(reports.map(report => report.reporter))

  return posts.map(post => ({
    post,
    reports: reports
      .filter(report => report.post_id === post.id)
      .map(report => ({ reporter: members.get(report.reporter)!, reason: report.reason, createdAt: report.created_at })),
  }))
}

export function dismissReports(viewer: Viewer, id: string) {
  requireAdmin(viewer)
  db.prepare('DELETE FROM feed_reports WHERE post_id = ?').run(id)
}

// --- Comments ---

interface CommentRow {
  id: string
  post_id: string
  parent_id: string | null
  author: string
  body: string
  created_at: string
  deleted_at: string | null
  like_count: number
}

const COMMENT_SELECT = `
  SELECT c.*, (SELECT COUNT(*) FROM feed_comment_likes l WHERE l.comment_id = c.id) AS like_count
  FROM feed_comments c
`

async function toComments(rows: CommentRow[], viewer: Viewer | null) {
  const members = await getMembers(rows.filter(row => !row.deleted_at).map(row => row.author))
  return rows.map(row => {
    const deleted = row.deleted_at !== null
    const attachments = db
      .prepare('SELECT id, name, mime, size, is_image FROM feed_attachments WHERE comment_id = ? ORDER BY position')
      .all(row.id) as unknown as AttachmentRow[]
    return {
      id: row.id,
      parentId: row.parent_id,
      // Nothing about a deleted comment is sent, not even who wrote it
      author: deleted ? null : members.get(row.author)!,
      body: row.body,
      attachments: attachments.map(toAttachment),
      createdAt: row.created_at,
      deleted,
      likeCount: row.like_count,
      liked:
        !!viewer &&
        !!db.prepare('SELECT 1 FROM feed_comment_likes WHERE comment_id = ? AND username = ?').get(row.id, viewer.username),
      mine: !deleted && viewer?.username === row.author,
    }
  })
}

// Flat and oldest first; replies point at their top-level comment through parentId
export function listComments(viewer: Viewer | null, postId: string) {
  findPost(viewer, postId)
  const rows = db.prepare(`${COMMENT_SELECT} WHERE c.post_id = ? ORDER BY c.created_at`).all(postId) as unknown as CommentRow[]
  return toComments(rows, viewer)
}

function findComment(viewer: Viewer, id: string) {
  const row = db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(id) as CommentRow | undefined
  if (!row || row.deleted_at) throw new HTTPException(404, { message: 'Kommentaren finnes ikke' })
  findPost(viewer, row.post_id)
  return row
}

export async function addComment(viewer: Viewer, postId: string, body: string, parentId: string | null, attachmentIds: string[]) {
  const post = findPost(viewer, postId)
  let parent: CommentRow | null = null
  if (parentId) {
    parent = findComment(viewer, parentId)
    if (parent.post_id !== postId) throw new HTTPException(400, { message: 'Kommentaren hører til et annet innlegg' })
  }

  const id = randomUUID()
  transaction(() => {
    // Threads are one level deep, so a reply to a reply joins the same thread
    db.prepare('INSERT INTO feed_comments (id, post_id, parent_id, author, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      postId,
      parent ? (parent.parent_id ?? parent.id) : null,
      viewer.username,
      body,
      now(),
    )
    attachmentIds.forEach((attachmentId, position) => {
      const { changes } = db
        .prepare(`UPDATE feed_attachments SET comment_id = ?, position = ? WHERE id = ? AND owner = ? AND ${UNATTACHED}`)
        .run(id, position, attachmentId, viewer.username)
      if (changes === 0) throw new HTTPException(400, { message: 'Et vedlegg finnes ikke lenger. Last det opp på nytt.' })
    })

    // The post's author hears about every comment, and whoever is answered about the reply
    const recipients = new Map([[post.author, 'comment']])
    if (parent) recipients.set(parent.author, 'reply')
    recipients.delete(viewer.username)
    for (const [recipient, kind] of recipients) {
      db.prepare('INSERT INTO notifications (id, recipient, kind, actor, post_id, comment_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        randomUUID(),
        recipient,
        kind,
        viewer.username,
        postId,
        id,
        now(),
      )
    }
  })

  const row = db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(id) as unknown as CommentRow
  return (await toComments([row], viewer))[0]
}

export function deleteComment(viewer: Viewer, id: string) {
  const comment = findComment(viewer, id)
  if (comment.author !== viewer.username && !viewer.admin) {
    throw new HTTPException(403, { message: 'Du kan bare slette egne kommentarer' })
  }
  const replies = (parentId: string) =>
    (db.prepare('SELECT COUNT(*) AS n FROM feed_comments WHERE parent_id = ?').get(parentId) as { n: number }).n

  transaction(() => {
    if (replies(id) > 0) {
      db.prepare("UPDATE feed_comments SET body = '', deleted_at = ? WHERE id = ?").run(now(), id)
      db.prepare('DELETE FROM feed_comment_likes WHERE comment_id = ?').run(id)
      db.prepare('DELETE FROM feed_attachments WHERE comment_id = ?').run(id)
      db.prepare('DELETE FROM notifications WHERE comment_id = ?').run(id)
      return
    }
    db.prepare('DELETE FROM feed_comments WHERE id = ?').run(id)
    // A placeholder with no replies left has nothing to hold together
    if (comment.parent_id && replies(comment.parent_id) === 0) {
      db.prepare('DELETE FROM feed_comments WHERE id = ? AND deleted_at IS NOT NULL').run(comment.parent_id)
    }
  })
}

export function setCommentLike(viewer: Viewer, id: string, liked: boolean) {
  findComment(viewer, id)
  if (liked) {
    db.prepare('INSERT OR IGNORE INTO feed_comment_likes (comment_id, username, created_at) VALUES (?, ?, ?)').run(id, viewer.username, now())
  } else {
    db.prepare('DELETE FROM feed_comment_likes WHERE comment_id = ? AND username = ?').run(id, viewer.username)
  }
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM feed_comment_likes WHERE comment_id = ?').get(id) as { n: number }
  return { liked, likeCount: n }
}

export function getCommentLikers(viewer: Viewer, id: string) {
  findComment(viewer, id)
  return likers('feed_comment_likes', 'comment_id', id)
}

// --- Attachments ---

// Only these are shown as pictures. Everything else, SVG included, is a download.
function sniffImage(bytes: Uint8Array) {
  const starts = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte)
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (starts(0x52, 0x49, 0x46, 0x46) && Buffer.from(bytes.subarray(8, 12)).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

const cleanFileName = (name: string) =>
  name
    .replace(/[\u0000-\u001f\u007f/\\]/g, '')
    .trim()
    .slice(-120) || 'fil'

export function saveAttachment(viewer: Viewer, file: { name: string; type: string; bytes: Uint8Array }) {
  db.prepare(`DELETE FROM feed_attachments WHERE ${UNATTACHED} AND created_at < ?`).run(
    new Date(Date.now() - UNATTACHED_TTL_MS).toISOString(),
  )
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM feed_attachments WHERE ${UNATTACHED} AND owner = ?`).get(viewer.username) as {
    n: number
  }
  if (n >= MAX_UNATTACHED_PER_MEMBER) {
    throw new HTTPException(429, { message: 'Du har lastet opp mange filer uten å publisere. Prøv igjen senere.' })
  }

  const image = sniffImage(file.bytes)
  const mime = image ?? (/^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : 'application/octet-stream')
  const attachment = { id: randomUUID(), name: cleanFileName(file.name), mime, size: file.bytes.length, isImage: image !== null }
  db.prepare(
    'INSERT INTO feed_attachments (id, owner, name, mime, size, is_image, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(attachment.id, viewer.username, attachment.name, mime, attachment.size, image ? 1 : 0, file.bytes, now())
  return { ...attachment, url: `/feed/attachments/${attachment.id}` }
}

export function readAttachment(viewer: Viewer | null, id: string) {
  const row = db
    .prepare(
      `SELECT a.name, a.mime, a.is_image, a.data, a.owner, p.visibility
       FROM feed_attachments a
         LEFT JOIN feed_comments c ON c.id = a.comment_id
         LEFT JOIN feed_posts p ON p.id = COALESCE(a.post_id, c.post_id)
       WHERE a.id = ?`,
    )
    .get(id) as
    | { name: string; mime: string; is_image: number; data: Uint8Array; owner: string; visibility: Visibility | null }
    | undefined
  // Until the post or comment is saved, only the member who uploaded the file can fetch it
  if (!row || (row.visibility === null && row.owner !== viewer?.username)) {
    throw new HTTPException(404, { message: 'Vedlegget finnes ikke' })
  }
  if (row.visibility !== 'public' && !viewer) throw new HTTPException(401, { message: 'Ikke innlogget' })
  return { name: row.name, mime: row.mime, isImage: row.is_image === 1, data: row.data, isPublic: row.visibility === 'public' }
}

// --- Notifications ---

type AnnouncementKind = 'event' | 'announcement'

// Runs inside the transaction of whatever is being announced
function announce(kind: AnnouncementKind, actor: string, postId: string, body: string) {
  db.prepare('INSERT INTO announcements (id, kind, actor, post_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    randomUUID(),
    kind,
    actor,
    postId,
    body,
    now(),
  )
}

// A message from the organizer of an event to every member
export function sendAnnouncement(viewer: Viewer, id: string, body: string) {
  const post = findPost(viewer, id)
  if (!isEvent(id)) throw new HTTPException(404, { message: 'Arrangementet finnes ikke' })
  if (post.author !== viewer.username) throw new HTTPException(403, { message: 'Bare den som opprettet arrangementet kan sende kunngjøringer' })
  announce('announcement', viewer.username, id, body)
}

interface NotificationRow {
  id: string
  kind: 'comment' | 'reply' | AnnouncementKind
  actor: string
  post_id: string
  comment_id: string | null
  created_at: string
  read: number
  body: string
}

// Announcements go to everyone but the member who made them
const ANNOUNCEMENTS_FOR = `
  FROM announcements a
  LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.username = ?
  WHERE a.actor != ?
`

export async function listNotifications(viewer: Viewer) {
  const { username } = viewer
  const own = db
    .prepare(
      `SELECT n.id, n.kind, n.actor, n.post_id, n.comment_id, n.created_at, n.read_at IS NOT NULL AS read, c.body
       FROM notifications n JOIN feed_comments c ON c.id = n.comment_id
       WHERE n.recipient = ? ORDER BY n.created_at DESC LIMIT ?`,
    )
    .all(username, NOTIFICATIONS_SHOWN) as unknown as NotificationRow[]
  const announced = db
    .prepare(
      `SELECT a.id, a.kind, a.actor, a.post_id, NULL AS comment_id, a.created_at, r.username IS NOT NULL AS read, a.body
       ${ANNOUNCEMENTS_FOR} ORDER BY a.created_at DESC LIMIT ?`,
    )
    .all(username, username, NOTIFICATIONS_SHOWN) as unknown as NotificationRow[]
  const rows = [...own, ...announced].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, NOTIFICATIONS_SHOWN)

  const count = (sql: string, ...params: string[]) => (db.prepare(sql).get(...params) as { n: number }).n
  const unread =
    count('SELECT COUNT(*) AS n FROM notifications WHERE recipient = ? AND read_at IS NULL', username) +
    count(`SELECT COUNT(*) AS n ${ANNOUNCEMENTS_FOR} AND r.username IS NULL`, username, username)
  const members = await getMembers(rows.map(row => row.actor))

  return {
    unread,
    items: rows.map(row => {
      // A comment can be pictures only
      const text = row.body || 'Bilde'
      return {
        id: row.id,
        kind: row.kind,
        actor: members.get(row.actor)!,
        postId: row.post_id,
        commentId: row.comment_id,
        excerpt: text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text,
        createdAt: row.created_at,
        read: row.read === 1,
      }
    }),
  }
}

// Without ids, everything is marked as read
export function markNotificationsRead(viewer: Viewer, ids: string[] | null) {
  const { username } = viewer
  const readAnnouncements = 'INSERT OR IGNORE INTO announcement_reads (announcement_id, username) SELECT id, ? FROM announcements'
  if (ids === null) {
    db.prepare('UPDATE notifications SET read_at = ? WHERE recipient = ? AND read_at IS NULL').run(now(), username)
    db.prepare(`${readAnnouncements} WHERE actor != ?`).run(username, username)
    return
  }
  for (const id of ids) {
    db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND recipient = ? AND read_at IS NULL').run(now(), id, username)
    db.prepare(`${readAnnouncements} WHERE id = ?`).run(username, id)
  }
}
