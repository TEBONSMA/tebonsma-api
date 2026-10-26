import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { findCaller, requireCaller, type Env } from './auth.ts'
import { config } from './config.ts'
import { currentPdf, currentVersion, publishVersion } from './vedtekter.ts'

// The vedtekter, for members only. The vedtekter repo publishes each build here with a key that
// only it and the API know (VEDTEKTER_PUBLISH_KEY).
export const vedtekterRoutes = new Hono<Env>()

const sameKey = (given: string, key: string) =>
  given.length === key.length && timingSafeEqual(Buffer.from(given), Buffer.from(key))

// multipart: commit, dokument (the JSON), pdf
vedtekterRoutes.put('/vedtekter', bodyLimit({ maxSize: 8 * 1024 * 1024 }), async c => {
  const key = config.vedtekter.publishKey
  if (!key) throw new HTTPException(404, { message: 'Finnes ikke' })
  const given = (c.req.header('Authorization') ?? '').replace(/^Bearer /, '')
  if (!sameKey(given, key)) throw new HTTPException(401, { message: 'Feil nøkkel' })
  const { commit, dokument, pdf } = await c.req.parseBody()
  if (typeof commit !== 'string' || !(dokument instanceof File) || !(pdf instanceof File)) {
    throw new HTTPException(400, { message: 'Trenger commit, dokument og pdf' })
  }
  return c.json(publishVersion(commit, await dokument.text(), new Uint8Array(await pdf.arrayBuffer())), 201)
})

vedtekterRoutes.get('/vedtekter', requireCaller, c => {
  const version = currentVersion()
  if (!version) throw new HTTPException(404, { message: 'Vedtektene er ikke lagt ut ennå' })
  return c.json(version)
})

// A link to the PDF that works without the login for an hour, so the browser opens it like any
// other PDF instead of from memory, which some browsers only download. Signed with a secret that
// is new each time the API starts.
const LINK_SECRET = randomBytes(32)
const LINK_MS = 60 * 60 * 1000
const signature = (expires: string) => createHmac('sha256', LINK_SECRET).update(`vedtekter-pdf:${expires}`).digest('base64url')

const linkIsGood = (c: Context) => {
  const expires = c.req.query('utloper') ?? ''
  const given = c.req.query('signatur') ?? ''
  return /^\d+$/.test(expires) && Number(expires) > Date.now() && sameKey(given, signature(expires))
}

vedtekterRoutes.get('/vedtekter/pdf/lenke', requireCaller, c => {
  const expires = String(Date.now() + LINK_MS)
  return c.json({ url: `/vedtekter/pdf?utloper=${expires}&signatur=${signature(expires)}`, utloper: new Date(Number(expires)).toISOString() })
})

// Logged in, or with a link from above. last-ned=1 downloads it instead of showing it.
vedtekterRoutes.get('/vedtekter/pdf', async c => {
  if (!linkIsGood(c) && !(await findCaller(c))) throw new HTTPException(401, { message: 'Logg inn for å lese vedtektene' })
  const pdf = currentPdf()
  if (!pdf) throw new HTTPException(404, { message: 'Vedtektene er ikke lagt ut ennå' })
  const disposition = c.req.query('last-ned') === '1' ? 'attachment' : 'inline'
  return c.body(Buffer.from(pdf), 200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${disposition}; filename="Vedtekter TEBONSMA.pdf"`,
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
})
