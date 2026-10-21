import Anthropic from '@anthropic-ai/sdk'
import { createMarket, ensureBotGroup, inGroup, type MarketInput } from '../bets.ts'
import { config } from '../config.ts'
import { db } from '../db.ts'
import { readImport, readLine } from '../marketInput.ts'
import { BOT } from './bot.ts'
import type { ClaudeRule, Verdict } from './rules.ts'
import { osloDate, osloHour, weekday } from './time.ts'

// Claude makes markets on what is going on in the world, Mondays and Thursdays, and decides
// them once the answer is out, searching the web for both. Every call is counted in dollars, and
// the bot stops for the month when it has spent what it may (CLAUDE_MONTHLY_USD).

db.exec(`
  CREATE TABLE IF NOT EXISTS claude_usage (
    at                 TEXT NOT NULL,
    job                TEXT NOT NULL,
    model              TEXT NOT NULL,
    input_tokens       INTEGER NOT NULL,
    output_tokens      INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    cache_read_tokens  INTEGER NOT NULL,
    searches           INTEGER NOT NULL,
    usd                REAL NOT NULL
  );
  -- The days the bot has made markets, so a day is never done twice, even after a failure
  CREATE TABLE IF NOT EXISTS claude_runs (
    day TEXT PRIMARY KEY,
    at  TEXT NOT NULL
  );
  -- How often the bot has tried to decide a market whose answer wasn't out yet
  CREATE TABLE IF NOT EXISTS claude_checks (
    market_id TEXT PRIMARY KEY,
    tries     INTEGER NOT NULL,
    last_at   TEXT NOT NULL
  );
`)

// Monday and Thursday, from nine in the morning
const PLAN_DAYS = [0, 3]
const PLAN_HOUR = 9
const MIN_MARKETS = 5
const MAX_MARKETS = 8
const PLAN_SEARCHES = 15
const DECIDE_SEARCHES = 6
// A market must stay open a while (an hour, shorter to try the bot out: CLAUDE_MIN_OPEN_SECONDS),
// and the answer must come within a month
const MIN_OPEN_MS = Number(process.env.CLAUDE_MIN_OPEN_SECONDS ?? 3600) * 1000
const MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000
// Tries at deciding a market, twelve hours apart, before it is left to the admins
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000
const MAX_TRIES = 8
// Rounds with Claude per question: the search may pause and go on, and an answer in words
// gets one reminder to use the tool
const MAX_TURNS = 5
const MAX_HOW_LENGTH = 300
const MAX_NOTE_LENGTH = 400
const MAX_URL_LENGTH = 500
const GROUP_ID = 'claude'

// Dollars per million tokens: input, output, cache writes (5 minutes) and cache reads; and
// per web search. Another model is counted at the first one's prices.
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-opus-5-5': [4, 20, 5, 0.2],
  'claude-sonnet-5-5': [2, 10, 2.5, 0.1],
}
const SEARCH_USD = 0.01

const LOCATION = { type: 'approximate', city: 'Trondheim', region: 'Trøndelag', country: 'NO', timezone: 'Europe/Oslo' } as const

let client: Anthropic | null = null
// The key and, in the tests, where the API is come from ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL
const claude = () => (client ??= new Anthropic({ timeout: 10 * 60 * 1000 }))

// --- What it costs

