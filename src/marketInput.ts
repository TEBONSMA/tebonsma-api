import { HTTPException } from 'hono/http-exception'
import type { MarketInput } from './bets.ts'
import { bad, readText } from './feedRoutes.ts'
import { idByName, usernameOf } from './members.ts'
import { MAX_ODDS, MIN_ODDS, SPREADS, type Spread } from './odds.ts'

// A market as it comes in, from an admin, an import or the bot, checked before anything is made

export const MAX_QUESTION_LENGTH = 140
const MAX_OUTCOME_LENGTH = 60
// Room for every member of TEBONSMA and then some
export const MAX_OUTCOMES = 10
const MAX_EXCLUDED = 50
const MAX_SECTION_TITLE_LENGTH = 60
const MAX_IMPORT = 30
// Over/under: how many numbers the slider can have, and how far up it can go
const MAX_NUMBERS = 200
const MAX_HIGHEST = 100_000

export const readLine = (raw: unknown, what: string, maxLength: number) => readText(raw, what, maxLength).replace(/\s+/g, ' ')

// Times are stored the way JavaScript writes them, so they can be compared as text
export function readTime(raw: unknown) {
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
export function readExcluded(raw: unknown) {
  if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string')) throw bad('Ugyldig liste over medlemmer')
  if (raw.length > MAX_EXCLUDED) throw bad('For mange medlemmer')
  return raw as string[]
}

export function readMarket(body: Record<string, unknown>): MarketInput {
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

export const readSectionTitle = (raw: unknown) => {
  const title = readLine(raw, 'Seksjonen', MAX_SECTION_TITLE_LENGTH)
  if (!title) throw bad('Seksjonen trenger et navn')
  return title
}

// Markets made in one go: each like a new market, plus the title
// of the section to put it under. Who is kept out can be given by name as well as by id.
export function readImport(body: Record<string, unknown>) {
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
