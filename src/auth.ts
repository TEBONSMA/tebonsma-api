import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { verifyAccessToken, type Caller } from './authelia.ts'
import { config } from './config.ts'

export type Env = { Variables: { caller: Caller } }

const bearerToken = (c: Context) => c.req.header('Authorization')?.match(/^Bearer (.+)$/)?.[1]

// The account being read or changed is always the one the access token belongs to
export const requireCaller = createMiddleware<Env>(async (c, next) => {
  const token = bearerToken(c)
  const caller = token ? await verifyAccessToken(token) : null
  if (!caller) throw new HTTPException(401, { message: 'Ikke innlogget' })
  c.set('caller', caller)
  await next()
})

// For endpoints that visitors can use too. A token that is sent but no longer valid is
// still an error, so the site notices the login has expired instead of showing less.
export async function findCaller(c: Context): Promise<Caller | null> {
  const token = bearerToken(c)
  if (!token) return null
  const caller = await verifyAccessToken(token)
  if (!caller) throw new HTTPException(401, { message: 'Ikke innlogget' })
  return caller
}

export const isAdmin = (caller: Caller | null) => !!caller?.groups.includes(config.adminGroup)
