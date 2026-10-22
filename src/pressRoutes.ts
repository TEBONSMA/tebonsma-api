import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { findCaller, requireCaller, type Env } from './auth.ts'
import { bad, readBody, readText } from './feedRoutes.ts'
import { readLine } from './marketInput.ts'
import { listMembers } from './members.ts'
import {
  createArticle,
  deleteArticle,
  getArticle,
  getForEditing,
  getFront,
  getMenu,
  isEditor,
  isPublication,
  listArticles,
  listForEditors,
  listSections,
  readImage,
  renameSection,
  requireEditor,
  saveImage,
  setFront,
  setMenu,
  setPublished,
  updateArticle,
  type ArticleInput,
  type Publication,
} from './press.ts'

// The Tebonsma Times and Tebonsma Tidsskrift (see press.ts). Reading is open, with members-only
// articles locked for visitors; /desk is the editors' side.
export const pressRoutes = new Hono<Env>()

// A picture comes as base64 JSON, up to 2 MB
pressRoutes.use('/press/*', bodyLimit({ maxSize: 3 * 1024 * 1024 }))

pressRoutes.get('/press/images/:id', c => {
  const image = readImage(c.req.param('id'))
  if (!image) throw new HTTPException(404, { message: 'Bildet finnes ikke' })
  return c.body(Buffer.from(image), 200, {
    'Content-Type': 'image/jpeg',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'public, max-age=31536000, immutable',
  })
})

const publicationOf = (c: Context): Publication => {
  const publication = c.req.param('publication') ?? ''
  if (!isPublication(publication)) throw new HTTPException(404, { message: 'Finnes ikke' })
  return publication
}

// The editors' side: logged in, and in the paper's editorial group
const editor = async (c: Context<Env>) => {
  const caller = c.get('caller')
  const publication = publicationOf(c)
  requireEditor(caller, publication)
  return { caller, publication }
}

const MAX_AHEAD = 366 * 24 * 60 * 60 * 1000

// When to publish: an ISO time, up to a year ahead, or null for now. A minute late is still now.
function readAt(raw: unknown) {
  if (raw === undefined || raw === null) return null
  const time = typeof raw === 'string' ? Date.parse(raw) : NaN
  if (Number.isNaN(time)) throw bad('Ugyldig tidspunkt')
  if (time < Date.now() - 60_000) throw bad('Tidspunktet har vært')
  if (time > Date.now() + MAX_AHEAD) throw bad('Kan ikke planlegge mer enn et år fram')
  return new Date(time).toISOString()
}

function readArticle(body: Record<string, unknown>): ArticleInput {
  const title = readLine(body.title ?? '', 'Tittelen', 200)
  if (!title) throw bad('Saken trenger en tittel')
  if (typeof body.body !== 'string' || body.body.length > 200_000) throw bad('Ugyldig brødtekst')
  const list = (raw: unknown, what: string, max: number) => {
    if (raw === undefined) return []
    if (!Array.isArray(raw) || raw.length > max || raw.some(item => typeof item !== 'string')) throw bad(`Ugyldig liste med ${what}`)
    return raw as string[]
  }
  const tags = [...new Set(list(body.tags, 'stikkord', 10).map(tag => readLine(tag, 'Stikkordet', 30)).filter(Boolean))]
  const visibility = body.visibility ?? 'members'
  if (visibility !== 'public' && visibility !== 'members') throw bad('Ugyldig synlighet')
  if (body.coverImage !== undefined && body.coverImage !== null && typeof body.coverImage !== 'string') throw bad('Ugyldig bilde')
  return {
    title,
    section: readLine(body.section ?? '', 'Seksjonen', 40),
    lead: readText(body.lead ?? '', 'Ingressen', 600),
    body: body.body,
    tags,
    authors: list(body.authors, 'forfattere', 10),
    visibility,
    coverImage: (body.coverImage as string | null | undefined) ?? null,
    coverCaption: readLine(body.coverCaption ?? '', 'Bildeteksten', 300),
  }
}

// --- Reading

