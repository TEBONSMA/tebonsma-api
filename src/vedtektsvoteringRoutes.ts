import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { findCaller, requireCaller, type Env } from './auth.ts'
import { readBody } from './feedRoutes.ts'
import { hasPublishKey } from './vedtekterRoutes.ts'
import { canManage } from './vedtektsforslag.ts'
import {
  addPunkt,
  adopted,
  castVote,
  checkIn,
  checkOut,
  closeVote,
  drawLot,
  endArsmote,
  liveArsmote,
  openFreeVote,
  openVote,
  removePunkt,
  revote,
  setAgenda,
  startArsmote,
} from './vedtektsvotering.ts'

// The årsmøte voting on the proposals (see vedtektsvotering.ts), for members only
export const vedtektsvoteringRoutes = new Hono<Env>()

vedtektsvoteringRoutes.use('/vedtekter/arsmote/live', requireCaller)
vedtektsvoteringRoutes.use('/vedtekter/arsmote/start', requireCaller)
vedtektsvoteringRoutes.use('/vedtekter/arsmote/avslutt', requireCaller)
vedtektsvoteringRoutes.use('/vedtekter/arsmote/oppmote', requireCaller)
vedtektsvoteringRoutes.use('/vedtekter/arsmote/oppmote/*', requireCaller)
vedtektsvoteringRoutes.use('/vedtekter/arsmote/saker', requireCaller)
vedtektsvoteringRoutes.use('/vedtekter/arsmote/saker/*', requireCaller)
vedtektsvoteringRoutes.use('/vedtekter/arsmote/saksliste', requireCaller)
vedtektsvoteringRoutes.use('/vedtekter/voteringer', requireCaller)
vedtektsvoteringRoutes.use('/vedtekter/voteringer/*', requireCaller)

// Everything the årsmøte page shows; it asks again every few seconds
vedtektsvoteringRoutes.get('/vedtekter/arsmote/live', async c => c.json(await liveArsmote(c.get('caller'))))

vedtektsvoteringRoutes.post('/vedtekter/arsmote/start', async c => {
  startArsmote(c.get('caller'))
  return c.json(await liveArsmote(c.get('caller')))
})

vedtektsvoteringRoutes.post('/vedtekter/arsmote/avslutt', async c => {
  endArsmote(c.get('caller'))
  return c.json(await liveArsmote(c.get('caller')))
})

// The member checks in themselves
vedtektsvoteringRoutes.post('/vedtekter/arsmote/oppmote', async c => {
  checkIn(c.get('caller'))
  return c.json(await liveArsmote(c.get('caller')))
})

// The protocol group checks someone in or out
vedtektsvoteringRoutes.post('/vedtekter/arsmote/oppmote/:memberId', async c => {
  checkIn(c.get('caller'), c.req.param('memberId'))
  return c.json(await liveArsmote(c.get('caller')))
})

vedtektsvoteringRoutes.delete('/vedtekter/arsmote/oppmote/:memberId', async c => {
  checkOut(c.get('caller'), c.req.param('memberId'))
  return c.json(await liveArsmote(c.get('caller')))
})

// { title }: another case on the agenda
vedtektsvoteringRoutes.post('/vedtekter/arsmote/saker', async c => {
  const { title } = await readBody(c)
  addPunkt(c.get('caller'), title)
  return c.json(await liveArsmote(c.get('caller')), 201)
})

vedtektsvoteringRoutes.delete('/vedtekter/arsmote/saker/:id', async c => {
  removePunkt(c.get('caller'), c.req.param('id'))
  return c.json(await liveArsmote(c.get('caller')))
})

// { order: ['forslag:3', 'punkt:…', …] }: the order the cases are taken in
vedtektsvoteringRoutes.put('/vedtekter/arsmote/saksliste', async c => {
  const { order } = await readBody(c)
  setAgenda(c.get('caller'), order)
  return c.json(await liveArsmote(c.get('caller')))
})

// { a, b }: forslag a against forslag b, or against the vedtekter as they are when b is null.
// { a, opptak: true }: whether forslag a, sent in too late, is taken up.
// { title, options, rule, sak? }: anything else the årsmøte votes on, maybe a case on the agenda.
vedtektsvoteringRoutes.post('/vedtekter/voteringer', async c => {
  const body = await readBody(c)
  if (body.title !== undefined) openFreeVote(c.get('caller'), body)
  else openVote(c.get('caller'), body.a, body.b, body.opptak === true)
  return c.json(await liveArsmote(c.get('caller')), 201)
})

// { choice: the option's index, or 'blank' }
vedtektsvoteringRoutes.post('/vedtekter/voteringer/:id/stem', async c => {
  const { choice } = await readBody(c)
  castVote(c.get('caller'), c.req.param('id'), choice)
  return c.json(await liveArsmote(c.get('caller')))
})

// { hand: { options: [n, …], blank } }: what was counted by hand in the room
vedtektsvoteringRoutes.post('/vedtekter/voteringer/:id/lukk', async c => {
  const { hand } = await readBody(c)
  closeVote(c.get('caller'), c.req.param('id'), hand && typeof hand === 'object' ? hand : {})
  return c.json(await liveArsmote(c.get('caller')))
})

// What the årsmøte adopted, for the vedtekter repo (with its key) or the protocol group
vedtektsvoteringRoutes.get('/vedtekter/arsmote/vedtatt', async c => {
  if (!hasPublishKey(c)) {
    const caller = await findCaller(c)
    if (!caller) throw new HTTPException(401, { message: 'Logg inn' })
    if (!canManage(caller)) throw new HTTPException(403, { message: 'Bare protokollfører kan hente vedtakene' })
  }
  return c.json(adopted())
})

// After a tie: { option } drawn by lot in the room, or 'tilfeldig' to draw here
vedtektsvoteringRoutes.post('/vedtekter/voteringer/:id/loddtrekning', async c => {
  const { option } = await readBody(c)
  drawLot(c.get('caller'), c.req.param('id'), option)
  return c.json(await liveArsmote(c.get('caller')))
})

// After a tie: { keep: [i, …] }, the options to vote on again
vedtektsvoteringRoutes.post('/vedtekter/voteringer/:id/gjenvalg', async c => {
  const { keep } = await readBody(c)
  revote(c.get('caller'), c.req.param('id'), keep)
  return c.json(await liveArsmote(c.get('caller')), 201)
})
