// Roulette with one zero: the places to bet, what they pay and when they win. The roulette table
// (flaks.ts) and roulette picks in combinations (bets.ts) both go by these.

export type RouletteBetType =
  | 'straight'
  | 'split'
  | 'street'
  | 'corner'
  | 'line'
  | 'red'
  | 'black'
  | 'odd'
  | 'even'
  | 'low'
  | 'high'
  | 'dozen'
  | 'column'

// A place on the table: straight 0-36, dozen and column 1-3. A place on the lines between the
// numbers has the numbers it covers instead, lowest first.
export interface RouletteSpot {
  type: RouletteBetType
  number?: number
  numbers?: number[]
}

// A bet on the table, with what is on it
export interface RouletteBet extends RouletteSpot {
  stake: number
}

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36])

// What a bet pays, the stake included
export const ROULETTE_ODDS: Record<RouletteBetType, number> = {
  straight: 36,
  split: 18,
  street: 12,
  corner: 9,
  line: 6,
  red: 2,
  black: 2,
  odd: 2,
  even: 2,
  low: 2,
  high: 2,
  dozen: 3,
  column: 3,
}
export const ROULETTE_TYPES = Object.keys(ROULETTE_ODDS) as RouletteBetType[]

// The bets on the lines between the numbers: two side by side (split), a row of three across the
// table (street), four around a corner (corner) and two rows (line). The numbers run in rows of
// three, 1-2-3, 4-5-6 and so on, with 0 next to the first row. 0 can be split with 1, 2 or 3, is
// in the streets 0-1-2 and 0-2-3, and 0-1-2-3 is a corner.
export const INSIDE_TYPES: RouletteBetType[] = ['split', 'street', 'corner', 'line']

const insideBets = new Set<string>()
const add = (type: RouletteBetType, numbers: number[]) => insideBets.add(`${type}:${numbers.join('-')}`)
for (let n = 1; n <= 36; n++) {
  const top = n % 3 === 0
  if (!top) add('split', [n, n + 1])
  if (n <= 33) add('split', [n, n + 3])
  if (!top && n <= 32) add('corner', [n, n + 1, n + 3, n + 4])
}
for (let row = 1; row <= 12; row++) {
  const first = 3 * row - 2
  add('street', [first, first + 1, first + 2])
  if (row < 12) add('line', [first, first + 1, first + 2, first + 3, first + 4, first + 5])
}
for (const n of [1, 2, 3]) add('split', [0, n])
add('street', [0, 1, 2])
add('street', [0, 2, 3])
add('corner', [0, 1, 2, 3])

// Whether the numbers, lowest first, are a place on the lines of that type
export const isInsideBet = (type: RouletteBetType, numbers: number[]) => insideBets.has(`${type}:${numbers.join('-')}`)

export function wins(spot: RouletteSpot, n: number) {
  if (spot.numbers) return spot.numbers.includes(n)
  if (spot.type === 'straight') return n === spot.number
  if (n === 0) return false
  switch (spot.type) {
    case 'red':
      return RED.has(n)
    case 'black':
      return !RED.has(n)
    case 'odd':
      return n % 2 === 1
    case 'even':
      return n % 2 === 0
    case 'low':
      return n <= 18
    case 'high':
      return n >= 19
    case 'dozen':
      return Math.ceil(n / 12) === spot.number
    case 'column':
      return ((n - 1) % 3) + 1 === spot.number
    default:
      return false
  }
}

export const colorOf = (n: number) => (n === 0 ? ('green' as const) : RED.has(n) ? ('red' as const) : ('black' as const))

// As members read it, the same as on the table: "Rødt", "Tall 17", "Split 17/20", "2. dusin"
export function spotLabel(spot: RouletteSpot) {
  const numbers = spot.numbers ?? []
  switch (spot.type) {
    case 'straight':
      return `Tall ${spot.number}`
    case 'split':
      return `Split ${numbers.join('/')}`
    case 'street':
      return numbers[0] === 0 ? `Rekke ${numbers.join('/')}` : `Rekke ${numbers[0]}–${numbers.at(-1)}`
    case 'corner':
      return `Hjørne ${numbers.join('/')}`
    case 'line':
      return `Dobbeltrekke ${numbers[0]}–${numbers.at(-1)}`
    case 'red':
      return 'Rødt'
    case 'black':
      return 'Svart'
    case 'odd':
      return 'Oddetall'
    case 'even':
      return 'Partall'
    case 'low':
      return '1–18'
    case 'high':
      return '19–36'
    case 'dozen':
      return `${spot.number}. dusin`
    case 'column':
      return `${spot.number}. kolonne`
  }
}
