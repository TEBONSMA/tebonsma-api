// TEB-hjulet, a money wheel (after Dream Catcher): 54 segments, six things to bet on and two
// multipliers. A multiplier spins the wheel again and multiplies what the next segment pays, at
// most twice in a row. The odds are set so every bet pays back about 96 %: with c segments of a
// kind, odds 0.96 * 45 / c (the 45 is the 54 segments less the two multipliers' share).

import type { Random } from './slot.ts'

export const WHEEL_SYMBOLS = ['jarritos', 'underberg', 'nachspiel', 'pulebord', 'nyttar', 'sommerfest'] as const
export type WheelSymbol = (typeof WHEEL_SYMBOLS)[number]
export type WheelSegment = WheelSymbol | 'x2' | 'x7'

// Around the wheel, clockwise from the pointer at rest. The site draws the same order.
export const WHEEL: WheelSegment[] = [
  'sommerfest', 'jarritos', 'underberg', 'pulebord', 'nachspiel', 'jarritos', 'nyttar', 'underberg', 'jarritos',
  'jarritos', 'underberg', 'nachspiel', 'jarritos', 'x2', 'underberg', 'jarritos', 'underberg', 'pulebord',
  'nachspiel', 'jarritos', 'jarritos', 'underberg', 'jarritos', 'jarritos', 'jarritos', 'underberg', 'nachspiel',
  'x7', 'underberg', 'jarritos', 'pulebord', 'jarritos', 'underberg', 'nyttar', 'nachspiel', 'underberg',
  'jarritos', 'jarritos', 'jarritos', 'underberg', 'jarritos', 'jarritos', 'nachspiel', 'underberg', 'pulebord',
  'jarritos', 'underberg', 'jarritos', 'jarritos', 'nachspiel', 'underberg', 'jarritos', 'jarritos', 'underberg',
]

// What a bet pays when its segment comes up, the stake included
export const WHEEL_ODDS: Record<WheelSymbol, number> = {
  jarritos: 1.88,
  underberg: 2.88,
  nachspiel: 6.17,
  pulebord: 10.8,
  nyttar: 21.6,
  sommerfest: 43.2,
}

// As members read them
export const WHEEL_NAMES: Record<WheelSymbol, string> = {
  jarritos: 'Jarritos',
  underberg: 'Underberg',
  nachspiel: 'Nachspiel',
  pulebord: 'Pulebord',
  nyttar: 'Nyttårsaften',
  sommerfest: 'Sommerfesten',
}

export const MULTIPLIERS: Record<'x2' | 'x7', number> = { x2: 2, x7: 7 }
const MAX_MULTIPLIERS = 2

export interface WheelOutcome {
  // The segments the wheel stopped on, in order: multipliers, then the symbol
  stops: number[]
  symbol: WheelSymbol
  multiplier: number
}

export function spinWheel(random: Random): WheelOutcome {
  const stops: number[] = []
  let multiplier = 1
  let multipliers = 0
  for (;;) {
    const stop = random(WHEEL.length)
    stops.push(stop)
    const segment = WHEEL[stop]
    if (segment === 'x2' || segment === 'x7') {
      // After two multipliers in a row, a third only spins again
      if (multipliers < MAX_MULTIPLIERS) {
        multiplier *= MULTIPLIERS[segment]
        multipliers++
      }
      continue
    }
    return { stops, symbol: segment, multiplier }
  }
}

// What a bet on the symbol pays, in whole coins
export const wheelPayout = (symbol: WheelSymbol, stake: number, outcome: WheelOutcome) =>
  outcome.symbol === symbol ? Math.floor(stake * WHEEL_ODDS[symbol] * outcome.multiplier) : 0