function record(job: string, response: Anthropic.Beta.BetaMessage) {
  const usage = response.usage
  const searches = usage.server_tool_use?.web_search_requests ?? 0
  const write = usage.cache_creation_input_tokens ?? 0
  const read = usage.cache_read_input_tokens ?? 0
  const [input, output, cacheWrite, cacheRead] = PRICES[response.model] ?? Object.values(PRICES)[0]
  const usd = (usage.input_tokens * input + usage.output_tokens * output + write * cacheWrite + read * cacheRead) / 1e6 + searches * SEARCH_USD
  db.prepare(
    `INSERT INTO claude_usage (at, job, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, searches, usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(new Date().toISOString(), job, response.model, usage.input_tokens, usage.output_tokens, write, read, searches, usd)
  console.log(`bot: Claude (${job}): ${searches} searches, ${usage.input_tokens + write + read} tokens in, ${usage.output_tokens} out, $${usd.toFixed(3)}`)
}

// Spent since the start of the month (UTC)
export function spentThisMonth() {
  const start = `${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`
  const { usd } = db.prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM claude_usage WHERE at >= ?').get(start) as { usd: number }
  return usd
}

const overBudget = () => {
  const over = spentThisMonth() >= config.claude!.monthlyUsd
  if (over) console.error(`bot: Claude has spent its $${config.claude!.monthlyUsd} for the month`)
  return over
}

// --- Asking

// One question, which Claude answers by calling the tool once it has searched the web. Claude
// may stop on the way (pause_turn), and then goes on where it left off. The answer is streamed,
// as long answers must be; the tool's input isn't (no eager_input_streaming), so the API still
// checks it against the schema.
async function ask(job: string, system: string, prompt: string, tool: Anthropic.Beta.BetaTool, searches: number, effort: 'medium' | 'high') {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: prompt }]
  let reminded = false
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = claude().beta.messages.stream({
      model: config.claude!.model,
      max_tokens: 32_000,
      // If the model declines, the API runs the question on another model instead
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      output_config: { effort },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: searches, user_location: LOCATION }, tool],
      tool_choice: { type: 'auto' },
      messages,
    })
    const response = await stream.finalMessage()
    record(job, response)
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content })
      continue
    }
    const call = response.content.find(block => block.type === 'tool_use' && block.name === tool.name)
    if (call?.type === 'tool_use' && response.stop_reason === 'tool_use') return call.input as Record<string, unknown>
    if (response.stop_reason !== 'end_turn' || reminded) throw new Error(`Claude (${job}) stopped without an answer: ${response.stop_reason}`)
    messages.push({ role: 'assistant', content: response.content }, { role: 'user', content: `Lever svaret med verktøyet ${tool.name}.` })
    reminded = true
  }
  throw new Error(`Claude (${job}) gave no answer in ${MAX_TURNS} rounds`)
}

const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })

// "onsdag 21. oktober 2026 kl. 09:00"
const longTime = (time: Date | string) =>
  new Intl.DateTimeFormat('nb-NO', {
    timeZone: 'Europe/Oslo',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time))

// --- Making markets

const PLAN_SYSTEM = `Du lager spill til TebBet (bet.tebonsma.no), den private spillsiden til vennegjengen TEBONSMA i Trondheim. Medlemmene spiller om TEB-mynter, som er lekepenger. Spillene dine havner rett i en gruppe på siden, uten at noen ser over dem først, så de må være riktige, tydelige og gå an å avgjøre.

## Oppgaven
Søk på nettet etter det som skjer de neste ukene, og lag nye spill om dagsaktuelle hendelser med et klart, offentlig utfall. Bland temaene: sport (ikke Norges herrelandslag i fotball, de har en egen bot), norsk politikk og samfunn, Trondheim og Trøndelag, kultur, TV, musikk, teknologi, økonomi og vær. Bland typene (ja/nei, ett valg, flere riktige, over/under), og ta gjerne med ett litt sprøtt spill.

Finn aldri på fakta. Datoer, deltakere, tall og odds skal bygge på det du finner. Finner du ikke grunnlag, velg et annet spill.

## Innhold
Ingen spill om tragedier, krig, terror, dødsfall, sykdom, ulykker, kriminalitet med ofre eller privatpersoner. Offentlige personer går an, men bare i det de gjør offentlig. Morsomt og gjerne litt frekt, men aldri sårende.

## Hvert spill
- question: kort og tydelig, på norsk bokmål (egennavn som de er), høyst 140 tegn.
- kind: yesno (utfallene Ja og Nei, i den rekkefølgen), choice (ett utfall slår inn, 2–10 utfall), multi (flere kan slå inn, 2–10 utfall) eller overunder (et tall).
- outcomes: navn på høyst 60 tegn, unike. Tom liste for overunder.
- odds: desimalodds fra 1.01 til 100 med to desimaler, inkludert innsatsen. Sett rettferdige odds: odds = 1 / sannsynlighet, så summen av 1/odds blir omtrent 1,00. Ikke legg på margin, TebBet gjør det selv. Bruk bookmakerodds, prognoser og meningsmålinger når de finnes, og trekk fra bookmakerens margin. Unngå nesten sikre utfall (odds under 1.15) og langskudd over 50 som ikke er morsomme. Vri heller på spørsmålet.
- winners (bare multi, ellers null): omtrent hvor mange utfall som blir riktige, minst 1 og færre enn utfallene. Sjansen for et utfall er da (1/odds delt på summen av 1/odds) ganger winners: anslå sjansen p for hvert utfall så summen blir winners, og sett odds = winners / p.
- line, lowest, highest, spread (bare overunder, ellers null): line på medianen og alltid på ,5. lowest og highest er laveste og høyeste realistiske tall, hele tall fra 0 til 100000 med 2 til 200 mellom seg. spread er low når svaret nesten sikkert havner nær linjen, high når det kan bli langt unna, ellers medium.
- closesAt: når spillet stenger, før utfallet kan bli kjent eller påvirkes: ved avspark eller start, eller før en kunngjøring. Minst to timer fram i tid, og svaret må komme innen en måned. ISO 8601 med norsk tid: +02:00 fra siste søndag i mars til siste søndag i oktober, ellers +01:00.
- decideAfter: når svaret sikkert er publisert, for eksempel tre timer etter avspark. Ikke før closesAt.
- how: én eller to setninger om hvordan spillet avgjøres: hvilken kilde som gjelder, og hva som skjer ved uavgjort, utsettelse eller avlysning (da annulleres spillet som regel). Medlemmene ser den etter «Avgjøres automatisk av Claude:».
- sources: én til tre lenker der svaret blir å finne.

Lag ikke spill som ligner dem som allerede ligger i gruppa. Når du er ferdig, kall verktøyet lag_spill én gang med alle spillene.`

const PLAN_TOOL: Anthropic.Beta.BetaTool = {
  name: 'lag_spill',
  description: 'Leverer de nye spillene. Kall det én gang, til slutt, med alle spillene.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['markets'],
    properties: {
      markets: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['question', 'kind', 'outcomes', 'winners', 'line', 'lowest', 'highest', 'spread', 'closesAt', 'decideAfter', 'how', 'sources'],
          properties: {
            question: { type: 'string' },
            kind: { type: 'string', enum: ['yesno', 'choice', 'multi', 'overunder'] },
            outcomes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'odds'],
                properties: { label: { type: 'string' }, odds: { type: 'number' } },
              },
            },
            winners: nullable({ type: 'number' }),
            line: nullable({ type: 'number' }),
            lowest: nullable({ type: 'integer' }),
            highest: nullable({ type: 'integer' }),
            spread: nullable({ type: 'string', enum: ['low', 'medium', 'high'] }),
            closesAt: { type: 'string', format: 'date-time' },
            decideAfter: { type: 'string', format: 'date-time' },
            how: { type: 'string' },
            sources: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
}

// The group the markets go in: the one named in the settings, by id or title, or else one of
// the bot's own, made the first time
function claudeGroup() {
  const name = config.claude!.group
  const found = db
    .prepare('SELECT id FROM bet_groups WHERE id = ? OR lower(title) = lower(?) ORDER BY created_at LIMIT 1')
    .get(name, name) as { id: string } | undefined
  if (found) return found.id
  ensureBotGroup(GROUP_ID, name, 'claude')
  return GROUP_ID
}

const httpUrl = (raw: unknown) => typeof raw === 'string' && /^https?:\/\/\S+$/.test(raw) && raw.length <= MAX_URL_LENGTH
const plainQuestion = (question: string) => question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// A market from Claude, checked as an import is, and against the bot's own rules
function readClaudeMarket(raw: Record<string, unknown>, now: number): { market: MarketInput; rule: ClaudeRule } {
  const { kind } = raw
  const body = {
    question: raw.question,
    kind,
    outcomes: raw.outcomes,
    closesAt: raw.closesAt,
    ...(kind === 'multi' && { winners: raw.winners }),
    ...(kind === 'overunder' && { line: raw.line, lowest: raw.lowest, highest: raw.highest, spread: raw.spread ?? 'medium' }),
  }
  const [{ market }] = readImport({ markets: [body] })
  const closes = market.closesAt ? Date.parse(market.closesAt) : NaN
  if (!(closes >= now + MIN_OPEN_MS && closes <= now + MAX_AHEAD_MS)) throw new Error('stengetiden er for tidlig, for sen eller mangler')
  const decideAfter = typeof raw.decideAfter === 'string' ? Date.parse(raw.decideAfter) : NaN
  if (!(decideAfter >= closes && decideAfter <= closes + MAX_AHEAD_MS)) throw new Error('decideAfter passer ikke med stengetiden')
  const how = readLine(raw.how, 'Avgjørelsen', MAX_HOW_LENGTH)
  if (!how) throw new Error('mangler hvordan spillet avgjøres')
  const sources = (Array.isArray(raw.sources) ? raw.sources : []).filter(httpUrl).slice(0, 3) as string[]
  return { market, rule: { type: 'claude', how, decideAfter: new Date(decideAfter).toISOString(), sources } }
}

let planning = false

// Makes markets on the days it is due, or now when an admin asks (force). Tells how many were
// made and how many Claude's markets didn't pass the checks, or null when nothing was done.
export async function planClaude(force = false) {
  if (!config.claude || planning) return null
  const now = new Date()
  const day = osloDate(now)
  if (!force) {
    if (!PLAN_DAYS.includes(weekday(day)) || osloHour(now) < PLAN_HOUR) return null
    if (db.prepare('SELECT 1 FROM claude_runs WHERE day = ?').get(day)) return null
  }
  if (overBudget()) return null
  planning = true
  try {
    db.prepare('INSERT OR IGNORE INTO claude_runs (day, at) VALUES (?, ?)').run(day, now.toISOString())
    const groupId = claudeGroup()
    const { title } = db.prepare('SELECT title FROM bet_groups WHERE id = ?').get(groupId) as { title: string }
    const monthAgo = new Date(now.getTime() - MAX_AHEAD_MS).toISOString()
    const known = db
      .prepare("SELECT question FROM bet_markets WHERE group_id = ? AND (status = 'open' OR settled_at >= ?) ORDER BY created_at")
      .all(groupId, monthAgo) as { question: string }[]
    const prompt = [
      `Nå er det ${longTime(now)} i Norge (${now.toISOString()}).`,
      `Lag ${MIN_MARKETS}–${MAX_MARKETS} nye spill til gruppa «${title}».`,
      known.length
        ? `Disse ligger allerede i gruppa eller er nylig avgjort, så ikke lag noe som ligner:\n${known.map(m => `- ${m.question}`).join('\n')}`
        : 'Gruppa er tom.',
    ].join('\n\n')

    const answer = await ask('plan', PLAN_SYSTEM, prompt, PLAN_TOOL, PLAN_SEARCHES, 'high')
    const proposed = Array.isArray(answer.markets) ? (answer.markets as Record<string, unknown>[]) : []
    const taken = new Set(known.map(m => plainQuestion(m.question)))
    let created = 0
    let skipped = 0
    for (const raw of proposed) {
      try {
        if (created === MAX_MARKETS) throw new Error('for mange spill')
        const { market, rule } = readClaudeMarket(raw ?? {}, Date.now())
        const key = plainQuestion(market.question)
        if (taken.has(key)) throw new Error('finnes allerede')
        createMarket(BOT, inGroup(groupId), { ...market, rule })
        taken.add(key)
        created++
      } catch (err) {
        skipped++
        console.error(`bot: left out Claude's market «${String(raw?.question)}»: ${err instanceof Error ? err.message : err}`)
      }
    }
    console.log(`bot: Claude made ${created} markets in «${title}», left out ${skipped}`)
    return { created, skipped }
  } finally {
    planning = false
  }
}

