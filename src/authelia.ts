import { createHash } from 'node:crypto'
import { config } from './config.ts'

export interface Caller {
  username: string
  groups: string[]
}

// Authelia access tokens are opaque, so they are checked against the userinfo endpoint.
// Results are cached briefly to avoid a round trip on every request.
const CACHE_MS = 60_000
const cache = new Map<string, { caller: Caller; until: number }>()

const cacheKey = (token: string) => createHash('sha256').update(token).digest('hex')

export async function verifyAccessToken(token: string): Promise<Caller | null> {
  const key = cacheKey(token)
  const hit = cache.get(key)
  if (hit && hit.until > Date.now()) return hit.caller

  const res = await fetch(config.userinfoUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) throw new Error(`userinfo returned HTTP ${res.status}`)

  const info = (await res.json()) as { preferred_username?: unknown; groups?: unknown }
  if (typeof info.preferred_username !== 'string' || !info.preferred_username) return null

  const caller: Caller = {
    username: info.preferred_username,
    groups: Array.isArray(info.groups) ? info.groups.filter(g => typeof g === 'string') : [],
  }
  cache.set(key, { caller, until: Date.now() + CACHE_MS })
  if (cache.size > 1000) {
    const now = Date.now()
    for (const [k, v] of cache) if (v.until <= now) cache.delete(k)
  }
  return caller
}
