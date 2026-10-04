import { closeMarket, createMarket, ensureAccount, getEvent, listOther, placeSlips, settleMarket } from '../src/bets.ts'
import { db } from '../src/db.ts'
import { createPost, type Viewer } from '../src/feed.ts'
import { getMembers } from '../src/members.ts'
import { oddsAt } from '../src/odds.ts'

// Example events with TebBet markets and a few bets, for `npm run dev:mock:demo`. Like
// everything else in mock mode it is made again on every restart.

const admin: Viewer = { username: 'admin', admin: true }
const dev: Viewer = { username: 'dev', admin: false }

const HOUR = 60 * 60 * 1000
const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * HOUR).toISOString()

async function event(title: string, location: string, startsIn: number, hours: number) {
  const post = await createPost(
    admin,
    {
      body: `${title}. Dette er et eksempel fra mock-oppsettet.`,
      visibility: 'members',
      attachmentIds: [],
      event: { title, location, startsAt: at(startsIn), endsAt: at(startsIn + hours) },
    },
    [],
  )
  return post.id
}

const yesNo = (question: string, yes: number, no: number, excluded: string[] = []) => ({
  question,
  kind: 'yesno' as const,
  outcomes: [
    { label: 'Ja', odds: yes },
    { label: 'Nei', odds: no },
  ],
  excluded,
})

const choice = (question: string, outcomes: [string, number][]) => ({
  question,
  kind: 'choice' as const,
  outcomes: outcomes.map(([label, odds]) => ({ label, odds })),
  excluded: [],
})

// Plays at whatever the odds are right now
async function play(viewer: Viewer, stake: number, outcomeIds: string[]) {
  const markets = [...(await listOther(viewer)).markets]
  const events = db.prepare('SELECT DISTINCT event_id FROM bet_markets WHERE event_id IS NOT NULL').all() as { event_id: string }[]
  for (const { event_id } of events) markets.push(...(await getEvent(viewer, event_id)).markets)
  const odds = new Map(markets.flatMap(market => market.outcomes.map(outcome => [outcome.id, outcome.odds] as const)))
  ensureAccount(viewer.username)
  placeSlips(viewer, [{ stake, selections: outcomeIds.map(outcomeId => ({ outcomeId, odds: odds.get(outcomeId)! })) }])
}

// Over or under a line, at whatever the odds are right now
async function playLine(viewer: Viewer, stake: number, marketId: string, side: 'over' | 'under', line: number) {
  const market = (await getEvent(viewer, party)).markets.find(m => m.id === marketId)!
  const chance = market.outcomes.reduce((sum, o) => (side === 'over' ? o.value! > line : o.value! < line) ? sum + o.price : sum, 0)
  ensureAccount(viewer.username)
  placeSlips(viewer, [{ stake, selections: [{ marketId, side, line, odds: oddsAt(chance) / 100 }] }])
}

const party = await event('Høstfest', 'Festlokalet', 24 * 6, 6)
const nachspiel = createMarket(admin, party, yesNo('Blir det nachspiel?', 140, 280))
const firstHome = createMarket(
  admin,
  party,
  choice('Hvem går hjem først?', [
    ['Dev Bruker', 300],
    ['Admin Bruker', 250],
    ['Noen andre', 180],
  ]),
)
createMarket(admin, party, yesNo('Klager naboene før kl. 01?', 350, 125))
// About Dev Bruker, so they may not play on it
const [devMember] = (await getMembers(['dev'])).values()
createMarket(admin, party, yesNo('Sovner Dev Bruker på sofaen?', 220, 165, [devMember.id]))
const beers = createMarket(admin, party, {
  question: 'Hvor mange øl drikker Dev Bruker?',
  kind: 'overunder',
  outcomes: [],
  line: 6.5,
  highest: 20,
  spread: 'medium',
  excluded: [devMember.id],
})

const quiz = await event('Quizkveld', 'Stua', 50, 3)
const winner = createMarket(
  admin,
  quiz,
  choice('Hvilket lag vinner?', [
    ['Lag 1', 220],
    ['Lag 2', 260],
    ['Lag 3', 400],
  ]),
)
const rematch = createMarket(admin, quiz, yesNo('Blir det omkamp?', 400, 120))

// Not about an event: only admins open these
const exam = createMarket(admin, null, {
  ...yesNo('Står alle eksamen i høst?', 260, 145),
  closesAt: at(24 * 10),
})

const grill = await event('Grillkveld', 'Bakgården', 2, 4)
const burnt = createMarket(admin, grill, yesNo('Blir pølsene brent?', 150, 240))
const rain = createMarket(admin, grill, yesNo('Kommer det regn?', 300, 135))

await play(dev, 100, [nachspiel.outcomes[0].id])
await play(admin, 50, [nachspiel.outcomes[1].id])
await play(admin, 80, [firstHome.outcomes[0].id])
await play(dev, 50, [winner.outcomes[1].id, rematch.outcomes[1].id])
await play(dev, 60, [burnt.outcomes[0].id])
await play(admin, 40, [burnt.outcomes[1].id])
await play(dev, 30, [rain.outcomes[0].id])
await play(admin, 75, [exam.outcomes[1].id])
await playLine(admin, 60, beers.id, 'over', 6.5)

// The grill evening is over: one market decided, one waiting for its result
db.prepare('UPDATE events SET starts_at = ?, ends_at = ? WHERE post_id = ?').run(at(-26), at(-22), grill)
settleMarket(admin, burnt.id, { outcomeId: burnt.outcomes[0].id })
closeMarket(admin, rain.id)

console.log('demo: added 3 events and a market outside them, with TebBet bets')
