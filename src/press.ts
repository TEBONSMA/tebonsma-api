import { randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import sanitizeHtml from 'sanitize-html'
import type { Caller } from './authelia.ts'
import { config } from './config.ts'
import { db, transaction } from './db.ts'
import { getMembers, usernameOf } from './members.ts'

// The two papers of TEBONSMA: The Tebonsma Times (times.tebonsma.no), a newspaper, and Tebonsma
// Tidsskrift (tidsskrift.tebonsma.no), a journal. They work the same; only their sites look
// different. Only the members of a paper's editorial group can write, publish and arrange it:
// times_redaksjon and tidsskrift_redaksjon in LLDAP. Each article is open to everyone or to
// members only; a visitor doesn't see members-only articles at all. They can be published at once
// or at a set time.

export const PUBLICATIONS = ['times', 'tidsskrift'] as const
export type Publication = (typeof PUBLICATIONS)[number]
export const isPublication = (value: string): value is Publication => PUBLICATIONS.includes(value as Publication)

const editorGroup = (publication: Publication) => (publication === 'times' ? config.press.timesGroup : config.press.tidsskriftGroup)
export const isEditor = (caller: Caller | null, publication: Publication) => !!caller?.groups.includes(editorGroup(publication))

export function requireEditor(caller: Caller | null, publication: Publication) {
  if (!caller) throw new HTTPException(401, { message: 'Ikke innlogget' })
  if (!isEditor(caller, publication)) throw new HTTPException(403, { message: 'Bare redaksjonen kan gjøre dette' })
}

db.exec(`
  CREATE TABLE IF NOT EXISTS press_articles (
    id             TEXT PRIMARY KEY,
    publication    TEXT NOT NULL CHECK (publication IN ('times', 'tidsskrift')),
    -- In the address: /sak/<slug>. Follows the title until the article is published, then stays.
    slug           TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    visibility     TEXT NOT NULL DEFAULT 'members' CHECK (visibility IN ('public', 'members')),
    -- The newspaper's section, or the journal's kind of article
    section        TEXT NOT NULL DEFAULT '',
    title          TEXT NOT NULL,
    -- The newspaper's lead, or the journal's abstract
    lead           TEXT NOT NULL DEFAULT '',
    -- Cleaned HTML (see cleanBody)
    body           TEXT NOT NULL DEFAULT '',
    tags           TEXT NOT NULL DEFAULT '[]',
    -- Usernames, in byline order
    authors        TEXT NOT NULL DEFAULT '[]',
    cover_image    TEXT,
    cover_caption  TEXT NOT NULL DEFAULT '',
    -- Its place on the front page, 0 at the top; null when it isn't there
    front_position INTEGER,
    created_by     TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    -- When it is out. In the future for an article set to be published later: until then only
    -- the editors see it (see LIVE).
    published_at   TEXT,
    UNIQUE (publication, slug)
  );
  CREATE INDEX IF NOT EXISTS press_articles_published ON press_articles (publication, status, published_at);

  -- The sections in the paper's menu, in order, as the editors set them
  CREATE TABLE IF NOT EXISTS press_menus (
    publication TEXT PRIMARY KEY,
    sections    TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS press_images (
    id          TEXT PRIMARY KEY,
    publication TEXT NOT NULL,
    data        BLOB NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
`)

const bad = (message: string) => new HTTPException(400, { message })
const now = () => new Date().toISOString()
const LATEST = 20
const PAGE = 20
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

interface ArticleRow {
  id: string
  publication: Publication
  slug: string
  status: 'draft' | 'published'
  visibility: 'public' | 'members'
  section: string
  title: string
  lead: string
  body: string
  tags: string
  authors: string
  cover_image: string | null
  cover_caption: string
  front_position: number | null
  created_by: string
  created_at: string
  updated_at: string
  published_at: string | null
}

// --- The text

// The editor's HTML, cut down to what an article may hold: no script, styles or other sites'
// pictures. Pictures are the paper's own, kept as /press/images/<id> whatever address the
// editor used for them.
const OWN_IMAGE = /^(?:https?:\/\/[^/]+)?\/press\/images\/([0-9a-f-]{36})$/

const FIGURE_SIZES = new Set(['small', 'medium', 'full'])

export function cleanBody(html: string) {
  return sanitizeHtml(html, {
    allowedTags: ['h2', 'h3', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'blockquote', 'ul', 'ol', 'li', 'hr', 'figure', 'img', 'figcaption', 'code'],
    // A picture in the text has a size (small beside the text, medium, full width) and a caption
    allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt'], figure: ['data-size'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    // Links open in a new tab, whatever the input said
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { href: attribs.href ?? '', target: '_blank', rel: 'noopener noreferrer' } }),
      figure: (tagName, attribs) => {
        const size = attribs['data-size'] ?? ''
        const kept: Record<string, string> = FIGURE_SIZES.has(size) ? { 'data-size': size } : {}
        return { tagName, attribs: kept }
      },
    },
    exclusiveFilter: frame => frame.tag === 'img' && !OWN_IMAGE.test(frame.attribs.src ?? ''),
  }).replace(/src="(?:https?:\/\/[^/"]+)?\/press\/images\//g, 'src="/press/images/')
}

