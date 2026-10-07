import { randomInt, randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { addCasinoRow, balanceOf } from './bets.ts'
import { db, transaction } from './db.ts'
import type { Viewer } from './feed.ts'
import { GAMES, type Field, type ScratchGame } from './flaksGames.ts'
import { usernameOf } from './members.ts'

// Flaks: games of pure luck that settle at once, scratch cards and roulette. Coins move through
// the ledger like everything else, as casino-stake and casino-payout rows.
//
// A scratch card's outcome is drawn when it is bought, like a real one: the prize first, by
// the game's odds, then fields that show it. The fields stay on the server until the member
// scratches them, one at a time, and the prize is paid when the last one is scratched.

db.exec(`
  CREATE TABLE IF NOT EXISTS flaks_tickets (
    id         TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    game       TEXT NOT NULL,
    price      INTEGER NOT NULL,
    -- What every field hides (JSON), and which have been scratched
    board      TEXT NOT NULL,
    scratched  TEXT NOT NULL DEFAULT '[]',
    prize      INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    created_at TEXT NOT NULL,
    done_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS flaks_tickets_member ON flaks_tickets (username, status, created_at);

  CREATE TABLE IF NOT EXISTS flaks_spins (
    id         TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    number     INTEGER NOT NULL,
    -- Every bet and what it paid (JSON)
    bets       TEXT NOT NULL,
    stake      INTEGER NOT NULL,
    payout     INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS flaks_spins_member ON flaks_spins (username, created_at);
`)

const bad = (message: string) => new HTTPException(400, { message })
const now = () => new Date().toISOString()
// Tickets left unscratched are kept; this many at most per member
const MAX_OPEN = 20
const DONE_SHOWN = 100

// --- The games, as members see them

// "1 av 3,4"
const oneIn = (perMillion: number) => {
  const n = 1_000_000 / perMillion
  return `1 av ${n < 10 ? n.toFixed(1).replace('.', ',') : Math.round(n).toLocaleString('nb-NO')}`
}

function describeGame(game: ScratchGame) {
  const winning = game.prizes.reduce((sum, p) => sum + p.perMillion, 0)
  const paidBack = game.prizes.reduce((sum, p) => sum + p.amount * p.perMillion, 0) / (game.price * 1_000_000)
  return {
    id: game.id,
    name: game.name,
    tagline: game.tagline,
    rules: game.rules,
    price: game.price,
    fields: game.fields,
    topPrize: Math.max(...game.prizes.map(p => p.amount)),
    // Chance that a ticket wins anything, and the share of stakes paid back on average
    chance: oneIn(winning),
    payback: Math.round(paidBack * 1000) / 10,
    prizes: [...game.prizes].sort((a, b) => b.amount - a.amount).map(p => ({ amount: p.amount, chance: oneIn(p.perMillion) })),
    // What the game shows on every ticket, like who is worth what
    legend: game.legend ?? null,
  }
}

export const listGames = () => GAMES.map(describeGame)

// --- Tickets

interface TicketRow {
  id: string
  username: string
  game: string
  price: number
  board: string
  scratched: string
  prize: number
  status: 'open' | 'done'
  created_at: string
  done_at: string | null
}

const gameOf = (id: string) => {
  const game = GAMES.find(g => g.id === id)
  if (!game) throw new HTTPException(404, { message: 'Loddet finnes ikke' })
  return game
}

// The prize, drawn by the game's odds out of a million tickets, to a thousandth of a ticket so
// odds like 1 in 720 000 come out right
function drawPrize(game: ScratchGame) {
  let ticket = randomInt(1_000_000_000) / 1000
  for (const prize of game.prizes) {
    if (ticket < prize.perMillion) return prize.amount
    ticket -= prize.perMillion
  }
  return 0
}

// What the member may see: scratched fields, and the prize once all are
function toTicket(row: TicketRow) {
  const board = JSON.parse(row.board) as Field[]
  const scratched = new Set(JSON.parse(row.scratched) as number[])
  const done = row.status === 'done'
  return {
    id: row.id,
    game: row.game,
    gameName: GAMES.find(g => g.id === row.game)?.name ?? row.game,
    price: row.price,
    fields: board.map((field, i) => (done || scratched.has(i) ? field : null)),
    done,
    prize: done ? row.prize : null,
    createdAt: row.created_at,
    doneAt: row.done_at,
  }
}

export type Ticket = ReturnType<typeof toTicket>

function findTicket(viewer: Viewer, id: string) {
  const row = db.prepare('SELECT * FROM flaks_tickets WHERE id = ? AND username = ?').get(id, viewer.username) as TicketRow | undefined
  if (!row) throw new HTTPException(404, { message: 'Loddet finnes ikke' })
  return row
}

export const openTickets = (viewer: Viewer) =>
  (
    db
      .prepare("SELECT * FROM flaks_tickets WHERE username = ? AND status = 'open' ORDER BY created_at")
      .all(viewer.username) as unknown as TicketRow[]
  ).map(toTicket)

// Tickets scratched to the end, the latest first: a member's own, or another's by public id
const doneTicketsOf = (username: string) =>
  (
    db
      .prepare("SELECT * FROM flaks_tickets WHERE username = ? AND status = 'done' ORDER BY done_at DESC LIMIT ?")
      .all(username, DONE_SHOWN) as unknown as TicketRow[]
  ).map(toTicket)

export const doneTickets = (viewer: Viewer) => doneTicketsOf(viewer.username)

export function doneTicketsOfMember(id: string) {
  const username = usernameOf(id)
  return username ? doneTicketsOf(username) : []
}

// A free ticket to try a game: drawn by the same odds as a real one, but nothing is kept, taken
// or paid. Its fields come all at once, since nothing hangs on them.
export function tryTicket(gameId: string) {
  const game = gameOf(gameId)
  const prize = drawPrize(game)
  return { game: game.id, gameName: game.name, price: game.price, fields: game.board(prize), prize }
}

export function buyTicket(viewer: Viewer, gameId: string) {
  const game = gameOf(gameId)
  return transaction(() => {
    if (balanceOf(viewer.username) < game.price) throw bad('Du har ikke nok TEB-mynter')
    const open = db.prepare("SELECT COUNT(*) AS n FROM flaks_tickets WHERE username = ? AND status = 'open'").get(viewer.username) as {
      n: number
    }
    if (open.n >= MAX_OPEN) throw bad('Skrap loddene du har før du kjøper flere')
    const prize = drawPrize(game)
    const id = randomUUID()
    db.prepare(
      'INSERT INTO flaks_tickets (id, username, game, price, board, prize, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, viewer.username, game.id, game.price, JSON.stringify(game.board(prize)), prize, now())
    addCasinoRow(viewer.username, -game.price, game.name, null)
    return toTicket(findTicket(viewer, id))
  })
}

// Scratches one field, or all that are left (field missing). The last one pays the prize.
export function scratch(viewer: Viewer, id: string, field?: number) {
  return transaction(() => {
    const row = findTicket(viewer, id)
    if (row.status === 'done') return toTicket(row)
    const board = JSON.parse(row.board) as Field[]
    const scratched = new Set(JSON.parse(row.scratched) as number[])
    if (field === undefined) board.forEach((_, i) => scratched.add(i))
    else {
      if (!Number.isInteger(field) || field < 0 || field >= board.length) throw bad('Ugyldig felt')
      scratched.add(field)
    }
    const done = scratched.size === board.length
    db.prepare('UPDATE flaks_tickets SET scratched = ?, status = ?, done_at = ? WHERE id = ?').run(
      JSON.stringify([...scratched]),
      done ? 'done' : 'open',
      done ? now() : null,
      id,
    )
    if (done && row.prize > 0) addCasinoRow(viewer.username, row.prize, gameOf(row.game).name, `Vant ${row.prize}`)
    return toTicket(findTicket(viewer, id))
  })
}

// --- Roulette: a European wheel with one zero. Bets pay their odds with the stake included.

export type RouletteBetType = 'straight' | 'red' | 'black' | 'odd' | 'even' | 'low' | 'high' | 'dozen' | 'column'
export interface RouletteBet {
  type: RouletteBetType
  // straight 0-36, dozen and column 1-3
  number?: number
  stake: number
}

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36])
const ROULETTE_ODDS: Record<RouletteBetType, number> = {
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

function wins(bet: RouletteBet, n: number) {
  if (bet.type === 'straight') return n === bet.number
  if (n === 0) return false
  switch (bet.type) {
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
      return Math.ceil(n / 12) === bet.number
    case 'column':
      return ((n - 1) % 3) + 1 === bet.number
  }
}

const colorOf = (n: number) => (n === 0 ? ('green' as const) : RED.has(n) ? ('red' as const) : ('black' as const))

interface SpinRow {
  id: string
  username: string
  number: number
  bets: string
  stake: number
  payout: number
  created_at: string
}

const toSpin = (row: SpinRow) => ({
  id: row.id,
  number: row.number,
  color: colorOf(row.number),
  bets: JSON.parse(row.bets) as (RouletteBet & { won: boolean; payout: number })[],
  stake: row.stake,
  payout: row.payout,
  createdAt: row.created_at,
})

// Where the ball lands, and what every bet pays there
function roll(bets: RouletteBet[]) {
  const number = randomInt(37)
  const results = bets.map(bet => {
    const won = wins(bet, number)
    return { ...bet, won, payout: won ? bet.stake * ROULETTE_ODDS[bet.type] : 0 }
  })
  const total = bets.reduce((sum, bet) => sum + bet.stake, 0)
  const paid = results.reduce((sum, bet) => sum + bet.payout, 0)
  return { number, results, total, paid }
}

// A free spin to try the game: the same wheel, but nothing is kept, taken or paid
export function tryRoulette(bets: RouletteBet[]) {
  const { number, results, total, paid } = roll(bets)
  return toSpin({ id: randomUUID(), username: '', number, bets: JSON.stringify(results), stake: total, payout: paid, created_at: now() })
}

export function spinRoulette(viewer: Viewer, bets: RouletteBet[]) {
  return transaction(() => {
    const { number, results, total, paid } = roll(bets)
    if (total > balanceOf(viewer.username)) throw bad('Du har ikke nok TEB-mynter')
    addCasinoRow(viewer.username, -total, 'Rulett', `${bets.length} ${bets.length === 1 ? 'innsats' : 'innsatser'}`)
    if (paid > 0) addCasinoRow(viewer.username, paid, 'Rulett', `Kula landet på ${number}`)
    // Kept so the spin shows among the settled bets
    const row: SpinRow = {
      id: randomUUID(),
      username: viewer.username,
      number,
      bets: JSON.stringify(results),
      stake: total,
      payout: paid,
      created_at: now(),
    }
    db.prepare(
      'INSERT INTO flaks_spins (id, username, number, bets, stake, payout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(row.id, row.username, row.number, row.bets, row.stake, row.payout, row.created_at)
    return toSpin(row)
  })
}

// Everyone's spins before a time, the latest first, for the activity log
export const spinsBefore = (until: string, limit: number) =>
  (
    db.prepare('SELECT * FROM flaks_spins WHERE created_at < ? ORDER BY created_at DESC LIMIT ?').all(until, limit) as unknown as SpinRow[]
  ).map(row => ({ username: row.username, spin: toSpin(row) }))

// Spins, the latest first: a member's own, or another's by public id
const spinsOf = (username: string) =>
  (
    db
      .prepare('SELECT * FROM flaks_spins WHERE username = ? ORDER BY created_at DESC LIMIT ?')
      .all(username, DONE_SHOWN) as unknown as SpinRow[]
  ).map(toSpin)

export const spins = (viewer: Viewer) => spinsOf(viewer.username)

export function spinsOfMember(id: string) {
  const username = usernameOf(id)
  return username ? spinsOf(username) : []
}
