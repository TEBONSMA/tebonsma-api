// The collector slot (after ELK's Pirots): four collectors stand on a 6 x 6 grid of pieces and,
// one after the other, walk into neighbouring pieces they can take, a step at a time: pieces of
// their own colour, wilds, coins and bonus pieces, and their colour's upgrade, which makes their
// pieces worth more for the rest of the spin. When none of them can take anything more, the
// grid falls down, collectors included, new pieces drop in from the top, and they go again.
// Three bonus pieces in one spin give free spins, where the upgrades are kept from spin to spin.
//
// The engine only knows colours 0-3 and kinds of pieces; the theme (flavours, members) is the
// site's. Everything the site needs to show a spin is in the frames, in order.

export const ROWS = 6
export const COLS = 6
export const COLORS = [0, 1, 2, 3] as const
export type Color = (typeof COLORS)[number]

export type Piece =
  | { id: number; kind: 'gem'; color: Color }
  | { id: number; kind: 'upgrade'; color: Color }
  | { id: number; kind: 'wild' }
  // value: in hundredths of the stake
  | { id: number; kind: 'coin'; value: number }
  | { id: number; kind: 'bonus' }

export interface Spot {
  row: number
  col: number
}

export type PlacedPiece = Piece & Spot
export type PlacedCollector = { color: Color } & Spot

export type Frame =
  // A new grid: the start of the spin, or of a free spin
  | { type: 'fill'; pieces: PlacedPiece[]; collectors: PlacedCollector[]; free: boolean; levels: number[] }
  // A collector takes the piece next to it. win in hundredths of the stake; level is the
  // collector's level after an upgrade.
  | { type: 'step'; color: Color; row: number; col: number; piece: number; win: number; level?: number }
  // Everything falls down; new pieces come in from above. moved: pieces and collectors that
  // moved, added: new pieces where they end up.
  | { type: 'fall'; moved: { piece?: number; collector?: Color; row: number; col: number }[]; added: PlacedPiece[] }
  // Free spins won or won again: how many are left now
  | { type: 'free'; left: number; won: number }

// How much a piece of each colour is worth, by its level, in hundredths of the stake
export const GEM_VALUES = [6, 12, 22, 45, 90, 180, 375]
export const MAX_LEVEL = GEM_VALUES.length - 1
const COIN_VALUES = [
  { value: 20, weight: 35 },
  { value: 50, weight: 30 },
  { value: 100, weight: 18 },
  { value: 200, weight: 10 },
  { value: 500, weight: 5 },
  { value: 2000, weight: 2 },
]
// How often each kind of piece drops in, of the total. In free spins, upgrades come more often.
const WEIGHTS = { gem: 21, upgrade: 1, wild: 5, coin: 0.8, bonus: 1.6 }
const FREE_UPGRADES = 4
export const FREE_SPINS = 10
export const MORE_FREE_SPINS = 5
const BONUS_TO_TRIGGER = 3
const MAX_FREE_SPINS = 40
// The most a spin can pay, in stakes
export const MAX_WIN = 5000
const MAX_FALLS = 60

// randomInt(n): a whole number from 0 to n - 1
export type Random = (n: number) => number

const pick = <T,>(random: Random, weighted: { weight: number; item: T }[]) => {
  const total = weighted.reduce((sum, w) => sum + w.weight, 0)
  // Weights may have one decimal; random draws in tenths
  let roll = random(Math.round(total * 10)) / 10
  for (const w of weighted) {
    if (roll < w.weight) return w.item
    roll -= w.weight
  }
  return weighted[weighted.length - 1].item
}

type Kind = Piece['kind']
const kinds = (upgrade: number): { weight: number; item: Kind }[] => [
  { weight: WEIGHTS.gem * COLORS.length, item: 'gem' },
  { weight: upgrade * COLORS.length, item: 'upgrade' },
  { weight: WEIGHTS.wild, item: 'wild' },
  { weight: WEIGHTS.coin, item: 'coin' },
  { weight: WEIGHTS.bonus, item: 'bonus' },
]
const BASE_KINDS = kinds(WEIGHTS.upgrade)
const FREE_KINDS = kinds(FREE_UPGRADES)

function newPiece(random: Random, id: number, free: boolean): Piece {
  const kind = pick(random, free ? FREE_KINDS : BASE_KINDS)
  if (kind === 'gem' || kind === 'upgrade') return { id, kind, color: COLORS[random(COLORS.length)] }
  if (kind === 'coin') return { id, kind, value: pick(random, COIN_VALUES.map(c => ({ weight: c.weight, item: c.value }))) }
  return { id, kind }
}

const takes = (color: Color, piece: Piece) =>
  piece.kind === 'wild' || piece.kind === 'coin' || piece.kind === 'bonus' || ((piece.kind === 'gem' || piece.kind === 'upgrade') && piece.color === color)

// Up, right, down, left
const NEIGHBOURS = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
]

