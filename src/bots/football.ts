import { createMarket, inGroup, sectionNamed, updateMarket, type MarketInput } from '../bets.ts'
import { db } from '../db.ts'
import { BOT } from './bot.ts'
import { getJson, getText } from './http.ts'
import type { FootballRule, Verdict } from './rules.ts'
import { shortDay } from './time.ts'

// Norway's men's team: the bot opens markets on its matches and decides them from the result.
// Matches, results and bookmaker odds (DraftKings) come from ESPN's open but undocumented API.
// The bot waits for the bookmaker's odds, which show up a few days before a match, and opens
// with odds from the Elo ratings at eloratings.net if they haven't come three days before.

export const FOOTBALL_GROUP = 'landslaget'
const NORWAY = '464'
const SCORER = 'Erling Haaland'
// Of Norway's goals, the share Haaland scores
const SCORER_SHARE = 0.45
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer'
const ELO = 'https://www.eloratings.net'
const DAY_MS = 24 * 60 * 60 * 1000
// From when the bot looks for the bookmaker's odds, and when it stops waiting for them. Both
// can be stretched to try the bot out (BOT_ODDS_DAYS, BOT_ELO_DAYS).
const ODDS_AHEAD_MS = Number(process.env.BOT_ODDS_DAYS ?? 14) * DAY_MS
const ELO_AHEAD_MS = Number(process.env.BOT_ELO_DAYS ?? 3) * DAY_MS
const FIXTURES_EVERY_MS = 3 * 60 * 60 * 1000
const ELO_EVERY_MS = 12 * 60 * 60 * 1000
// Goals in an international match, on average
const MEAN_GOALS = 2.6
const ELO_HOME_ADVANTAGE = 100
const MAX_GOALS = 15

interface Competitor {
  homeAway: 'home' | 'away'
  team: { id: string; displayName: string }
  score?: string | { value?: number }
}

interface EspnEvent {
  id: string
  date: string
  league?: string | { slug?: string }
  competitions: { date?: string; status: { type: { name: string; state: string; completed?: boolean } }; competitors: Competitor[] }[]
}

// Their names in Norwegian; others keep ESPN's English name
const NAMES: Record<string, string> = {
  Norway: 'Norge',
  Denmark: 'Danmark',
  Sweden: 'Sverige',
  Iceland: 'Island',
  'Faroe Islands': 'Færøyene',
  Scotland: 'Skottland',
  'Northern Ireland': 'Nord-Irland',
  'Republic of Ireland': 'Irland',
  Ireland: 'Irland',
  Germany: 'Tyskland',
  France: 'Frankrike',
  Spain: 'Spania',
  Italy: 'Italia',
  Netherlands: 'Nederland',
  Belgium: 'Belgia',
  Switzerland: 'Sveits',
  Austria: 'Østerrike',
  Poland: 'Polen',
  Czechia: 'Tsjekkia',
  'Czech Republic': 'Tsjekkia',
  Hungary: 'Ungarn',
  Croatia: 'Kroatia',
  'Bosnia-Herzegovina': 'Bosnia-Hercegovina',
  'Bosnia and Herzegovina': 'Bosnia-Hercegovina',
  'North Macedonia': 'Nord-Makedonia',
  Greece: 'Hellas',
  Turkey: 'Tyrkia',
  Türkiye: 'Tyrkia',
  Cyprus: 'Kypros',
  Ukraine: 'Ukraina',
  Belarus: 'Hviterussland',
  Russia: 'Russland',
  Azerbaijan: 'Aserbajdsjan',
  Kazakhstan: 'Kasakhstan',
  Estonia: 'Estland',
  Lithuania: 'Litauen',
  Luxembourg: 'Luxemburg',
  Moldova: 'Moldova',
  Brazil: 'Brasil',
  'United States': 'USA',
  USA: 'USA',
  Morocco: 'Marokko',
  'South Korea': 'Sør-Korea',
  Australia: 'Australia',
}
const norwegian = (name: string) => NAMES[name] ?? name

