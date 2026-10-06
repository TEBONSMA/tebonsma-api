import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

// Runs the API the way `npm run dev:mock` does, against the mock login provider, directory and
// mail server, and calls it like the site would. Nothing here needs a network or credentials.

const PORT = 18787
const MOCK_AUTH_PORT = 19091
const API = `http://127.0.0.1:${PORT}`
const ORIGIN = 'http://localhost:5173'

let server: ChildProcess
let dataDir: string

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface Reply<T = any> {
  status: number
  data: T
  headers: Headers
}

// user is one of the mock users (dev, kari, ola, admin), or null for a visitor
async function call<T = any>(method: string, path: string, user: string | null, body?: unknown, extra: Record<string, string> = {}): Promise<Reply<T>> {
  const headers: Record<string, string> = { ...extra }
  if (user) headers.Authorization = `Bearer mock-access.${user}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const type = res.headers.get('content-type') ?? ''
  const data = type.includes('json') ? await res.json() : await res.text()
  return { status: res.status, data, headers: res.headers }
}

// Uploads a small PNG as the given member, as the site does before a post is saved
async function upload(user: string, name: string) {
  const form = new FormData()
  form.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], name, { type: 'image/png' }))
  const res = await fetch(`${API}/feed/attachments`, { method: 'POST', headers: { Authorization: `Bearer mock-access.${user}` }, body: form })
  return (await res.json()) as { id: string }
}

// Waits until the condition holds, for things that happen on a timer in the API
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, seconds: number): Promise<T> {
  const end = Date.now() + seconds * 1000
  let last: T
  do {
    last = await read()
    if (ok(last)) return last
    await sleep(500)
  } while (Date.now() < end)
  return last
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'tebonsma-api-test-'))
  server = spawn(process.execPath, ['dev/server.ts'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      MOCK_AUTH_PORT: String(MOCK_AUTH_PORT),
      DATA_DIR: dataDir,
      ALLOWED_ORIGINS: ORIGIN,
      SITE_URL: ORIGIN,
      BOTS: 'off',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  server.stderr?.on('data', chunk => (stderr += chunk))

  const health = await until(
    () => fetch(`${API}/health`).then(res => res.ok, () => false),
    ok => ok,
    30,
  )
  assert.ok(health, `The API did not start:\n${stderr}`)
})

after(async () => {
  // Wait for the server to let go of the database before its folder is removed
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve))
    server.kill()
    await exited
  }
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

describe('login', () => {
  it('refuses a missing or bad token on member endpoints', async () => {
    assert.equal((await call('GET', '/me', null)).status, 401)
    assert.equal((await call('GET', '/me', 'nobody')).status, 401)
    assert.equal((await call('POST', '/feed/posts', null, {})).status, 401)
    assert.equal((await call('POST', '/mail/send', null, {})).status, 401)
  })

  it('allows browser calls from the site only', async () => {
    const allowed = await fetch(`${API}/feed/posts`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' } })
    assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN)
    const other = await fetch(`${API}/feed/posts`, { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET' } })
    assert.equal(other.headers.get('access-control-allow-origin'), null)
  })
})

describe('feed', () => {
  it('shows members-only posts to members, not to visitors', async () => {
    const made = await call('POST', '/feed/posts', 'dev', { body: 'Hei alle', visibility: 'members', attachmentIds: [] })
    assert.equal(made.status, 201)
    assert.ok(made.data.author.id, 'authors are known by a public id')
    assert.ok(!JSON.stringify(made.data).includes('"dev"'), 'usernames never leave the API')

    const visitor = await call('GET', '/feed/posts', null)
    assert.equal(visitor.data.posts.length, 0)
    const member = await call('GET', '/feed/posts', 'kari')
    assert.equal(member.data.posts.length, 1)
    assert.equal((await call('GET', `/feed/posts/${made.data.id}`, null)).status, 401)
  })

  it('takes comments and sends the author a notification', async () => {
    const post = (await call('GET', '/feed/posts', 'kari')).data.posts[0]
    const comment = await call('POST', `/feed/posts/${post.id}/comments`, 'kari', { body: 'Hei!', parentId: null, attachmentIds: [] })
    assert.equal(comment.status, 201)
    const notifications = await call('GET', '/notifications', 'dev')
    assert.ok(notifications.data.items.some((item: any) => item.kind === 'comment'))
  })
})

describe('events', () => {
  const starts = new Date(Date.now() + 3 * 86_400_000).toISOString()
  const ends = new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString()
  let eventId: string

  it('is a post with a title and a time', async () => {
    const made = await call('POST', '/feed/posts', 'admin', {
      body: 'Ta med godt humør',
      visibility: 'members',
      attachmentIds: [],
      event: { title: 'Grillkveld', location: 'Hagen', startsAt: starts, endsAt: ends },
    })
    assert.equal(made.status, 201)
    assert.equal(made.data.event.title, 'Grillkveld')
    eventId = made.data.id
  })

  it('takes sign-ups on closed events', async () => {
    const rsvp = await call('PUT', `/events/${eventId}/rsvp`, 'dev', { answer: 'yes' })
    assert.equal(rsvp.status, 200)
    assert.equal(rsvp.data.yes, 1)
    assert.equal(rsvp.data.mine, 'yes')
  })

  it('lets the organizer add a poll, once', async () => {
    const poll = await call('POST', `/events/${eventId}/poll`, 'admin', { question: 'Hva griller vi?', pollOptions: ['Pølser', 'Burger'] })
    assert.equal(poll.status, 201)
    assert.equal((await call('POST', `/events/${eventId}/poll`, 'dev', { question: 'X?', pollOptions: ['A', 'B'] })).status, 403)
    assert.equal((await call('POST', `/events/${eventId}/poll`, 'admin', { question: 'Igjen?', pollOptions: ['A', 'B'] })).status, 400)
    const vote = await call('PUT', `/feed/posts/${eventId}/vote`, 'dev', { optionId: poll.data.options[0].id })
    assert.equal(vote.data.totalVotes, 1)
  })

  it('is in the member calendar feed but not the public one', async () => {
    const ics = await call<string>('GET', '/calendar.ics', null)
    assert.ok(ics.headers.get('content-type')?.startsWith('text/calendar'))
    assert.ok(!ics.data.includes(eventId))

    const own = await call('GET', '/me/calendar', 'dev')
    const feed = await call<string>('GET', own.data.path, null)
    assert.equal(feed.status, 200)
    assert.ok(feed.data.includes(`UID:${eventId}@tebonsma.no`))
    assert.ok(feed.data.includes('SUMMARY:Grillkveld'))
  })
})

describe('games', () => {
  it('keeps each member’s best score with a run ticket', async () => {
    const run = await call('POST', '/games/flappy-teb/runs', 'dev')
    assert.equal(run.status, 200)
    // Right after the start only a small score is plausible
    const score = await call('POST', '/games/flappy-teb/scores', 'dev', { runId: run.data.runId, score: 2 })
    assert.equal(score.status, 200, JSON.stringify(score.data))
    assert.equal(score.data.newBest, true)
    assert.equal((await call('POST', '/games/flappy-teb/scores', 'dev', { runId: run.data.runId, score: 2 })).status, 422, 'a ticket is used once')
    const board = await call('GET', '/games/flappy-teb/leaderboard', 'dev')
    assert.equal(board.data.you.score, 2)
  })
})

describe('member pages', () => {
  it('shows a member by public id, with posts, records and coins', async () => {
    const me = await call('GET', '/members/me', 'dev')
    assert.equal(me.status, 200)
    assert.equal(me.data.isYou, true)
    assert.equal(me.data.counts.posts, 1)
    assert.ok(me.data.records.some((r: any) => r.game === 'flappy-teb' && r.record?.score === 2))
    const other = await call('GET', `/members/${me.data.member.id}`, 'kari')
    assert.equal(other.data.isYou, false)
    assert.equal((await call('GET', '/members/dev', 'kari')).status, 404, 'usernames are not ids')
  })
})

describe('mail', () => {
  it('reads the member’s own mailbox', async () => {
    const folders = await call('GET', '/mail/folders', 'dev')
    assert.equal(folders.status, 200)
    const inbox = folders.data.folders.find((f: any) => f.key === 'inbox')
    assert.ok(inbox.total > 0, 'the mock mailbox starts with mail')

    const list = await call('GET', '/mail/messages?folder=inbox', 'dev')
    const first = list.data.messages[0]
    const mail = await call('GET', `/mail/messages/${encodeURIComponent(first.id)}`, 'dev')
    assert.equal(mail.status, 200)
    assert.ok(!/<script/i.test(JSON.stringify(mail.data)), 'scripts never reach the site')
  })

  it('sends mail between members, after the undo window', async () => {
    const members = await call('GET', '/members', 'dev')
    const kari = members.data.find((m: any) => /kari/i.test(m.name))
    const sent = await call('POST', '/mail/send', 'dev', {
      to: [{ memberId: kari.id }],
      cc: [],
      bcc: [],
      subject: 'Hilsen fra testen',
      html: '<p>Hei <b>du</b></p>',
      uploadIds: [],
    })
    assert.equal(sent.status, 200, JSON.stringify(sent.data))

    const inbox = await until(
      () => call('GET', '/mail/messages?folder=inbox', 'kari'),
      reply => reply.data.messages.some((m: any) => m.subject === 'Hilsen fra testen'),
      20,
    )
    assert.ok(inbox.data.messages.some((m: any) => m.subject === 'Hilsen fra testen'), 'the mail arrived')
    const notifications = await call('GET', '/notifications', 'kari')
    assert.ok(notifications.data.mailUnread >= 1)
  })
})

describe('organizers', () => {
  const starts = new Date(Date.now() + 5 * 86_400_000).toISOString()
  const ends = new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString()
  const event = { title: 'Pubquiz', location: 'Puben', startsAt: starts, endsAt: ends }
  let eventId: string
  let picture: string

  it('are chosen among the members, not every account', async () => {
    const names = (await call('GET', '/members', 'dev')).data.map((m: any) => m.name)
    assert.ok(names.includes('Kari Nordmann') && names.includes('Ola Nordmann'))
    assert.ok(!names.includes('Dev Bruker'), 'the caller is left out')
    assert.ok(!names.includes('Admin Bruker'), 'accounts outside the member group are left out')
  })

  it('may edit an event they were given, but not who organizes it', async () => {
    const kari = (await call('GET', '/members', 'dev')).data.find((m: any) => /kari/i.test(m.name))
    const made = await call('POST', '/feed/posts', 'dev', { body: 'Lag på fire', visibility: 'members', attachmentIds: [], event: { ...event, organizers: [kari.id] } })
    assert.equal(made.status, 201)
    assert.deepEqual(made.data.event.organizers.map((m: any) => m.name), ['Kari Nordmann'])
    eventId = made.data.id

    picture = (await upload('kari', 'kart.png')).id
    const edited = await call('PATCH', `/feed/posts/${eventId}`, 'kari', { body: 'Lag på fire, start 19', visibility: 'members', attachmentIds: [picture], event })
    assert.equal(edited.status, 200, JSON.stringify(edited.data))
    assert.equal(edited.data.attachments.length, 1)

    assert.equal((await call('PATCH', `/feed/posts/${eventId}`, 'kari', { body: 'x', visibility: 'members', attachmentIds: [picture], event: { ...event, organizers: [] } })).status, 403)
    assert.equal((await call('PATCH', `/feed/posts/${eventId}`, 'ola', { body: 'x', visibility: 'members', attachmentIds: [], event })).status, 403)
    assert.equal((await call('DELETE', `/feed/posts/${eventId}`, 'kari')).status, 403)
  })

  it('keep each other’s files when they edit', async () => {
    const byAuthor = await call('PATCH', `/feed/posts/${eventId}`, 'dev', { body: 'Lag på fire, start 19.30', visibility: 'members', attachmentIds: [picture], event })
    assert.equal(byAuthor.status, 200, JSON.stringify(byAuthor.data))
    assert.equal(byAuthor.data.attachments.length, 1)

    const notKaris = (await upload('ola', 'ola.png')).id
    const withOthers = await call('PATCH', `/feed/posts/${eventId}`, 'kari', { body: 'x', visibility: 'members', attachmentIds: [picture, notKaris], event })
    assert.equal(withOthers.status, 400, 'a new file must be the editor’s own upload')
  })

  it('run the event’s markets on TebBet, like admins', async () => {
    const market = (user: string) =>
      call('POST', `/bet/events/${eventId}/markets`, user, { question: 'Hvem vinner?', kind: 'choice', outcomes: [{ label: 'Lag A', odds: 2 }, { label: 'Lag B', odds: 2 }], excluded: [] })
    assert.equal((await market('kari')).status, 201)
    assert.equal((await market('ola')).status, 403)
  })
})

describe('TebBet', () => {
  it('gives a member their starting coins', async () => {
    const me = await call('GET', '/bet/me', 'dev')
    assert.equal(me.status, 200)
    assert.equal(me.data.balance, 1000)
  })
})
