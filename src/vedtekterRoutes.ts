import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { requireCaller, type Env } from './auth.ts'
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

vedtekterRoutes.get('/vedtekter/pdf', requireCaller, c => {
  const pdf = currentPdf()
  if (!pdf) throw new HTTPException(404, { message: 'Vedtektene er ikke lagt ut ennå' })
  return c.body(Buffer.from(pdf), 200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'inline; filename="Vedtekter TEBONSMA.pdf"',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
})