const leagueOf = (event: EspnEvent) => (typeof event.league === 'string' ? event.league : event.league?.slug) || 'all'

// --- Odds from Elo ratings

interface Elo {
  at: number
  ratings: Map<string, number>
  codes: Map<string, string>
  // home code, away code, date -> the home side's win expectancy (a win plus half a draw)
  fixtures: Map<string, number>
}
let elo: Elo | null = null

async function loadElo() {
  if (elo && Date.now() - elo.at < ELO_EVERY_MS) return elo
  const rows = async (path: string) => (await getText(`${ELO}/${path}`)).split('\n').map(line => line.split('\t'))
  const [world, teams, fixtures] = await Promise.all([rows('World.tsv'), rows('en.teams.tsv'), rows('fixtures.tsv')])
  const codes = new Map<string, string>()
  for (const [code, ...names] of teams) for (const name of names) if (name && !code.includes('_')) codes.set(name.trim(), code)
  elo = {
    at: Date.now(),
    ratings: new Map(world.filter(row => row.length > 3).map(row => [row[2], Number(row[3])])),
    codes,
    fixtures: new Map(
      fixtures
        .filter(row => row.length > 11)
        .map(row => [`${row[3]} ${row[4]} ${row[0]}-${row[1].padStart(2, '0')}-${row[2].padStart(2, '0')}`, Number(row[11]) / 100]),
    ),
  }
  return elo
}

// The home side's win expectancy: from the Elo fixture list, or worked out from the ratings
// with home advantage. Missing when a team isn't known.
function expectancy(ratings: Elo, home: string, away: string, date: string) {
  const homeCode = ratings.codes.get(home)
  const awayCode = ratings.codes.get(away)
  if (!homeCode || !awayCode) return null
  const listed = ratings.fixtures.get(`${homeCode} ${awayCode} ${date.slice(0, 10)}`)
  if (listed !== undefined && listed > 0 && listed < 1) return listed
  const homeRating = ratings.ratings.get(homeCode)
  const awayRating = ratings.ratings.get(awayCode)
  if (!homeRating || !awayRating) return null
  return 1 / (10 ** (-(homeRating + ELO_HOME_ADVANTAGE - awayRating) / 400) + 1)
}

const poisson = (lambda: number) => {
  const chances = [Math.exp(-lambda)]
  for (let k = 1; k <= MAX_GOALS; k++) chances.push((chances[k - 1] * lambda) / k)
  return chances
}

// Chances of each result when each side's goals are Poisson with the given means
function scoreline(homeGoals: number, awayGoals: number) {
  const home = poisson(homeGoals)
  const away = poisson(awayGoals)
  let homeWin = 0
  let draw = 0
  const total = new Array(2 * MAX_GOALS + 1).fill(0)
  home.forEach((h, i) =>
    away.forEach((a, j) => {
      if (i > j) homeWin += h * a
      else if (i === j) draw += h * a
      total[i + j] += h * a
    }),
  )
  return { homeWin, draw, awayWin: 1 - homeWin - draw, total, home, away }
}

// The goal means that give the expectancy, sharing the expected number of goals between the sides
function goalMeans(expected: number, mean = MEAN_GOALS) {
  let low = -mean + 0.05
  let high = mean - 0.05
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2
    const s = scoreline((mean + mid) / 2, (mean - mid) / 2)
    if (s.homeWin + s.draw / 2 < expected) low = mid
    else high = mid
  }
  const lead = (low + high) / 2
  return { home: (mean + lead) / 2, away: (mean - lead) / 2 }
}

// American odds (-165, +330) as a chance, with the bookmaker's margin still in
const americanChance = (odds: number) => (odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100))

// The expected number of goals that makes over the line as likely as the bookmaker says
function meanGoals(line: number, over: number) {
  let low = 0.3
  let high = 7
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2
    const under = poisson(mid)
      .slice(0, Math.floor(line) + 1)
      .reduce((sum, p) => sum + p, 0)
    if (1 - under < over) low = mid
    else high = mid
  }
  return (low + high) / 2
}

