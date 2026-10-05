// How the bot fetches from the outside world: identified, and never waiting long. ESPN turns
// away agents with a link in them, so it is just the name.
const USER_AGENT = 'TebBet/1.0'
const TIMEOUT_MS = 20_000

async function get(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res
}

export const getText = async (url: string) => (await get(url)).text()
export const getJson = async <T>(url: string) => (await (await get(url)).json()) as T
