import { HTTPException } from 'hono/http-exception'
import { backend, type Account } from './backend.ts'

// The auto-reply is a Sieve script on the mail server, so it answers while the member is logged
// out too. It is kept as the script "tebonsma", with the settings written in a comment at the top
// so the page can show them again.

export const SCRIPT_NAME = 'tebonsma'
const HEADER = '# teb-autoreply: '
const MAX_SUBJECT = 200
const MAX_BODY = 2000
const DAY = /^\d{4}-\d{2}-\d{2}$/

export interface AutoReply {
  enabled: boolean
  subject: string
  // Plain text
  body: string
  // The first and last day it answers, as YYYY-MM-DD. Without them it answers until it is turned off.
  from: string | null
  to: string | null
}

export const OFF: AutoReply = { enabled: false, subject: '', body: '', from: null, to: null }

interface Stored extends AutoReply {
  // Another script that was active when this one was turned on, which it includes so the member's own filters go on working
  wraps: string | null
}

export function readAutoReply(input: Record<string, unknown>): AutoReply {
  const { enabled, subject, body, from = null, to = null } = input
  if (typeof enabled !== 'boolean' || typeof subject !== 'string' || typeof body !== 'string') {
    throw new HTTPException(400, { message: 'Ugyldig forespørsel' })
  }
  const cleanSubject = subject.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
  const cleanBody = body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  if (cleanSubject.length > MAX_SUBJECT) throw new HTTPException(400, { message: `Emnet kan ikke være lengre enn ${MAX_SUBJECT} tegn` })
  if (cleanBody.length > MAX_BODY) throw new HTTPException(400, { message: `Teksten kan ikke være lengre enn ${MAX_BODY} tegn` })
  for (const day of [from, to]) {
    if (day !== null && (typeof day !== 'string' || !DAY.test(day) || Number.isNaN(new Date(day).getTime()))) {
      throw new HTTPException(400, { message: 'Ugyldig dato' })
    }
  }
  if (from && to && to < from) throw new HTTPException(400, { message: 'Sluttdatoen kan ikke komme før startdatoen' })
  if (enabled && !cleanBody) throw new HTTPException(400, { message: 'Skriv hva autosvaret skal si' })
  return { enabled, subject: cleanSubject, body: cleanBody, from: from as string | null, to: to as string | null }
}

const quote = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

// A multi-line string in Sieve: lines that start with a dot get a second one, and a lone dot ends it
const multiline = (text: string) => `text:\r\n${text.split('\n').map(line => (line.startsWith('.') ? `.${line}` : line)).join('\r\n')}\r\n.\r\n`

export function buildScript(settings: Stored) {
  const requires = new Set<string>()
  const lines: string[] = [`${HEADER}${JSON.stringify(settings)}`]

  if (settings.enabled) {
    requires.add('vacation')
    const conditions: string[] = []
    if (settings.from) {
      requires.add('date').add('relational')
      conditions.push(`currentdate :value "ge" "date" ${quote(settings.from)}`)
    }
    if (settings.to) {
      requires.add('date').add('relational')
      conditions.push(`currentdate :value "le" "date" ${quote(settings.to)}`)
    }
    // Once per sender in four days. Sieve itself doesn't answer lists or automatic mails.
    const action = `vacation :days 4${settings.subject ? ` :subject ${quote(settings.subject)}` : ''} ${multiline(settings.body)};`
    lines.push(conditions.length > 0 ? `if allof (${conditions.join(', ')}) {\r\n${action}\r\n}` : action)
  }
  if (settings.wraps) {
    requires.add('include')
    lines.push(`include :personal ${quote(settings.wraps)};`)
  }
  const require = requires.size > 0 ? `require [${[...requires].map(quote).join(', ')}];\r\n` : ''
  return `${require}${lines.join('\r\n')}\r\n`
}

function parseScript(script: string): Stored | null {
  const line = script.split(/\r?\n/).find(l => l.startsWith(HEADER))
  if (!line) return null
  try {
    const parsed = JSON.parse(line.slice(HEADER.length)) as Partial<Stored>
    return {
      enabled: parsed.enabled === true,
      subject: typeof parsed.subject === 'string' ? parsed.subject : '',
      body: typeof parsed.body === 'string' ? parsed.body : '',
      from: typeof parsed.from === 'string' ? parsed.from : null,
      to: typeof parsed.to === 'string' ? parsed.to : null,
      wraps: typeof parsed.wraps === 'string' ? parsed.wraps : null,
    }
  } catch {
    return null
  }
}

export async function getAutoReply(account: Account): Promise<AutoReply> {
  const [scripts, script] = await Promise.all([backend().listSieve(account), backend().getSieve(account, SCRIPT_NAME)])
  const stored = script ? parseScript(script) : null
  if (!stored) return OFF
  // Turned on means it is the active script, not only that it was once written that way
  const active = scripts.some(s => s.name === SCRIPT_NAME && s.active)
  return { enabled: stored.enabled && active, subject: stored.subject, body: stored.body, from: stored.from, to: stored.to }
}

export async function saveAutoReply(account: Account, settings: AutoReply): Promise<AutoReply> {
  const scripts = await backend().listSieve(account)
  const current = scripts.find(s => s.active)
  const existing = await backend().getSieve(account, SCRIPT_NAME)
  const before = existing ? parseScript(existing) : null

  // The script that was in use before this one, so it can be included while this is on, and brought back when it is turned off
  const wraps = current && current.name !== SCRIPT_NAME ? current.name : (before?.wraps ?? null)

  try {
    await backend().putSieve(account, SCRIPT_NAME, buildScript({ ...settings, wraps }))
  } catch {
    throw new HTTPException(400, { message: 'Postserveren godtok ikke autosvaret. Sjekk teksten og datoene.' })
  }
  if (settings.enabled) {
    await backend().activateSieve(account, SCRIPT_NAME)
  } else if (current?.name === SCRIPT_NAME) {
    // Back to what was used before, or to nothing
    await backend().activateSieve(account, wraps)
  }
  return getAutoReply(account)
}
