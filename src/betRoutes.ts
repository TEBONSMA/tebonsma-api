import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { ACTIVITY_KINDS, listActivity, type ActivityKind } from './activity.ts'
import { requireCaller, type Env } from './auth.ts'
import { ACTIONS, act, deal, doneHands, doneHandsOfMember, openHand, type Action } from './blackjack.ts'
import {
  closeMarket,
  createGroup,
  createMarket,
  createSection,
  DEFAULT_GROUP,
  deleteGroup,
  deleteMarket,
  deleteSection,
  ensureAccount,
  getAccount,
  getEvent,
  getGroup,
  getLeaderboard,
  getMemberPage,
  getSlips,
  inGroup,
  listEvents,
  listGroups,
  listLedger,
  listMembers,
  listSlips,
  onEvent,
  placeSlips,
  renameGroup,
  renameSection,
  reopenMarket,
  saveFront,
  saveLayout,
  sectionNamed,
  settleMarket,
  updateMarket,
  voidMarket,
  type LayoutGroup,
  type MarketInput,
  type SlipInput,
} from './bets.ts'
import {
  buyTicket,
  doneTickets,
  doneTicketsOfMember,
  listGames,
  openTickets,
  ROULETTE_TYPES,
  scratch,
  tryTicket,
  spinRoulette,
  tryRoulette,
  spins,
  spinsOfMember,
  type RouletteBet,
} from './flaks.ts'
import { idByName, usernameOf } from './members.ts'
import { MAX_ODDS, MIN_ODDS, SPREADS, type Spread } from './odds.ts'
import { bad, readBody, readText, viewerOf } from './feedRoutes.ts'

const MAX_QUESTION_LENGTH = 140
const MAX_OUTCOME_LENGTH = 60
// Room for every member of TEBONSMA and then some
const MAX_OUTCOMES = 10
const MAX_SLIPS = 20
const MAX_SELECTIONS = 10
const MAX_STAKE = 1_000_000
const MAX_EXCLUDED = 50
const MAX_SECTION_TITLE_LENGTH = 60
const MAX_GROUP_TITLE_LENGTH = 40
const MAX_LAYOUT_ITEMS = 500
const MAX_IMPORT = 30
// Over/under: how many numbers the slider can have, and how far up it can go
const MAX_NUMBERS = 200
const MAX_HIGHEST = 100_000

// TebBet, the members' betting site at bet.tebonsma.no. Everything needs a login.
export const betRoutes = new Hono<Env>()

betRoutes.use('/bet/*', requireCaller, bodyLimit({ maxSize: 32 * 1024 }))
// Opens the account on the first visit and pays the Mondays owed since the last one
betRoutes.use('/bet/*', async (c, next) => {
  ensureAccount(c.get('caller').username)
  await next()
})

const readLine = (raw: unknown, what: string, maxLength: number) => readText(raw, what, maxLength).replace(/\s+/g, ' ')

// Times are stored the way JavaScript writes them, so they can be compared as text
function readTime(raw: unknown) {
  if (raw === null) return null
  const time = typeof raw === 'string' ? new Date(raw) : null
  if (!time || Number.isNaN(time.getTime())) throw bad('Ugyldig tidspunkt')
  return time.toISOString()
}

const readOdds = (raw: unknown) => {
  const odds = typeof raw === 'number' ? Math.round(raw * 100) : NaN
  if (!Number.isInteger(odds) || odds < MIN_ODDS || odds > MAX_ODDS) {
    throw bad(`Oddsen må være mellom ${MIN_ODDS / 100} og ${MAX_ODDS / 100}`)
  }
  return odds
}

// Members kept out of a market, by their public id
function readExcluded(raw: unknown) {
  if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string')) throw bad('Ugyldig liste over medlemmer')
  if (raw.length > MAX_EXCLUDED) throw bad('For mange medlemmer')
  return raw as string[]
}