// --- Deciding

const JUDGE_SYSTEM = `Du avgjør spill på TebBet, den private spillsiden til vennegjengen TEBONSMA. Medlemmene spiller om lekepenger, men avgjørelsen skal være like riktig som hos et ekte spillselskap.

Søk på nettet etter svaret, og følg avgjørelsesregelen til spillet. Svar med verktøyet avgjor:
- result «avgjort» bare når du har funnet svaret i en pålitelig kilde. Sett da outcome (nummeret på utfallet) for ja/nei og ett valg, outcomes (numrene på alle utfallene som slo inn, kanskje ingen) for flere riktige, eller value (tallet det endte på) for over/under. Feltene som ikke gjelder, er null eller en tom liste.
- result «ikke_klart» når svaret ikke er kjent ennå, eller du ikke er sikker.
- result «annullert» når regelen sier at spillet skal annulleres, for eksempel ved avlysning eller utsettelse, eller spørsmålet ikke lar seg avgjøre som det er stilt.

note er én eller to setninger på norsk bokmål om hva som skjedde, for eksempel «Rosenborg vant 2–1 over Molde.» url er lenken til kilden du bygger på.`

const JUDGE_TOOL: Anthropic.Beta.BetaTool = {
  name: 'avgjor',
  description: 'Leverer avgjørelsen av spillet.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['result', 'outcome', 'outcomes', 'value', 'note', 'url'],
    properties: {
      result: { type: 'string', enum: ['avgjort', 'annullert', 'ikke_klart'] },
      outcome: nullable({ type: 'integer' }),
      outcomes: { type: 'array', items: { type: 'integer' } },
      value: nullable({ type: 'number' }),
      note: { type: 'string' },
      url: nullable({ type: 'string' }),
    },
  },
}

