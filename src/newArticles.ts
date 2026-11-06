import { db } from './db.ts'
import { PUBLICATIONS, storedAuthors, type Publication } from './press.ts'
import { pushSubscribers, pushTo, type PushMessage } from './push.ts'

// Every five minutes, members with notifications on for one of the papers hear about the
// articles that came out there since the last look: one push each, leaving out the ones they
// wrote or published themselves. An article set for later is news when its time comes; one put
// back in time, like an old article brought in from before, never is.

// Can be shortened to try it out, or for the tests
const EVERY_MS = Number(process.env.NEW_ARTICLES_CHECK_SECONDS ?? 5 * 60) * 1000
const MAX_BODY = 140

// How each paper speaks of itself, and where an article is on its site
const PAPERS: Record<Publication, { name: string; path: string; one: string; many: string }> = {
  times: { name: 'The Tebonsma Times', path: 'sak', one: 'Ny sak', many: 'nye saker' },
  tidsskrift: { name: 'Tebonsma Tidsskrift', path: 'artikkel', one: 'Ny artikkel', many: 'nye artikler' },
}

db.exec(`
  CREATE TABLE IF NOT EXISTS push_checks (
    name       TEXT PRIMARY KEY,
    checked_at TEXT NOT NULL
  );
`)

interface NewArticle {
  slug: string
  title: string
  authors: string
  created_by: string
}

const shorten = (text: string) => (text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text)

function messageFor(publication: Publication, articles: NewArticle[]): PushMessage {
  const paper = PAPERS[publication]
  // A newer one replaces an older one the member hasn't looked at
  const tag = 'new-articles'
  if (articles.length === 1) {
    return { title: `${paper.one} i ${paper.name}`, body: articles[0].title, url: `/${paper.path}/${articles[0].slug}`, tag }
  }
  return {
    title: `${articles.length} ${paper.many} i ${paper.name}`,
    body: shorten(articles.map(article => article.title).join(' · ')),
    url: '/',
    tag,
  }
}

// The one who published it, and its authors, know about it already
const theirOwn = (article: NewArticle, username: string) =>
  article.created_by === username || storedAuthors(article.authors).some(author => author.username === username)

export function announceNewArticles(publication: Publication) {
  const check = `new-articles:${publication}`
  const now = new Date().toISOString()
  const last = (db.prepare('SELECT checked_at FROM push_checks WHERE name = ?').get(check) as { checked_at: string } | undefined)
    ?.checked_at
  db.prepare('INSERT INTO push_checks (name, checked_at) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET checked_at = excluded.checked_at').run(
    check,
    now,
  )
  // The first look only starts the clock, so a new installation doesn't announce every article there is
  if (!last) return

  const articles = db
    .prepare(
      `SELECT slug, title, authors, created_by FROM press_articles
       WHERE publication = ? AND status = 'published' AND published_at > ? AND published_at <= ?
       ORDER BY published_at`,
    )
    .all(publication, last, now) as unknown as NewArticle[]
  if (articles.length === 0) return

  for (const username of pushSubscribers(publication)) {
    const theirs = articles.filter(article => !theirOwn(article, username))
    if (theirs.length > 0) pushTo(publication, [username], messageFor(publication, theirs))
  }
}

export function startNewArticlesCheck() {
  const check = () => {
    for (const publication of PUBLICATIONS) {
      try {
        announceNewArticles(publication)
      } catch (err) {
        console.error(`could not announce new articles in ${publication}:`, err)
      }
    }
  }
  check()
  setInterval(check, EVERY_MS)
}