// For the address: lower case, Norwegian letters spelled out, words joined by dashes
export function slugify(title: string) {
  const slug = title
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
  return slug || 'sak'
}

function uniqueSlug(publication: Publication, title: string, except: string | null) {
  const base = slugify(title)
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`
    const taken = db.prepare('SELECT id FROM press_articles WHERE publication = ? AND slug = ?').get(publication, slug) as { id: string } | undefined
    if (!taken || taken.id === except) return slug
  }
}

// --- What the sites get

async function toArticles(rows: ArticleRow[], withBody: boolean) {
  const members = await getMembers(rows.flatMap(row => JSON.parse(row.authors) as string[]))
  const time = now()
  return rows.map(row => {
    return {
      id: row.id,
      publication: row.publication,
      slug: row.slug,
      status: row.status,
      visibility: row.visibility,
      section: row.section,
      title: row.title,
      lead: row.lead,
      body: withBody ? row.body : null,
      tags: JSON.parse(row.tags) as string[],
      authors: (JSON.parse(row.authors) as string[]).map(username => members.get(username)!).filter(Boolean),
      coverImage: row.cover_image ? `/press/images/${row.cover_image}` : null,
      coverCaption: row.cover_caption,
      frontPosition: row.front_position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedAt: row.published_at,
      // Published, but not out until publishedAt
      scheduled: row.status === 'published' && !!row.published_at && row.published_at > time,
    }
  })
}
export type Article = Awaited<ReturnType<typeof toArticles>>[number]

const SELECT = 'SELECT * FROM press_articles'
// What readers see: published, and not set for later. Takes the time now.
const LIVE = "status = 'published' AND published_at <= ?"
// Members-only articles are for those logged in
const OPEN_TO = (caller: Caller | null) => (caller ? '' : " AND visibility = 'public'")

// The front page: the articles the editors placed, in their order, then the latest of the rest
export async function getFront(publication: Publication, caller: Caller | null) {
  // One set for later may be placed already, and comes on when it is out
  const placed = db
    .prepare(`${SELECT} WHERE publication = ? AND ${LIVE}${OPEN_TO(caller)} AND front_position IS NOT NULL ORDER BY front_position`)
    .all(publication, now()) as unknown as ArticleRow[]
  const latest = db
    .prepare(`${SELECT} WHERE publication = ? AND ${LIVE}${OPEN_TO(caller)} AND front_position IS NULL ORDER BY published_at DESC LIMIT ?`)
    .all(publication, now(), LATEST) as unknown as ArticleRow[]
  return { front: await toArticles(placed, false), latest: await toArticles(latest, false) }
}

export interface ArticleQuery {
  section?: string
  tag?: string
  q?: string
  // Published before this time, for the next page
  before?: string
}

// Published articles, the newest first, a page at a time
export async function listArticles(publication: Publication, caller: Caller | null, query: ArticleQuery) {
  const where = ['publication = ?', LIVE + OPEN_TO(caller)]
  const params: string[] = [publication, now()]
  if (query.section) {
    where.push('section = ?')
    params.push(query.section)
  }
  if (query.tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)')
    params.push(query.tag)
  }
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/g, c => `\\${c}`)}%`
    where.push("(title LIKE ? ESCAPE '\\' OR lead LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')")
    params.push(like, like, like)
  }
  if (query.before) {
    where.push('published_at < ?')
    params.push(query.before)
  }
  const rows = db
    .prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY published_at DESC LIMIT ?`)
    .all(...params, PAGE + 1) as unknown as ArticleRow[]
  const page = rows.slice(0, PAGE)
  return { articles: await toArticles(page, false), next: rows.length > PAGE ? page[page.length - 1].published_at : null }
}

// The sections in use, with how many articles each, for the editors' menu page
export function listSections(publication: Publication, caller: Caller | null) {
  return db
    .prepare(`SELECT section, COUNT(*) AS count FROM press_articles WHERE publication = ? AND ${LIVE}${OPEN_TO(caller)} AND section != '' GROUP BY section ORDER BY count DESC`)
    .all(publication, now()) as { section: string; count: number }[]
}

// The menu: the editors' list, empty until they have made one
export function getMenu(publication: Publication) {
  const row = db.prepare('SELECT sections FROM press_menus WHERE publication = ?').get(publication) as { sections: string } | undefined
  if (row) return { sections: JSON.parse(row.sections) as string[], custom: true }
  return { sections: [], custom: false }
}

export function setMenu(publication: Publication, sections: string[]) {
  db.prepare(
    `INSERT INTO press_menus (publication, sections, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (publication) DO UPDATE SET sections = excluded.sections, updated_at = excluded.updated_at`,
  ).run(publication, JSON.stringify(sections), now())
  return getMenu(publication)
}

// A new name for a section: on every article in it, and in the menu
export function renameSection(publication: Publication, from: string, to: string) {
  if (!from || !to) throw bad('Seksjonen trenger et navn')
  transaction(() => {
    db.prepare('UPDATE press_articles SET section = ? WHERE publication = ? AND section = ?').run(to, publication, from)
    const menu = db.prepare('SELECT sections FROM press_menus WHERE publication = ?').get(publication) as { sections: string } | undefined
    if (menu) {
      const sections = [...new Set((JSON.parse(menu.sections) as string[]).map(section => (section === from ? to : section)))]
      db.prepare('UPDATE press_menus SET sections = ?, updated_at = ? WHERE publication = ?').run(JSON.stringify(sections), now(), publication)
    }
  })
  return getMenu(publication)
}

const isLive = (row: ArticleRow) => row.status === 'published' && !!row.published_at && row.published_at <= now()

// One article by its address. Drafts and articles set for later only for the editors, members-only
// articles only for those logged in.
export async function getArticle(publication: Publication, slug: string, caller: Caller | null) {
  const row = db.prepare(`${SELECT} WHERE publication = ? AND slug = ?`).get(publication, slug) as ArticleRow | undefined
  const hidden = !row || (!isLive(row) && !isEditor(caller, publication)) || (row.visibility === 'members' && !caller)
  if (!row || hidden) throw new HTTPException(404, { message: 'Saken finnes ikke' })
  return (await toArticles([row], true))[0]
}

// --- For the editors

const findRow = (publication: Publication, id: string) => {
  const row = db.prepare(`${SELECT} WHERE publication = ? AND id = ?`).get(publication, id) as ArticleRow | undefined
  if (!row) throw new HTTPException(404, { message: 'Saken finnes ikke' })
  return row
}

// Everything, drafts first, for the editors' list
export async function listForEditors(publication: Publication, caller: Caller) {
  const rows = db
    .prepare(`${SELECT} WHERE publication = ? ORDER BY status = 'published', COALESCE(published_at, updated_at) DESC`)
    .all(publication) as unknown as ArticleRow[]
  return toArticles(rows, false)
}

export async function getForEditing(publication: Publication, id: string, caller: Caller) {
  return (await toArticles([findRow(publication, id)], true))[0]
}

export interface ArticleInput {
  title: string
  section: string
  lead: string
  body: string
  tags: string[]
  // Public member ids, in byline order
  authors: string[]
  visibility: 'public' | 'members'
  coverImage: string | null
  coverCaption: string
}

const authorsOf = (ids: string[]) =>
  ids.map(id => {
    const username = usernameOf(id)
    if (!username) throw bad('Fant ikke en av forfatterne')
    return username
  })

const imageIdOf = (raw: string | null) => {
  if (raw === null) return null
  const id = raw.match(/([0-9a-f-]{36})$/)?.[1]
  if (!id || !db.prepare('SELECT 1 FROM press_images WHERE id = ?').get(id)) throw bad('Fant ikke bildet')
  return id
}

export async function createArticle(publication: Publication, caller: Caller, input: ArticleInput) {
  const id = randomUUID()
  const time = now()
  db.prepare(
    `INSERT INTO press_articles (id, publication, slug, visibility, section, title, lead, body, tags, authors, cover_image, cover_caption, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    publication,
    uniqueSlug(publication, input.title, null),
    input.visibility,
    input.section,
    input.title,
    input.lead,
    cleanBody(input.body),
    JSON.stringify(input.tags),
    JSON.stringify(authorsOf(input.authors)),
    imageIdOf(input.coverImage),
    input.coverCaption,
    caller.username,
    time,
    time,
  )
  return getForEditing(publication, id, caller)
}

