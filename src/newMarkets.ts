import { hiddenFor } from './bets.ts'
import { db } from './db.ts'
import { pushSubscribers, pushTo, type PushMessage } from './push.ts'

// Once an hour, TebBet members with notifications on hear about the markets that opened since
// the last look: one push each, leaving out markets they are kept out of and ones they made
// themselves. Markets that have already closed or been decided are not news any more.

// Can be shortened to try it out, or for the tests
const EVERY_MS = Number(process.env.NEW_MARKETS_CHECK_SECONDS ?? 60 * 60) * 1000
const CHECK = 'new-markets'
const MAX_BODY = 140

db.exec(`
  CREATE TABLE IF NOT EXISTS push_checks (
    name       TEXT PRIMARY KEY,
    checked_at TEXT NOT NULL
  );
`)

interface NewMarket {
  id: string
  question: string
  event_id: string | null
  event_title: string | null
  group_id: string | null
  group_title: string | null
  created_by: string
}

const placeOf = (market: NewMarket) =>
  market.event_id
    ? { key: `event:${market.event_id}`, title: market.event_title ?? 'Et arrangement', url: `/arrangement/${market.event_id}` }
    : { key: `group:${market.group_id}`, title: market.group_title ?? 'Andre spill', url: `/gruppe/${market.group_id}` }

// "A", "A og B", "A, B og C"
const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} og ${items.at(-1)}`)

const shorten = (text: string) => (text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text)

function messageFor(markets: NewMarket[]): PushMessage {
  const places = [...new Map(markets.map(market => [placeOf(market).key, placeOf(market)])).values()]
  // A newer one replaces an older one the member hasn't looked at
  const tag = 'new-markets'
  if (markets.length === 1) return { title: `Nytt spill: ${places[0].title}`, body: markets[0].question, url: places[0].url, tag }
  if (places.length === 1) {
    return {
      title: `${markets.length} nye spill: ${places[0].title}`,
      body: shorten(markets.map(market => market.question).join(' · ')),
      url: places[0].url,
      tag,
    }
  }
  return { title: `${markets.length} nye spill å spille på`, body: shorten(list(places.map(place => place.title))), url: '/', tag }
}

export function announceNewMarkets() {
  const now = new Date().toISOString()
  const last = (db.prepare('SELECT checked_at FROM push_checks WHERE name = ?').get(CHECK) as { checked_at: string } | undefined)
    ?.checked_at
  db.prepare('INSERT INTO push_checks (name, checked_at) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET checked_at = excluded.checked_at').run(
    CHECK,
    now,
  )
  // The first look only starts the clock, so a new installation doesn't announce every market there is
  if (!last) return

  const markets = db
    .prepare(
      `SELECT m.id, m.question, m.event_id, e.title AS event_title, m.group_id, g.title AS group_title, m.created_by
       FROM bet_markets m
       LEFT JOIN events e ON e.post_id = m.event_id
       LEFT JOIN bet_groups g ON g.id = m.group_id
       WHERE m.created_at > ? AND m.created_at <= ? AND m.status = 'open' AND (m.closes_at IS NULL OR m.closes_at > ?)
       ORDER BY m.created_at`,
    )
    .all(last, now, now) as unknown as NewMarket[]
  if (markets.length === 0) return

  for (const username of pushSubscribers('tebbet')) {
    const hidden = hiddenFor(username)
    const theirs = markets.filter(market => !hidden.has(market.id) && market.created_by !== username)
    if (theirs.length > 0) pushTo('tebbet', [username], messageFor(theirs))
  }
}

export function startNewMarketsCheck() {
  const check = () => {
    try {
      announceNewMarkets()
    } catch (err) {
      console.error('could not announce new markets:', err)
    }
  }
  check()
  setInterval(check, EVERY_MS)
}