pressRoutes.get('/press/:publication/front', async c => c.json(await getFront(publicationOf(c), await findCaller(c))))
// The sections in use, with how many articles each
pressRoutes.get('/press/:publication/sections', c => c.json(listSections(publicationOf(c))))
// The sections in the menu, in order
pressRoutes.get('/press/:publication/menu', c => c.json(getMenu(publicationOf(c))))
// ?section=, ?tag=, ?q= and ?before=<next> for the page after
pressRoutes.get('/press/:publication/articles', async c => {
  const { section, tag, q, before } = c.req.query()
  if (before !== undefined && Number.isNaN(Date.parse(before))) throw bad('Ugyldig tidspunkt')
  return c.json(await listArticles(publicationOf(c), await findCaller(c), { section, tag, q: q?.trim().slice(0, 100) || undefined, before }))
})
pressRoutes.get('/press/:publication/articles/:slug', async c =>
  c.json(await getArticle(publicationOf(c), c.req.param('slug') ?? '', await findCaller(c))),
)
// Who is looking: whether they may edit, so the site knows whether to show the editors' tools
pressRoutes.get('/press/:publication/me', async c => {
  const caller = await findCaller(c)
  return c.json({ loggedIn: !!caller, editor: isEditor(caller, publicationOf(c)) })
})

// --- The editors' side

pressRoutes.use('/press/:publication/desk', requireCaller)
pressRoutes.use('/press/:publication/desk/*', requireCaller)
pressRoutes.get('/press/:publication/desk', async c => {
  const { caller, publication } = await editor(c)
  return c.json(await listForEditors(publication, caller))
})
// The members to choose authors among
pressRoutes.get('/press/:publication/desk/members', async c => {
  await editor(c)
  return c.json(await listMembers(''))
})
pressRoutes.get('/press/:publication/desk/:id', async c => {
  const { caller, publication } = await editor(c)
  return c.json(await getForEditing(publication, c.req.param('id') ?? '', caller))
})
pressRoutes.post('/press/:publication/desk', async c => {
  const { caller, publication } = await editor(c)
  return c.json(await createArticle(publication, caller, readArticle(await readBody(c))), 201)
})
pressRoutes.put('/press/:publication/desk/:id', async c => {
  const { caller, publication } = await editor(c)
  return c.json(await updateArticle(publication, c.req.param('id') ?? '', caller, readArticle(await readBody(c))))
})
// { at } to publish later; without it, now
pressRoutes.post('/press/:publication/desk/:id/publish', async c => {
  const { caller, publication } = await editor(c)
  const body = (await c.req.json().catch(() => ({}))) as { at?: unknown } | null
  return c.json(await setPublished(publication, c.req.param('id') ?? '', caller, true, readAt(body?.at)))
})
pressRoutes.post('/press/:publication/desk/:id/unpublish', async c => {
  const { caller, publication } = await editor(c)
  return c.json(await setPublished(publication, c.req.param('id') ?? '', caller, false))
})
pressRoutes.delete('/press/:publication/desk/:id', async c => {
  const { publication } = await editor(c)
  deleteArticle(publication, c.req.param('id') ?? '')
  return c.json({ ok: true })
})
// { ids }: the front page from the top
pressRoutes.put('/press/:publication/front', requireCaller, async c => {
  const { caller, publication } = await editor(c)
  const { ids } = await readBody(c)
  if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== 'string')) throw bad('Ugyldig rekkefølge')
  return c.json(await setFront(publication, ids as string[], caller))
})
// { sections }: the menu from the left
pressRoutes.put('/press/:publication/menu', requireCaller, async c => {
  const { publication } = await editor(c)
  const { sections } = await readBody(c)
  if (!Array.isArray(sections) || sections.length > 12 || sections.some(s => typeof s !== 'string')) throw bad('Ugyldig meny')
  const names = [...new Set((sections as string[]).map(section => readLine(section, 'Seksjonen', 40)).filter(Boolean))]
  return c.json(setMenu(publication, names))
})
// { from, to }: a section gets a new name, on every article in it
pressRoutes.post('/press/:publication/sections/rename', requireCaller, async c => {
  const { publication } = await editor(c)
  const { from, to } = await readBody(c)
  return c.json(renameSection(publication, readLine(from ?? '', 'Seksjonen', 40), readLine(to ?? '', 'Seksjonen', 40)))
})
// { image: base64 JPEG }
pressRoutes.post('/press/:publication/images', requireCaller, async c => {
  const { caller, publication } = await editor(c)
  const { image } = await readBody(c)
  if (typeof image !== 'string') throw bad('Mangler bilde')
  return c.json(saveImage(publication, caller, Buffer.from(image, 'base64')), 201)
})
