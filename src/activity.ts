import { hiddenFor, toSlips, type SlipRow } from './bets.ts'
import { BOT } from './bots/bot.ts'
import { db } from './db.ts'
import type { Viewer } from './feed.ts'
import { GAMES } from './flaksGames.ts'
import { getMembers } from './members.ts'

// Activity: everything that happens on TebBet in one log, the newest first. Every slip played,
// every market decided or called off, and every scratch card scratched to the end, a page at a
// time. Everyone sees the same log; who played what is already shown on each event and group,
// but not the odds on markets the viewer is kept out of.

const PAGE = 50

export const ACTIVITY_KINDS = ['slip', 'result', 'ticket'] as const
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
          `SELECT id, username, game, price, prize, done_at FROM flaks_tickets
           WHERE status = 'done' AND done_at < ? ORDER BY done_at DESC LIMIT ?`,
        )
        .all(until, PAGE) as unknown as TicketRow[])
    : []

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

  const deciders = results.map(row => row.settled_by).filter((name): name is string => !!name && name !== BOT.username)
  const members = await getMembers([...slips.map(row => row.username), ...tickets.map(row => row.username), ...deciders])
  const slipsById = new Map(toSlips(slips, hiddenFor(viewer.username)).map(slip => [slip.id, slip]))

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
    })),
  ].sort((a, b) => b.at.localeCompare(a.at))

  const page = items.slice(0, PAGE)
  const more = items.length > PAGE || [slips, results, tickets].some(rows => rows.length === PAGE)
  // Ask with before = next for the page after this one
  return { items: page, next: more && page.length > 0 ? page[page.length - 1].at : null }
}
