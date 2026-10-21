import { ensureBotGroup, settleMarket, voidMarket } from '../bets.ts'
import { db } from '../db.ts'
import { BOT } from './bot.ts'
import { judgeClaude, planClaude } from './claude.ts'
import { FOOTBALL_GROUP, forgetSummaries, judgeFootball, planFootball } from './football.ts'
import type { Rule } from './rules.ts'

// TebBet's bot: opens markets on Norway's matches, has Claude make markets on the news, and
// decides every market that has a rule once the answer is in.

const ROUND_MS = 10 * 60 * 1000

interface OpenRow {
  id: string
  kind: string
  rule: string
  closes_at: string | null
}

// Every market the bot can decide that has closed: the ones whose answer is in are decided
export async function decideAll() {
  forgetSummaries()
  const open = db
    .prepare("SELECT id, kind, rule, closes_at FROM bet_markets WHERE status = 'open' AND rule IS NOT NULL AND closes_at <= ?")
    .all(new Date().toISOString()) as unknown as OpenRow[]
  for (const market of open) {
    try {
      const rule = JSON.parse(market.rule) as Rule
      const verdict = rule.type === 'claude' ? await judgeClaude(market.id, rule) : await judgeFootball(rule, market.closes_at!)
      if (!verdict) continue
      const finding = { note: verdict.note, url: verdict.url }
      const outcomeAt = (position: number) =>
        (db.prepare('SELECT id FROM bet_outcomes WHERE market_id = ? AND position = ?').get(market.id, position) as { id: string }).id
      if ('void' in verdict) voidMarket(BOT, market.id, finding)
      else if ('value' in verdict) settleMarket(BOT, market.id, { value: verdict.value }, finding)
      else if ('outcomes' in verdict) settleMarket(BOT, market.id, { outcomeIds: verdict.outcomes.map(outcomeAt) }, finding)
      else {
        const outcome = outcomeAt(verdict.outcome)
        settleMarket(BOT, market.id, market.kind === 'multi' ? { outcomeIds: [outcome] } : { outcomeId: outcome }, finding)
      }
    } catch (err) {
      console.error(`bot: could not decide market ${market.id}:`, err)
    }
  }
}

let running = false

export async function runBots() {
  if (running) return
  running = true
  try {
    for (const [what, step] of [
      ['plan football', planFootball],
      ['plan with Claude', () => planClaude()],
      ['decide markets', decideAll],
    ] as const) {
      try {
        await step()
      } catch (err) {
        console.error(`bot: could not ${what}:`, err)
      }
    }
  } finally {
    running = false
  }
}

// BOTS=off leaves the bot out, as in local development unless asked for
export function startBots() {
  ensureBotGroup(FOOTBALL_GROUP, 'Landslaget', 'football')
  if (process.env.BOTS === 'off') return
  setTimeout(() => void runBots(), 20_000)
  setInterval(() => void runBots(), ROUND_MS)
  console.log('bot: started')
}
