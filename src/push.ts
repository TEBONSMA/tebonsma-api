import webpush from 'web-push'
import { HTTPException } from 'hono/http-exception'
import { config } from './config.ts'
import { db } from './db.ts'

// Push notifications to members' phones and computers (Web Push). Each site asks the browser for
// a subscription and hands it in here; the API then sends through the browser maker's push
// service (Google, Apple, Mozilla, Microsoft), end-to-end encrypted to that one browser.

export const PUSH_SITES = ['teb', 'tebbet'] as const
export type PushSite = (typeof PUSH_SITES)[number]

// What the site's service worker shows: url is a path on that site, opened when it is tapped.
// A newer notification with the same tag replaces the older one.
export interface PushMessage {
  title: string
  body: string
  url: string
  tag?: string
}

export interface PushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

type Sender = (subscription: PushSubscription, payload: string) => Promise<unknown>

db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    site       TEXT NOT NULL CHECK (site IN ('teb', 'tebbet')),
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS push_subscriptions_member ON push_subscriptions (username, site);
`)

// The API posts to whatever endpoint a browser gave, so only the push services themselves are
// accepted, never an address inside the network
const PUSH_HOSTS = ['.googleapis.com', '.push.apple.com', '.mozilla.com', '.notify.windows.com']
const MAX_ENDPOINT = 1024
const KEY = /^[A-Za-z0-9_-]{16,128}={0,2}$/

const webPush: Sender = (subscription, payload) =>
  webpush.sendNotification(subscription, payload, {
    vapidDetails: config.push!,
    // A phone that is off for a day misses it rather than getting old news
    TTL: 24 * 60 * 60,
  })

// Without keys (and in a trial run of a new version, deploy/deploy.sh) nothing is sent
let sender: Sender | null = config.push && process.env.TRIAL !== '1' ? webPush : null

// For local development and tests: where pushes go instead
export const usePushSender = (next: Sender) => {
  sender = next
}

export const pushKey = () => config.push?.publicKey ?? null

export function readSubscription(raw: unknown): PushSubscription {
  const { endpoint, keys } = (raw ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT || !URL.canParse(endpoint)) {
    throw new HTTPException(400, { message: 'Ugyldig abonnement' })
  }
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some(host => url.hostname.endsWith(host))) {
    throw new HTTPException(400, { message: 'Ukjent push-tjeneste' })
  }
  const { p256dh, auth } = keys ?? {}
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !KEY.test(p256dh) || !KEY.test(auth)) {
    throw new HTTPException(400, { message: 'Ugyldig abonnement' })
  }
  return { endpoint, keys: { p256dh, auth } }
}

// A browser that comes back, also after another member logged in on it, belongs to whoever
// handed it in last
export function subscribe(username: string, site: PushSite, { endpoint, keys }: PushSubscription) {
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, username, site, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET username = excluded.username, site = excluded.site, p256dh = excluded.p256dh, auth = excluded.auth
  `).run(endpoint, username, site, keys.p256dh, keys.auth, new Date().toISOString())
}

export function unsubscribe(username: string, endpoint: string) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND username = ?').run(endpoint, username)
}

interface SubscriptionRow {
  endpoint: string
  p256dh: string
  auth: string
}

async function deliver(rows: SubscriptionRow[], message: PushMessage) {
  const send = sender
  if (!send) return
  const payload = JSON.stringify(message)
  await Promise.all(
    rows.map(async row => {
      try {
        await send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload)
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        // The browser has dropped the subscription (the member turned it off or reinstalled)
        if (status === 404 || status === 410) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint)
        else console.error(`Push to ${new URL(row.endpoint).hostname} failed:`, status ?? err)
      }
    }),
  )
}

// Fire and forget: a push service that is slow or down never holds up the request that caused it
export function pushTo(site: PushSite, usernames: string[], message: PushMessage) {
  if (!sender || usernames.length === 0) return
  const rows = db
    .prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE site = ? AND username IN (${usernames.map(() => '?').join(', ')})`)
    .all(site, ...usernames) as unknown as SubscriptionRow[]
  void deliver(rows, message)
}

// The members with notifications on for the site
export const pushSubscribers = (site: PushSite) =>
  sender
    ? (db.prepare('SELECT DISTINCT username FROM push_subscriptions WHERE site = ?').all(site) as { username: string }[]).map(
        row => row.username,
      )
    : []

// To every member with notifications on, but the one who caused it
export function pushToAll(site: PushSite, except: string, message: PushMessage) {
  if (!sender) return
  const rows = db
    .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE site = ? AND username != ?')
    .all(site, except) as unknown as SubscriptionRow[]
  void deliver(rows, message)
}
