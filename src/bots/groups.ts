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

// Claude's markets from before there were groups, in the news group, and the group each belongs
// in. Those made by hand stay in the news group.
const FROM_THE_NEWS: [string, BotGroup['id']][] = [
  ['fd35bb56-b21d-49cd-8524-fe0ec4a202db', 'sport'], // HamKam – Rosenborg
  ['d81143a5-3ca5-4a07-a3de-3a0c505f3c8f', 'sport'], // Rosenborg videre i NM
  ['b2af7c72-77d9-4937-bd4f-affc8ef54a36', 'sport'], // Bodø/Glimt – Lille
  ['78999983-4d18-43a3-b5a1-9d477114e58f', 'sport'], // Gullkampen Bodø/Glimt – Viking
  ['684b1954-072e-47ea-a838-73913522572e', 'sport'], // Formel 1 i Austin
  ['27765697-4f20-49e6-86a2-ec5d356abc11', 'sport'], // Antonelli verdensmester
  ['fd66710e-2e36-4046-bbc8-23723f089cf8', 'sport'], // Ballon d'Or-vinneren
  ['8bc0d564-ee52-4667-b066-2d3397aac5da', 'sport'], // Haalands plass i Ballon d'Or
  ['9f209e36-ad8b-4a34-841a-5bc28232c4f3', 'utenriks'], // Mellomvalget i USA
  ['77bddcd6-2e0a-40ee-bbbe-dd34cb837513', 'okonomi'], // Apples nye produkter
  ['e393132f-8da5-41b6-ad90-85dd39675383', 'okonomi'], // Navnet på Apples MacBook
  ['e07ac533-a9dd-4bf4-bf4b-7fdf4e1b3128', 'okonomi'], // KPI for oktober
  ['609496ea-ff3e-40ec-a640-792acb4c88dc', 'okonomi'], // Nvidias omsetning
  ['63706485-3da6-4eb0-8bb7-fb6df5b9d8cd', 'trondelag'], // Snø på Voll
]

// Each of those still in the news group goes to its own. Nothing happens the second time.
function sortTheNews() {
  transaction(() => {
    for (const [id, groupId] of FROM_THE_NEWS) {
      if (!db.prepare("SELECT 1 FROM bet_markets WHERE id = ? AND group_id = 'nyheter'").get(id)) continue
      const group = BOT_GROUPS.find(known => known.id === groupId)!
      db.prepare('UPDATE bet_markets SET group_id = ?, section_id = NULL WHERE id = ?').run(botGroupId(group), id)
    }
  })
}

retireFootball()
sortTheNews()
