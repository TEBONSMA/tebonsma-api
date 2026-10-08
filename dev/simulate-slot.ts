import { payoutOf, playSlot, type Piece } from '../src/slot.ts'

// How the collector slot pays over many spins: node dev/simulate-slot.ts [spins]
const spins = Number(process.argv[2] ?? 200_000)
const random = (n: number) => Math.floor(Math.random() * n)
const stake = 100
let paid = 0
let hits = 0
let bonus = 0
let biggest = 0
let frames = 0
let steps = 0
const from = { gem: 0, coin: 0, free: 0 }
const buckets = new Map<string, number>()
for (let i = 0; i < spins; i++) {
  const result = playSlot(random)
  const payout = payoutOf(stake, result.win)
  paid += payout
  frames += result.frames.length
  if (payout > 0) hits++
  if (result.freeSpins > 0) bonus++
  biggest = Math.max(biggest, payout / stake)
  const kinds = new Map<number, Piece['kind']>()
  let free = false
  for (const frame of result.frames) {
    if (frame.type === 'fill') {
      free = frame.free
      for (const p of frame.pieces) kinds.set(p.id, p.kind)
    } else if (frame.type === 'fall') for (const p of frame.added) kinds.set(p.id, p.kind)
    else if (frame.type === 'step') {
      steps++
      if (free) from.free += frame.win
      else if (kinds.get(frame.piece) === 'coin') from.coin += frame.win
      else from.gem += frame.win
    }
  }
  const x = payout / stake
  const bucket = x === 0 ? '0' : x < 1 ? '<1' : x < 5 ? '1-5' : x < 20 ? '5-20' : x < 100 ? '20-100' : x < 1000 ? '100-1000' : '1000+'
  buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
}
const pct = (n: number) => ((n / (spins * 100)) * 100).toFixed(1)
console.log(
  `RTP ${((paid / (spins * stake)) * 100).toFixed(2)} % (gems ${pct(from.gem)}, coins ${pct(from.coin)}, free spins ${pct(from.free)}), hit rate ${((hits / spins) * 100).toFixed(1)} %, bonus 1 in ${Math.round(spins / Math.max(bonus, 1))}, biggest ${biggest}x, steps/spin ${(steps / spins).toFixed(1)}, frames/spin ${(frames / spins).toFixed(0)}`,
)
console.log([...buckets].sort().map(([k, v]) => `${k}: ${((v / spins) * 100).toFixed(2)} %`).join('  '))