const KIND_WORDS = { yesno: 'ja/nei', choice: 'ett valg', multi: 'flere riktige', overunder: 'over/under' } as const

interface MarketRow {
  question: string
  kind: keyof typeof KIND_WORDS
  line: number | null
  closes_at: string
}

// A Claude market whose answer should be out: Claude looks it up, at most every twelve hours,
// and after eight tries it is left to the admins. Null while there is nothing to decide on.
export async function judgeClaude(marketId: string, rule: ClaudeRule): Promise<Verdict | null> {
  if (!config.claude || Date.now() < Date.parse(rule.decideAfter)) return null
  const check = db.prepare('SELECT tries, last_at FROM claude_checks WHERE market_id = ?').get(marketId) as
    | { tries: number; last_at: string }
    | undefined
  if (check && (check.tries >= MAX_TRIES || Date.now() - Date.parse(check.last_at) < CHECK_EVERY_MS)) return null
  if (overBudget()) return null
  const tries = (check?.tries ?? 0) + 1
  db.prepare(
    'INSERT INTO claude_checks (market_id, tries, last_at) VALUES (?, ?, ?) ON CONFLICT (market_id) DO UPDATE SET tries = excluded.tries, last_at = excluded.last_at',
  ).run(marketId, tries, new Date().toISOString())

  const market = db.prepare('SELECT question, kind, line, closes_at FROM bet_markets WHERE id = ?').get(marketId) as unknown as MarketRow
  const outcomes = db.prepare('SELECT label, value FROM bet_outcomes WHERE market_id = ? ORDER BY position').all(marketId) as {
    label: string
    value: number | null
  }[]
  const choices =
    market.kind === 'overunder'
      ? `Linjen er ${market.line}. Svar med tallet det endte på (tallene går fra ${outcomes[0].value} til ${outcomes.at(-1)!.value}, men oppgi det faktiske tallet).`
      : `Utfallene, med nummer:\n${outcomes.map((o, i) => `${i}: ${o.label}`).join('\n')}`
  const prompt = [
    `Spill: «${market.question}»`,
    `Type: ${KIND_WORDS[market.kind]}`,
    choices,
    `Avgjøres slik: ${rule.how}`,
    rule.sources.length ? `Kilder å sjekke: ${rule.sources.join(', ')}` : '',
    `Spillet stengte ${longTime(market.closes_at)}, og svaret skulle være kjent fra ${longTime(rule.decideAfter)}.`,
    `Nå er det ${longTime(new Date())}.`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const answer = await ask('decide', JUDGE_SYSTEM, prompt, JUDGE_TOOL, DECIDE_SEARCHES, 'medium')
  const verdict = toVerdict(answer, market.kind, outcomes.length)
  if (!verdict && tries >= MAX_TRIES) console.error(`bot: Claude could not decide «${market.question}»; it is up to an admin`)
  return verdict
}

function toVerdict(answer: Record<string, unknown>, kind: MarketRow['kind'], count: number): Verdict | null {
  if (answer.result !== 'avgjort' && answer.result !== 'annullert') return null
  const note = readLine(answer.note, 'Begrunnelsen', MAX_NOTE_LENGTH)
  const finding = { note: note || 'Avgjort av Claude.', ...(httpUrl(answer.url) && { url: answer.url as string }) }
  if (answer.result === 'annullert') return { void: true, ...finding }
  const place = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < count
  if (kind === 'overunder') return Number.isFinite(answer.value) ? { value: answer.value as number, ...finding } : null
  if (kind === 'multi') {
    const outcomes = answer.outcomes
    return Array.isArray(outcomes) && outcomes.every(place) ? { outcomes: [...new Set(outcomes)], ...finding } : null
  }
  return place(answer.outcome) ? { outcome: answer.outcome, ...finding } : null
}
