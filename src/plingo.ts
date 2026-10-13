import { randomInt } from 'node:crypto'

// Plingo: a ball drops through ROWS rows of pegs and goes left or right at each one, a coin
// toss, so it lands in a bucket by the binomial odds. The path is drawn here and shown by the
// site. The rounds themselves, and the coins, are in rounds.ts.

export const PLINGO_ROWS = 16
// Balls in one drop, at 0,1 s apart on the site
export const PLINGO_MAX_BALLS = 50

// The multiplier of each bucket from the left, in hundredths: 3500 is 35x. The same as the
// site's (src/lib/plingo.ts). The edges are rare (1 in 65 536 each), the middle is where most land.
// Pays back 97,5 % on average.
const HALF = [100000, 13000, 2500, 600, 300, 150, 50, 40, 30]
export const PLINGO_MULTIPLIERS = [...HALF, ...HALF.slice(0, -1).reverse()]

// One ball: left (0) or right (1) at each row, and the bucket it ends in (the number of rights)
export function drawBall(stake: number, random: (max: number) => number = randomInt) {
  const path = Array.from({ length: PLINGO_ROWS }, () => random(2))
  const bucket = path.reduce((sum, step) => sum + step, 0)
  const multiplier = PLINGO_MULTIPLIERS[bucket]
  return { path, bucket, multiplier, payout: Math.floor((stake * multiplier) / 100) }
}
