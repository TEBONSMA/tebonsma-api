import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

// Runs the API the way `npm run dev:mock` does, against the mock login provider, directory and
// mail server, and calls it like the site would. Nothing here needs a network or credentials.

const PORT = 18787
const MOCK_AUTH_PORT = 19091
const CLAUDE_PORT = 19393
const API = `http://127.0.0.1:${PORT}`
const ORIGIN = 'http://localhost:5173'

let server: ChildProcess
let dataDir: string
// What the API pushed, as the mock push service prints it (dev/mock-push.ts)
const pushes: { endpoint: string; title: string; body: string; url: string; tag?: string }[] = []

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Claude, as the bot sees it, so the tests never reach Anthropic: making markets pauses once on
// the way and then delivers the markets the test has set, and a decision is the answer the test
// has set. Every question is kept to look at.
let claudeMarkets: unknown[] = []
let claudeVerdict: Record<string, unknown> = {}
const claudeAsked: any[] = []
let claudeServer: Server

function startClaude() {
  claudeServer = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      const request = JSON.parse(body)
      claudeAsked.push(request)
      const tool = request.tools.find((t: any) => t.name === 'lag_spill' || t.name === 'avgjor')
      const pause = tool.name === 'lag_spill' && request.messages.at(-1).role === 'user'
      const input = tool.name === 'lag_spill' ? { markets: claudeMarkets } : claudeVerdict
      // $0.04 in, $0.04 out and three searches at $0.01: $0.11 a question
      const usage = {
        input_tokens: 10_000,
        output_tokens: 2_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 },
      }
      const [block, delta] = pause
        ? [{ type: 'text', text: '' }, { type: 'text_delta', text: 'Søker videre …' }]
        : [
            { type: 'tool_use', id: `toolu_${claudeAsked.length}`, name: tool.name, input: {} },
            { type: 'input_json_delta', partial_json: JSON.stringify(input) },
          ]
      const message = { id: `msg_${claudeAsked.length}`, type: 'message', role: 'assistant', model: request.model, content: [] }
      // The answer streams, as the real one does
      const events: [string, object][] = [
        ['message_start', { message: { ...message, stop_reason: null, stop_sequence: null, usage } }],
        ['content_block_start', { index: 0, content_block: block }],
        ['content_block_delta', { index: 0, delta }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: pause ? 'pause_turn' : 'tool_use', stop_sequence: null }, usage }],
        ['message_stop', {}],
      ]
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(''))
    })
  })
  return new Promise<void>(resolve => claudeServer.listen(CLAUDE_PORT, '127.0.0.1', resolve))
}

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
  await startClaude()
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
      // Fyllekjøring's multiplier climbs 50 times as fast: 250x in about a second
      CRASH_SPEED: '50',
      // The bot's Claude is the stand-in above, and its markets may close within seconds
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${CLAUDE_PORT}`,
      CLAUDE_MIN_OPEN_SECONDS: '1',
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
  claudeServer?.close()
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
    // The front page counts every market, also those it leaves out; a combination counts on each
    const listed = (await call('GET', '/bet/groups', 'dev')).data.groups.find((g: any) => g.id === group.data.id)
    assert.equal(listed.markets.length, 2, 'decided today, so still listed')
    const { lastDecidedAt, ...summary } = listed.summary
    assert.deepEqual(summary, { markets: 2, decided: 1, staked: 200 })
    assert.equal(lastDecidedAt, settled.data.settledAt)

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

describe('more casino', () => {
  const balance = async (user: string) => (await call('GET', '/bet/me', user)).data.balance as number

  it('spins Sponsorjakten, with frames that add up to the win', async () => {
    const before = await balance('kari')
    const spin = await call('POST', '/bet/casino/sponsorjakten/spin', 'kari', { stake: 20 })
    assert.equal(spin.status, 200, JSON.stringify(spin.data))
    assert.equal(spin.data.members.length, 4)
    assert.equal(await balance('kari'), before - 20 + spin.data.payout)

    // Play the frames back: every step is a collector taking the piece next to it
    let pieces = new Map<number, any>()
    let collectors: any[] = []
    let won = 0
    for (const frame of spin.data.frames) {
      if (frame.type === 'fill') {
        pieces = new Map(frame.pieces.map((p: any) => [p.id, p]))
        collectors = frame.collectors.map((c: any) => ({ ...c }))
        assert.equal(pieces.size + collectors.length, 36, 'a full grid')
      } else if (frame.type === 'step') {
        const piece = pieces.get(frame.piece)
        const collector = collectors.find(c => c.color === frame.color)
        assert.ok(piece, 'the piece is on the grid')
        assert.equal(Math.abs(piece.row - collector.row) + Math.abs(piece.col - collector.col), 1, 'next to the collector')
        assert.ok(piece.kind !== 'gem' || piece.color === frame.color, 'a gem of its own colour')
        pieces.delete(frame.piece)
        collector.row = piece.row
        collector.col = piece.col
        won += frame.win
      } else if (frame.type === 'fall') {
        for (const move of frame.moved) {
          if (move.piece !== undefined) Object.assign(pieces.get(move.piece), { row: move.row, col: move.col })
          else Object.assign(collectors.find(c => c.color === move.collector), { row: move.row, col: move.col })
        }
        for (const piece of frame.added) pieces.set(piece.id, piece)
        assert.equal(pieces.size + collectors.length, 36, 'full again after the fall')
      }
    }
    assert.equal(spin.data.payout, Math.floor((20 * Math.min(won, 500_000)) / 100))

    const free = await call('POST', '/bet/casino/sponsorjakten/spin', 'kari', { stake: 20, trial: true })
    assert.equal(free.status, 200)
    assert.equal(free.data.round, null)
    assert.equal(await balance('kari'), before - 20 + spin.data.payout, 'a free spin moves nothing')
    const mine = await call('GET', '/bet/flaks/rounds', 'kari')
    assert.equal(mine.data.length, 1, 'only the real spin is kept')
    assert.equal((await call('POST', '/bet/casino/sponsorjakten/spin', 'kari', { stake: 0 })).status, 400)
  })

  it('drives Fyllekjøring until the member takes out or the car crashes', async () => {
    // A car can crash near the start, before it can be looked at (it climbs 50 times as fast here,
    // and how far it gets before the next call depends on the machine): then it drives again, once
    // that one, and any second drive that got going, is over
    let before = 0
    let flight
    for (let tries = 0; ; tries++) {
      assert.ok(tries < 10, 'cars that keep crashing at once')
      before = await balance('ola')
      const launched = await call('POST', '/bet/casino/fyllekjoring/launch', 'ola', { stake: 10 })
      assert.equal(launched.status, 201, JSON.stringify(launched.data))
      flight = launched.data.flight
      assert.equal(flight.status, 'playing')
      assert.ok(!('crash' in flight.detail), 'the crash point is secret while it flies')
      const current = (await call('GET', '/bet/casino/fyllekjoring', 'ola')).data.flight
      const again = await call('POST', '/bet/casino/fyllekjoring/launch', 'ola', { stake: 10 })
      // One drive at a time
      if (current?.id === flight.id && again.status === 409) break
      // Over before anyone took out: it crashed, and paid nothing
      const over = (await call('GET', `/bet/casino/fyllekjoring/${flight.id}/landing`, 'ola')).data.flight
      assert.equal(over.status, 'done')
      assert.equal(over.detail.takenAt, null)
      assert.equal(over.payout, 0)
      if (again.status === 201) await call('GET', `/bet/casino/fyllekjoring/${again.data.flight.id}/landing`, 'ola')
    }

    const taken = await call('POST', `/bet/casino/fyllekjoring/${flight.id}/takeout`, 'ola')
    assert.equal(taken.status, 200)
    const done = taken.data.flight
    assert.equal(done.status, 'done')
    if (done.detail.takenAt === null) assert.equal(done.payout, 0, 'blew up first')
    else {
      assert.ok(done.detail.takenAt <= done.detail.crash)
      assert.equal(done.payout, Math.floor((10 * done.detail.takenAt) / 100))
    }
    assert.equal(await balance('ola'), before - 10 + done.payout)

    // With a target, it takes out by itself if the car gets that far
    const auto = await call('POST', '/bet/casino/fyllekjoring/launch', 'ola', { stake: 100, target: 1.5 })
    const landed = await call('GET', `/bet/casino/fyllekjoring/${auto.data.flight.id}/landing`, 'ola')
    const result = landed.data.flight
    assert.equal(result.status, 'done')
    if (result.detail.crash > 150) {
      assert.equal(result.detail.takenAt, 150)
      assert.equal(result.payout, 150)
    } else assert.equal(result.payout, 0)

    assert.equal((await call('POST', '/bet/casino/fyllekjoring/launch', 'ola', { stake: 10, target: 1 })).status, 400)
    const free = await call('POST', '/bet/casino/fyllekjoring/try', 'ola')
    assert.ok(free.data.crash >= 100)
    const log = await call('GET', '/bet/activity?kind=round', 'kari')
    // A Sponsorjakten spin and two drives, at least
    assert.ok(log.data.items.length >= 3)
    assert.ok(log.data.items.every((item: any) => item.kind === 'round'))
    const page = await call('GET', `/bet/members/${log.data.items[0].member.id}?status=settled`, 'kari')
    assert.ok(page.data.rounds.length >= 1)
  })

  it('gives every member ten rounds on the house in each game, played without coins', async () => {
    const me = (await call('GET', '/bet/me', 'admin')).data
    assert.deepEqual(me.gifts, { sponsorjakten: { left: 10, stake: 25 }, fyllekjoring: { left: 10, stake: 25 } })

    const spin = await call('POST', '/bet/casino/sponsorjakten/spin', 'admin', { gift: true })
    assert.equal(spin.status, 200, JSON.stringify(spin.data))
    assert.equal(spin.data.round.stake, 25)
    assert.equal(spin.data.round.detail.gift, true)
    assert.equal(spin.data.account.balance, me.balance + spin.data.payout, 'nothing taken, the win paid')
    assert.equal(spin.data.account.gifts.sponsorjakten.left, 9)

    const drive = await call('POST', '/bet/casino/fyllekjoring/launch', 'admin', { gift: true })
    assert.equal(drive.status, 201, JSON.stringify(drive.data))
    assert.equal(drive.data.flight.stake, 25)
    assert.equal(drive.data.account.gifts.fyllekjoring.left, 9)
    assert.equal(drive.data.account.balance, me.balance + spin.data.payout)
    const landed = (await call('GET', `/bet/casino/fyllekjoring/${drive.data.flight.id}/landing`, 'admin')).data.flight
    assert.equal(landed.detail.gift, true)
    assert.equal(await balance('admin'), me.balance + spin.data.payout + landed.payout)

    // Once they are used, there are no more
    for (let i = 0; i < 9; i++) assert.equal((await call('POST', '/bet/casino/sponsorjakten/spin', 'admin', { gift: true })).status, 200)
    assert.equal((await call('POST', '/bet/casino/sponsorjakten/spin', 'admin', { gift: true })).status, 400)
    assert.equal((await call('GET', '/bet/me', 'admin')).data.gifts.sponsorjakten, undefined)

    // Every member can see what is left on the house on the member page
    const id = (await call('GET', '/members/me', 'admin')).data.member.id
    assert.deepEqual((await call('GET', `/bet/members/${id}`, 'kari')).data.gifts, {
      sponsorjakten: { left: 0, plays: 10, stake: 25 },
      fyllekjoring: { left: 9, plays: 10, stake: 25 },
    })
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
    // Let a check go by first, so markets from the tests before are told about already
    await sleep(1200)
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
      assert.match(push.title, /^(Nytt spill|2 nye spill): Fredagsquiz$/, JSON.stringify(forDev()))
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

describe('the bot with Claude', () => {
  it('makes markets from what Claude finds, checked like an import, and decides them', async () => {
    assert.equal((await call('POST', '/bet/bot/claude/plan', 'kari')).status, 403)
    assert.deepEqual((await call('GET', '/bet/bot/claude', 'admin')).data, { on: true, model: 'claude-opus-5-5', monthlyUsd: 20, spentUsd: 0 })

    // The snow market closes soon, but with time to be made and played on, also on a slow machine
    const soon = new Date(Date.now() + 8000).toISOString()
    const later = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
    const blank = { winners: null, line: null, lowest: null, highest: null, spread: null }
    const snow = {
      ...blank,
      group: 'Trøndelag',
      question: 'Kommer det snø i Trondheim før 1. november?',
      kind: 'yesno',
      outcomes: [{ label: 'Ja', odds: 2.5 }, { label: 'Nei', odds: 1.67 }],
      closesAt: soon,
      decideAfter: soon,
      how: 'Ja hvis Meteorologisk institutt melder snødekke i Trondheim.',
      sources: ['https://www.yr.no', 'ikke en lenke'],
    }
    claudeMarkets = [
      snow,
      {
        ...blank,
        group: 'Sport',
        question: 'Hvor mange mål blir det i Eliteserien i helgen?',
        kind: 'overunder',
        outcomes: [],
        line: 22.5,
        lowest: 5,
        highest: 45,
        spread: 'low',
        closesAt: later,
        decideAfter: later,
        how: 'Summen av målene i serierunden, ifølge NTB.',
        sources: [],
      },
      { ...snow, question: 'Bare ett utfall?', kind: 'choice', outcomes: [{ label: 'Rosenborg', odds: 2 }] },
      { ...snow, question: 'Kommer det snø i Trondheim før 1. november?!' },
      { ...snow, group: 'Nyheter', question: 'Blir det nyheter i morgen?' },
    ]
    const made = await call('POST', '/bet/bot/claude/plan', 'admin')
    assert.equal(made.status, 201, JSON.stringify(made.data))
    assert.deepEqual(made.data, { created: 2, skipped: 3 }, 'one with a single outcome, the same question again, and a group the bot has not')

    const [asked, resumed] = claudeAsked
    assert.equal(asked.model, 'claude-opus-5-5')
    assert.equal(asked.fallbacks, 'default')
    assert.ok(asked.tools.some((t: any) => t.type === 'web_search_20260209'))
    assert.equal(resumed.messages.at(-1).role, 'assistant', 'a paused search goes on where it stopped')
    assert.match(asked.messages[0].content, /- Sport: /, 'Claude is told the groups')

    // Each market in its group, made the first time
    const group = (await call('GET', '/bet/groups/trondelag', 'kari')).data
    assert.equal(group.title, 'Trøndelag')
    assert.deepEqual(group.markets.map((m: any) => m.question), [snow.question])
    const market = group.markets[0]
    assert.equal(market.autoRule, `Avgjøres automatisk av Claude: ${snow.how}`)
    const yes = market.outcomes[0]
    const before = (await call('GET', '/bet/me', 'kari')).data.balance
    const played = await call('POST', '/bet/slips', 'kari', { slips: [{ stake: 10, selections: [{ outcomeId: yes.id, odds: yes.odds }] }] })
    assert.equal(played.status, 201, JSON.stringify(played.data))

    await sleep(Date.parse(soon) - Date.now() + 500)
    claudeVerdict = { result: 'avgjort', outcome: 0, outcomes: [], value: null, note: 'Det kom snø 28. oktober.', url: 'https://www.yr.no/snø' }
    assert.equal((await call('POST', '/bet/bot/decide', 'admin')).status, 200)
    const decision = claudeAsked.at(-1)
    assert.match(decision.messages[0].content, /0: Ja\n1: Nei/)
    assert.equal(claudeAsked.filter(r => r.tools.some((t: any) => t.name === 'avgjor')).length, 1, 'only the market that is due')

    const after = (await call('GET', '/bet/groups/trondelag', 'kari')).data.markets
    const decided = after.find((m: any) => m.question === snow.question)
    assert.equal(decided.state, 'settled')
    assert.equal(decided.note, 'Det kom snø 28. oktober.')
    assert.equal(decided.noteUrl, 'https://www.yr.no/snø')
    assert.equal((await call('GET', '/bet/groups/sport', 'kari')).data.markets.find((m: any) => m.kind === 'overunder').state, 'open')
    assert.ok((await call('GET', '/bet/me', 'kari')).data.balance > before, 'the slip on Ja won')

    // Three questions at $0.11
    assert.equal((await call('GET', '/bet/bot/claude', 'admin')).data.spentUsd.toFixed(2), '0.33')
  })
})

describe('The Tebonsma Times and Tebonsma Tidsskrift', () => {
  const article = (title: string, extra: object = {}) => ({ title, section: 'Innenriks', lead: 'Ingress', body: '<p>Brødtekst</p>', visibility: 'members', ...extra })

  it('lets only the editorial group write', async () => {
    assert.equal((await call('POST', '/press/times/desk', null, article('Hei'))).status, 401)
    assert.equal((await call('POST', '/press/times/desk', 'dev', article('Hei'))).status, 403, 'a member outside the group')
    assert.equal((await call('POST', '/press/times/desk', 'eirik', article('Hei'))).status, 403, 'the other paper’s editor')
    assert.equal((await call('POST', '/press/avisa/desk', 'petter', article('Hei'))).status, 404)
    assert.deepEqual((await call('GET', '/press/times/me', 'petter')).data, { loggedIn: true, editor: true })
    assert.deepEqual((await call('GET', '/press/times/me', 'dev')).data, { loggedIn: true, editor: false })
    assert.deepEqual((await call('GET', '/press/tidsskrift/me', 'eirik')).data, { loggedIn: true, editor: true })
  })

  it('keeps drafts to the editors and cleans what is written', async () => {
    const made = await call('POST', '/press/times/desk', 'petter', article('Blir det snøbad på pulebordet?', {
      body: '<p>Hei<script>alert(1)</script></p><img src="https://example.com/x.png"><p><a href="javascript:alert(1)">farlig</a> <a href="https://tebonsma.no">trygg</a></p>',
    }))
    assert.equal(made.status, 201, JSON.stringify(made.data))
    assert.equal(made.data.slug, 'blir-det-snobad-pa-pulebordet')
    assert.equal(made.data.status, 'draft')
    assert.ok(!made.data.body.includes('script') && !made.data.body.includes('example.com') && !made.data.body.includes('javascript'), made.data.body)
    assert.ok(made.data.body.includes('<a href="https://tebonsma.no" target="_blank" rel="noopener noreferrer">trygg</a>'), made.data.body)
    assert.equal((await call('GET', `/press/times/articles/${made.data.slug}`, 'kari')).status, 404, 'a draft is not out')
    assert.equal((await call('GET', `/press/times/articles/${made.data.slug}`, 'petter')).status, 200)
  })

  it('publishes, keeps members-only articles from visitors and keeps the address', async () => {
    const made = (await call('POST', '/press/times/desk', 'petter', article('Eivind kom for sent', { section: 'Pulebord' }))).data
    const published = await call('POST', `/press/times/desk/${made.id}/publish`, 'petter')
    assert.equal(published.data.status, 'published')
    assert.equal((await call('GET', `/press/times/articles/${made.slug}`, null)).status, 404, 'not there at all for visitors')
    const member = (await call('GET', `/press/times/articles/${made.slug}`, 'kari')).data
    assert.equal(member.body, '<p>Brødtekst</p>')
    const renamed = await call('PUT', `/press/times/desk/${made.id}`, 'petter', article('Eivind kom for sent igjen', { section: 'Pulebord' }))
    assert.equal(renamed.data.slug, made.slug, 'a published article keeps its address')
    const listed = async (path: string, who: string | null) => (await call('GET', path, who)).data.articles.some((a: any) => a.id === made.id)
    assert.equal(await listed('/press/times/articles', null), false)
    assert.equal(await listed('/press/times/articles?q=igjen', null), false)
    assert.equal(await listed('/press/times/articles', 'kari'), true)
    assert.equal(await listed('/press/times/articles?q=igjen', 'kari'), true)
    const front = (await call('GET', '/press/times/front', null)).data
    assert.ok([...front.front, ...front.latest].every((a: any) => a.id !== made.id), 'nor on the front page')
    assert.ok((await call('GET', '/press/times/sections', null)).data.every((s: any) => s.section !== 'Pulebord'))
    assert.ok((await call('GET', '/press/times/sections', 'kari')).data.some((s: any) => s.section === 'Pulebord'))
    assert.ok((await call('GET', '/press/tidsskrift/articles', null)).data.articles.every((a: any) => a.id !== made.id), 'each paper has its own')
  })

  it('publishes at a set time, out of sight until then', async () => {
    const made = (await call('POST', '/press/times/desk', 'petter', article('Sommerfesten er avlyst', { visibility: 'public', section: 'Fest' }))).data
    const path = `/press/times/desk/${made.id}/publish`
    assert.equal((await call('POST', path, 'petter', { at: 'snart' })).status, 400)
    const at = new Date(Date.now() + 1500).toISOString()
    const scheduled = await call('POST', path, 'petter', { at })
    assert.equal(scheduled.status, 200, JSON.stringify(scheduled.data))
    assert.equal(scheduled.data.scheduled, true)
    assert.equal(scheduled.data.publishedAt, at)
    const renamed = await call('PUT', `/press/times/desk/${made.id}`, 'petter', article('Sommerfesten er avlyst likevel', { visibility: 'public', section: 'Fest' }))
    assert.equal(renamed.data.slug, 'sommerfesten-er-avlyst-likevel', 'the address follows the title until it is out')
    const slug = renamed.data.slug
    assert.equal((await call('PUT', '/press/times/front', 'petter', { ids: [made.id] })).status, 200, 'it may be placed on the front page already')
    const hidden = async (who: string | null) => {
      assert.equal((await call('GET', `/press/times/articles/${slug}`, who)).status, 404)
      assert.ok((await call('GET', '/press/times/articles', who)).data.articles.every((a: any) => a.id !== made.id))
      const front = (await call('GET', '/press/times/front', who)).data
      assert.ok([...front.front, ...front.latest].every((a: any) => a.id !== made.id))
    }
    await hidden(null)
    await hidden('kari')
    assert.ok((await call('GET', '/press/times/sections', null)).data.every((s: any) => s.section !== 'Fest'))
    assert.equal((await call('GET', `/press/times/articles/${slug}`, 'petter')).data.scheduled, true, 'the editors can look at it')
    await new Promise(resolve => setTimeout(resolve, 1600))
    const out = await call('GET', `/press/times/articles/${slug}`, null)
    assert.equal(out.status, 200)
    assert.equal(out.data.scheduled, false)
    assert.equal((await call('GET', '/press/times/front', null)).data.front[0].id, made.id, 'on the front page when it is out')
    assert.equal((await call('POST', path, 'petter', { at: new Date(Date.now() + 60_000).toISOString() })).status, 400, 'what is out stays out')
  })

  it('publishes with an earlier date, for articles from before the site', async () => {
    const made = (await call('POST', '/press/times/desk', 'petter', article('Dassen er nuka', { visibility: 'public' }))).data
    const path = `/press/times/desk/${made.id}/publish`
    assert.equal((await call('POST', path, 'petter', { at: '1999-12-31T23:00:00.000Z' })).status, 400)
    const at = '2024-12-21T23:40:00.000Z'
    const published = await call('POST', path, 'petter', { at })
    assert.equal(published.status, 200, JSON.stringify(published.data))
    assert.equal(published.data.scheduled, false)
    assert.equal(published.data.publishedAt, at)
    assert.equal((await call('GET', `/press/times/articles/${made.slug}`, null)).status, 200, 'out at once')
  })

  it('lets an author go by another name in one article', async () => {
    const members = (await call('GET', '/press/times/desk/members', 'petter')).data
    const petter = members.find((m: any) => m.name === 'Petter Redaktør')
    const kari = members.find((m: any) => m.name === 'Kari Nordmann')
    const made = await call('POST', '/press/times/desk', 'petter', article('Med kallenavn', { authors: [{ id: petter.id, alias: 'Abraham' }, kari.id] }))
    assert.equal(made.status, 201, JSON.stringify(made.data))
    assert.deepEqual(made.data.authors.map((a: any) => [a.id, a.name, a.alias]), [[petter.id, 'Petter Redaktør', 'Abraham'], [kari.id, 'Kari Nordmann', null]])
    assert.equal((await call('POST', '/press/times/desk', 'petter', article('Uten forfatter', { authors: [{ alias: 'Ingen' }] }))).status, 400)
  })

  it('keeps the issue the journal printed an article in', async () => {
    const made = await call('POST', '/press/tidsskrift/desk', 'eirik', article('Fra utgave 1', { issue: '1/2025' }))
    assert.equal(made.status, 201, JSON.stringify(made.data))
    assert.equal(made.data.issue, '1/2025')
    assert.equal((await call('PUT', `/press/tidsskrift/desk/${made.data.id}`, 'eirik', article('Fra utgave 1'))).data.issue, '', 'empty when left out')
    assert.equal((await call('POST', '/press/tidsskrift/desk', 'eirik', article('For lang', { issue: 'x'.repeat(21) }))).status, 400)
  })

  it('takes authors without an account by name', async () => {
    const members = (await call('GET', '/press/tidsskrift/desk/members', 'eirik')).data
    const eirik = members.find((m: any) => m.name === 'Eirik Doktor')
    const made = await call('POST', '/press/tidsskrift/desk', 'eirik', article('Tverrfaglig samarbeid', { authors: [{ id: eirik.id }, { name: 'Trond Viggo Torgersen' }] }))
    assert.equal(made.status, 201, JSON.stringify(made.data))
    assert.deepEqual(made.data.authors, [
      { ...eirik, alias: null },
      { id: null, name: 'Trond Viggo Torgersen', avatar: null, alias: null },
    ])
    assert.equal((await call('POST', '/press/tidsskrift/desk', 'eirik', article('Uten navn', { authors: [{ name: ' ' }] }))).status, 400)
  })

  it('publishes at once what was set for later', async () => {
    const made = (await call('POST', '/press/times/desk', 'petter', article('Planlagt, men ikke lenger'))).data
    await call('POST', `/press/times/desk/${made.id}/publish`, 'petter', { at: new Date(Date.now() + 3_600_000).toISOString() })
    const now = await call('POST', `/press/times/desk/${made.id}/publish`, 'petter')
    assert.equal(now.data.scheduled, false)
    // Now, not in an hour; the server's clock may run a few milliseconds ahead of the test's
    assert.ok(Date.parse(now.data.publishedAt) < Date.now() + 60_000, now.data.publishedAt)
    const later = (await call('POST', '/press/times/desk', 'petter', article('Avbrutt planlegging'))).data
    await call('POST', `/press/times/desk/${later.id}/publish`, 'petter', { at: new Date(Date.now() + 3_600_000).toISOString() })
    const back = await call('POST', `/press/times/desk/${later.id}/unpublish`, 'petter')
    assert.equal(back.data.status, 'draft')
    assert.equal(back.data.scheduled, false)
  })

  it('arranges the front page, with only published articles', async () => {
    const one = (await call('POST', '/press/times/desk', 'petter', article('Toppsak', { visibility: 'public' }))).data
    const two = (await call('POST', '/press/times/desk', 'petter', article('Nummer to', { visibility: 'public' }))).data
    assert.equal((await call('PUT', '/press/times/front', 'petter', { ids: [one.id] })).status, 400, 'a draft can’t go on it')
    await call('POST', `/press/times/desk/${one.id}/publish`, 'petter')
    await call('POST', `/press/times/desk/${two.id}/publish`, 'petter')
    const front = await call('PUT', '/press/times/front', 'petter', { ids: [two.id, one.id] })
    assert.equal(front.status, 200, JSON.stringify(front.data))
    assert.deepEqual(front.data.front.map((a: any) => a.title), ['Nummer to', 'Toppsak'])
    assert.ok(front.data.latest.every((a: any) => a.id !== one.id && a.id !== two.id), 'not twice')
    await call('POST', `/press/times/desk/${two.id}/unpublish`, 'petter')
    assert.deepEqual((await call('GET', '/press/times/front', null)).data.front.map((a: any) => a.title), ['Toppsak'])
    assert.equal((await call('PUT', '/press/times/front', 'dev', { ids: [] })).status, 403)
  })

  it('lets the editors set the menu and rename a section', async () => {
    assert.deepEqual((await call('GET', '/press/times/menu', null)).data, { sections: [], custom: false }, 'empty until the editors choose')
    assert.equal((await call('PUT', '/press/times/menu', 'dev', { sections: ['Sport'] })).status, 403)
    const set = await call('PUT', '/press/times/menu', 'petter', { sections: ['Innenriks', 'Sport', 'Innenriks', ' '] })
    assert.equal(set.status, 200, JSON.stringify(set.data))
    assert.deepEqual(set.data, { sections: ['Innenriks', 'Sport'], custom: true })
    const renamed = await call('POST', '/press/times/sections/rename', 'petter', { from: 'Innenriks', to: 'Inn- og utenriks' })
    assert.deepEqual(renamed.data.sections, ['Inn- og utenriks', 'Sport'])
    const listed = (await call('GET', '/press/times/articles?section=Inn-%20og%20utenriks', 'kari')).data.articles
    assert.ok(listed.length > 0, 'the articles moved along')
    assert.equal((await call('GET', '/press/times/articles?section=Innenriks', 'kari')).data.articles.length, 0)
  })

  it('takes pictures from the editors and serves them to anyone', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64')
    assert.equal((await call('POST', '/press/tidsskrift/images', 'petter', { image: jpeg })).status, 403)
    const saved = await call('POST', '/press/tidsskrift/images', 'eirik', { image: jpeg })
    assert.equal(saved.status, 201)
    const res = await fetch(API + saved.data.url)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/jpeg')
    assert.equal((await call('POST', '/press/tidsskrift/images', 'eirik', { image: Buffer.from('<svg/>').toString('base64') })).status, 400)
    const withPicture = await call('POST', '/press/tidsskrift/desk', 'eirik', article('Med bilde', {
      coverImage: saved.data.url,
      body: `<p>Tekst</p><figure data-size="small" onclick="x"><img src="http://localhost:18787${saved.data.url}" alt="x"><figcaption>Petter på <em>pulebordet</em></figcaption></figure><figure data-size="huge"><img src="${saved.data.url}"></figure>`,
    }))
    assert.equal(withPicture.status, 201, JSON.stringify(withPicture.data))
    assert.equal(withPicture.data.coverImage, saved.data.url)
    const body = withPicture.data.body as string
    assert.ok(body.includes(`<figure data-size="small"><img src="${saved.data.url}" alt="x" /><figcaption>Petter på <em>pulebordet</em></figcaption></figure>`), body)
    assert.ok(body.includes(`<figure><img src="${saved.data.url}" /></figure>`), body) // an unknown size is dropped
  })

  it('keeps graphs and videos from other sites in a sandbox, without their scripts', async () => {
    const datawrapper =
      '<iframe title="Pils per hode" id="datawrapper-chart-abc" src="https://datawrapper.dwcdn.net/abc/1/" scrolling="no" frameborder="0" style="width: 0; min-width: 100% !important; border: none;" height="400" data-external="1" onload="alert(1)"></iframe><script>window.addEventListener("message", () => {})</script>'
    const youtube = '<iframe width="560" height="315" src="https://www.youtube.com/embed/x" allow="camera; autoplay" allowfullscreen></iframe>'
    const refused =
      '<iframe src="http://example.com/"></iframe><iframe src="https://times.tebonsma.no/"></iframe><iframe src="javascript:alert(1)"></iframe><iframe srcdoc="<script>alert(1)</script>"></iframe>'
    const made = await call('POST', '/press/tidsskrift/desk', 'eirik', article('Med graf', { body: `<p>Tekst</p>${datawrapper}${youtube}${refused}` }))
    assert.equal(made.status, 201, JSON.stringify(made.data))
    const body = made.data.body as string
    const frames = body.match(/<iframe[^>]*>/g) ?? []
    assert.equal(frames.length, 2, body)
    for (const frame of frames) {
      assert.ok(frame.includes('sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-presentation"'), frame)
      assert.ok(frame.includes('allow="fullscreen; encrypted-media; picture-in-picture; clipboard-write"'), frame)
    }
    assert.ok(frames[0].includes('src="https://datawrapper.dwcdn.net/abc/1/"') && frames[0].includes('title="Pils per hode"') && frames[0].includes('height="400"'), frames[0])
    assert.ok(!frames[0].includes('style'), frames[0])
    assert.ok(frames[1].includes('width="560"') && /style="aspect-ratio:\s*560 \/ 315"/.test(frames[1]), frames[1])
    assert.ok(!/<script|alert|onload|srcdoc|example\.com|tebonsma\.no|camera|frameborder/.test(body), body)
  })
})

describe('the vedtekter', () => {
  const commit = 'a'.repeat(40)
  const pdf = new Uint8Array(Buffer.from('%PDF-1.5\n%test\n'))
  const document = {
    tittel: 'Vedtekter for den autoritære stiftelse',
    navn: 'TEBONSMA',
    vedtatt: 'Vedtatt på ordinært årsmøte',
    versjon: '0.1.7',
    dato: '2026-10-26',
    paragrafer: [
      {
        id: 'foreningen',
        nummer: '1',
        tittel: 'Foreningen',
        tittelHtml: 'Foreningen',
        html: '<p>Se <a href="#navn">§ 1.1</a><script>alert(1)</script><img src="x" onerror="alert(1)"></p>',
        barn: [],
      },
    ],
  }
  // As the vedtekter repo's workflow sends a build
  const publish = async (key: string, fields: { commit: string; dokument: string; pdf: Uint8Array<ArrayBuffer> }) => {
    const form = new FormData()
    form.append('commit', fields.commit)
    form.append('dokument', new File([fields.dokument], 'vedtekter.json', { type: 'application/json' }))
    form.append('pdf', new File([fields.pdf], 'vedtekter.pdf', { type: 'application/pdf' }))
    const res = await fetch(`${API}/vedtekter`, { method: 'PUT', headers: { Authorization: `Bearer ${key}` }, body: form })
    return { status: res.status, data: await res.json() }
  }

  it('takes builds from the vedtekter repo with its key, and shows them to members only', async () => {
    assert.equal((await call('GET', '/vedtekter', 'kari')).status, 404, 'nothing published yet')
    const good = { commit, dokument: JSON.stringify(document), pdf }
    assert.equal((await publish('wrong', good)).status, 401)
    assert.equal((await publish('mock', { ...good, pdf: new Uint8Array([1, 2, 3]) })).status, 400, 'not a PDF')
    assert.equal((await publish('mock', { ...good, dokument: '{"tittel": "x"}' })).status, 400)
    assert.equal((await publish('mock', { ...good, commit: 'main' })).status, 400)
    const published = await publish('mock', good)
    assert.equal(published.status, 201, JSON.stringify(published.data))

    assert.equal((await call('GET', '/vedtekter', null)).status, 401)
    const read = await call('GET', '/vedtekter', 'kari')
    assert.equal(read.status, 200)
    assert.equal(read.data.tittel, document.tittel)
    assert.equal(read.data.commit, commit)
    assert.equal(read.data.paragrafer[0].id, 'foreningen')
    assert.equal(read.data.paragrafer[0].html, '<p>Se <a href="#navn">§ 1.1</a></p>', 'only the markup the build writes')

    assert.equal((await call('GET', '/vedtekter/pdf', null)).status, 401)
    const res = await fetch(`${API}/vedtekter/pdf`, { headers: { Authorization: 'Bearer mock-access.kari' } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/pdf')
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-')

    // A link for the browser to open without the login, for an hour
    assert.equal((await call('GET', '/vedtekter/pdf/lenke', null)).status, 401)
    const { url } = (await call('GET', '/vedtekter/pdf/lenke', 'kari')).data
    const opened = await fetch(API + url)
    assert.equal(opened.status, 200)
    assert.match(opened.headers.get('content-disposition') ?? '', /^inline/)
    assert.match((await fetch(`${API + url}&last-ned=1`)).headers.get('content-disposition') ?? '', /^attachment/)
    assert.equal((await fetch(`${API + url}x`)).status, 401, 'a signature changed by a letter')

    // A rerun of the same build replaces it
    await publish('mock', { ...good, dokument: JSON.stringify({ ...document, versjon: '0.1.8' }) })
    assert.equal((await call('GET', '/vedtekter', 'kari')).data.versjon, '0.1.8')
  })

  it('takes proposals to change them, amendments and comments, and lets the protocol group decide', async () => {
    const paragraph = (id: string, nummer: string, tittel: string, kilde: string, barn: object[] = []) => ({
      id,
      nummer,
      tittel,
      tittelHtml: tittel,
      kilde,
      html: `<p>${kilde}</p>`,
      barn,
    })
    const tree = [
      paragraph('foreningen', '1', 'Foreningen', 'Om foreningen.', [paragraph('navn', '1.1', 'Navn', 'Navnet er TEBONSMA.')]),
      paragraph('styret', '2', 'Styret', 'Sju medlemmer.', [
        paragraph('styretitler', '2.1', 'Styretitler', '', [paragraph('prop-hunter', '2.1.1', 'Prop-hunter / Styremedlem', 'Skaffer rekvisitter.')]),
      ]),
      paragraph('bedrukkenhet', '3', 'Bedrukkenhet', 'Alkohol.'),
    ]
    assert.equal((await publish('mock', { commit: 'c'.repeat(40), dokument: JSON.stringify({ ...document, paragrafer: tree }), pdf })).status, 201)

    assert.equal((await call('GET', '/vedtekter/forslag', null)).status, 401)
    const start = (await call('GET', '/vedtekter/forslag', 'kari')).data
    assert.equal(start.canManage, false)
    assert.equal(start.arsmote, null)
    assert.deepEqual(
      start.forslag.map((f: any) => [f.number, f.title, f.status]),
      [
        [1, 'Kriseteam på alle fester', 'utkast'],
        [2, 'Mangfold- og inkluderingsansvarlig', 'utkast'],
      ],
      'the two additions from the årsmøte in 2025, still without a text',
    )
    assert.deepEqual(start.forslag[1].changes, [
      { type: 'legge-til', title: 'Mangfold- og inkluderingsansvarlig / Styremedlem', parent: '§ 2.1', after: '§ 2.1.1' },
    ])

    const propose = (user: string, body: object) => call('POST', '/vedtekter/forslag', user, { reason: '', ...body })
    const rename = { type: 'endre', target: 'navn', title: 'Navn', text: 'Navnet er TEBONSMA, og det skal du ikke glemme.' }
    assert.equal((await propose('kari', { title: 'Ingenting', changes: [{ ...rename, text: 'Navnet er TEBONSMA.' }], submit: true })).status, 400)
    assert.equal((await propose('kari', { title: 'Feil sted', changes: [{ type: 'endre', target: 'finnes-ikke', title: 'X', text: '' }] })).status, 400)
    const made = await propose('kari', { title: 'Husk navnet', reason: 'Folk glemmer.', changes: [rename], submit: true })
    assert.equal(made.status, 201, JSON.stringify(made.data))
    assert.equal(made.data.number, 3)
    assert.equal(made.data.status, 'innsendt')
    assert.equal(made.data.changes[0].original.kilde, 'Navnet er TEBONSMA.')
    assert.equal(made.data.author.name, 'Kari Nordmann')

    // A new paragraph goes after one of those under the parent it is placed in
    const add = (after: string | null) => ({ type: 'legge-til', parent: 'styret', after, title: 'Kasserer', text: '' })
    assert.equal((await propose('kari', { title: 'Ny', changes: [add('navn')] })).status, 400)
    const draft = await propose('kari', { title: 'Kasserer i styret', changes: [add('styretitler')] })
    assert.equal(draft.status, 201, JSON.stringify(draft.data))
    assert.equal(draft.data.status, 'utkast')
    assert.equal((await call('POST', '/vedtekter/forslag/4/send-inn', 'ola')).status, 403, 'not her draft')
    assert.equal((await call('POST', '/vedtekter/forslag/4/send-inn', 'kari')).data.status, 'innsendt')
    const removeAndChange = [{ type: 'slette', target: 'styret' }, { type: 'endre', target: 'prop-hunter', title: 'X', text: 'Y' }]
    assert.equal((await propose('kari', { title: 'Rot', changes: removeAndChange, submit: true })).status, 400)

    assert.equal((await call('PATCH', '/vedtekter/forslag/3', 'ola', { title: 'Mitt nå', changes: [rename] })).status, 403)
    const amendment = await propose('ola', { title: 'Husk navnet, men kortere', parent: 3, changes: [{ ...rename, text: 'Navnet er TEBONSMA. Husk det.' }], submit: true })
    assert.equal(amendment.status, 201, JSON.stringify(amendment.data))
    assert.equal(amendment.data.parent, 3)
    assert.equal((await propose('ola', { title: 'Enda kortere', parent: 5, changes: [rename] })).status, 400, 'no amendments to amendments')
    const commented = await call('POST', '/vedtekter/forslag/3/kommentarer', 'ola', { body: 'Godt forslag' })
    assert.equal(commented.status, 201)
    assert.deepEqual(commented.data.comments.map((c: any) => [c.author.name, c.body]), [['Ola Nordmann', 'Godt forslag']])
    assert.deepEqual(commented.data.amendments.map((a: any) => a.number), [5])

    assert.equal((await call('POST', '/vedtekter/forslag/4/trekk', 'kari')).data.status, 'trukket')
    assert.equal((await call('POST', '/vedtekter/forslag/3/status', 'kari', { status: 'vedtatt' })).status, 403)
    const decided = await call('POST', '/vedtekter/forslag/3/status', 'eirik', { status: 'vedtatt' })
    assert.equal(decided.data.status, 'vedtatt')
    assert.equal(decided.data.can.edit, false)

    // The protocol group sets the årsmøte; the deadlines follow § 3
    assert.equal((await call('PUT', '/vedtekter/arsmote', 'kari', { title: 'Årsmøte', startsAt: '2030-12-20T12:00:00.000Z' })).status, 403)
    const meeting = await call('PUT', '/vedtekter/arsmote', 'eirik', { title: 'Ordinært årsmøte 2030', startsAt: '2030-12-20T12:00:00.000Z' })
    assert.equal(meeting.status, 200, JSON.stringify(meeting.data))
    assert.equal(meeting.data.forslagFrist, '2030-12-13T12:00:00.000Z')
    assert.equal(meeting.data.sakslisteFrist, '2030-12-18T12:00:00.000Z')
    // Still the one planned when the time has passed, until it is started or moved
    const passed = await call('PUT', '/vedtekter/arsmote', 'eirik', { title: 'Ordinært årsmøte 2030', startsAt: '2020-12-20T12:00:00.000Z' })
    assert.equal(passed.data.id, meeting.data.id)
    assert.equal((await call('GET', '/vedtekter/forslag', 'kari')).data.arsmote.id, meeting.data.id)
    await call('PUT', '/vedtekter/arsmote', 'eirik', { title: 'Ordinært årsmøte 2030', startsAt: '2030-12-20T12:00:00.000Z' })
    const listed = (await call('GET', '/vedtekter/forslag', 'eirik')).data
    assert.equal(listed.canManage, true)
    assert.equal(listed.arsmote.title, 'Ordinært årsmøte 2030')
    const five = listed.forslag.find((f: any) => f.number === 5)
    assert.equal(five.arsmote, listed.arsmote.id)
    assert.equal(five.late, false)
  })

  it('lets the årsmøte vote on the proposals: one against the other, and the one left against the vedtekter', async () => {
    assert.equal((await call('POST', '/vedtekter/forslag/5/trekk', 'eirik')).data.status, 'trukket')
    const propose = async (user: string, title: string, changes: object[]) => {
      const made = await call('POST', '/vedtekter/forslag', user, { title, reason: '', changes, submit: true })
      assert.equal(made.status, 201, JSON.stringify(made.data))
      return made.data.number as number
    }
    const p = await propose('kari', 'Navnet med utropstegn', [{ type: 'endre', target: 'navn', title: 'Navn', text: 'Navnet er TEBONSMA!' }])
    const q = await propose('ola', 'Navnet med store bokstaver', [{ type: 'endre', target: 'navn', title: 'NAVN', text: 'NAVNET ER TEBONSMA.' }])
    const r = await propose('dev', 'Fjern bedrukkenheten', [{ type: 'slette', target: 'bedrukkenhet' }])
    const s = await propose('kari', 'Kasserer', [{ type: 'legge-til', parent: 'styretitler', after: 'prop-hunter', title: 'Kasserer / Styremedlem', text: 'Har pengene.' }])

    assert.equal((await call('POST', '/vedtekter/arsmote/oppmote', 'kari')).status, 400, 'not started')
    assert.equal((await call('POST', '/vedtekter/arsmote/start', 'kari')).status, 403)
    const started = await call('POST', '/vedtekter/arsmote/start', 'eirik')
    assert.equal(started.status, 200, JSON.stringify(started.data))
    assert.equal(started.data.arsmote.state, 'pågår')
    const moved = { title: 'Ordinært årsmøte 2030', startsAt: '2030-12-21T12:00:00.000Z' }
    assert.equal((await call('PUT', '/vedtekter/arsmote', 'eirik', moved)).status, 400, 'the deadlines follow from the time')
    // The two proposals to § 1.1 are one case; the others stand alone
    assert.deepEqual(
      started.data.saker.map((sak: any) => [sak.forslag.map((f: any) => f.number), sak.next]),
      [
        [[p, q], { a: p, b: q, opptak: false }],
        [[r], { a: r, b: null, opptak: false }],
        [[s], { a: s, b: null, opptak: false }],
      ],
    )

    // The protocol group adds other cases and puts them in order; everyone sees the list
    assert.equal((await call('POST', '/vedtekter/arsmote/saker', 'kari', { title: 'Valg av styreleder' })).status, 403)
    const valg = (await call('POST', '/vedtekter/arsmote/saker', 'eirik', { title: 'Valg av styreleder' })).data.saker.at(-1)
    assert.equal(valg.title, 'Valg av styreleder')
    const reordered = await call('PUT', '/vedtekter/arsmote/saksliste', 'eirik', { order: [valg.key, `forslag:${r}`, `forslag:${q}`] })
    assert.deepEqual(
      reordered.data.saker.map((sak: any) => sak.title),
      ['Valg av styreleder', 'Fjern bedrukkenheten', 'Navnet med utropstegn', 'Kasserer'],
      'any proposal in a case places it',
    )
    assert.equal((await call('PUT', '/vedtekter/arsmote/saksliste', 'eirik', { order: ['DROP TABLE'] })).status, 400)
    assert.equal((await call('PUT', '/vedtekter/arsmote/saksliste', 'kari', { order: [] })).status, 403)
    assert.equal((await call('GET', '/vedtekter/arsmote/live', 'kari')).data.saker[0].title, 'Valg av styreleder')

    for (const user of ['kari', 'ola', 'dev']) assert.equal((await call('POST', '/vedtekter/arsmote/oppmote', user)).data.present, true)
    const petter = (await call('GET', '/members', 'eirik')).data.find((m: any) => /petter/i.test(m.name))
    assert.equal((await call('POST', `/vedtekter/arsmote/oppmote/${petter.id}`, 'kari')).status, 403)
    assert.equal((await call('POST', `/vedtekter/arsmote/oppmote/${petter.id}`, 'eirik')).data.attendees.length, 4)
    assert.equal((await call('DELETE', `/vedtekter/arsmote/oppmote/${petter.id}`, 'eirik')).data.attendees.length, 3)

    const open = async (a: number, b: number | null) => {
      const opened = await call('POST', '/vedtekter/voteringer', 'eirik', { a, b })
      assert.equal(opened.status, 201, JSON.stringify(opened.data))
      return opened.data.voteringer.at(-1).id as string
    }
    const vote = (user: string, id: string, choice: number | 'blank') => call('POST', `/vedtekter/voteringer/${id}/stem`, user, { choice })
    assert.equal((await call('POST', '/vedtekter/voteringer', 'eirik', { a: p, b: null })).status, 400, 'forslag q is still in the way')
    assert.equal((await call('POST', '/vedtekter/voteringer', 'kari', { a: p, b: q })).status, 403)

    // A tie, left to the protocol group, which draws lots
    const kontra = await open(p, q)
    assert.equal((await call('POST', '/vedtekter/voteringer', 'eirik', { a: r, b: null })).status, 400, 'one at a time')
    assert.equal((await vote('kari', kontra, 0)).status, 200)
    assert.equal((await vote('ola', kontra, 0)).status, 200)
    assert.equal((await vote('ola', kontra, 1)).status, 200, 'a member can change their mind')
    assert.equal((await vote('dev', kontra, 'blank')).status, 200)
    assert.equal((await vote('dev', kontra, 2)).status, 400, 'there are two options')
    assert.equal((await vote('petter', kontra, 0)).status, 403, 'not checked in')
    const during = (await call('GET', '/vedtekter/arsmote/live', 'kari')).data.voteringer[0]
    assert.equal(during.changes.a[0].text, 'Navnet er TEBONSMA!', 'the changes in full, to see what differs')
    assert.equal(during.changes.b[0].original.kilde, 'Navnet er TEBONSMA.')
    assert.deepEqual(during.options, [`Forslag ${p}`, `Forslag ${q}`])
    assert.equal(during.mine, 0)
    assert.equal(during.voted, 3)
    assert.equal(during.counts, null, 'only the protocol group sees the count before it closes')
    assert.equal((await call('POST', `/vedtekter/voteringer/${kontra}/lukk`, 'kari', { hand: {} })).status, 403)
    const even = (await call('POST', `/vedtekter/voteringer/${kontra}/lukk`, 'eirik', { hand: { options: [2, 2] } })).data.voteringer[0]
    assert.equal(even.status, 'likt')
    assert.equal(even.result, null)
    assert.deepEqual(even.tied, [0, 1])
    assert.equal(even.changes, null)
    assert.deepEqual([...even.counts.total, even.counts.blank.total], [3, 3, 1])
    assert.equal((await call('GET', `/vedtekter/forslag/${p}`, 'kari')).data.status, 'innsendt', 'nothing decided yet')
    assert.equal((await call('POST', '/vedtekter/voteringer', 'eirik', { a: r, b: null })).status, 400, 'the tie first')
    assert.equal((await call('POST', '/vedtekter/arsmote/avslutt', 'eirik')).status, 400)
    const lot = (body: object, user = 'eirik') => call('POST', `/vedtekter/voteringer/${kontra}/loddtrekning`, user, body)
    assert.equal((await lot({ option: 'tilfeldig' }, 'kari')).status, 403)
    assert.equal((await lot({ option: 2 })).status, 400)
    const tied = (await lot({ option: 'tilfeldig' })).data
    const closed = tied.voteringer[0]
    assert.equal(closed.status, 'lukket')
    assert.equal(closed.byLot, true)
    assert.equal((await lot({ option: 0 })).status, 400, 'drawn once')
    const [winner, loser] = closed.result === 0 ? [p, q] : [q, p]
    assert.equal((await call('GET', `/vedtekter/forslag/${loser}`, 'kari')).data.status, 'forkastet')
    assert.deepEqual(tied.saker.find((sak: any) => sak.key === `forslag:${p}`).next, { a: winner, b: null, opptak: false })

    // 2 of 3 is enough to change the vedtekter (§ 3.3)
    const first = await open(winner, null)
    await vote('kari', first, 0)
    await vote('ola', first, 0)
    await vote('dev', first, 1)
    const adoptedOne = (await call('POST', `/vedtekter/voteringer/${first}/lukk`, 'eirik', {})).data.voteringer[1]
    assert.deepEqual(adoptedOne.options, ['For', 'Mot'])
    assert.equal(adoptedOne.result, 0)
    assert.equal((await call('GET', `/vedtekter/forslag/${winner}`, 'kari')).data.status, 'vedtatt')

    // A majority, but not 2/3
    const second = await open(r, null)
    await vote('kari', second, 0)
    await vote('ola', second, 1)
    await vote('dev', second, 1)
    await call('POST', `/vedtekter/voteringer/${second}/lukk`, 'eirik', { hand: { options: [2] } })
    assert.equal((await call('GET', `/vedtekter/forslag/${r}`, 'kari')).data.status, 'forkastet')

    const third = await open(s, null)
    await vote('kari', third, 0)
    await call('POST', `/vedtekter/voteringer/${third}/lukk`, 'eirik', { hand: { options: [5, 1], blank: 3 } })
    assert.equal((await vote('ola', third, 0)).status, 400, 'closed')

    // Anything else on the agenda, with its own options; it decides no proposal
    const free = (body: object) => call('POST', '/vedtekter/voteringer', 'eirik', body)
    assert.equal((await free({ title: 'Valg av styreleder', options: ['Kari'] })).status, 400, 'two options at least')
    assert.equal((await free({ title: 'Valg av styreleder', options: ['Kari', 'kari'] })).status, 400)
    assert.equal((await call('POST', '/vedtekter/voteringer', 'kari', { title: 'Kupp', options: ['Ja', 'Nei'] })).status, 403)
    const election = (await free({ title: 'Valg av styreleder', options: ['Kari', 'Ola', 'Petter'], sak: valg.punkt })).data.voteringer.at(-1)
    assert.equal(election.kind, 'fri')
    assert.equal(election.title, 'Valg av styreleder')
    assert.equal(election.a, null)
    await vote('kari', election.id, 0)
    await vote('ola', election.id, 1)
    await vote('dev', election.id, 1)
    // A three-way tie, voted on again without Petter
    const threeWay = (await call('POST', `/vedtekter/voteringer/${election.id}/lukk`, 'eirik', { hand: { options: [1, 0, 2] } })).data
    assert.deepEqual(threeWay.voteringer.at(-1).counts.total, [2, 2, 2])
    assert.deepEqual(threeWay.voteringer.at(-1).tied, [0, 1, 2])
    assert.equal(threeWay.saker[0].current, true, 'the case waits for the tie')
    const again = (body: object) => call('POST', `/vedtekter/voteringer/${election.id}/gjenvalg`, 'eirik', body)
    assert.equal((await again({ keep: [0] })).status, 400, 'two options at least')
    const revoted = (await again({ keep: [0, 1] })).data
    const runoff = revoted.voteringer.at(-1)
    assert.deepEqual(runoff.options, ['Kari', 'Ola'])
    assert.equal(runoff.gjenvalgAv, election.id)
    assert.equal(runoff.status, 'åpen')
    assert.equal(revoted.voteringer.at(-2).gjenvalg, true)
    assert.equal(revoted.saker[0].done, false)
    await vote('kari', runoff.id, 0)
    await vote('ola', runoff.id, 1)
    await vote('dev', runoff.id, 1)
    const afterElection = (await call('POST', `/vedtekter/voteringer/${runoff.id}/lukk`, 'eirik', {})).data
    assert.equal(afterElection.voteringer.at(-1).result, 1, 'Ola')
    assert.equal(afterElection.saker[0].done, true, 'the case on the agenda is done')
    assert.equal((await call('DELETE', `/vedtekter/arsmote/saker/${valg.punkt}`, 'eirik')).status, 400, 'it was voted on')
    const budget = (await free({ title: 'Godkjenne budsjettet', options: ['Ja', 'Nei'], rule: 'to-tredjedeler' })).data.voteringer.at(-1)
    await vote('kari', budget.id, 0)
    await vote('ola', budget.id, 1)
    const unsettled = (await call('POST', `/vedtekter/voteringer/${budget.id}/lukk`, 'eirik', { hand: { options: [2, 1] } })).data.voteringer.at(-1)
    assert.equal(unsettled.result, null, '3 of 5 is less than 2/3, so nothing is decided')

    // What was adopted goes to the vedtekter repo, which fetches it with its key
    assert.equal((await call('GET', '/vedtekter/arsmote/vedtatt', 'kari')).status, 403)
    assert.equal((await call('GET', '/vedtekter/arsmote/vedtatt', null)).status, 401)
    const res = await fetch(`${API}/vedtekter/arsmote/vedtatt`, { headers: { Authorization: 'Bearer mock' } })
    const exported = await res.json()
    assert.equal(res.status, 200, JSON.stringify(exported))
    assert.match(exported.vedtatt, /^Sist endret på ordinært årsmøte \d{1,2}\. [a-zø]+ \d{4}$/)
    assert.deepEqual(exported.forslag.map((f: any) => f.number), [winner, s])
    assert.equal(exported.forslag[1].changes[0].after, 'prop-hunter')
    assert.deepEqual((await call('GET', '/vedtekter/arsmote/vedtatt', 'eirik')).data, exported)

    assert.equal((await call('POST', '/vedtekter/arsmote/avslutt', 'kari')).status, 403)
    const ended = (await call('POST', '/vedtekter/arsmote/avslutt', 'eirik')).data
    assert.equal(ended.arsmote.state, 'avsluttet')
    assert.equal(ended.voteringer.length, 7, 'the votes stay for everyone to see')
    assert.deepEqual((await call('GET', '/vedtekter/arsmote/vedtatt', 'eirik')).data.forslag.map((f: any) => f.number), [winner, s])

    // An årsmøte in three days: the deadline a week before has passed, so what comes in now is not
    // on the agenda, and is only taken up if 3/4 of those present want it
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
    assert.equal((await call('PUT', '/vedtekter/arsmote', 'eirik', { title: 'Ekstraordinært årsmøte', startsAt: soon })).status, 200)
    const late1 = await propose('ola', 'For sent', [{ type: 'endre', target: 'foreningen', title: 'Foreningen', text: 'Om oss.' }])
    const late2 = await propose('kari', 'Også for sent', [{ type: 'endre', target: 'styret', title: 'Styret', text: 'Ni medlemmer.' }])
    await call('POST', '/vedtekter/arsmote/start', 'eirik')
    for (const user of ['kari', 'ola', 'dev']) await call('POST', '/vedtekter/arsmote/oppmote', user)
    const lateLive = (await call('GET', '/vedtekter/arsmote/live', 'eirik')).data
    assert.deepEqual(
      lateLive.saker.map((sak: any) => [sak.forslag[0].opptak, sak.next]),
      [
        ['kreves', { a: late1, b: null, opptak: true }],
        ['kreves', { a: late2, b: null, opptak: true }],
      ],
    )
    assert.equal((await call('POST', '/vedtekter/voteringer', 'eirik', { a: late1, b: null })).status, 400, 'not on the agenda yet')
    const takeUp = async (number: number) => {
      const opened = await call('POST', '/vedtekter/voteringer', 'eirik', { a: number, opptak: true })
      assert.equal(opened.status, 201, JSON.stringify(opened.data))
      return opened.data.voteringer.at(-1)
    }
    const withLate1 = (await call('POST', '/vedtekter/forslag', 'dev', { title: 'Om dem', reason: '', parent: late1, submit: true, changes: [{ type: 'endre', target: 'foreningen', title: 'Foreningen', text: 'Om dem.' }] })).data
    const notEnough = await takeUp(late1)
    assert.equal(notEnough.title, `Skal forslag ${late1} tas opp?`)
    assert.deepEqual(notEnough.options, ['Ja', 'Nei'])
    await vote('kari', notEnough.id, 0)
    await vote('ola', notEnough.id, 0)
    await vote('dev', notEnough.id, 1)
    const left = (await call('POST', `/vedtekter/voteringer/${notEnough.id}/lukk`, 'eirik', {})).data
    assert.equal(left.voteringer.at(-1).present, 3)
    assert.equal(left.voteringer.at(-1).result, 1, '2 of 3 present is less than 3/4')
    assert.equal(left.saker[0].forslag[0].opptak, 'ikke-tatt-opp')
    assert.equal(left.saker[0].forslag[0].status, 'innsendt', 'it goes on to the next årsmøte')
    assert.equal(left.saker[0].forslag[1].opptak, 'ikke-tatt-opp', 'its amendment goes with it')
    assert.equal(left.saker[0].done, true)
    assert.equal((await call('POST', '/vedtekter/voteringer', 'eirik', { a: late1, b: null })).status, 400)
    assert.equal((await call('POST', '/vedtekter/voteringer', 'eirik', { a: withLate1.number, b: null })).status, 400)

    const enough = await takeUp(late2)
    for (const user of ['kari', 'ola', 'dev']) await vote(user, enough.id, 0)
    const taken = (await call('POST', `/vedtekter/voteringer/${enough.id}/lukk`, 'eirik', {})).data
    assert.equal(taken.saker[1].forslag[0].opptak, 'tatt-opp')
    assert.deepEqual(taken.saker[1].next, { a: late2, b: null, opptak: false })
    // An amendment made in the meeting to a case on the agenda needs no 3/4
    const onTheSpot = (await call('POST', '/vedtekter/forslag', 'dev', { title: 'Åtte', reason: '', parent: late2, submit: true, changes: [{ type: 'endre', target: 'styret', title: 'Styret', text: 'Åtte medlemmer.' }] })).data
    const withAmendment = (await call('GET', '/vedtekter/arsmote/live', 'eirik')).data.saker[1]
    assert.deepEqual(withAmendment.next, { a: late2, b: onTheSpot.number, opptak: false })
    assert.equal(withAmendment.forslag[1].opptak, null)
    const afterwards = (await call('POST', '/vedtekter/arsmote/avslutt', 'eirik')).data
    assert.equal(afterwards.saker[0].forslag[0].opptak, 'ikke-tatt-opp', 'still on the list of the årsmøte that left it out')
  })
})