export interface SlotResult {
  frames: Frame[]
  // In hundredths of the stake, before the cap
  win: number
  // Free spins played
  freeSpins: number
  // The highest level any colour reached
  topLevel: number
}

export function playSlot(random: Random): SlotResult {
  const frames: Frame[] = []
  let nextId = 1
  let win = 0
  let freeLeft = 0
  let freeSpins = 0
  let levels = COLORS.map(() => 0)
  let topLevel = 0
  const cap = MAX_WIN * 100

  // One grid, from fill to the last fall; returns the bonus pieces taken
  const round = (free: boolean) => {
    if (!free) levels = COLORS.map(() => 0)
    const grid: (Piece | null)[][] = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => newPiece(random, nextId++, free)))
    // The collectors stand on four cells of their own
    const cells = Array.from({ length: ROWS * COLS }, (_, i) => i)
    const collectors: PlacedCollector[] = COLORS.map(color => {
      const cell = cells.splice(random(cells.length), 1)[0]
      const row = Math.floor(cell / COLS)
      const col = cell % COLS
      grid[row][col] = null
      return { color, row, col }
    })
    frames.push({
      type: 'fill',
      pieces: grid.flatMap((cells, row) => cells.flatMap((piece, col) => (piece ? [{ ...piece, row, col }] : []))),
      collectors: collectors.map(c => ({ ...c })),
      free,
      levels: [...levels],
    })

    const occupied = (row: number, col: number) => collectors.some(c => c.row === row && c.col === col)
    let bonuses = 0
    for (let falls = 0; falls < MAX_FALLS && win < cap; falls++) {
      let took = false
      for (const collector of collectors) {
        for (;;) {
          const next = NEIGHBOURS.map(([dr, dc]) => ({ row: collector.row + dr, col: collector.col + dc })).find(
            ({ row, col }) =>
              row >= 0 && row < ROWS && col >= 0 && col < COLS && !occupied(row, col) && grid[row][col] !== null && takes(collector.color, grid[row][col]!),
          )
          if (!next) break
          const piece = grid[next.row][next.col]!
          grid[next.row][next.col] = null
          collector.row = next.row
          collector.col = next.col
          took = true
          let gained = 0
          let level: number | undefined
          if (piece.kind === 'gem') gained = GEM_VALUES[levels[collector.color]]
          else if (piece.kind === 'coin') gained = piece.value
          else if (piece.kind === 'bonus') bonuses++
          else if (piece.kind === 'upgrade') {
            levels[collector.color] = Math.min(MAX_LEVEL, levels[collector.color] + 1)
            level = levels[collector.color]
            topLevel = Math.max(topLevel, level)
          }
          win += gained
          frames.push({ type: 'step', color: collector.color, row: next.row, col: next.col, piece: piece.id, win: gained, ...(level !== undefined && { level }) })
        }
      }
      if (!took) break

      // Everything falls to the bottom of its column, and new pieces fill the top
      const moved: { piece?: number; collector?: Color; row: number; col: number }[] = []
      const added: PlacedPiece[] = []
      for (let col = 0; col < COLS; col++) {
        const stack: ({ piece: Piece } | { collector: PlacedCollector })[] = []
        for (let row = 0; row < ROWS; row++) {
          const collector = collectors.find(c => c.row === row && c.col === col)
          if (collector) stack.push({ collector })
          else if (grid[row][col]) stack.push({ piece: grid[row][col]! })
        }
        const empty = ROWS - stack.length
        for (let row = 0; row < ROWS; row++) grid[row][col] = null
        stack.forEach((item, i) => {
          const row = empty + i
          if ('piece' in item) {
            grid[row][col] = item.piece
            moved.push({ piece: item.piece.id, row, col })
          } else {
            if (item.collector.row !== row) moved.push({ collector: item.collector.color, row, col })
            item.collector.row = row
          }
        })
        for (let row = 0; row < empty; row++) {
          const piece = newPiece(random, nextId++, free)
          grid[row][col] = piece
          added.push({ ...piece, row, col })
        }
      }
      frames.push({ type: 'fall', moved, added })
    }
    return bonuses
  }

  const won = round(false)
  if (won >= BONUS_TO_TRIGGER) {
    // The free spins start with every colour at least one level up
    levels = levels.map(level => Math.max(level, 1))
    freeLeft = FREE_SPINS
    frames.push({ type: 'free', left: freeLeft, won: FREE_SPINS })
    while (freeLeft > 0 && freeSpins < MAX_FREE_SPINS && win < cap) {
      freeLeft--
      freeSpins++
      const again = round(true)
      if (again >= BONUS_TO_TRIGGER) {
        freeLeft += MORE_FREE_SPINS
        frames.push({ type: 'free', left: freeLeft, won: MORE_FREE_SPINS })
      }
    }
  }
  return { frames, win, freeSpins, topLevel }
}

// What a spin pays in coins: the win in hundredths of the stake, capped, rounded down
export const payoutOf = (stake: number, win: number) => Math.floor((stake * Math.min(win, MAX_WIN * 100)) / 100)
