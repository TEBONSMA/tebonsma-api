import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { findCaller, isAdmin, requireCaller, type Env } from './auth.ts'
import type { Caller } from './authelia.ts'
import type { EventInput } from './events.ts'
import {
  addComment,
  createPost,
  deleteComment,
  deletePost,
  dismissReports,
  getCommentLikers,
  getPost,
  getPostLikers,
  listComments,
  listNotifications,
  listPosts,
  listReports,
  markNotificationsRead,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_COMMENT_ATTACHMENTS,
  readAttachment,
  reportPost,
  saveAttachment,
  setCommentLike,
  setPinned,
  setPostLike,
  SORTS,
  updatePost,
  vote,
  type PostInput,
  type Sort,
  type Viewer,
} from './feed.ts'
import { getAvatar } from './members.ts'

const MAX_POST_LENGTH = 5000
const MAX_COMMENT_LENGTH = 2000
const MAX_REASON_LENGTH = 500
const MAX_POLL_OPTIONS = 6
const MAX_POLL_OPTION_LENGTH = 80
const MAX_EVENT_TITLE_LENGTH = 120
const MAX_EVENT_LOCATION_LENGTH = 200
const PAGE_SIZE = 10
const MAX_PAGE_SIZE = 30

const toViewer = (caller: Caller): Viewer => ({ username: caller.username, admin: isAdmin(caller) })
export const viewerOf = (c: Context<Env>) => toViewer(c.get('caller'))
export const visitorOf = async (c: Context) => {
  const caller = await findCaller(c)
  return caller ? toViewer(caller) : null
}

export const bad = (message: string) => new HTTPException(400, { message })

export async function readBody(c: Context) {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Ugyldig forespørsel')
  return body as Record<string, unknown>
}

// Line breaks and tabs are kept; other control characters have no place in a post
export function readText(raw: unknown, what: string, maxLength: number) {
  if (typeof raw !== 'string') throw bad(`${what} må være tekst`)
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
  if (text.length > maxLength) throw bad(`${what} kan ikke være lengre enn ${maxLength} tegn`)
  return text
}

function readAttachmentIds(raw: unknown, max: number, what: string) {
  if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string')) throw bad('Ugyldige vedlegg')
  const ids = [...new Set(raw as string[])]
  if (ids.length > max) throw bad(`${what} kan ha opptil ${max} vedlegg`)
  return ids
}

// Times are stored the way JavaScript writes them, so they can be compared as text
function readTime(raw: unknown) {
  const time = typeof raw === 'string' ? new Date(raw) : null
  if (!time || Number.isNaN(time.getTime())) throw bad('Ugyldig tidspunkt')
  return time.toISOString()
}

function readEvent(raw: unknown): EventInput | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('Ugyldig arrangement')
  const { title, location, startsAt = null, endsAt = null } = raw as Record<string, unknown>

  const event: EventInput = {
    // A title is one line
    title: readText(title, 'Tittelen', MAX_EVENT_TITLE_LENGTH).replace(/\s+/g, ' '),
    location: readText(location ?? '', 'Stedet', MAX_EVENT_LOCATION_LENGTH).replace(/\s+/g, ' '),
    startsAt: startsAt === null ? null : readTime(startsAt),
    endsAt: endsAt === null ? null : readTime(endsAt),
  }
  if (!event.title) throw bad('Arrangementet trenger en tittel')
  if ((event.startsAt === null) !== (event.endsAt === null)) throw bad('Oppgi både start og slutt, eller ingen av dem')
  if (event.startsAt && event.endsAt && event.endsAt <= event.startsAt) throw bad('Arrangementet må slutte etter at det starter')
  return event
}

function readPostInput(body: Record<string, unknown>): PostInput {
  const { visibility, attachmentIds = [] } = body
  if (visibility !== 'public' && visibility !== 'members') throw bad('Velg hvem som skal se innlegget')

  return {
    body: readText(body.body ?? '', 'Innlegget', MAX_POST_LENGTH),
    visibility,
    attachmentIds: readAttachmentIds(attachmentIds, MAX_ATTACHMENTS, 'Et innlegg'),
    event: readEvent(body.event),
  }
}

