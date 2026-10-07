import { randomInt, randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { addCasinoRow, balanceOf } from './bets.ts'
import { db, transaction } from './db.ts'
import type { Viewer } from './feed.ts'
import { usernameOf } from './members.ts'

// Blackjack against the dealer, one hand at a time. The cards come from an endlessly shuffled
// shoe and live on the server, so the dealer's hole card can't be peeked at. Rules: blackjack
// pays 3:2 (rounded down), the dealer peeks for blackjack and stands on soft 17, any first two
// cards can be doubled, a pair can be split once (split aces get one card each), and a 21 after a
// split is not a blackjack. Coins move through the ledger like the other games of luck. A free
// hand (trial) plays the same, but takes and pays nothing and isn't listed.

db.exec(`
  CREATE TABLE IF NOT EXISTS flaks_hands (
    id         TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    trial      INTEGER NOT NULL DEFAULT 0,
    -- The cards, the player's hands and whose turn it is (JSON)
    state      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'playing' CHECK (status IN ('playing', 'done')),
    -- Everything staked, doubles and splits included, and what was paid back
    staked     INTEGER NOT NULL,
    payout     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    done_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS flaks_hands_member ON flaks_hands (username, status, created_at);
`)

const GAME = 'Blackjack'
const DONE_SHOWN = 100
const bad = (message: string) => new HTTPException(400, { message })
const now = () => new Date().toISOString()

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const
// Spades, hearts, diamonds, clubs
const SUITS = ['S', 'H', 'D', 'C'] as const

export interface Card {
  rank: (typeof RANKS)[number]
  suit: (typeof SUITS)[number]
}

type Result = 'blackjack' | 'win' | 'push' | 'lose' | 'bust'

interface PlayerHand {
  cards: Card[]
  bet: number
  doubled: boolean
  // Made by a split, so 21 on two cards is just 21
  split: boolean
  done: boolean
  result: Result | null
  payout: number
}

interface State {
  dealer: Card[]
  hands: PlayerHand[]
  // The hand being played
  active: number
  // The hole card is turned
  revealed: boolean
}

interface HandRow {
  id: string
  username: string
  trial: number
  state: string
  status: 'playing' | 'done'
  staked: number
  payout: number
  created_at: string
  done_at: string | null
}

const draw = (): Card => ({ rank: RANKS[randomInt(RANKS.length)], suit: SUITS[randomInt(SUITS.length)] })
const valueOf = (card: Card) => (card.rank === 'A' ? 11 : ['10', 'J', 'Q', 'K'].includes(card.rank) ? 10 : Number(card.rank))

// The best total, and whether an ace still counts as 11 (a soft total)
export function totalOf(cards: Card[]) {
  let total = 0
  let aces = 0
  for (const card of cards) {
    total += valueOf(card)
    if (card.rank === 'A') aces++
  }
  while (total > 21 && aces > 0) {
    total -= 10
    aces--
  }
  return { total, soft: aces > 0 }
}

const isBlackjack = (cards: Card[]) => cards.length === 2 && totalOf(cards).total === 21
const newHand = (cards: Card[], bet: number, split = false): PlayerHand => ({
  cards,
  bet,
  doubled: false,
  split,
  done: false,
  result: null,
  payout: 0,
})

// The dealer draws to 17 and stands on soft 17, unless every hand is already bust; then each
// hand is settled. Returns what is paid back all told.
function finish(state: State) {
  state.revealed = true
  state.active = state.hands.length
  if (state.hands.some(hand => totalOf(hand.cards).total <= 21)) {
    while (totalOf(state.dealer).total < 17) state.dealer.push(draw())
  }
  const dealer = totalOf(state.dealer).total
  const dealerBlackjack = isBlackjack(state.dealer)
  for (const hand of state.hands) {
    const mine = totalOf(hand.cards).total
    const blackjack = !hand.split && isBlackjack(hand.cards)
    hand.done = true
    if (mine > 21) hand.result = 'bust'
    else if (blackjack && !dealerBlackjack) hand.result = 'blackjack'
    else if (dealerBlackjack && !blackjack) hand.result = 'lose'
    else if (dealer > 21 || mine > dealer) hand.result = 'win'
    else if (mine === dealer) hand.result = 'push'
    else hand.result = 'lose'
    hand.payout =
      hand.result === 'blackjack' ? Math.floor(hand.bet * 2.5) : hand.result === 'win' ? hand.bet * 2 : hand.result === 'push' ? hand.bet : 0
  }
  return state.hands.reduce((sum, hand) => sum + hand.payout, 0)
}

// On to the next hand that is still being played, or to the dealer when none is
function advance(state: State) {
  for (const hand of state.hands) {
    if (!hand.done && totalOf(hand.cards).total >= 21) hand.done = true
  }
  const next = state.hands.findIndex(hand => !hand.done)
  state.active = next === -1 ? state.hands.length : next
  return next === -1
}

function canSplit(state: State) {
  const hand = state.hands[state.active]
  return state.hands.length === 1 && hand.cards.length === 2 && valueOf(hand.cards[0]) === valueOf(hand.cards[1])
}

// What the member sees: the dealer's hole card stays face down (null) until it is turned
function toHand(row: HandRow) {
  const state = JSON.parse(row.state) as State
  const playing = row.status === 'playing'
  const hand = state.hands[state.active]
  const balance = playing && !row.trial ? balanceOf(row.username) : Infinity
  const shown = state.revealed ? state.dealer : state.dealer.slice(0, 1)
  return {
    id: row.id,
    trial: row.trial === 1,
    status: row.status,
    dealer: {
      cards: state.revealed ? state.dealer : [state.dealer[0], null],
      total: totalOf(shown).total,
      soft: totalOf(shown).soft,
    },
    hands: state.hands.map(h => ({ ...h, ...totalOf(h.cards) })),
    // The hand being played; null once the dealer has played
    active: playing ? state.active : null,
    // What the member may do now
    actions: {
      hit: playing,
      stand: playing,
      double: playing && hand.cards.length === 2 && !hand.doubled && balance >= hand.bet,
      split: playing && canSplit(state) && balance >= hand.bet,
    },
    staked: row.staked,
    payout: row.payout,
    createdAt: row.created_at,
    doneAt: row.done_at,
  }
}

export type Hand = ReturnType<typeof toHand>

function save(row: HandRow, state: State, done: boolean) {
  row.state = JSON.stringify(state)
  if (done) {
    row.status = 'done'
    row.done_at = now()
  }
  db.prepare('UPDATE flaks_hands SET state = ?, status = ?, staked = ?, payout = ?, done_at = ? WHERE id = ?').run(
    row.state,
    row.status,
    row.staked,
    row.payout,
    row.done_at,
    row.id,
  )
}

// Settles the hand when it is over: the dealer plays and what is won goes into the ledger
function settle(row: HandRow, state: State) {
  row.payout = finish(state)
  const won = state.hands.filter(hand => hand.payout > 0)
  if (!row.trial && row.payout > 0) {
    addCasinoRow(row.username, row.payout, GAME, won.some(hand => hand.result === 'blackjack') ? 'Blackjack!' : `Vant ${row.payout}`)
  }
  save(row, state, true)
}

const openRow = (username: string) =>
  db.prepare("SELECT * FROM flaks_hands WHERE username = ? AND status = 'playing'").get(username) as HandRow | undefined

// The hand the member is in the middle of, if any
export function openHand(viewer: Viewer) {
  const row = openRow(viewer.username)
  return row ? toHand(row) : null
}

export function deal(viewer: Viewer, bet: number, trial: boolean) {
  return transaction(() => {
    if (openRow(viewer.username)) throw new HTTPException(409, { message: 'Spill ferdig hånden du har først' })
    if (!trial && bet > balanceOf(viewer.username)) throw bad('Du har ikke nok TEB-mynter')
    // Free hands that are over aren't kept
    db.prepare("DELETE FROM flaks_hands WHERE username = ? AND trial = 1 AND status = 'done'").run(viewer.username)
    if (!trial) addCasinoRow(viewer.username, -bet, GAME, 'Innsats')

    const player = [draw(), draw()]
    const state: State = { dealer: [draw(), draw()], hands: [newHand(player, bet)], active: 0, revealed: false }
    const row: HandRow = {
      id: randomUUID(),
      username: viewer.username,
      trial: trial ? 1 : 0,
      state: JSON.stringify(state),
      status: 'playing',
      staked: bet,
      payout: 0,
      created_at: now(),
      done_at: null,
    }
    db.prepare(
      'INSERT INTO flaks_hands (id, username, trial, state, status, staked, payout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(row.id, row.username, row.trial, row.state, row.status, row.staked, row.payout, row.created_at)

    // A blackjack on either side ends it at once: the dealer peeks under an ace or a ten
    if (isBlackjack(state.dealer) || isBlackjack(player)) settle(row, state)
    return toHand(row)
  })
}

export const ACTIONS = ['hit', 'stand', 'double', 'split'] as const
export type Action = (typeof ACTIONS)[number]

export function act(viewer: Viewer, id: string, action: Action) {
  return transaction(() => {
    const row = db.prepare('SELECT * FROM flaks_hands WHERE id = ? AND username = ?').get(id, viewer.username) as HandRow | undefined
    if (!row) throw new HTTPException(404, { message: 'Hånden finnes ikke' })
    if (row.status !== 'playing') throw bad('Hånden er ferdig')
    const state = JSON.parse(row.state) as State
    const hand = state.hands[state.active]
    const pay = (detail: string) => {
      if (row.trial) return
      if (balanceOf(viewer.username) < hand.bet) throw bad('Du har ikke nok TEB-mynter')
      addCasinoRow(viewer.username, -hand.bet, GAME, detail)
    }

    switch (action) {
      case 'hit':
        hand.cards.push(draw())
        break
      case 'stand':
        hand.done = true
        break
      case 'double':
        if (hand.cards.length !== 2 || hand.doubled) throw bad('Du kan bare doble på de to første kortene')
        pay('Dobling')
        row.staked += hand.bet
        hand.bet *= 2
        hand.doubled = true
        hand.cards.push(draw())
        hand.done = true
        break
      case 'split': {
        if (!canSplit(state)) throw bad('Du kan bare splitte to like kort, én gang')
        pay('Splitt')
        row.staked += hand.bet
        const aces = hand.cards[0].rank === 'A'
        state.hands = hand.cards.map(card => ({ ...newHand([card, draw()], hand.bet, true), done: aces }))
        state.active = 0
        break
      }
    }

    if (advance(state)) settle(row, state)
    else save(row, state, false)
    return toHand(row)
  })
}

// Everyone's hands played to the end before a time, free ones left out, for the activity log
export const handsBefore = (until: string, limit: number) =>
  (
    db
      .prepare("SELECT * FROM flaks_hands WHERE status = 'done' AND trial = 0 AND done_at < ? ORDER BY done_at DESC LIMIT ?")
      .all(until, limit) as unknown as HandRow[]
  ).map(row => ({ username: row.username, hand: toHand(row) }))

// Hands played to the end, the latest first, free ones left out: a member's own, or another's
const doneHandsOf = (username: string) =>
  (
    db
      .prepare("SELECT * FROM flaks_hands WHERE username = ? AND status = 'done' AND trial = 0 ORDER BY done_at DESC LIMIT ?")
      .all(username, DONE_SHOWN) as unknown as HandRow[]
  ).map(toHand)

export const doneHands = (viewer: Viewer) => doneHandsOf(viewer.username)

export function doneHandsOfMember(id: string) {
  const username = usernameOf(id)
  return username ? doneHandsOf(username) : []
}
