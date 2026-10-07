import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requireCaller, type Env } from './auth.ts'
import { calendarFeed, calendarPath, calendarViewer, resetCalendarPath } from './calendar.ts'
import { listRsvps, setRsvp } from './events.ts'
import { addEventPoll, getPost, listEvents, sendAnnouncement } from './feed.ts'
import { bad, readBody, readPoll, readText, viewerOf, visitorOf } from './feedRoutes.ts'

const MAX_ANNOUNCEMENT_LENGTH = 500

// Events are created, changed and deleted as the feed posts they are (see feedRoutes);
// these are the parts only events have
export const eventRoutes = new Hono<Env>()

eventRoutes.use('/events/*', bodyLimit({ maxSize: 16 * 1024 }))

function readDay(raw: string | undefined) {
  if (raw === undefined) return null
  const time = new Date(raw)
  if (Number.isNaN(time.getTime())) throw bad('Ugyldig tidspunkt')
  return time.toISOString()
}

eventRoutes.get('/events', async c =>
  c.json(await listEvents(await visitorOf(c), readDay(c.req.query('from')), readDay(c.req.query('to')))),
)

eventRoutes.put('/events/:id/rsvp', requireCaller, async c => {
  const { answer } = await readBody(c)
  if (answer !== 'yes' && answer !== 'maybe' && answer !== 'no' && answer !== null) throw bad('Svar ja, kanskje eller nei')
  const viewer = viewerOf(c)
  // Fetching the post checks that the member can see it
  const post = await getPost(viewer, c.req.param('id'))
  return c.json(setRsvp(post.id, viewer, post.visibility, answer))
})

eventRoutes.get('/events/:id/rsvps', requireCaller, async c => {
  const post = await getPost(viewerOf(c), c.req.param('id'))
  return c.json(await listRsvps(post.id, post.visibility))
})

eventRoutes.post('/events/:id/announcements', requireCaller, async c => {
  const { body } = await readBody(c)
  const text = readText(body ?? '', 'Kunngjøringen', MAX_ANNOUNCEMENT_LENGTH)
  if (!text) throw bad('Kunngjøringen er tom')
  sendAnnouncement(viewerOf(c), c.req.param('id'), text)
  return c.json({ ok: true }, 201)
})

eventRoutes.post('/events/:id/poll', requireCaller, async c => {
  const { pollOptions, question } = await readBody(c)
  const poll = readPoll(pollOptions, question, true, '')
  if (!poll) throw bad('En spørreundersøkelse trenger minst to svaralternativer')
  return c.json(addEventPoll(viewerOf(c), c.req.param('id'), poll), 201)
})

// The calendar for calendar apps to subscribe to. They can't send a token, so the public
// events have an open address and each member has a secret one with the closed events too.
const ics = (c: Context, feed: string, cache: 'public' | 'private') =>
  c.body(feed, 200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="tebonsma.ics"',
    'Cache-Control': `${cache}, max-age=900`,
  })

eventRoutes.get('/calendar.ics', async c => ics(c, await calendarFeed(null), 'public'))

eventRoutes.get('/calendar/:file{.+\\.ics}', async c =>
  ics(c, await calendarFeed(await calendarViewer(c.req.param('file').slice(0, -'.ics'.length))), 'private'),
)

eventRoutes.get('/me/calendar', requireCaller, c => c.json({ path: calendarPath(c.get('caller').username) }))

eventRoutes.post('/me/calendar', requireCaller, c => c.json({ path: resetCalendarPath(c.get('caller').username) }))
