// How TebBet sets its odds. The organizer's opening odds say how likely each outcome is,
// and from then on a market maker moves them: every coin played on an outcome makes it look
// likelier, so its odds fall and the others' rise. This is Hanson's logarithmic market
// scoring rule (LMSR), which can't be gamed by betting back and forth, plus a margin for
// the bank.
//
// Odds are whole hundredths everywhere (185 is 1,85), so nothing is lost to rounding.
// The site has a copy of the functions it needs to show the odds a stake will get.

// Share of every payout the bank keeps
export const MARGIN = 0.05
// How many coins it takes to move the odds; higher is slower
export const DEFAULT_LIQUIDITY = 2000
export const MIN_ODDS = 101
export const MAX_ODDS = 10_000
// A combination can't pay more than this many times the stake
export const MAX_COMBINED_ODDS = 100_000

// Rounds down to whole hundredths. The nudge keeps a value that should be a whole number
// from landing just below it through floating point error.
const clamp = (odds: number) => Math.min(MAX_ODDS, Math.max(MIN_ODDS, Math.floor(odds + 1e-9)))

// The probabilities the opening odds stand for, without the organizer's own margin
export function probabilitiesFromOdds(odds: number[]) {
  const implied = odds.map(o => 100 / o)
  const total = implied.reduce((sum, p) => sum + p, 0)
  return implied.map(p => p / total)
}

// The market maker keeps a number of shares per outcome. Starting at liquidity × ln(p)
// makes the prices equal the opening probabilities.
export const openingShares = (probability: number, liquidity: number) => liquidity * Math.log(probability)

// What each outcome costs right now, as a probability. Shifted by the largest value so
// exp() can't overflow.
export function prices(shares: number[], liquidity: number) {
  const top = Math.max(...shares)
  const weights = shares.map(q => Math.exp((q - top) / liquidity))
  const total = weights.reduce((sum, w) => sum + w, 0)
  return weights.map(w => w / total)
}

// The odds shown on the outcome: what a small stake would get
export const oddsAt = (price: number) => clamp((100 * (1 - MARGIN)) / price)

// Shares a stake buys at the given price. Each share pays one coin if the outcome happens.
export const sharesFor = (stake: number, price: number, liquidity: number) =>
  liquidity * Math.log1p(Math.expm1(stake / liquidity) / price)

// The odds a stake actually gets. A large stake moves the price while it is being bought,
// so it gets a little less than the odds shown.
export const oddsFor = (stake: number, price: number, liquidity: number) =>
  clamp((100 * (1 - MARGIN) * sharesFor(stake, price, liquidity)) / stake)

// Odds of several selections together; a void selection counts as 1,00
export function combine(odds: number[]) {
  let combined = 100
  for (const o of odds) combined = Math.floor((combined * o) / 100)
  return Math.min(combined, MAX_COMBINED_ODDS)
}

export const payoutFor = (stake: number, odds: number) => Math.floor((stake * odds) / 100)

// Over/under: the number being counted is split into the whole numbers from 0 up to the
// highest, which also stands for anything above it. Betting over 4,5 is betting on all of
// 5, 6, 7 and so on at once, so the odds on every line hang together. The opening chances
// follow a Poisson distribution, which suits things that are counted (beers, goals, minutes
// late), with the organizer's line in the middle: over and under it start out even.
export function countProbabilities(line: number, highest: number) {
  const under = Math.floor(line)
  // Chance of at most `under` for a mean of lambda, worked out in logs so a large mean
  // can't underflow
  const chanceUnder = (lambda: number) => {
    let logTerm = -lambda
    let sum = Math.exp(logTerm)
    for (let k = 1; k <= under; k++) {
      logTerm += Math.log(lambda) - Math.log(k)
      sum += Math.exp(logTerm)
    }
    return sum
  }
  // The chance of under falls as the mean grows; find the mean that makes it one half
  let low = 1e-6
  let high = 4 * highest + 10
  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2
    if (chanceUnder(mid) > 0.5) low = mid
    else high = mid
  }
  const lambda = (low + high) / 2

  const chances: number[] = []
  let logTerm = -lambda
  for (let k = 0; k < highest; k++) {
    if (k > 0) logTerm += Math.log(lambda) - Math.log(k)
    chances.push(Math.exp(logTerm))
  }
  chances.push(Math.max(0, 1 - chances.reduce((sum, p) => sum + p, 0)))
  // No number is ruled out entirely, or its shares would be minus infinity
  const floored = chances.map(p => Math.max(p, 1e-6))
  const total = floored.reduce((sum, p) => sum + p, 0)
  return floored.map(p => p / total)
}