function readMarket(body: Record<string, unknown>): MarketInput {
  const question = readLine(body.question, 'Spørsmålet', MAX_QUESTION_LENGTH)
  if (!question) throw bad('Skriv hva det skal spilles på')
  if (body.kind !== 'yesno' && body.kind !== 'choice' && body.kind !== 'multi' && body.kind !== 'overunder') throw bad('Velg type spill')
  const excluded = body.excluded === undefined ? [] : readExcluded(body.excluded)
  const closesAt = body.closesAt === undefined ? {} : { closesAt: readTime(body.closesAt) }
  if (body.sectionId !== undefined && body.sectionId !== null && typeof body.sectionId !== 'string') throw bad('Ugyldig seksjon')
  const sectionId = (body.sectionId ?? null) as string | null

  // Over/under gets an outcome per number from the lowest to the highest, around the
  // organizer's line
  if (body.kind === 'overunder') {
    const { line, lowest = 0, highest, spread = 'medium' } = body
    const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_HIGHEST
    if (!whole(lowest) || !whole(highest) || highest - lowest < 2 || highest - lowest > MAX_NUMBERS) {
      throw bad(`Laveste og høyeste tall må være hele tall, med fra 2 til ${MAX_NUMBERS} mellom seg`)
    }
    if (typeof line !== 'number' || line % 1 !== 0.5 || line < lowest + 0.5 || line > highest - 0.5) {
      throw bad('Linjen må ligge mellom to hele tall, som 4,5, mellom det laveste og det høyeste tallet')
    }
    if (typeof spread !== 'string' || !(spread in SPREADS)) throw bad('Ugyldig spredning')
    return { question, kind: 'overunder', outcomes: [], line, lowest, highest, spread: spread as Spread, ...closesAt, excluded, sectionId }
  }

  if (!Array.isArray(body.outcomes)) throw bad('Mangler utfall')

  const yesNo = body.kind === 'yesno'
  const outcomes = body.outcomes.map((raw, i) => {
    const { label, odds } = (raw ?? {}) as Record<string, unknown>
    // A yes/no market always has the outcomes Ja and Nei, in that order
    const name = yesNo ? (['Ja', 'Nei'][i] ?? '') : readLine(label, 'Utfallet', MAX_OUTCOME_LENGTH)
    return { label: name, odds: readOdds(odds) }
  })
  if (yesNo) {
    if (outcomes.length !== 2) throw bad('Et ja/nei-spill har to utfall')
  } else {
    if (outcomes.length < 2 || outcomes.length > MAX_OUTCOMES) throw bad(`Et spill har fra 2 til ${MAX_OUTCOMES} utfall`)
    if (outcomes.some(o => !o.label)) throw bad('Alle utfall må ha et navn')
    if (new Set(outcomes.map(o => o.label.toLowerCase())).size !== outcomes.length) throw bad('To utfall har samme navn')
  }
  // Multi: about how many will come true, which the opening odds are worked out from
  if (body.kind === 'multi') {
    const { winners } = body
    if (typeof winners !== 'number' || !(winners >= 1) || winners >= outcomes.length) {
      throw bad('Antallet som blir riktige må være minst 1 og færre enn utfallene')
    }
    return { question, kind: 'multi', outcomes, winners, ...closesAt, excluded, sectionId }
  }
  return { question, kind: body.kind, outcomes, ...closesAt, excluded, sectionId }
}

const readSectionTitle = (raw: unknown) => {
  const title = readLine(raw, 'Seksjonen', MAX_SECTION_TITLE_LENGTH)
  if (!title) throw bad('Seksjonen trenger et navn')
  return title
}

const readGroupTitle = (raw: unknown) => {
  const title = readLine(raw, 'Gruppen', MAX_GROUP_TITLE_LENGTH)
  if (!title) throw bad('Gruppen trenger et navn')
  return title
}

// ['event:<id>', 'group:<id>', ...], from the top of the front page
function readFront(body: Record<string, unknown>) {
  const { items } = body
  if (!Array.isArray(items) || items.length > MAX_LAYOUT_ITEMS || items.some(item => typeof item !== 'string')) {
    throw bad('Ugyldig rekkefølge')
  }
  return items as string[]
}

// Markets made in one go: each like a new market, plus the title
// of the section to put it under. Who is kept out can be given by name as well as by id.
function readImport(body: Record<string, unknown>) {
  const { markets } = body
  if (!Array.isArray(markets) || markets.length === 0) throw bad('Fant ingen spill å importere')
  if (markets.length > MAX_IMPORT) throw bad(`Du kan importere opptil ${MAX_IMPORT} spill om gangen`)
  return markets.map((raw, i) => {
    const entry = (raw ?? {}) as Record<string, unknown>
    try {
      const market = readMarket(entry)
      const excluded = market.excluded.map(member => {
        const id = usernameOf(member) ? member : idByName(member)
        if (!id) throw bad(`Fant ikke medlemmet «${member}»`)
        return id
      })
      const section = entry.section === undefined ? null : readSectionTitle(entry.section)
      return { market: { ...market, excluded }, section }
    } catch (err) {
      if (err instanceof HTTPException) throw bad(`Spill ${i + 1}: ${err.message}`)
      throw err
    }
  })
}

