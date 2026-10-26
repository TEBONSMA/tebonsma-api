import { ensureBotGroup } from '../bets.ts'
import { db, transaction } from '../db.ts'

// The groups the bot fills with Claude's markets, and what goes in each, as Claude is told
export const BOT_GROUPS = [
  { id: 'sport', title: 'Sport', about: 'idrett i Norge og verden: fotball, ski, håndball, sjakk, sykkel og annet' },
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

// The bot no longer makes markets on Norway's football matches. Their rules go, so a match
// still undecided is left to the admins, and the group they were in, Landslaget, goes into
// Sport, in its place on the front page. Nothing happens the second time.
function retireFootball() {
  transaction(() => {
    db.prepare(
      `UPDATE bet_markets SET rule = NULL, note = CASE WHEN status = 'open' THEN ? ELSE note END
       WHERE json_extract(rule, '$.type') = 'football'`,
    ).run('Boten som laget spillet er lagt ned, så det avgjøres nå for hånd.')
    if (!db.prepare("SELECT 1 FROM bet_groups WHERE id = 'landslaget'").get()) return
    const sport = botGroupId(BOT_GROUPS[0])
    db.prepare("UPDATE bet_markets SET group_id = ?, section_id = NULL WHERE group_id = 'landslaget'").run(sport)
    db.prepare("DELETE FROM bet_sections WHERE group_id = 'landslaget'").run()
    if (db.prepare('SELECT 1 FROM bet_front WHERE item = ?').get(`group:${sport}`)) {
      db.prepare("DELETE FROM bet_front WHERE item = 'group:landslaget'").run()
    } else {
      db.prepare("UPDATE bet_front SET item = ? WHERE item = 'group:landslaget'").run(`group:${sport}`)
    }
    db.prepare("DELETE FROM bet_groups WHERE id = 'landslaget'").run()
  })
}

retireFootball()
