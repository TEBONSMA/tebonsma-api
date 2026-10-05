import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { verifyAccessToken } from '../authelia.ts'
import { config } from '../config.ts'
import { db } from '../db.ts'

// For a member who has said yes, the API keeps a refresh token from a client of its own at the login
// provider, so a mail can be sent at the time the member chose even when they are logged out. It is
// the only secret the API keeps for a member, it is encrypted, and the member can take it back at
// any time. A member who hasn't said yes has nothing stored.
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_offline_tokens (
    owner      TEXT PRIMARY KEY,
    token      BLOB NOT NULL,
    iv         BLOB NOT NULL,
    tag        BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
`)

const SCOPE = 'openid profile email groups offline_access'
const STATE_MS = 10 * 60 * 1000
const REFRESH_MARGIN_MS = 60_000

export const offlineAvailable = () => config.mail.offline !== null

function settings() {
  if (!config.mail.offline) throw new HTTPException(503, { message: 'Send senere er ikke slått på' })
  return config.mail.offline
}

// --- Keeping the token ---

function encrypt(token: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', settings().key, iv)
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return { token: encrypted, iv, tag: cipher.getAuthTag() }
}

function decrypt(row: { token: Uint8Array; iv: Uint8Array; tag: Uint8Array }) {
  const decipher = createDecipheriv('aes-256-gcm', settings().key, row.iv)
  decipher.setAuthTag(Buffer.from(row.tag))
  return Buffer.concat([decipher.update(row.token), decipher.final()]).toString('utf8')
}

function store(owner: string, refreshToken: string) {
  const sealed = encrypt(refreshToken)
  db.prepare(
    `INSERT INTO mail_offline_tokens (owner, token, iv, tag, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (owner) DO UPDATE SET token = excluded.token, iv = excluded.iv, tag = excluded.tag`,
  ).run(owner, sealed.token, sealed.iv, sealed.tag, new Date().toISOString())
}

export const hasOfflineToken = (owner: string) =>
  offlineAvailable() && !!db.prepare('SELECT 1 FROM mail_offline_tokens WHERE owner = ?').get(owner)

export const offlineOwners = () =>
  offlineAvailable() ? (db.prepare('SELECT owner FROM mail_offline_tokens').all() as unknown as { owner: string }[]).map(row => row.owner) : []

// --- Asking the login provider ---

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const { clientId, clientSecret, tokenUrl } = settings()
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`,
    },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(10_000),
  })
  const body = (await res.json().catch(() => null)) as (TokenResponse & { error?: string }) | null
  if (!res.ok || !body) throw new TokenRefused(body?.error ?? `HTTP ${res.status}`, res.status >= 400 && res.status < 500)
  return body
}

// The provider said no (the permission was taken back or has run out), as opposed to not answering
export class TokenRefused extends Error {
  permanent: boolean

  constructor(message: string, permanent: boolean) {
    super(message)
    this.permanent = permanent
  }
}

// --- Saying yes ---

const pending = new Map<string, { owner: string; verifier: string; until: number }>()

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

// The address the member is sent to, to say yes at the login provider
export function startOffline(owner: string) {
  const { clientId, authorizeUrl, redirectUri } = settings()
  for (const [state, entry] of pending) if (entry.until < Date.now()) pending.delete(state)

  const state = randomBytes(24).toString('base64url')
  const verifier = randomBytes(48).toString('base64url')
  pending.set(state, { owner, verifier, until: Date.now() + STATE_MS })

  const url = new URL(authorizeUrl)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challengeOf(verifier),
    code_challenge_method: 'S256',
  }).toString()
  return { url: url.toString() }
}

// The member came back with a code: exchange it, check it is really theirs, and keep the refresh token
export async function finishOffline(owner: string, code: string, state: string) {
  const entry = pending.get(state)
  pending.delete(state)
  if (!entry || entry.until < Date.now() || entry.owner !== owner) {
    throw new HTTPException(400, { message: 'Tillatelsen har gått ut. Prøv igjen.' })
  }

  let tokens: TokenResponse
  try {
    tokens = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: settings().redirectUri,
      code_verifier: entry.verifier,
    })
  } catch {
    throw new HTTPException(400, { message: 'Innloggingstjenesten godtok ikke tillatelsen. Prøv igjen.' })
  }
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new HTTPException(400, { message: 'Innloggingstjenesten ga ikke fra seg en tillatelse som varer' })
  }

  // Said yes while logged in as someone else at the provider: not this member's to give
  const who = await verifyAccessToken(tokens.access_token)
  if (!who || who.username !== owner) throw new HTTPException(403, { message: 'Du var logget inn som en annen bruker. Prøv igjen.' })

  store(owner, tokens.refresh_token)
  cache.set(owner, { token: tokens.access_token, until: Date.now() + (tokens.expires_in ?? 300) * 1000 })
}

// --- Saying no ---

export async function revokeOffline(owner: string) {
  const row = db.prepare('SELECT token, iv, tag FROM mail_offline_tokens WHERE owner = ?').get(owner) as
    | { token: Uint8Array; iv: Uint8Array; tag: Uint8Array }
    | undefined
  db.prepare('DELETE FROM mail_offline_tokens WHERE owner = ?').run(owner)
  cache.delete(owner)
  if (!row || !config.mail.offline) return

  // Also tell the provider, so the token is dead there too. The member's own choice already counts here.
  const { clientId, clientSecret, revokeUrl } = config.mail.offline
  try {
    await fetch(revokeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`,
      },
      body: new URLSearchParams({ token: decrypt(row), token_type_hint: 'refresh_token' }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch (err) {
    console.error('Could not revoke the refresh token at the provider:', err)
  }
}

// --- Using it ---

const cache = new Map<string, { token: string; until: number }>()

// A fresh access token for the member, or a TokenRefused when the permission is gone (which also
// removes it here). A provider that doesn't answer is an ordinary error, tried again later.
export async function accessTokenFor(owner: string) {
  const hit = cache.get(owner)
  if (hit && hit.until - REFRESH_MARGIN_MS > Date.now()) return hit.token

  const row = db.prepare('SELECT token, iv, tag FROM mail_offline_tokens WHERE owner = ?').get(owner) as
    | { token: Uint8Array; iv: Uint8Array; tag: Uint8Array }
    | undefined
  if (!row) throw new TokenRefused('no permission', true)

  let refreshToken: string
  try {
    refreshToken = decrypt(row)
  } catch {
    // Written with a key that is no longer the one in use, so it can't be read again
    db.prepare('DELETE FROM mail_offline_tokens WHERE owner = ?').run(owner)
    throw new TokenRefused('unreadable', true)
  }

  try {
    const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
    if (!tokens.access_token) throw new TokenRefused('no access token', true)
    // Some providers give a new refresh token each time
    if (tokens.refresh_token) store(owner, tokens.refresh_token)
    cache.set(owner, { token: tokens.access_token, until: Date.now() + (tokens.expires_in ?? 300) * 1000 })
    return tokens.access_token
  } catch (err) {
    if (err instanceof TokenRefused && err.permanent) {
      db.prepare('DELETE FROM mail_offline_tokens WHERE owner = ?').run(owner)
      cache.delete(owner)
    }
    throw err
  }
}