interface Odds {
  homeWin: number
  draw: number
  awayWin: number
  // Expected goals in the match
  mean: number
}

// The bookmaker's chances from the match summary, without its margin; missing until it has odds
function bookmakerOdds(summary: Summary, homeId: string): Odds | null {
  const odds = summary.pickcenter?.find(o => o.homeTeamOdds?.moneyLine && o.awayTeamOdds?.moneyLine && o.drawOdds?.moneyLine)
  if (!odds) return null
  const homeFirst = odds.homeTeamOdds!.teamId === undefined || odds.homeTeamOdds!.teamId === homeId
  const home = americanChance(homeFirst ? odds.homeTeamOdds!.moneyLine! : odds.awayTeamOdds!.moneyLine!)
  const away = americanChance(homeFirst ? odds.awayTeamOdds!.moneyLine! : odds.homeTeamOdds!.moneyLine!)
  const draw = americanChance(odds.drawOdds!.moneyLine!)
  const total = home + draw + away
  let mean = MEAN_GOALS
  if (odds.overUnder && odds.overOdds && odds.underOdds) {
    const over = americanChance(odds.overOdds)
    mean = meanGoals(odds.overUnder, over / (over + americanChance(odds.underOdds)))
  }
  return { homeWin: home / total, draw: draw / total, awayWin: away / total, mean }
}

// Odds in hundredths that stand for a chance; the market adds the bank's margin itself
const oddsOf = (chance: number) => Math.min(10_000, Math.max(101, Math.round(100 / Math.min(0.99, Math.max(0.01, chance)))))

// The line where over and under are closest to even, and the chances of each number up to the
// highest, which also stands for anything above it
function overUnder(distribution: number[], highest: number) {
  let line = 0.5
  let best = Infinity
  for (let candidate = 0.5; candidate < highest - 1; candidate++) {
    const under = distribution.slice(0, candidate + 0.5).reduce((sum, p) => sum + p, 0)
    if (Math.abs(under - 0.5) < best) {
      best = Math.abs(under - 0.5)
      line = candidate
    }
  }
  const chances = distribution.slice(0, highest)
  chances.push(1 - chances.reduce((sum, p) => sum + p, 0))
  return { line, chances: chances.map(p => Math.max(p, 1e-6)) }
}

// --- Opening markets

const exists = (key: string) =>
  db.prepare('SELECT id, status, closes_at FROM bet_markets WHERE bot_key = ?').get(key) as
    | { id: string; status: string; closes_at: string | null }
    | undefined

let fixturesAt = 0

export async function planFootball() {
  if (Date.now() - fixturesAt < FIXTURES_EVERY_MS) return
  fixturesAt = Date.now()
  const { events } = await getJson<{ events: EspnEvent[] }>(`${ESPN}/all/teams/${NORWAY}/schedule?fixture=true`)
  for (const event of events ?? []) {
    try {
      await planMatch(event)
    } catch (err) {
      console.error(`bot: could not open markets on match ${event.id}:`, err)
    }
  }
}

