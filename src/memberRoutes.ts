import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { requireCaller, type Env } from './auth.ts'
import { ensureAccount, getLeaderboard } from './bets.ts'
import { countPostsBy, listPostsBy } from './feed.ts'
import { bad, viewerOf } from './feedRoutes.ts'
import { getMembers, usernameOf } from './members.ts'
import { getRecords } from './scoreboard.ts'

const PAGE_SIZE = 10
const MAX_PAGE_SIZE = 30

// A member's own page, open to every member. Others are known by their public id, never by
// username; "me" is the member asking, so the site needn't know its own id.
export const memberRoutes = new Hono<Env>()

async function resolve(c: Context<Env>, param: string) {
  const own = c.get('caller').username
  const username = param === 'me' ? own : usernameOf(param)
  if (!username) throw new HTTPException(404, { message: 'Medlemmet finnes ikke' })
  const [member] = (await getMembers([username])).values()
  return { username, member, isYou: username === own }
}

memberRoutes.get('/members/:id', requireCaller, async c => {
  const { username, member, isYou } = await resolve(c, c.req.param('id'))
  // A new member starts with their coins the first time anyone looks
  if (isYou) ensureAccount(username)
  const standing = (await getLeaderboard()).find(row => row.member.id === member.id)

  return c.json({
    member,
    isYou,
    counts: countPostsBy(username),
    records: getRecords(username),
    // Missing for a member who has never opened TebBet
    coins: standing
      ? { balance: standing.balance, inPlay: standing.inPlay, total: standing.total, rank: standing.rank }
      : null,
  })
})

memberRoutes.get('/members/:id/posts', requireCaller, async c => {
  const kind = c.req.query('kind') ?? 'posts'
  if (kind !== 'posts' && kind !== 'events') throw bad('Ukjent type')
  const offset = Math.max(0, Math.trunc(Number(c.req.query('offset') ?? 0)) || 0)
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(c.req.query('limit') ?? PAGE_SIZE)) || PAGE_SIZE))
  const { username } = await resolve(c, c.req.param('id'))
  return c.json(await listPostsBy(viewerOf(c), username, kind === 'events', offset, limit))
})
