// Buran, a crash game: the rocket climbs and the multiplier with it, from 1,00x, until it blows
// up at a point drawn before launch and kept secret. Take your coins out before that and you get
// the stake times the multiplier; after, nothing. The point is drawn so that the chance it gets
// to x or beyond is 0.96 / x: whenever you take out, a coin pays back 96 % on average, and about
// 5 % of the rockets blow up at 1,00x.

import type { Random } from './slot.ts'

export const HOUSE_KEEPS = 0.04
// The highest the rocket goes; it blows up there at the latest
export const MAX_CRASH = 250
// How fast the multiplier climbs: e^(RATE * ms), so 2x after about 7 s, 10x after 23 s and 250x
// after 55 s. CRASH_SPEED makes it faster, for the tests.
const RATE = 0.0001 * Number(process.env.CRASH_SPEED ?? 1)

// In hundredths: 100 is 1,00x
export function drawCrash(random: Random) {
  const u = random(1_000_000_000) / 1_000_000_000
  const point = Math.floor(((1 - HOUSE_KEEPS) / (1 - u)) * 100)
  return Math.min(Math.max(point, 100), MAX_CRASH * 100)
}

// The multiplier, in hundredths, ms after launch
export const multiplierAt = (ms: number) => Math.floor(Math.exp(RATE * Math.max(ms, 0)) * 100)

// When the multiplier reaches m (hundredths), in ms after launch
export const timeAt = (m: number) => Math.ceil(Math.log(m / 100) / RATE)

export const crashRate = RATE
