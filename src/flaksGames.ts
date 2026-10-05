import { randomInt } from 'node:crypto'

// The scratch cards. Each draws its prize by its own odds (out of a million tickets) and then
// lays out fields that show that prize by its own rules. Prices, prizes and odds follow
// Norsk Tipping's digital Flax cards of the same price.

// What a field hides. symbol says what it is; the rest depends on the game.
export interface Field {
  symbol: string
  amount?: number
  member?: string
  flavor?: string
}

export interface ScratchGame {
  id: string
  name: string
  tagline: string
  rules: string
  price: number
  fields: number
  prizes: { amount: number; perMillion: number }[]
  // Shown on every ticket, like what each member is worth
  legend?: { label: string; amount: number }[]
  board: (prize: number) => Field[]
}

const pick = <T>(list: readonly T[]) => list[randomInt(list.length)]

function shuffle<T>(list: T[]) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

// The prize as one, two or three of the amounts on the ticket, so a win can come in parts
function split(prize: number, amounts: number[], most = 3) {
  const parts = 1 + randomInt(most)
  const tries: number[][] = []
  const search = (left: number, count: number, chosen: number[]) => {
    if (count === 0) {
      if (left === 0) tries.push(chosen)
      return
    }
    for (const amount of amounts) if (amount <= left) search(left - amount, count - 1, [...chosen, amount])
  }
  search(prize, parts, [])
  return tries.length > 0 ? pick(tries) : [prize]
}

// --- Underbergen: every Underberg pays what is on it, but Bergen spoils the whole ticket

const UNDERBERG_FIELDS = 9

function underbergGame(id: string, name: string, price: number, prizes: ScratchGame['prizes']): ScratchGame {
  const amounts = prizes.map(p => p.amount)
  return {
    id,
    name,
    tagline: 'Finn Underberg. Ikke finn Bergen.',
    rules:
      'Skrap feltene ett og ett. Hver Underberg du finner, gir beløpet som står på flasken. Men dukker Bergen opp, er hele loddet tapt, uansett hvor mange Underberg du har funnet.',
    price,
    fields: UNDERBERG_FIELDS,
    prizes,
    board(prize) {
      const fields: Field[] = []
      if (prize > 0) {
        for (const amount of split(prize, amounts)) fields.push({ symbol: 'underberg', amount })
      } else {
        // Every losing ticket meets Bergen, often after a tempting Underberg or two
        fields.push({ symbol: 'bergen' })
        for (let i = randomInt(3); i > 0; i--) fields.push({ symbol: 'underberg', amount: pick(amounts) })
      }
      while (fields.length < UNDERBERG_FIELDS) fields.push({ symbol: 'kapsel' })
      return shuffle(fields)
    },
  }
}

// --- Trippel-Teb: three of the same member wins what that member is worth

// The members of TEBONSMA as on tebonsma.no, by their name on TebBet
export const MEMBERS = ['Pling', 'Gjøran', 'Johan', 'Magne', 'Abraham', 'Kris', 'Remi', 'Slangen', 'Adam'] as const
const GANG_FIELDS = 9

function gangGame(id: string, name: string, price: number, prizes: ScratchGame['prizes']): ScratchGame {
  // The biggest prize goes to the first member, and so on down
  const worth = [...prizes].sort((a, b) => b.amount - a.amount).map((p, i) => ({ label: MEMBERS[i], amount: p.amount }))
  return {
    id,
    name,
    tagline: 'Finn tre like i gjengen.',
    rules:
      'Skrap feltene. Finner du samme medlem tre ganger, vinner du det medlemmet er verdt. Hvem som er verdt hva, står på loddet.',
    price,
    fields: GANG_FIELDS,
    prizes,
    legend: worth,
    board(prize) {
      const winner = worth.find(w => w.amount === prize)?.label
      const fields: Field[] = []
      if (winner) for (let i = 0; i < 3; i++) fields.push({ symbol: 'member', member: winner })
      // The rest: no one else three times, but plenty of pairs to keep it exciting
      const others = shuffle(MEMBERS.filter(m => m !== winner))
      const counts = new Map<string, number>()
      let i = 0
      while (fields.length < GANG_FIELDS) {
        const member = others[i % others.length]
        const count = counts.get(member) ?? 0
        if (count < 2 && (count === 0 || randomInt(3) > 0)) {
          fields.push({ symbol: 'member', member })
          counts.set(member, count + 1)
        }
        i++
      }
      return shuffle(fields)
    },
  }
}