// [{ sectionId, marketIds }], the groups in the order they are to be shown
function readLayout(body: Record<string, unknown>): LayoutGroup[] {
  const { groups } = body
  if (!Array.isArray(groups) || groups.length > MAX_LAYOUT_ITEMS) throw bad('Ugyldig rekkefølge')
  return groups.map(raw => {
    const { sectionId, marketIds } = (raw ?? {}) as Record<string, unknown>
    if (sectionId !== null && typeof sectionId !== 'string') throw bad('Ugyldig rekkefølge')
    if (!Array.isArray(marketIds) || marketIds.length > MAX_LAYOUT_ITEMS || marketIds.some(id => typeof id !== 'string')) {
      throw bad('Ugyldig rekkefølge')
    }
    return { sectionId, marketIds: marketIds as string[] }
  })
}

function readSlips(body: Record<string, unknown>): SlipInput[] {
  const { slips } = body
  if (!Array.isArray(slips) || slips.length === 0) throw bad('Kupongen er tom')
  if (slips.length > MAX_SLIPS) throw bad(`Du kan spille opptil ${MAX_SLIPS} spill om gangen`)
  return slips.map(raw => {
    const { stake, selections } = (raw ?? {}) as Record<string, unknown>
    if (typeof stake !== 'number' || !Number.isInteger(stake) || stake < 1 || stake > MAX_STAKE) {
      throw bad('Innsatsen må være et helt antall mynter')
    }
    if (!Array.isArray(selections) || selections.length === 0) throw bad('Kupongen er tom')
    if (selections.length > MAX_SELECTIONS) throw bad(`En kombinasjon kan ha opptil ${MAX_SELECTIONS} utfall`)
    return {
      stake,
      selections: selections.map(selection => {
        const { outcomeId, marketId, side, line, odds } = (selection ?? {}) as Record<string, unknown>
        if (typeof odds !== 'number') throw bad('Ugyldig kupong')
        if (typeof outcomeId === 'string') return { outcomeId, odds }
        if (typeof marketId === 'string' && (side === 'over' || side === 'under') && typeof line === 'number') {
          return { marketId, side, line, odds }
        }
        throw bad('Ugyldig kupong')
      }),
    }
  })
}

// [{ type, number?, stake }], as the roulette table sends them
function readRouletteBets(body: Record<string, unknown>): RouletteBet[] {
  const { bets } = body
  if (!Array.isArray(bets) || bets.length === 0) throw bad('Legg på minst én innsats')
  if (bets.length > 50) throw bad('For mange innsatser')
  return bets.map(raw => {
    const { type, number, stake } = (raw ?? {}) as Record<string, unknown>
    if (typeof type !== 'string' || !ROULETTE_TYPES.includes(type as RouletteBet['type'])) throw bad('Ugyldig innsats')
    if (typeof stake !== 'number' || !Number.isInteger(stake) || stake < 1 || stake > MAX_STAKE) {
      throw bad('Innsatsen må være et helt antall mynter')
    }
    const highest = type === 'straight' ? 36 : type === 'dozen' || type === 'column' ? 3 : null
    if (highest === null) return { type: type as RouletteBet['type'], stake }
    const lowest = type === 'straight' ? 0 : 1
    if (typeof number !== 'number' || !Number.isInteger(number) || number < lowest || number > highest) throw bad('Ugyldig tall')
    return { type: type as RouletteBet['type'], number, stake }
  })
}

const id = (c: Context) => c.req.param('id') ?? ''

betRoutes.get('/bet/me', async c => c.json(await getAccount(viewerOf(c))))

betRoutes.get('/bet/events', async c => c.json(await listEvents(viewerOf(c))))
betRoutes.get('/bet/members', async c => c.json(await listMembers()))
betRoutes.get('/bet/events/:id', async c => c.json(await getEvent(viewerOf(c), id(c))))

betRoutes.post('/bet/events/:id/markets', async c => {
  const market = createMarket(viewerOf(c), onEvent(id(c)), readMarket(await readBody(c)))
  return c.json(market, 201)
})

