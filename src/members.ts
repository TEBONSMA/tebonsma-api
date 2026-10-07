import { createHash, randomUUID } from 'node:crypto'
import { config } from './config.ts'
import { db } from './db.ts'
import { getProfile, listGroupMembers, listUsers, type Profile } from './lldap.ts'

// How a member appears to others in the feed. The id is random, so usernames (which are
// also the mail logins) never leave the API.
export interface PublicMember {
  id: string
  name: string
  avatar: string | null
}

interface MemberRow {
  username: string
  id: string
  display_name: string
  avatar_hash: string | null
  refreshed_at: number
}

// Names and pictures live in LLDAP; this is a copy so the feed doesn't ask LLDAP for every
// author on every request
const REFRESH_MS = 10 * 60 * 1000
const RETRY_MS = 60 * 1000
const UNKNOWN_NAME = 'Medlem'

db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    username     TEXT PRIMARY KEY,
    id           TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    avatar       BLOB,
    avatar_hash  TEXT,
    refreshed_at INTEGER NOT NULL
  );
`)

const COLUMNS = 'username, id, display_name, avatar_hash, refreshed_at'

const findRow = (username: string) =>
  db.prepare(`SELECT ${COLUMNS} FROM members WHERE username = ?`).get(username) as MemberRow | undefined

const toPublic = (row: MemberRow): PublicMember => ({
  id: row.id,
  name: row.display_name,
  avatar: row.avatar_hash ? `/members/${row.id}/avatar?v=${row.avatar_hash}` : null,
})

function save(username: string, displayName: string, avatarBase64: string | null) {
  const avatar = avatarBase64 ? Buffer.from(avatarBase64, 'base64') : null
  const hash = avatar ? createHash('sha256').update(avatar).digest('hex').slice(0, 16) : null
  db.prepare(`
    INSERT INTO members (username, id, display_name, avatar, avatar_hash, refreshed_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (username) DO UPDATE SET
      display_name = excluded.display_name, avatar = excluded.avatar,
      avatar_hash = excluded.avatar_hash, refreshed_at = excluded.refreshed_at
  `).run(username, randomUUID(), displayName, avatar, hash, Date.now())
}

// Called whenever the API has a fresh profile in hand, so edits show up in the feed at once
export const rememberProfile = (profile: Profile) =>
  save(profile.username, profile.displayName || UNKNOWN_NAME, profile.avatar)

// When LLDAP can't be reached, wait a little before asking about the same member again
const retryAfter = new Map<string, number>()

async function refresh(username: string) {
  if ((retryAfter.get(username) ?? 0) > Date.now()) return
  try {
    rememberProfile(await getProfile(username))
    retryAfter.delete(username)
  } catch (err) {
    console.error(`Could not refresh member ${username}:`, err)
    retryAfter.set(username, Date.now() + RETRY_MS)
    // Members who have left LLDAP keep the name they had; others get a placeholder
    if (!findRow(username)) save(username, UNKNOWN_NAME, null)
  }
}

export async function getMembers(usernames: Iterable<string>) {
  const unique = [...new Set(usernames)]
  const stale = unique.filter(username => {
    const row = findRow(username)
    return !row || Date.now() - row.refreshed_at > REFRESH_MS
  })
  await Promise.all(stale.map(refresh))

  return new Map(unique.map(username => [username, toPublic(findRow(username)!)]))
}

// The member with this name, for imports that name who is kept out of a market
export function idByName(name: string) {
  const wanted = name.trim().toLocaleLowerCase('nb')
  const rows = db.prepare('SELECT id, display_name FROM members').all() as { id: string; display_name: string }[]
  return rows.find(row => row.display_name.toLocaleLowerCase('nb') === wanted)?.id
}

// The member behind a public id, if the API has seen them
export const usernameOf = (id: string) =>
  (db.prepare('SELECT username FROM members WHERE id = ?').get(id) as { username: string } | undefined)?.username

export function getAvatar(id: string) {
  const row = db.prepare('SELECT avatar FROM members WHERE id = ?').get(id) as { avatar: Uint8Array | null } | undefined
  return row?.avatar ?? null
}

// Only for the API itself: a member is known to others by this random id, and it leads back
// to the account here without anyone else seeing the username
export function findByMemberId(id: string) {
  const row = db.prepare('SELECT username FROM members WHERE id = ?').get(id) as { username: string } | undefined
  return row?.username ?? null
}

// Everyone with an account, for choosing who to send a mail or share something to. Only the
// random id, name and picture leave the API, never usernames or addresses.
const LIST_MS = 5 * 60 * 1000
let listed: { at: number; usernames: string[]; emails: Map<string, string> } | null = null

async function ensureListed() {
  if (!listed || Date.now() - listed.at > LIST_MS) {
    const profiles = await listUsers()
    for (const profile of profiles) rememberProfile(profile)
    listed = {
      at: Date.now(),
      usernames: profiles.map(profile => profile.username),
      emails: new Map(profiles.flatMap(profile => (profile.email ? [[profile.email.toLowerCase(), profile.username] as const] : []))),
    }
  }
  return listed
}

// The members of TEBONSMA to choose from, as mail recipients or as organizers of an event:
// the member group, so the admin and service accounts in the directory are left out
export async function listMembers(except: string) {
  const usernames = await listGroupMembers(config.memberGroup)
  const members = await getMembers(usernames.filter(username => username !== except))
  return [...members.values()].sort((a, b) => a.name.localeCompare(b.name, 'nb'))
}

// Whether a mail address belongs to a member, so a mail from one is shown as from them
export async function findMemberByEmail(address: string) {
  const username = (await ensureListed()).emails.get(address.toLowerCase())
  return username ?? null
}