async function planMatch(event: EspnEvent) {
  const competition = event.competitions[0]
  const kickoff = new Date(competition.date ?? event.date).toISOString()
  const until = Date.parse(kickoff) - Date.now()
  if (competition.status.type.state !== 'pre' || until < 60 * 60 * 1000) return

  const keys = ['winner', 'goals', 'team-goals', 'scorer'].map(bet => `espn:${event.id}:${bet}`)
  // A match that has been moved: betting follows the new kickoff
  for (const key of keys) {
    const market = exists(key)
    if (market?.status === 'open' && market.closes_at !== kickoff) updateMarket(BOT, market.id, { closesAt: kickoff })
  }
  if (until > ODDS_AHEAD_MS || keys.every(exists)) return

  const home = competition.competitors.find(c => c.homeAway === 'home')!.team
  const away = competition.competitors.find(c => c.homeAway === 'away')!.team
  const summary = await getJson<Summary>(`${ESPN}/${leagueOf(event)}/summary?event=${event.id}`)
  let odds = bookmakerOdds(summary, home.id)
  if (!odds) {
    if (until > ELO_AHEAD_MS) return
    const expected = expectancy(await loadElo(), home.displayName, away.displayName, kickoff)
    if (expected === null) {
      console.error(`bot: no odds or Elo rating for ${home.displayName} – ${away.displayName}`)
      return
    }
    const elo = scoreline(goalMeans(expected).home, goalMeans(expected).away)
    odds = { homeWin: elo.homeWin, draw: elo.draw, awayWin: elo.awayWin, mean: MEAN_GOALS }
  }
  const means = goalMeans(odds.homeWin + odds.draw / 2, odds.mean)
  const result = scoreline(means.home, means.away)
  const norwayHome = home.id === NORWAY
  const norwayGoals = norwayHome ? result.home : result.away
  const homeName = norwegian(home.displayName)
  const awayName = norwegian(away.displayName)
  const opponent = norwayHome ? awayName : homeName
  const match = `${homeName} – ${awayName}`
  const section = sectionNamed(BOT, inGroup(FOOTBALL_GROUP), `${match}, ${shortDay(kickoff)}`)
  const rule = (bet: FootballRule['bet'], extra: Partial<FootballRule> = {}): FootballRule => ({
    type: 'football',
    event: event.id,
    league: leagueOf(event),
    bet,
    ...extra,
  })
  const base = { closesAt: kickoff, excluded: [], sectionId: section.id }
  const totals = overUnder(result.total, 10)
  const ours = overUnder(norwayGoals, 8)
  const scores = 1 - Math.exp(-SCORER_SHARE * (norwayHome ? means.home : means.away))

  const markets: [string, MarketInput][] = [
    [
      keys[0],
      {
        ...base,
        question: `Hvem vinner ${match}?`,
        kind: 'choice',
        outcomes: [
          { label: homeName, odds: oddsOf(odds.homeWin) },
          { label: 'Uavgjort', odds: oddsOf(odds.draw) },
          { label: awayName, odds: oddsOf(odds.awayWin) },
        ],
        rule: rule('winner'),
      },
    ],
    [
      keys[1],
      {
        ...base,
        question: `Hvor mange mål blir det i ${match}?`,
        kind: 'overunder',
        outcomes: [],
        line: totals.line,
        lowest: 0,
        highest: 10,
        chances: totals.chances,
        rule: rule('goals'),
      },
    ],
    [
      keys[2],
      {
        ...base,
        question: `Hvor mange mål scorer Norge mot ${opponent}?`,
        kind: 'overunder',
        outcomes: [],
        line: ours.line,
        lowest: 0,
        highest: 8,
        chances: ours.chances,
        rule: rule('team-goals', { team: NORWAY }),
      },
    ],
    [
      keys[3],
      {
        ...base,
        question: `Scorer ${SCORER} mot ${opponent}?`,
        kind: 'yesno',
        outcomes: [
          { label: 'Ja', odds: oddsOf(scores) },
          { label: 'Nei', odds: oddsOf(1 - scores) },
        ],
        rule: rule('scorer', { team: NORWAY, player: SCORER }),
      },
    ],
  ]
  for (const [key, input] of markets) if (!exists(key)) createMarket(BOT, inGroup(FOOTBALL_GROUP), { ...input, botKey: key })
}

// --- Deciding

interface Summary {
  header: { competitions: { date: string; status: { type: { name: string; state: string; completed?: boolean } }; competitors: Competitor[] }[] }
  keyEvents?: {
    type?: { type?: string; text?: string }
    scoringPlay?: boolean
    clock?: { displayValue?: string }
    team?: { id?: string }
    participants?: { athlete?: { displayName?: string } }[]
  }[]
  rosters?: { team: { id: string }; roster?: { starter?: boolean; subbedIn?: boolean; athlete?: { displayName?: string } }[] }[]
  // The bookmaker's odds before the match, American style
  pickcenter?: {
    overUnder?: number
    overOdds?: number
    underOdds?: number
    homeTeamOdds?: { moneyLine?: number; teamId?: string }
    awayTeamOdds?: { moneyLine?: number; teamId?: string }
    drawOdds?: { moneyLine?: number }
  }[]
}