// Groups of markets that aren't about an event, which admins run, and the order of events and
// groups on the front page
betRoutes.get('/bet/groups', c => c.json(listGroups(viewerOf(c))))
betRoutes.get('/bet/groups/:id', async c => c.json(await getGroup(viewerOf(c), id(c))))
betRoutes.post('/bet/groups', async c => c.json(createGroup(viewerOf(c), readGroupTitle((await readBody(c)).title)), 201))
betRoutes.patch('/bet/groups/:id', async c => c.json(renameGroup(viewerOf(c), id(c), readGroupTitle((await readBody(c)).title))))
betRoutes.delete('/bet/groups/:id', c => {
  deleteGroup(viewerOf(c), id(c))
  return c.json({ ok: true })
})
betRoutes.put('/bet/front', async c => {
  saveFront(viewerOf(c), readFront(await readBody(c)))
  return c.json({ ok: true })
})
betRoutes.post('/bet/groups/:id/markets', async c => c.json(createMarket(viewerOf(c), inGroup(id(c)), readMarket(await readBody(c))), 201))
// Several markets at once, all checked before any is made
betRoutes.post('/bet/groups/:id/import', async c => {
  const viewer = viewerOf(c)
  const container = inGroup(id(c))
  const entries = readImport(await readBody(c))
  const markets = entries.map(({ market, section }) =>
    createMarket(viewer, container, { ...market, sectionId: section && sectionNamed(viewer, container, section).id }),
  )
  return c.json({ created: markets.length }, 201)
})
// What the site before groups asked for: the markets outside events
betRoutes.get('/bet/other', async c => c.json(await getGroup(viewerOf(c), DEFAULT_GROUP)))

// Sections, and the order of markets and sections, on an event or in a group
betRoutes.post('/bet/events/:id/sections', async c =>
  c.json(createSection(viewerOf(c), onEvent(id(c)), readSectionTitle((await readBody(c)).title)), 201),
)
betRoutes.post('/bet/groups/:id/sections', async c =>
  c.json(createSection(viewerOf(c), inGroup(id(c)), readSectionTitle((await readBody(c)).title)), 201),
)
betRoutes.patch('/bet/sections/:id', async c => c.json(renameSection(viewerOf(c), id(c), readSectionTitle((await readBody(c)).title))))
betRoutes.delete('/bet/sections/:id', c => {
  deleteSection(viewerOf(c), id(c))
  return c.json({ ok: true })
})
betRoutes.put('/bet/events/:id/layout', async c => {
  saveLayout(viewerOf(c), onEvent(id(c)), readLayout(await readBody(c)))
  return c.json({ ok: true })
})
betRoutes.put('/bet/groups/:id/layout', async c => {
  saveLayout(viewerOf(c), inGroup(id(c)), readLayout(await readBody(c)))
  return c.json({ ok: true })
})

betRoutes.patch('/bet/markets/:id', async c => {
  const body = await readBody(c)
  const question = body.question === undefined ? undefined : readLine(body.question, 'Spørsmålet', MAX_QUESTION_LENGTH)
  if (question === '') throw bad('Skriv hva det skal spilles på')
  const closesAt = body.closesAt === undefined ? undefined : readTime(body.closesAt)
  const excluded = body.excluded === undefined ? undefined : readExcluded(body.excluded)
  return c.json(updateMarket(viewerOf(c), id(c), { question, closesAt, excluded }))
})

betRoutes.post('/bet/markets/:id/close', c => c.json(closeMarket(viewerOf(c), id(c))))

// The winning outcome, every outcome that came true on a multi market, or for over/under the
// number it ended on
betRoutes.post('/bet/markets/:id/settle', async c => {
  const { outcomeId, outcomeIds, value } = await readBody(c)
  if (typeof outcomeId === 'string') return c.json(settleMarket(viewerOf(c), id(c), { outcomeId }))
  if (Array.isArray(outcomeIds) && outcomeIds.length <= MAX_OUTCOMES && outcomeIds.every(o => typeof o === 'string')) {
    return c.json(settleMarket(viewerOf(c), id(c), { outcomeIds: outcomeIds as string[] }))
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_STAKE) {
    return c.json(settleMarket(viewerOf(c), id(c), { value }))
  }
  throw bad('Velg hva som skjedde')
})

betRoutes.post('/bet/markets/:id/void', c => c.json(voidMarket(viewerOf(c), id(c))))
betRoutes.post('/bet/markets/:id/reopen', c => c.json(reopenMarket(viewerOf(c), id(c))))

betRoutes.delete('/bet/markets/:id', c => {
  deleteMarket(viewerOf(c), id(c))
  return c.json({ ok: true })
})

betRoutes.post('/bet/slips', async c => {
  const viewer = viewerOf(c)
  const ids = placeSlips(viewer, readSlips(await readBody(c)))
  return c.json({ slips: getSlips(viewer, ids), account: await getAccount(viewer) }, 201)
})

