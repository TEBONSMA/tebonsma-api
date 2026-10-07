import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { requireCaller, type Env } from './auth.ts'
import { betRoutes } from './betRoutes.ts'
import { removeUnplayedMarkets } from './bets.ts'
import { startBots } from './bots/index.ts'
import { config } from './config.ts'
import { eventRoutes } from './eventRoutes.ts'
import { feedRoutes } from './feedRoutes.ts'
import { mailRoutes } from './mailRoutes.ts'
import { hasBackend, useBackend } from './mail/backend.ts'
import { imapBackend } from './mail/imapBackend.ts'
import { startScheduler } from './mail/scheduled.ts'
import { memberRoutes } from './memberRoutes.ts'
import { getProfile as readProfile, setAvatar, updateProfile, type ProfileChanges } from './lldap.ts'
import { rememberProfile } from './members.ts'
import { getLeaderboard, isGame, ScoreRejected, startRun, submitScore } from './scoreboard.ts'

const app = new Hono<Env>()

// Every profile read here is fresh from LLDAP, so the feed's copy of names and pictures
// is brought up to date along the way
async function getProfile(username: string) {
  const profile = await readProfile(username)
  rememberProfile(profile)
  return profile
}

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

// Which commit is running, written by deploy/deploy.sh. The Deploy workflow on GitHub watches it.
app.get('/version', c =>
  c.json({ commit: process.env.COMMIT_SHA ?? null, deployedAt: process.env.DEPLOYED_AT ?? null }, 200, { 'Cache-Control': 'no-store' }),
)

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

// Game scoreboards: a run ticket is issued when a game starts and redeemed with the score
const MAX_SCORE = 10_000_000

const gameParam = (c: Context<Env>) => {
  const game = c.req.param('game') ?? ''
  if (!isGame(game)) throw new HTTPException(404, { message: 'Ukjent spill' })
  return game
}

const startGameRun = (c: Context<Env>, game: string) => c.json({ runId: startRun(game, c.get('caller').username) })

const submitGameScore = async (c: Context<Env>, game: string) => {
  const body = (await c.req.json().catch(() => null)) as { runId?: unknown; score?: unknown } | null
  const runId = body?.runId
  const score = body?.score
  if (typeof runId !== 'string' || typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
    throw new HTTPException(400, { message: 'Ugyldig resultat' })
  }

  const { username } = c.get('caller')
  const profile = await getProfile(username)
  const newBest = submitScore(game, username, profile.displayName || username, runId, score)
  return c.json({ newBest, leaderboard: getLeaderboard(game, username) })
}

const gameLeaderboard = (c: Context<Env>, game: string) => c.json(getLeaderboard(game, c.get('caller').username))

app.post('/games/:game/runs', requireCaller, c => startGameRun(c, gameParam(c)))
app.post('/games/:game/scores', requireCaller, c => submitGameScore(c, gameParam(c)))
app.get('/games/:game/leaderboard', requireCaller, c => gameLeaderboard(c, gameParam(c)))

// The site used these before every game had a scoreboard; kept so an older copy of the
// site in someone's browser keeps working
app.post('/flappy/runs', requireCaller, c => startGameRun(c, 'flappy-teb'))
app.post('/flappy/scores', requireCaller, c => submitGameScore(c, 'flappy-teb'))
app.get('/flappy/leaderboard', requireCaller, c => gameLeaderboard(c, 'flappy-teb'))

app.route('/', feedRoutes)
app.route('/', eventRoutes)
app.route('/', mailRoutes)
app.route('/', betRoutes)
app.route('/', memberRoutes)

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
  if (err instanceof ScoreRejected) return c.json({ error: err.message }, 422)
  console.error(`${c.req.method} ${c.req.path} failed:`, err)
  return c.json({ error: 'Noe gikk galt på serveren' }, 500)
})

app.notFound(c => c.json({ error: 'Finnes ikke' }, 404))

// The real mail server, unless a stand-in was registered first (npm run dev:mock does)
if (!hasBackend()) useBackend(imapBackend)
// A trial run of a new version (deploy/deploy.sh) answers requests but does nothing on its own:
// no scheduled mail goes out and the bot stays off
const trial = process.env.TRIAL === '1'
if (!trial) startScheduler()

serve({ fetch: app.fetch, port: config.port }, info => {
  console.log(`tebonsma-api listening on port ${info.port}`)
})

if (!trial) startBots()

// Markets nobody played on are cleared away a day after they close
function clearUnplayed() {
  try {
    const removed = removeUnplayedMarkets()
    if (removed > 0) console.log(`removed ${removed} unplayed ${removed === 1 ? 'market' : 'markets'}`)
  } catch (err) {
    console.error('could not remove unplayed markets:', err)
  }
}
if (!trial) {
  clearUnplayed()
  setInterval(clearUnplayed, 10 * 60 * 1000)
}