const plain = (name: string) =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
// "Erling Braut Haaland" is "Erling Haaland": the surname is enough
const samePlayer = (name: string, player: string) => plain(name).split(/\s+/).includes(plain(player).split(/\s+/).pop()!)
// "90'+3'" is the 90th minute
const minuteOf = (clock: string | undefined) => Number.parseInt(clock ?? '', 10)
const scoreOf = (competitor: Competitor) =>
  Number(typeof competitor.score === 'object' ? competitor.score?.value : competitor.score)

const summaries = new Map<string, Promise<Summary>>()

// Summaries are fetched once per round of the bot, however many markets a match has
export const forgetSummaries = () => summaries.clear()

export async function judgeFootball(rule: FootballRule, closesAt: string): Promise<Verdict | null> {
  const url = `${ESPN}/${rule.league}/summary?event=${rule.event}`
  if (!summaries.has(url)) summaries.set(url, getJson<Summary>(url))
  const summary = await summaries.get(url)!
  const competition = summary.header.competitions[0]
  const status = competition.status.type
  const link = `https://www.espn.com/soccer/match/_/gameId/${rule.event}`

  if (/CANCEL|ABANDON|FORFEIT/.test(status.name)) return { void: true, note: 'Kampen ble avlyst.', url: link }
  if (/POSTPONE|SUSPEND/.test(status.name)) {
    return Date.now() - Date.parse(closesAt) > 3 * DAY_MS ? { void: true, note: 'Kampen ble utsatt.', url: link } : null
  }
  if (status.state !== 'post' || !status.completed) return null

  const home = competition.competitors.find(c => c.homeAway === 'home')!
  const away = competition.competitors.find(c => c.homeAway === 'away')!
  const goals = (summary.keyEvents ?? []).filter(
    event => event.scoringPlay && minuteOf(event.clock?.displayValue) <= 90 && !/shootout/i.test(event.type?.text ?? ''),
  )
  // After extra time or penalties, normal time ended level, and the goals of normal time are
  // counted from the match events
  const extraTime = /AET|PEN|EXTRA/.test(status.name)
  const score = extraTime
    ? {
        home: goals.filter(event => event.team?.id === home.team.id).length,
        away: goals.filter(event => event.team?.id === away.team.id).length,
      }
    : { home: scoreOf(home), away: scoreOf(away) }
  if (!Number.isFinite(score.home) || !Number.isFinite(score.away)) return null
  if (extraTime && score.home !== score.away) {
    return { void: true, note: 'Boten fant ikke målene i ordinær tid.', url: link }
  }
  const ended = `Endte ${score.home}–${score.away} etter 90 minutter.`

  switch (rule.bet) {
    case 'winner':
      return { outcome: score.home > score.away ? 0 : score.home === score.away ? 1 : 2, note: ended, url: link }
    case 'goals':
      return { value: score.home + score.away, note: ended, url: link }
    case 'team-goals':
      return { value: rule.team === home.team.id ? score.home : score.away, note: ended, url: link }
    case 'scorer': {
      const roster = summary.rosters?.find(r => r.team.id === rule.team)?.roster
      if (!roster) return null
      const played = roster.some(p => samePlayer(p.athlete?.displayName ?? '', rule.player!) && (p.starter || p.subbedIn))
      if (!played) return { void: true, note: `${rule.player} spilte ikke.`, url: link }
      const scored = goals.find(
        event =>
          event.team?.id === rule.team &&
          !/own goal/i.test(event.type?.text ?? '') &&
          samePlayer(event.participants?.[0]?.athlete?.displayName ?? '', rule.player!),
      )
      return scored
        ? { outcome: 0, note: `${rule.player} scoret i minutt ${minuteOf(scored.clock?.displayValue)}. ${ended}`, url: link }
        : { outcome: 1, note: `${rule.player} scoret ikke. ${ended}`, url: link }
    }
  }
}