betRoutes.get('/bet/slips', c => c.json(listSlips(viewerOf(c), c.req.query('status') === 'settled')))

// Flaks: scratch cards and roulette, settled at once
betRoutes.get('/bet/flaks', c => c.json({ games: listGames(), tickets: openTickets(viewerOf(c)) }))
// Own tickets scratched to the end
betRoutes.get('/bet/flaks/done', c => c.json(doneTickets(viewerOf(c))))
betRoutes.post('/bet/flaks/:game/buy', async c => {
  const viewer = viewerOf(c)
  const ticket = buyTicket(viewer, c.req.param('game') ?? '')
  return c.json({ ticket, account: await getAccount(viewer) }, 201)
})
// A free ticket to try the game, with every field; no coins move
betRoutes.post('/bet/flaks/:game/try', c => c.json(tryTicket(c.req.param('game') ?? '')))
// { field } scratches one field, {} all that are left
betRoutes.post('/bet/flaks/tickets/:id/scratch', async c => {
  const viewer = viewerOf(c)
  const { field } = await readBody(c)
  if (field !== undefined && typeof field !== 'number') throw bad('Ugyldig felt')
  const ticket = scratch(viewer, id(c), field as number | undefined)
  return c.json({ ticket, account: await getAccount(viewer) })
})
// Own roulette spins, and blackjack hands played to the end
betRoutes.get('/bet/flaks/spins', c => c.json(spins(viewerOf(c))))
betRoutes.get('/bet/flaks/hands', c => c.json(doneHands(viewerOf(c))))
// Blackjack: the hand being played, if any; a new one ({ bet, trial? }); and the moves on it
betRoutes.get('/bet/casino/blackjack', c => c.json({ hand: openHand(viewerOf(c)) }))
betRoutes.post('/bet/casino/blackjack/deal', async c => {
  const viewer = viewerOf(c)
  const { bet, trial } = await readBody(c)
  if (typeof bet !== 'number' || !Number.isInteger(bet) || bet < 1 || bet > MAX_STAKE) throw bad('Innsatsen må være et helt antall mynter')
  return c.json({ hand: deal(viewer, bet, trial === true), account: await getAccount(viewer) }, 201)
})
betRoutes.post('/bet/casino/blackjack/:id/:action', async c => {
  const action = c.req.param('action') ?? ''
  if (!ACTIONS.includes(action as Action)) throw bad('Ugyldig trekk')
  const viewer = viewerOf(c)
  return c.json({ hand: act(viewer, id(c), action as Action), account: await getAccount(viewer) })
})
// A free spin with the same bets; no coins move and nothing is kept
betRoutes.post('/bet/casino/roulette/try', async c => c.json(tryRoulette(readRouletteBets(await readBody(c)))))
betRoutes.post('/bet/casino/roulette/spin', async c => {
  const viewer = viewerOf(c)
  const spin = spinRoulette(viewer, readRouletteBets(await readBody(c)))
  return c.json({ ...spin, account: await getAccount(viewer) })
})
betRoutes.get('/bet/ledger', c => c.json(listLedger(viewerOf(c))))
// Everything played and decided on TebBet, the newest first: ?before=<next> for older, ?kind=slip,
// result or ticket for one kind
betRoutes.get('/bet/activity', async c => {
  const before = c.req.query('before')
  if (before !== undefined && Number.isNaN(Date.parse(before))) throw bad('Ugyldig tidspunkt')
  const kind = c.req.query('kind')
  if (kind !== undefined && !ACTIVITY_KINDS.includes(kind as ActivityKind)) throw bad('Ugyldig type')
  const kinds = kind === undefined ? ACTIVITY_KINDS : [kind as ActivityKind]
  return c.json(await listActivity(viewerOf(c), before === undefined ? null : new Date(before).toISOString(), kinds))
})
betRoutes.get('/bet/leaderboard', async c => c.json(await getLeaderboard()))
// Another member's page: their place, coins and slips (?status=open|settled)
// With the scratch cards they have finished and their roulette spins among the settled
betRoutes.get('/bet/members/:id', async c => {
  const settled = c.req.query('status') === 'settled'
  const page = await getMemberPage(viewerOf(c), id(c), settled)
  return c.json({
    ...page,
    tickets: settled ? doneTicketsOfMember(id(c)) : [],
    spins: settled ? spinsOfMember(id(c)) : [],
    hands: settled ? doneHandsOfMember(id(c)) : [],
  })
})
