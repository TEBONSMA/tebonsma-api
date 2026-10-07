import { hiddenFor, labelOf, resultOf, toOdds, toSlips, type LegResultRow, type SelectionResult, type SlipRow } from './bets.ts'
import { handsBefore } from './blackjack.ts'
import { BOT } from './bots/bot.ts'
import { db } from './db.ts'
import type { Viewer } from './feed.ts'
import { spinsBefore } from './flaks.ts'
import { GAMES, type Field } from './flaksGames.ts'
import { getMembers } from './members.ts'

// Activity: everything that happens on TebBet in one log, the newest first. Every slip played,
// every market decided or called off, every scratch card scratched to the end, every roulette spin
// and every blackjack hand played out (free ones left out), a page at a time. Everyone sees the same log; who played what is already shown on each event and group,
// but not the odds on markets the viewer is kept out of.

const PAGE = 50

export const ACTIVITY_KINDS = ['slip', 'result', 'ticket', 'spin', 'hand'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

interface ResultRow {
  id: string
  question: string
  kind: string
  status: 'settled' | 'void'
  result_value: number | null
  settled_by: string | null
  settled_at: string
  event_id: string | null
  event_title: string | null
  group_id: string | null
  group_title: string | null
  bets: number
}

interface TicketRow {
  id: string
  username: string
  game: string
  price: number
  prize: number
  done_at: string
  // What every field held (JSON); a ticket here is scratched to the end
  board: string
}

// A pick on a decided market, with the slip it is on
interface PickRow extends LegResultRow {
  market_id: string
  slip_id: string
  label: string | null
  odds: number
  username: string
  stake: number
  slip_status: 'open' | 'won' | 'lost' | 'void'
  payout: number
  slip_odds: number
  legs: number
  // Picks on the slip whose market was called off, which count as odds 1,00
  voided: number
}

const ORDER: Record<SelectionResult, number> = { won: 0, pending: 1, void: 2, lost: 3 }

// Everyone who played on the decided markets, by market: what they picked, at what odds, whether
// it came true, and what their slip won or lost all told. A slip with several outcomes of one
// multi market is one entry. On markets the viewer is kept out of, the odds stay hidden, and so
// does what a winner got, since that gives the odds away.
function playersOn(marketIds: string[]) {
  const byMarket = new Map<string, PickRow[][]>()
  if (marketIds.length === 0) return byMarket
  const rows = db
    .prepare(
      `SELECT s.market_id, s.slip_id, s.outcome_id, s.side, s.line, s.odds, o.label, o.won, m.status, m.result_value,
         sl.username, sl.stake, sl.status AS slip_status, sl.payout, sl.odds AS slip_odds,
         (SELECT COUNT(*) FROM bet_selections x WHERE x.slip_id = s.slip_id) AS legs,
         (SELECT COUNT(*) FROM bet_selections x JOIN bet_markets xm ON xm.id = x.market_id
          WHERE x.slip_id = s.slip_id AND xm.status = 'void') AS voided
       FROM bet_selections s
       JOIN bet_slips sl ON sl.id = s.slip_id
       JOIN bet_markets m ON m.id = s.market_id
       LEFT JOIN bet_outcomes o ON o.id = s.outcome_id
       WHERE s.market_id IN (${marketIds.map(() => '?').join(', ')})
       ORDER BY sl.created_at`,
    )
    .all(...marketIds) as unknown as PickRow[]
  for (const row of rows) {
    const slips = byMarket.get(row.market_id) ?? []
    const same = slips.find(picks => picks[0].slip_id === row.slip_id)
    if (same) same.push(row)
    else slips.push([row])
    byMarket.set(row.market_id, slips)
  }
  return byMarket
}

function toPlayer(picks: PickRow[], hidden: Set<string>) {
  const [first] = picks
  const secret = hidden.has(first.market_id)
  const results = picks.map(resultOf)
  const result: SelectionResult = results.includes('lost')
    ? 'lost'
    : results.every(r => r === 'void')
      ? 'void'
      : results.includes('pending')
        ? 'pending'
        : 'won'
  // What the slip came to: its payout less the stake, or nothing yet while other markets on it wait
  const gain =
    first.slip_status === 'won' ? first.payout - first.stake : first.slip_status === 'lost' ? -first.stake : first.slip_status === 'void' ? 0 : null
  return {
    username: first.username,
    label: picks.map(labelOf).join(', '),
    odds: secret ? null : Math.round(picks.reduce((product, pick) => product * toOdds(pick.odds), 1) * 100) / 100,
    stake: first.stake,
    // Whether the pick on this market came true
    result,
    // Set when the slip is a combination: how many picks it has, its odds all told, and how many
    // of its markets were called off (each then counts as odds 1,00)
    combination:
      first.legs > picks.length ? { legs: first.legs, odds: secret ? null : toOdds(first.slip_odds), voided: first.voided } : null,
    slip: first.slip_status,
    gain: secret && gain !== null && gain > 0 ? null : gain,
  }
}

// What a decided market came to, as members read it: "Ja", "Lag A, Lag C", "7" (over/under), or
// null when it was called off
function answerOf(row: ResultRow, winners: Map<string, string[]>) {
  if (row.status === 'void') return null
  if (row.kind === 'overunder') return String(row.result_value)
  return winners.get(row.id)?.join(', ') || 'Ingen'
}

// One page of the log, older than `before` when given; only some kinds when asked
export async function listActivity(viewer: Viewer, before: string | null, kinds: readonly ActivityKind[]) {
  // Later than any time stored, so the first page starts from now
  const until = before ?? '9999'
  const slips = kinds.includes('slip')
    ? (db
        .prepare('SELECT * FROM bet_slips WHERE created_at < ? ORDER BY created_at DESC LIMIT ?')
        .all(until, PAGE) as unknown as (SlipRow & { username: string })[])
    : []
  const results = kinds.includes('result')
    ? (db
        .prepare(
          `SELECT m.id, m.question, m.kind, m.status, m.result_value, m.settled_by, m.settled_at,
             m.event_id, e.title AS event_title, m.group_id, g.title AS group_title,
             (SELECT COUNT(DISTINCT s.slip_id) FROM bet_selections s WHERE s.market_id = m.id) AS bets
           FROM bet_markets m
           LEFT JOIN events e ON e.post_id = m.event_id
           LEFT JOIN bet_groups g ON g.id = m.group_id
           WHERE m.status != 'open' AND m.settled_at < ?
           ORDER BY m.settled_at DESC LIMIT ?`,
        )
        .all(until, PAGE) as unknown as ResultRow[])
    : []
  const tickets = kinds.includes('ticket')
    ? (db
        .prepare(
          `SELECT id, username, game, price, prize, done_at, board FROM flaks_tickets
           WHERE status = 'done' AND done_at < ? ORDER BY done_at DESC LIMIT ?`,
        )
        .all(until, PAGE) as unknown as TicketRow[])
    : []

  const spins = kinds.includes('spin') ? spinsBefore(until, PAGE) : []
  const hands = kinds.includes('hand') ? handsBefore(until, PAGE) : []

  const winners = new Map<string, string[]>()
  if (results.length > 0) {
    const rows = db
      .prepare(
        `SELECT market_id, label FROM bet_outcomes WHERE won = 1 AND market_id IN (${results.map(() => '?').join(', ')})
         ORDER BY position`,
      )
      .all(...results.map(row => row.id)) as { market_id: string; label: string }[]
    for (const row of rows) winners.set(row.market_id, [...(winners.get(row.market_id) ?? []), row.label])
  }

  const hidden = hiddenFor(viewer.username)
  const players = playersOn(results.map(row => row.id))
  const deciders = results.map(row => row.settled_by).filter((name): name is string => !!name && name !== BOT.username)
  const bettors = [...players.values()].flat().map(picks => picks[0].username)
  const members = await getMembers([
    ...slips.map(row => row.username),
    ...tickets.map(row => row.username),
    ...spins.map(row => row.username),
    ...hands.map(row => row.username),
    ...deciders,
    ...bettors,
  ])
  const slipsById = new Map(toSlips(slips, hidden).map(slip => [slip.id, slip]))

  const items = [
    ...slips.map(row => ({
      kind: 'slip' as const,
      id: `slip:${row.id}`,
      at: row.created_at,
      member: members.get(row.username)!,
      slip: slipsById.get(row.id)!,
    })),
    ...results.map(row => ({
      kind: 'result' as const,
      id: `result:${row.id}:${row.settled_at}`,
      at: row.settled_at,
      marketId: row.id,
      question: row.question,
      eventId: row.event_id,
      eventTitle: row.event_title,
      groupId: row.group_id,
      groupTitle: row.group_title,
      // null when it was called off and the stakes paid back
      answer: answerOf(row, winners),
      decidedBy: row.settled_by === BOT.username ? 'TebBet-boten' : row.settled_by ? (members.get(row.settled_by)?.name ?? null) : null,
      // How many slips were on it
      bets: row.bets,
      // Everyone who played on it, winners first
      players: (players.get(row.id) ?? [])
        .map(picks => toPlayer(picks, hidden))
        .sort((a, b) => ORDER[a.result] - ORDER[b.result] || (b.gain ?? 0) - (a.gain ?? 0) || b.stake - a.stake)
        .map(({ username, ...player }) => ({ member: members.get(username)!, ...player })),
    })),
    ...tickets.map(row => ({
      kind: 'ticket' as const,
      id: `ticket:${row.id}`,
      at: row.done_at,
      member: members.get(row.username)!,
      game: row.game,
      gameName: GAMES.find(game => game.id === row.game)?.name ?? row.game,
      price: row.price,
      prize: row.prize,
      // Every field, as the ticket was scratched
      fields: JSON.parse(row.board) as Field[],
    })),
    ...spins.map(({ username, spin }) => ({
      kind: 'spin' as const,
      id: `spin:${spin.id}`,
      at: spin.createdAt,
      member: members.get(username)!,
      spin,
    })),
    ...hands.map(({ username, hand }) => ({
      kind: 'hand' as const,
      id: `hand:${hand.id}`,
      at: hand.doneAt ?? hand.createdAt,
      member: members.get(username)!,
      hand,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at))

  const page = items.slice(0, PAGE)
  const more = items.length > PAGE || [slips, results, tickets, spins, hands].some(rows => rows.length === PAGE)
  // Ask with before = next for the page after this one
  return { items: page, next: more && page.length > 0 ? page[page.length - 1].at : null }
}
