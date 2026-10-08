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
// What the API pushed, as the mock push service prints it (dev/mock-push.ts)
const pushes: { endpoint: string; title: string; body: string; url: string; tag?: string }[] = []

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
      NEW_MARKETS_CHECK_SECONDS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  server.stderr?.on('data', chunk => (stderr += chunk))
  let stdout = ''
  server.stdout?.on('data', chunk => {
    stdout += chunk
    const lines = stdout.split('\n')
    stdout = lines.pop()!
    for (const line of lines) if (line.startsWith('[push] ')) pushes.push(JSON.parse(line.slice(7)))
  })

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

  it('stops counting a combination once it is lost, and logs the bet and the result', async () => {
    const group = await call('POST', '/bet/groups', 'admin', { title: 'Været' })
    assert.equal(group.status, 201, JSON.stringify(group.data))
    const market = async (question: string) => {
      const created = await call('POST', `/bet/groups/${group.data.id}/markets`, 'admin', {
        question,
        kind: 'yesno',
        outcomes: [{ label: 'Ja', odds: 2 }, { label: 'Nei', odds: 2 }],
        excluded: [],
      })
      assert.equal(created.status, 201, JSON.stringify(created.data))
      return created.data
    }
    const rain = await market('Regner det i morgen?')
    const snow = await market('Snør det i morgen?')
    const yes = (m: any) => ({ outcomeId: m.outcomes[0].id, odds: m.outcomes[0].odds })
    const played = await call('POST', '/bet/slips', 'dev', { slips: [{ stake: 100, selections: [yes(rain), yes(snow)] }] })
    assert.equal(played.status, 201, JSON.stringify(played.data))

    const settled = await call('POST', `/bet/markets/${rain.id}/settle`, 'admin', { outcomeId: rain.outcomes[1].id })
    assert.equal(settled.status, 200, JSON.stringify(settled.data))
    const after = await call('GET', `/bet/groups/${group.data.id}`, 'dev')
    assert.deepEqual(after.data.markets.find((m: any) => m.id === snow.id).mine, {}, 'nothing rides on snow once rain lost')

    const log = await call('GET', '/bet/activity', 'kari')
    assert.equal(log.status, 200)
    assert.equal(log.data.items[0].kind, 'result')
    assert.equal(log.data.items[0].answer, 'Nei')
    const [player] = log.data.items[0].players
    assert.equal(player.member.name, 'Dev Bruker')
    assert.equal(player.label, 'Ja')
    assert.equal(player.result, 'lost')
    assert.equal(player.gain, -100)
    assert.equal(player.combination.legs, 2)
    assert.equal(player.combination.voided, 0)
    const slip = log.data.items.find((item: any) => item.kind === 'slip')
    assert.equal(slip.slip.selections.length, 2)
    assert.equal(slip.slip.status, 'lost')
    const results = await call('GET', '/bet/activity?kind=result', 'kari')
    assert.ok(results.data.items.every((item: any) => item.kind === 'result'))
    assert.equal((await call('GET', '/bet/activity?kind=nope', 'kari')).status, 400)
  })

  it('hides the odds on a market from a member kept out of it, wherever they show', async () => {
    const members = await call('GET', '/bet/members', 'admin')
    const kari = members.data.find((m: any) => m.name === 'Kari Nordmann')
    const group = await call('POST', '/bet/groups', 'admin', { title: 'Om Kari' })
    const created = await call('POST', `/bet/groups/${group.data.id}/markets`, 'admin', {
      question: 'Kommer Kari for seint?',
      kind: 'yesno',
      outcomes: [{ label: 'Ja', odds: 1.5 }, { label: 'Nei', odds: 3 }],
      excluded: [kari.id],
    })
    assert.equal(created.status, 201, JSON.stringify(created.data))
    const yes = created.data.outcomes[0]
    assert.equal((await call('POST', '/bet/slips', 'dev', { slips: [{ stake: 50, selections: [{ outcomeId: yes.id, odds: yes.odds }] }] })).status, 201)

    const seen = (await call('GET', `/bet/groups/${group.data.id}`, 'kari')).data
    const market = seen.markets[0]
    assert.equal(market.blocked, true)
    assert.ok(market.outcomes.every((o: any) => o.odds === null && o.price === null && o.staked === null))
    assert.equal(seen.bets[0].odds, null)
    const log = (await call('GET', '/bet/activity?kind=slip', 'kari')).data.items[0]
    assert.equal(log.slip.odds, null)
    assert.equal(log.slip.potentialPayout, null)
    assert.equal(log.slip.selections[0].odds, null)

    // Others still see them
    assert.equal(typeof (await call('GET', '/bet/activity?kind=slip', 'ola')).data.items[0].slip.odds, 'number')

    // Once decided, the result lists who won, but not at what odds or for how much to Kari
    assert.equal((await call('POST', `/bet/markets/${created.data.id}/settle`, 'admin', { outcomeId: yes.id })).status, 200)
    const forKari = (await call('GET', '/bet/activity?kind=result', 'kari')).data.items[0].players[0]
    assert.equal(forKari.result, 'won')
    assert.equal(forKari.odds, null)
    assert.equal(forKari.gain, null)
    const forOla = (await call('GET', '/bet/activity?kind=result', 'ola')).data.items[0].players[0]
    assert.equal(typeof forOla.odds, 'number')
    assert.ok(forOla.gain > 0)
  })

  it('lets a member try a scratch card for free', async () => {
    const before = (await call('GET', '/bet/me', 'ola')).data.balance
    const ticket = await call('POST', '/bet/flaks/underbergen/try', 'ola')
    assert.equal(ticket.status, 200, JSON.stringify(ticket.data))
    assert.equal(ticket.data.fields.length, 9)
    assert.equal(typeof ticket.data.prize, 'number')
    assert.equal((await call('GET', '/bet/me', 'ola')).data.balance, before, 'no coins move')
    assert.equal((await call('GET', '/bet/flaks', 'ola')).data.tickets.length, 0, 'nothing is kept')
    assert.equal((await call('POST', '/bet/flaks/finnes-ikke/try', 'ola')).status, 404)
  })

  it('plays blackjack, with coins in and out of the ledger', async () => {
    const balance = async () => (await call('GET', '/bet/me', 'kari')).data.balance
    for (let round = 0; round < 5; round++) {
      const before = await balance()
      const dealt = await call('POST', '/bet/casino/blackjack/deal', 'kari', { bet: 20 })
      assert.equal(dealt.status, 201, JSON.stringify(dealt.data))
      let hand = dealt.data.hand
      if (hand.status === 'playing') {
        assert.equal(hand.dealer.cards[1], null, 'the hole card stays hidden')
        assert.equal((await call('POST', '/bet/casino/blackjack/deal', 'kari', { bet: 20 })).status, 409, 'one hand at a time')
        assert.equal((await call('POST', `/bet/casino/blackjack/${hand.id}/fly`, 'kari')).status, 400)
        hand = (await call('POST', `/bet/casino/blackjack/${hand.id}/stand`, 'kari')).data.hand
      }
      assert.equal(hand.status, 'done')
      assert.ok(hand.dealer.cards.every((card: any) => card !== null), 'the hole card is shown at the end')
      assert.equal(await balance(), before - hand.staked + hand.payout)
    }
    const played = await call('GET', '/bet/flaks/hands', 'kari')
    assert.equal(played.data.length, 5)
  })

  it('logs roulette spins and blackjack hands, but not free ones', async () => {
    assert.equal((await call('POST', '/bet/casino/roulette/spin', 'kari', { bets: [{ type: 'black', stake: 10 }] })).status, 200)
    const log = await call('GET', '/bet/activity?kind=spin,hand', 'ola')
    assert.equal(log.status, 200)
    assert.ok(log.data.items.every((item: any) => item.kind === 'spin' || item.kind === 'hand'))
    assert.equal(log.data.items.filter((item: any) => item.kind === 'spin').length, 1)
    assert.ok(log.data.items.filter((item: any) => item.kind === 'hand').every((item: any) => !item.hand.trial))
    assert.equal((await call('GET', '/bet/activity?kind=spin,nope', 'ola')).status, 400)
  })

  it('logs scratch cards with every field', async () => {
    const bought = await call('POST', '/bet/flaks/underbergen/buy', 'kari')
    assert.equal(bought.status, 201, JSON.stringify(bought.data))
    const scratched = await call('POST', `/bet/flaks/tickets/${bought.data.ticket.id}/scratch`, 'kari', {})
    assert.equal(scratched.data.ticket.done, true)
    const [logged] = (await call('GET', '/bet/activity?kind=ticket', 'ola')).data.items
    assert.equal(logged.id, `ticket:${bought.data.ticket.id}`)
    assert.deepEqual(logged.fields, scratched.data.ticket.fields)
  })

  it('lets admins put up a picture for a group', async () => {
    const group = (await call('POST', '/bet/groups', 'admin', { title: 'Med bilde' })).data
    assert.equal(group.image, null)
    // The start of a JPEG is all the API checks
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64')
    assert.equal((await call('PUT', `/tebbet/groups/${group.id}/image`, 'ola', { image: jpeg })).status, 403)
    assert.equal((await call('PUT', `/tebbet/groups/${group.id}/image`, 'admin', { image: Buffer.from('not a jpeg').toString('base64') })).status, 400)
    const put = await call('PUT', `/tebbet/groups/${group.id}/image`, 'admin', { image: jpeg })
    assert.equal(put.status, 200, JSON.stringify(put.data))
    const listed = (await call('GET', `/bet/groups/${group.id}`, 'ola')).data
    assert.equal(listed.image, put.data.image)
    const picture = await fetch(API + put.data.image)
    assert.equal(picture.status, 200, 'anyone may fetch it')
    assert.equal(picture.headers.get('content-type'), 'image/jpeg')
    assert.equal((await call('DELETE', `/tebbet/groups/${group.id}/image`, 'admin')).data.image, null)
    assert.equal((await fetch(API + `/tebbet/groups/${group.id}/image`)).status, 404)
  })

  it('plays a combination with a roulette pick, spun at once', async () => {
    const group = (await call('POST', '/bet/groups', 'admin', { title: 'Rulettkombo' })).data
    const market = (
      await call('POST', `/bet/groups/${group.id}/markets`, 'admin', {
        question: 'Blir det fest?',
        kind: 'yesno',
        outcomes: [{ label: 'Ja', odds: 2 }, { label: 'Nei', odds: 2 }],
        excluded: [],
      })
    ).data
    const red = { roulette: { type: 'red' }, odds: 2 }
    const yes = async () => {
      const outcome = (await call('GET', `/bet/groups/${group.id}`, 'kari')).data.markets[0].outcomes[0]
      return { outcomeId: outcome.id, odds: outcome.odds }
    }
    const play = async (selections: unknown[]) => call('POST', '/bet/slips', 'kari', { slips: [{ stake: 10, selections }] })
    assert.equal((await play([red])).status, 400, 'roulette alone')
    assert.equal((await play([await yes(), red, red])).status, 400, 'two roulette picks')
    assert.equal((await play([await yes(), { roulette: { type: 'red' }, odds: 3 }])).status, 400, 'wrong odds')

    const played = []
    for (let i = 0; i < 6; i++) {
      const placed = await play([await yes(), red])
      assert.equal(placed.status, 201, JSON.stringify(placed.data))
      const [slip] = placed.data.slips
      const spin = slip.selections.find((s: any) => s.roulette)
      assert.equal(spin.label, 'Rødt')
      assert.ok(spin.roulette.landed >= 0 && spin.roulette.landed <= 36)
      // A miss loses the slip at once; a hit leaves it waiting on the market
      assert.equal(slip.status, spin.result === 'won' ? 'open' : 'lost')
      played.push(slip)
    }

    assert.equal((await call('POST', `/bet/markets/${market.id}/settle`, 'admin', { outcomeId: market.outcomes[0].id })).status, 200)
    const settled = (await call('GET', '/bet/slips?status=settled', 'kari')).data
    for (const slip of played.filter(s => s.status === 'open')) {
      const after = settled.find((s: any) => s.id === slip.id)
      assert.equal(after.status, 'won')
      assert.equal(after.payout, Math.floor((10 * Math.round(slip.odds * 100)) / 100), 'the market and roulette odds together')
    }
  })

  it('lets a member try blackjack for free', async () => {
    const before = (await call('GET', '/bet/me', 'ola')).data.balance
    let hand = (await call('POST', '/bet/casino/blackjack/deal', 'ola', { bet: 100, trial: true })).data.hand
    assert.equal(hand.trial, true)
    while (hand.status === 'playing') hand = (await call('POST', `/bet/casino/blackjack/${hand.id}/hit`, 'ola')).data.hand
    assert.equal((await call('GET', '/bet/me', 'ola')).data.balance, before, 'no coins move')
    assert.equal((await call('GET', '/bet/flaks/hands', 'ola')).data.length, 0, 'free hands are not listed')
  })

  it('lets a member try roulette for free', async () => {
    const before = (await call('GET', '/bet/me', 'ola')).data.balance
    const spin = await call('POST', '/bet/casino/roulette/try', 'ola', { bets: [{ type: 'red', stake: 100 }, { type: 'straight', number: 17, stake: 10 }] })
    assert.equal(spin.status, 200, JSON.stringify(spin.data))
    assert.ok(spin.data.number >= 0 && spin.data.number <= 36)
    assert.equal(spin.data.stake, 110)
    assert.equal(spin.data.bets.length, 2)
    assert.equal((await call('GET', '/bet/me', 'ola')).data.balance, before, 'no coins move')
    assert.equal((await call('GET', '/bet/flaks/spins', 'ola')).data.length, 0, 'nothing is kept')
  })

  it('takes roulette bets on the lines between the numbers', async () => {
    const odds: Record<string, number> = { split: 18, street: 12, corner: 9, line: 6 }
    const bets = [
      { type: 'split', numbers: [20, 17], stake: 10 },
      { type: 'street', numbers: [13, 14, 15], stake: 10 },
      { type: 'corner', numbers: [0, 1, 2, 3], stake: 10 },
      { type: 'line', numbers: [31, 32, 33, 34, 35, 36], stake: 10 },
    ]
    for (let i = 0; i < 15; i++) {
      const spin = await call('POST', '/bet/casino/roulette/try', 'ola', { bets })
      assert.equal(spin.status, 200, JSON.stringify(spin.data))
      assert.deepEqual(spin.data.bets[0].numbers, [17, 20], 'the numbers lowest first')
      for (const bet of spin.data.bets) {
        const won = bet.numbers.includes(spin.data.number)
        assert.equal(bet.won, won)
        assert.equal(bet.payout, won ? bet.stake * odds[bet.type] : 0)
      }
    }
    const refused = async (bet: object) => (await call('POST', '/bet/casino/roulette/try', 'ola', { bets: [{ ...bet, stake: 10 }] })).status
    assert.equal(await refused({ type: 'split', numbers: [17, 19] }), 400, 'not side by side')
    assert.equal(await refused({ type: 'split', numbers: [3, 4] }), 400, 'not across the end of a row')
    assert.equal(await refused({ type: 'corner', numbers: [1, 2, 3, 4] }), 400)
    assert.equal(await refused({ type: 'street', numbers: [2, 3, 4] }), 400)
    assert.equal(await refused({ type: 'line', numbers: [34, 35, 36] }), 400)
    assert.equal(await refused({ type: 'split' }), 400)
  })
})

