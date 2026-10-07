// Roulette with one zero: the places to bet, what they pay and when they win. The roulette table
// (flaks.ts) and roulette picks in combinations (bets.ts) both go by these.

export type RouletteBetType = 'straight' | 'red' | 'black' | 'odd' | 'even' | 'low' | 'high' | 'dozen' | 'column'

// A place on the table: straight 0-36, dozen and column 1-3
export interface RouletteSpot {
  type: RouletteBetType
  number?: number
}

// A bet on the table, with what is on it
export interface RouletteBet extends RouletteSpot {
  stake: number
}

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36])

// What a bet pays, the stake included
export const ROULETTE_ODDS: Record<RouletteBetType, number> = {
  straight: 36,
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

export function wins(spot: RouletteSpot, n: number) {
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
  }
}

export const colorOf = (n: number) => (n === 0 ? ('green' as const) : RED.has(n) ? ('red' as const) : ('black' as const))

// As members read it, the same as on the table: "Rødt", "Tall 17", "2. dusin"
export function spotLabel(spot: RouletteSpot) {
  switch (spot.type) {
    case 'straight':
      return `Tall ${spot.number}`
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
