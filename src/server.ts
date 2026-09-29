import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { verifyAccessToken, type Caller } from './authelia.ts'
import { config } from './config.ts'
import { getLeaderboard, ScoreRejected, startRun, submitScore } from './flappy.ts'
import { getProfile, setAvatar, updateProfile, type ProfileChanges } from './lldap.ts'

type Env = { Variables: { caller: Caller } }

const app = new Hono<Env>()

// The account being read or changed is always the one the access token belongs to
const requireCaller = createMiddleware<Env>(async (c, next) => {
  const token = c.req.header('Authorization')?.match(/^Bearer (.+)$/)?.[1]
  const caller = token ? await verifyAccessToken(token) : null
  if (!caller) throw new HTTPException(401, { message: 'Ikke innlogget' })
  c.set('caller', caller)
  await next()
})

app.use(
  '*',
  cors({
    origin: config.allowedOrigins,
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  }),
)

app.get('/health', c => c.json({ ok: true }))

const MAX_NAME_LENGTH = 64
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

function readName(body: Record<string, unknown>, field: keyof ProfileChanges, required: boolean) {
  const raw = body[field]
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') throw new HTTPException(400, { message: `${field} må være tekst` })
  const value = raw.trim()
  if (required && !value) throw new HTTPException(400, { message: 'Visningsnavn kan ikke være tomt' })
  if (value.length > MAX_NAME_LENGTH) throw new HTTPException(400, { message: `${field} er for langt` })
  if (CONTROL_CHARS.test(value)) throw new HTTPException(400, { message: `${field} har ugyldige tegn` })
  return value
}

app.get('/me', requireCaller, async c => c.json(await getProfile(c.get('caller').username)))

app.patch('/me', requireCaller, async c => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object') throw new HTTPException(400, { message: 'Ugyldig forespørsel' })

  const changes: ProfileChanges = {
    displayName: readName(body, 'displayName', true),
    firstName: readName(body, 'firstName', false),
    lastName: readName(body, 'lastName', false),
  }
  const { username } = c.get('caller')
  await updateProfile(username, changes)
  return c.json(await getProfile(username))
})

const MAX_AVATAR_BYTES = 512 * 1024

app.put('/me/avatar', requireCaller, bodyLimit({ maxSize: 1024 * 1024 }), async c => {
  const body = await c.req.json().catch(() => null)
  const image = body && typeof body === 'object' ? (body as Record<string, unknown>).image : null
  if (typeof image !== 'string') throw new HTTPException(400, { message: 'Mangler bilde' })

  const bytes = Buffer.from(image, 'base64')
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (!isJpeg) throw new HTTPException(400, { message: 'Bildet må være JPEG' })
  if (bytes.length > MAX_AVATAR_BYTES) throw new HTTPException(413, { message: 'Bildet er for stort' })

  const { username } = c.get('caller')
  await setAvatar(username, bytes.toString('base64'))
  return c.json(await getProfile(username))
})

app.delete('/me/avatar', requireCaller, async c => {
  const { username } = c.get('caller')
  await setAvatar(username, null)
  return c.json(await getProfile(username))
})

// Flappy scoreboard: a run ticket is issued when a game starts and redeemed with the score
app.post('/flappy/runs', requireCaller, c => c.json({ runId: startRun(c.get('caller').username) }))

app.post('/flappy/scores', requireCaller, async c => {
  const body = (await c.req.json().catch(() => null)) as { runId?: unknown; score?: unknown } | null
  const runId = body?.runId
  const score = body?.score
  if (typeof runId !== 'string' || typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 100_000) {
    throw new HTTPException(400, { message: 'Ugyldig resultat' })
  }

  const { username } = c.get('caller')
  const profile = await getProfile(username)
  const newBest = submitScore(username, profile.displayName || username, runId, score)
  return c.json({ newBest, leaderboard: getLeaderboard(username) })
})

app.get('/flappy/leaderboard', requireCaller, c => c.json(getLeaderboard(c.get('caller').username)))

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
  if (err instanceof ScoreRejected) return c.json({ error: err.message }, 422)
  console.error(`${c.req.method} ${c.req.path} failed:`, err)
  return c.json({ error: 'Noe gikk galt på serveren' }, 500)
})

app.notFound(c => c.json({ error: 'Finnes ikke' }, 404))

serve({ fetch: app.fetch, port: config.port }, info => {
  console.log(`tebonsma-api listening on port ${info.port}`)
})