export async function updateArticle(publication: Publication, id: string, caller: Caller, input: ArticleInput) {
  const row = findRow(publication, id)
  // An article that is out keeps its address, so links to it keep working
  const slug = isLive(row) ? row.slug : uniqueSlug(publication, input.title, id)
  db.prepare(
    `UPDATE press_articles SET slug = ?, visibility = ?, section = ?, title = ?, lead = ?, body = ?, tags = ?, authors = ?,
       cover_image = ?, cover_caption = ?, updated_at = ? WHERE id = ?`,
  ).run(
    slug,
    input.visibility,
    input.section,
    input.title,
    input.lead,
    cleanBody(input.body),
    JSON.stringify(input.tags),
    JSON.stringify(authorsOf(input.authors)),
    imageIdOf(input.coverImage),
    input.coverCaption,
    now(),
    id,
  )
  return getForEditing(publication, id, caller)
}

// Out now, or at another time (at) for one that isn't out yet: later to schedule it, earlier for
// an article from before the site. An article taken down and put back keeps the time it first
// came out.
export async function setPublished(publication: Publication, id: string, caller: Caller, published: boolean, at: string | null = null) {
  const row = findRow(publication, id)
  const time = now()
  if (published && !row.title.trim()) throw bad('Saken trenger en tittel')
  if (published && at && isLive(row)) throw bad('Saken er allerede ute')
  const publishedAt = at ?? (row.published_at && row.published_at <= time ? row.published_at : time)
  db.prepare('UPDATE press_articles SET status = ?, published_at = ?, front_position = ?, updated_at = ? WHERE id = ?').run(
    published ? 'published' : 'draft',
    published ? publishedAt : row.published_at,
    // An article taken down leaves the front page
    published ? row.front_position : null,
    time,
    id,
  )
  return getForEditing(publication, id, caller)
}