function readPollOptions(raw: unknown) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw bad('Ugyldig spørreundersøkelse')
  const options = raw.map(option => readText(option, 'Svaralternativet', MAX_POLL_OPTION_LENGTH)).filter(Boolean)
  if (options.length < 2) throw bad('En spørreundersøkelse trenger minst to svaralternativer')
  if (options.length > MAX_POLL_OPTIONS) throw bad(`En spørreundersøkelse kan ha opptil ${MAX_POLL_OPTIONS} svaralternativer`)
  return options
}

export const feedRoutes = new Hono<Env>()

// Everything except file uploads is a small JSON body
const jsonLimit = bodyLimit({ maxSize: 256 * 1024 })
for (const path of ['/feed/posts', '/feed/posts/*', '/feed/comments/*', '/notifications/*']) feedRoutes.use(path, jsonLimit)

// --- Posts ---

feedRoutes.get('/feed/posts', async c => {
  const sort = c.req.query('sort') ?? 'new'
  if (!Object.hasOwn(SORTS, sort)) throw bad('Ukjent sortering')
  const offset = Math.max(0, Math.trunc(Number(c.req.query('offset') ?? 0)) || 0)
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(c.req.query('limit') ?? PAGE_SIZE)) || PAGE_SIZE))
  return c.json(await listPosts(await visitorOf(c), sort as Sort, offset, limit))
})

feedRoutes.get('/feed/posts/:id', async c => c.json(await getPost(await visitorOf(c), c.req.param('id'))))

feedRoutes.post('/feed/posts', requireCaller, async c => {
  const body = await readBody(c)
  const input = readPostInput(body)
  const pollOptions = readPollOptions(body.pollOptions)
  if (pollOptions.length > 0 && input.event) throw bad('Et arrangement kan ikke ha spørreundersøkelse')
  if (pollOptions.length > 0 && !input.body) throw bad('Skriv spørsmålet i innlegget')
  // The title is enough for an event
  if (!input.event && !input.body && input.attachmentIds.length === 0) throw bad('Innlegget er tomt')
  return c.json(await createPost(viewerOf(c), input, pollOptions), 201)
})

// The poll stays as it was posted; changing the options would change what people voted for
feedRoutes.patch('/feed/posts/:id', requireCaller, async c => {
  const viewer = viewerOf(c)
  const id = c.req.param('id')
  const input = readPostInput(await readBody(c))
  if (!input.event && !input.body && (input.attachmentIds.length === 0 || (await getPost(viewer, id)).poll)) {
    throw bad('Innlegget er tomt')
  }
  return c.json(await updatePost(viewer, id, input))
})

feedRoutes.delete('/feed/posts/:id', requireCaller, c => {
  deletePost(viewerOf(c), c.req.param('id'))
  return c.json({ ok: true })
})

feedRoutes.put('/feed/posts/:id/like', requireCaller, c => c.json(setPostLike(viewerOf(c), c.req.param('id'), true)))
feedRoutes.delete('/feed/posts/:id/like', requireCaller, c => c.json(setPostLike(viewerOf(c), c.req.param('id'), false)))
feedRoutes.get('/feed/posts/:id/likes', requireCaller, async c => c.json(await getPostLikers(viewerOf(c), c.req.param('id'))))

feedRoutes.put('/feed/posts/:id/pin', requireCaller, async c => c.json(await setPinned(viewerOf(c), c.req.param('id'), true)))
feedRoutes.delete('/feed/posts/:id/pin', requireCaller, async c => c.json(await setPinned(viewerOf(c), c.req.param('id'), false)))

feedRoutes.put('/feed/posts/:id/vote', requireCaller, async c => {
  const { optionId } = await readBody(c)
  if (optionId !== null && typeof optionId !== 'string') throw bad('Ugyldig stemme')
  return c.json(vote(viewerOf(c), c.req.param('id'), optionId))
})

// --- Reports ---

feedRoutes.post('/feed/posts/:id/report', requireCaller, async c => {
  const { reason } = await readBody(c)
  reportPost(viewerOf(c), c.req.param('id'), readText(reason ?? '', 'Begrunnelsen', MAX_REASON_LENGTH))
  return c.json({ ok: true })
})