describe('push notifications', () => {
  // What a browser hands over: an address at its push service and the keys to encrypt for it
  const subscription = (name: string) => ({
    endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
    keys: { p256dh: 'B' + 'x'.repeat(86), auth: 'a'.repeat(22) },
  })
  const pushedTo = (name: string) => pushes.filter(push => push.endpoint.endsWith(`/${name}`))

  it('takes subscriptions from members, for the push services only', async () => {
    const key = await call('GET', '/push/key', null)
    assert.equal(typeof key.data.publicKey, 'string')

    const add = (user: string | null, body: unknown) => call('POST', '/push/subscriptions', user, body)
    assert.equal((await add(null, { site: 'teb', subscription: subscription('nobody') })).status, 401)
    assert.equal((await add('dev', { site: 'elsewhere', subscription: subscription('dev-x') })).status, 400)
    const inside = { ...subscription('dev-x'), endpoint: 'https://lldap:17170/api/graphql' }
    assert.equal((await add('dev', { site: 'teb', subscription: inside })).status, 400, 'never an address inside the network')
    assert.equal((await add('dev', { site: 'teb', subscription: { ...subscription('dev-x'), endpoint: 'http://fcm.googleapis.com/x' } })).status, 400)

    assert.equal((await add('dev', { site: 'teb', subscription: subscription('dev-teb') })).status, 204)
    assert.equal((await add('dev', { site: 'tebbet', subscription: subscription('dev-bet') })).status, 204)
    assert.equal((await add('kari', { site: 'teb', subscription: subscription('kari-teb') })).status, 204)
    assert.equal((await add('kari', { site: 'tebbet', subscription: subscription('kari-bet') })).status, 204)
  })

  it('tells the author about a comment, and everyone else about a new event', async () => {
    const post = await call('POST', '/feed/posts', 'dev', { body: 'Hvem blir med?', visibility: 'members', attachmentIds: [] })
    await call('POST', `/feed/posts/${post.data.id}/comments`, 'kari', { body: 'Jeg!', parentId: null, attachmentIds: [] })
    const [comment] = await until(async () => pushedTo('dev-teb'), list => list.length > 0, 5)
    assert.equal(comment.title, 'Kari Nordmann kommenterte innlegget ditt')
    assert.equal(comment.body, 'Jeg!')
    assert.equal(comment.url, `/feed/${post.data.id}`)
    assert.equal(pushedTo('kari-teb').length, 0, 'not to the one who commented')

    const event = await call('POST', '/feed/posts', 'kari', {
      body: 'Grilling i parken',
      visibility: 'members',
      attachmentIds: [],
      event: { title: 'Grillfest', location: 'Parken', startsAt: '2030-06-01T16:00:00.000Z', endsAt: '2030-06-01T20:00:00.000Z' },
    })
    assert.equal(event.status, 201, JSON.stringify(event.data))
    const announced = await until(async () => pushedTo('dev-teb'), list => list.length > 1, 5)
    assert.equal(announced[1].title, 'Kari Nordmann publiserte et arrangement')
    assert.equal(announced[1].body, 'Grillfest')
    assert.equal(pushedTo('kari-teb').length, 0)
    assert.equal(pushedTo('dev-bet').length, 0, 'TebBet only hears about TebBet')
  })

  it('tells a member on TebBet when their slip is decided', async () => {
    const group = await call('POST', '/bet/groups', 'admin', { title: 'Push' })
    const market = await call('POST', `/bet/groups/${group.data.id}/markets`, 'admin', {
      question: 'Kommer varselet?',
      kind: 'yesno',
      outcomes: [{ label: 'Ja', odds: 2 }, { label: 'Nei', odds: 2 }],
      excluded: [],
    })
    const yes = market.data.outcomes[0]
    const played = await call('POST', '/bet/slips', 'dev', { slips: [{ stake: 100, selections: [{ outcomeId: yes.id, odds: yes.odds }] }] })
    assert.equal(played.status, 201, JSON.stringify(played.data))
    const decided = () => pushedTo('dev-bet').filter(push => push.tag?.startsWith('slip:'))
    assert.equal(decided().length, 0, 'nothing while it is open')

    await call('POST', `/bet/markets/${market.data.id}/settle`, 'admin', { outcomeId: yes.id })
    const [won] = await until(async () => decided(), list => list.length > 0, 5)
    assert.match(won.title, /^Du vant \d+ T$/)
    assert.equal(won.body, 'Ja · Kommer varselet?')
    assert.equal(won.url, '/mine-spill?vis=avgjorte')
  })

  it('tells TebBet members about new markets once in a while, but not ones they are kept out of', async () => {
    const news = (name: string) => pushedTo(name).filter(push => push.tag === 'new-markets')
    const before = { dev: news('dev-bet').length, kari: news('kari-bet').length }
    const members = await call('GET', '/bet/members', 'admin')
    const kari = members.data.find((m: any) => m.name === 'Kari Nordmann')
    const group = await call('POST', '/bet/groups', 'admin', { title: 'Fredagsquiz' })
    const add = (question: string, excluded: string[]) =>
      call('POST', `/bet/groups/${group.data.id}/markets`, 'admin', {
        question,
        kind: 'yesno',
        outcomes: [{ label: 'Ja', odds: 2 }, { label: 'Nei', odds: 2 }],
        excluded,
      })
    assert.equal((await add('Vinner Kari quizen?', [kari.id])).status, 201)
    assert.equal((await add('Blir det over 30 spørsmål?', [])).status, 201)

    // The check runs every second here (NEW_MARKETS_CHECK_SECONDS), every hour in production,
    // so the two markets may come in one push or two
    const mentioning = (list: typeof pushes, text: string) => list.filter(push => push.body.includes(text)).length
    const forDev = () => news('dev-bet').slice(before.dev)
    await until(async () => forDev(), list => mentioning(list, 'Vinner Kari') > 0 && mentioning(list, 'over 30') > 0, 5)
    for (const push of forDev()) {
      assert.match(push.title, /^(Nytt spill|2 nye spill): Fredagsquiz$/)
      assert.equal(push.url, `/gruppe/${group.data.id}`)
    }
    const [forKari] = await until(async () => news('kari-bet').slice(before.kari), list => list.length > 0, 5)
    assert.equal(forKari.title, 'Nytt spill: Fredagsquiz')
    assert.equal(forKari.body, 'Blir det over 30 spørsmål?', 'not the market Kari is kept out of')

    await sleep(1500)
    assert.equal(mentioning(forDev(), 'Vinner Kari'), 1, 'each market is news once')
    assert.equal(mentioning(forDev(), 'over 30'), 1)
    assert.equal(mentioning(news('kari-bet').slice(before.kari), 'Vinner Kari'), 0)
  })

  it('stops when the member turns it off', async () => {
    const before = pushedTo('dev-teb').length
    const off = await call('DELETE', '/push/subscriptions', 'dev', { endpoint: subscription('dev-teb').endpoint })
    assert.equal(off.status, 204)
    await call('POST', '/feed/posts', 'kari', {
      body: 'Enda en',
      visibility: 'members',
      attachmentIds: [],
      event: { title: 'Quiz', location: 'Puben', startsAt: '2030-06-02T16:00:00.000Z', endsAt: '2030-06-02T20:00:00.000Z' },
    })
    await sleep(500)
    assert.equal(pushedTo('dev-teb').length, before)
  })
})
