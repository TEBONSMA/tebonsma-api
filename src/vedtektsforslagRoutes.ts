import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { requireCaller, type Env } from './auth.ts'
import { readBody } from './feedRoutes.ts'
import {
  addComment,
  createForslag,
  getForslag,
  listForslag,
  setArsmote,
  setStatus,
  submitForslag,
  updateForslag,
  withdrawForslag,
} from './vedtektsforslag.ts'

// Proposals to change the vedtekter (see vedtektsforslag.ts), for members only
export const vedtektsforslagRoutes = new Hono<Env>()

vedtektsforslagRoutes.use('/vedtekter/forslag', requireCaller)
vedtektsforslagRoutes.use('/vedtekter/forslag/*', requireCaller)
vedtektsforslagRoutes.use('/vedtekter/arsmote', requireCaller)

const numberOf = (c: Context) => {
  const number = Number(c.req.param('number'))
  if (!Number.isInteger(number) || number < 1) throw new HTTPException(404, { message: 'Forslaget finnes ikke' })
  return number
}

vedtektsforslagRoutes.get('/vedtekter/forslag', async c => c.json(await listForslag(c.get('caller'))))

// { title, reason, changes, parent?, submit? }
vedtektsforslagRoutes.post('/vedtekter/forslag', async c => c.json(await createForslag(c.get('caller'), await readBody(c)), 201))

vedtektsforslagRoutes.get('/vedtekter/forslag/:number', async c => c.json(await getForslag(c.get('caller'), numberOf(c))))

vedtektsforslagRoutes.patch('/vedtekter/forslag/:number', async c =>
  c.json(await updateForslag(c.get('caller'), numberOf(c), await readBody(c))),
)

vedtektsforslagRoutes.post('/vedtekter/forslag/:number/send-inn', async c => c.json(await submitForslag(c.get('caller'), numberOf(c))))

vedtektsforslagRoutes.post('/vedtekter/forslag/:number/trekk', async c => c.json(await withdrawForslag(c.get('caller'), numberOf(c))))

// { status: 'innsendt' | 'vedtatt' | 'forkastet' }
vedtektsforslagRoutes.post('/vedtekter/forslag/:number/status', async c => {
  const { status } = await readBody(c)
  return c.json(await setStatus(c.get('caller'), numberOf(c), status))
})

// { body }
vedtektsforslagRoutes.post('/vedtekter/forslag/:number/kommentarer', async c => {
  const { body } = await readBody(c)
  return c.json(await addComment(c.get('caller'), numberOf(c), body), 201)
})

// { title, startsAt }: the next årsmøte
vedtektsforslagRoutes.put('/vedtekter/arsmote', async c => c.json(setArsmote(c.get('caller'), await readBody(c))))