feedRoutes.get('/feed/reports', requireCaller, async c => c.json(await listReports(viewerOf(c))))

feedRoutes.delete('/feed/posts/:id/reports', requireCaller, c => {
  dismissReports(viewerOf(c), c.req.param('id'))
  return c.json({ ok: true })
})

// --- Comments ---

feedRoutes.get('/feed/posts/:id/comments', async c => c.json(await listComments(await visitorOf(c), c.req.param('id'))))

feedRoutes.post('/feed/posts/:id/comments', requireCaller, async c => {
  const body = await readBody(c)
  const text = readText(body.body ?? '', 'Kommentaren', MAX_COMMENT_LENGTH)
  const attachmentIds = readAttachmentIds(body.attachmentIds ?? [], MAX_COMMENT_ATTACHMENTS, 'En kommentar')
  if (!text && attachmentIds.length === 0) throw bad('Kommentaren er tom')
  const { parentId = null } = body
  if (parentId !== null && typeof parentId !== 'string') throw bad('Ugyldig forespørsel')
  return c.json(await addComment(viewerOf(c), c.req.param('id'), text, parentId, attachmentIds), 201)
})

feedRoutes.delete('/feed/comments/:id', requireCaller, c => {
  deleteComment(viewerOf(c), c.req.param('id'))
  return c.json({ ok: true })
})

feedRoutes.put('/feed/comments/:id/like', requireCaller, c => c.json(setCommentLike(viewerOf(c), c.req.param('id'), true)))
feedRoutes.delete('/feed/comments/:id/like', requireCaller, c => c.json(setCommentLike(viewerOf(c), c.req.param('id'), false)))
feedRoutes.get('/feed/comments/:id/likes', requireCaller, async c => c.json(await getCommentLikers(viewerOf(c), c.req.param('id'))))

// --- Attachments ---

feedRoutes.post(
  '/feed/attachments',
  requireCaller,
  // Room for the multipart wrapping around the file itself
  bodyLimit({
    maxSize: MAX_ATTACHMENT_BYTES + 64 * 1024,
    onError: () => {
      throw new HTTPException(413, { message: 'Filen er for stor' })
    },
  }),
  async c => {
    const form = await c.req.parseBody().catch(() => null)
    const file = form?.file
    if (!(file instanceof File)) throw bad('Mangler fil')
    if (file.size === 0) throw bad('Filen er tom')
    if (file.size > MAX_ATTACHMENT_BYTES) throw new HTTPException(413, { message: 'Filen er for stor' })

    const bytes = new Uint8Array(await file.arrayBuffer())
    return c.json(saveAttachment(viewerOf(c), { name: file.name, type: file.type, bytes }), 201)
  },
)

// Uploaded files are never run or rendered as pages, whatever they contain
export const UPLOAD_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
}

feedRoutes.get('/feed/attachments/:id', async c => {
  const file = readAttachment(await visitorOf(c), c.req.param('id'))
  const disposition = file.isImage ? 'inline' : 'attachment'
  return c.body(Buffer.from(file.data), 200, {
    ...UPLOAD_HEADERS,
    'Content-Type': file.mime,
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    // A post can be changed to members only, so public files aren't cached for long
    'Cache-Control': file.isPublic ? 'public, max-age=3600' : 'private, max-age=3600',
  })
})

// Profile pictures of feed authors. The address changes when the picture does.
feedRoutes.get('/members/:id/avatar', c => {
  const avatar = getAvatar(c.req.param('id'))
  if (!avatar) throw new HTTPException(404, { message: 'Finnes ikke' })
  return c.body(Buffer.from(avatar), 200, {
    ...UPLOAD_HEADERS,
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'public, max-age=31536000, immutable',
  })
})

// --- Notifications ---

feedRoutes.get('/notifications', requireCaller, async c => c.json(await listNotifications(viewerOf(c))))

feedRoutes.post('/notifications/read', requireCaller, async c => {
  const { ids = null } = await readBody(c)
  if (ids !== null && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) throw bad('Ugyldig forespørsel')
  markNotificationsRead(viewerOf(c), ids as string[] | null)
  return c.json({ ok: true })
})
