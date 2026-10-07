import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { requireCaller, type Env } from './auth.ts'
import { PUSH_SITES, pushKey, readSubscription, subscribe, unsubscribe, type PushSite } from './push.ts'

// Turning push notifications on and off, for one browser on one of the sites
export const pushRoutes = new Hono<Env>()

pushRoutes.use('/push/*', bodyLimit({ maxSize: 8 * 1024 }))

// The public half of the API's key, which the browser needs to subscribe. null while
// notifications are off on the server.
pushRoutes.get('/push/key', c => c.json({ publicKey: pushKey() }))

pushRoutes.post('/push/subscriptions', requireCaller, async c => {
  if (!pushKey()) throw new HTTPException(503, { message: 'Varsler er ikke slått på ennå' })
  const body = (await c.req.json().catch(() => null)) as { site?: unknown; subscription?: unknown } | null
  const site = body?.site
  if (typeof site !== 'string' || !PUSH_SITES.includes(site as PushSite)) {
    throw new HTTPException(400, { message: 'Ukjent nettside' })
  }
  subscribe(c.get('caller').username, site as PushSite, readSubscription(body?.subscription))
  return c.body(null, 204)
})

pushRoutes.delete('/push/subscriptions', requireCaller, async c => {
  const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null
  if (typeof body?.endpoint !== 'string') throw new HTTPException(400, { message: 'Mangler endpoint' })
  unsubscribe(c.get('caller').username, body.endpoint)
  return c.body(null, 204)
})
