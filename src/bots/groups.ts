import { ensureBotGroup } from '../bets.ts'
import { db } from '../db.ts'

// The groups the bot fills with Claude's markets, and what goes in each, as Claude is told
export const BOT_GROUPS = [
  { id: 'sport', title: 'Sport', about: 'idrett i Norge og verden: fotball, ski, håndball, sjakk, sykkel og annet, men ikke Norges herrelandslag i fotball, de har en egen bot' },
  { id: 'politikk', title: 'Politikk', about: 'norsk politikk og samfunn: Stortinget, regjeringen, partiene, målingene og kommunene' },
  { id: 'utenriks', title: 'Utenriks', about: 'politikk, valg og store saker i resten av verden' },
  { id: 'trondelag', title: 'Trøndelag', about: 'Trondheim og Trøndelag: byen, NTNU, lokalpolitikken, været og det som skjer lokalt' },
  { id: 'kultur', title: 'Kultur og underholdning', about: 'TV, film, musikk, kjendiser, priser og festivaler' },
  { id: 'okonomi', title: 'Økonomi og teknologi', about: 'renter, børs, priser, selskaper, teknologi og lanseringer' },
] as const

export type BotGroup = (typeof BOT_GROUPS)[number]

// The group a market goes in: one admins have made with that id or title, or else the bot's
// own, made the first time
export function botGroupId(group: BotGroup) {
  const found = db
    .prepare('SELECT id FROM bet_groups WHERE id = ? OR lower(title) = lower(?) ORDER BY created_at LIMIT 1')
    .get(group.id, group.title) as { id: string } | undefined
  if (found) return found.id
  ensureBotGroup(group.id, group.title, 'claude')
  return group.id
}