// --- Jarritos: your bottles against the winning flavours; the man with the cane wins anyway

const FLAVORS = [
  'Mandarin',
  'Lime',
  'Guava',
  'Ananas',
  'Mango',
  'Grapefrukt',
  'Jordbær',
  'Fruktpunsj',
  'Vannmelon',
  'Pasjonsfrukt',
  'Cola',
] as const
const WINNING = 2
const BOTTLES = 8

function jarritosGame(id: string, name: string, price: number, prizes: ScratchGame['prizes']): ScratchGame {
  const amounts = prizes.map(p => p.amount)
  return {
    id,
    name,
    tagline: 'Dine flasker mot dagens vinnersmaker.',
    rules:
      'De to første feltene er dagens vinnersmaker. Har en av dine åtte flasker samme smak, vinner du beløpet på den. Finner du mannen med stokk, vinner du beløpet på ham uansett. Flere treff gir flere gevinster.',
    price,
    fields: WINNING + BOTTLES,
    prizes,
    board(prize) {
      const winning = shuffle([...FLAVORS]).slice(0, WINNING)
      const others = FLAVORS.filter(f => !winning.includes(f))
      const bottles: Field[] = []
      if (prize > 0) {
        for (const amount of split(prize, amounts)) {
          bottles.push(randomInt(6) === 0 ? { symbol: 'stokk', amount } : { symbol: 'flaske', flavor: pick(winning), amount })
        }
      }
      while (bottles.length < BOTTLES) bottles.push({ symbol: 'flaske', flavor: pick(others), amount: pick(amounts) })
      return [...winning.map(flavor => ({ symbol: 'vinner', flavor })), ...shuffle(bottles)]
    },
  }
}

// Prize tables: amount and how many of every million tickets win it. Each follows the Flax card
// of its kind and price: Underbergen GriseFlax (20, top prize 1 in 200 000), Jarritos 10X
// Pengedryss (25, 1 in 666 667) and Trippel-Teb MillionFlax (30, 1 000 000 at 1 in 720 000, a win
// in 3,2). They pay back 55-59 % of the stakes, within Norsk Tipping's 45-65 % for Flax.
export const GAMES: ScratchGame[] = [
  underbergGame('underbergen', 'Underbergen', 20, [
    { amount: 20, perMillion: 155_009 },
    { amount: 40, perMillion: 100_000 },
    { amount: 100, perMillion: 25_000 },
    { amount: 200, perMillion: 5_000 },
    { amount: 500, perMillion: 600 },
    { amount: 1_000, perMillion: 100 },
    { amount: 20_000, perMillion: 5 },
  ]),
  jarritosGame('jarritos', 'Jarritos', 25, [
    { amount: 25, perMillion: 185_258.5 },
    { amount: 50, perMillion: 80_000 },
    { amount: 100, perMillion: 30_000 },
    { amount: 250, perMillion: 6_000 },
    { amount: 500, perMillion: 1_500 },
    { amount: 1_000, perMillion: 250 },
    { amount: 10_000, perMillion: 20 },
    { amount: 100_000, perMillion: 1.5 },
  ]),
  gangGame('trippel-teb', 'Trippel-Teb', 30, [
    { amount: 30, perMillion: 225_669 },
    { amount: 60, perMillion: 60_000 },
    { amount: 120, perMillion: 20_000 },
    { amount: 300, perMillion: 5_000 },
    { amount: 600, perMillion: 1_500 },
    { amount: 1_500, perMillion: 300 },
    { amount: 10_000, perMillion: 25 },
    { amount: 100_000, perMillion: 5 },
    { amount: 1_000_000, perMillion: 25 / 18 },
  ]),
]