export function deleteArticle(publication: Publication, id: string) {
  findRow(publication, id)
  db.prepare('DELETE FROM press_articles WHERE id = ?').run(id)
}

// The front page in order: the ids of published articles, the top story first. The rest leave it.
export async function setFront(publication: Publication, ids: string[], caller: Caller) {
  transaction(() => {
    db.prepare('UPDATE press_articles SET front_position = NULL WHERE publication = ?').run(publication)
    ids.forEach((id, position) => {
      const row = findRow(publication, id)
      if (row.status !== 'published') throw bad(`«${row.title}» er ikke publisert`)
      db.prepare('UPDATE press_articles SET front_position = ? WHERE id = ?').run(position, id)
    })
  })
  return getFront(publication, caller)
}

// --- Pictures

// A JPEG the site has made small enough; returns its address
export function saveImage(publication: Publication, caller: Caller, bytes: Buffer) {
  if (!(bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) throw bad('Bildet må være JPEG')
  if (bytes.length > MAX_IMAGE_BYTES) throw new HTTPException(413, { message: 'Bildet er for stort' })
  const id = randomUUID()
  db.prepare('INSERT INTO press_images (id, publication, data, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, publication, bytes, caller.username, now())
  return { id, url: `/press/images/${id}` }
}

// Pictures are served to anyone who has the address. The address is random, so a picture in a
// members-only article isn't found by guessing.
export const readImage = (id: string) =>
  (db.prepare('SELECT data FROM press_images WHERE id = ?').get(id) as { data: Uint8Array } | undefined)?.data ?? null
