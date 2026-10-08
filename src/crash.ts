// Fyllekjøring, a crash game: the car drives on and the multiplier climbs with it, from 1,00x,
// until it crashes at a point drawn before the start and kept secret. Take your coins out before
// that and you get the stake times the multiplier; after, nothing. The point is drawn so that the
// chance it gets to x or beyond is 0.96 / x: whenever you take out, a coin pays back 96 % on
// average, and about 5 % of the drives crash at 1,00x.

import type { Random } from './slot.ts'

export const HOUSE_KEEPS = 0.04
// The furthest the car goes: Palanga, the end of the route. A car that gets there parks instead
// of crashing, and pays this to everyone still in it. The chance of getting there
// is 0.96 / 250, so it pays back 96 % like everywhere else.
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
