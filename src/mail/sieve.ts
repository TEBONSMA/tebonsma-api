import { connect as tcpConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { config } from '../config.ts'
import { unavailable, type Account, type SieveScript } from './backend.ts'

// A small ManageSieve client (RFC 5804): enough to list, read, write and switch on a member's filter
// scripts. It logs in with the member's own access token, like the mail connections do. Each call
// makes its own short connection, since scripts are only touched when someone changes their auto-reply.

// --- Reading what the server says ---

// One line of a reply: quoted strings and literals come out as text, words like ACTIVE as they are
type Line = string[]

interface Reply {
  status: 'OK' | 'NO' | 'BYE'
  // Anything after the status word, such as a reason or a response code
  message: string
  lines: Line[]
}

const TIMEOUT_MS = 10_000

export class SieveRefused extends Error {}

// Reads a stream of bytes as ManageSieve replies. It works on any socket, so it can be tried against canned replies.
export class SieveReader {
  private buffer = Buffer.alloc(0)
  private waiting: (() => void) | null = null
  private ended = false
  private failure: Error | null = null

  private detachFrom: (() => void) | null = null

  constructor(socket: Socket) {
    const onData = (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.wake()
    }
    const onEnd = () => this.end()
    const onError = (err: Error) => {
      this.failure = err
      this.end()
    }
    socket.on('data', onData)
    socket.on('end', onEnd)
    socket.on('close', onEnd)
    socket.on('error', onError)
    this.detachFrom = () => {
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('close', onEnd)
      socket.off('error', onError)
    }
  }

  // Stops listening, for when the connection is taken over by an encrypted layer
  detach() {
    this.detachFrom?.()
    this.detachFrom = null
  }

  private end() {
    this.ended = true
    this.wake()
  }

  private wake() {
    const resume = this.waiting
    this.waiting = null
    resume?.()
  }

  private async more() {
    if (this.ended) throw this.failure ?? new Error('The connection closed')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The server did not answer in time')), TIMEOUT_MS)
      this.waiting = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  private async need(bytes: number) {
    while (this.buffer.length < bytes) await this.more()
  }

  // Everything up to the next line break
  private async rawLine() {
    for (;;) {
      const end = this.buffer.indexOf('\r\n')
      if (end !== -1) {
        const line = this.buffer.subarray(0, end)
        this.buffer = this.buffer.subarray(end + 2)
        return line
      }
      await this.more()
    }
  }

  // A line split into words. A literal ({n}, with its bytes on the lines after) becomes one word.
  private async line(): Promise<Line> {
    const words: string[] = []
    let raw = (await this.rawLine()).toString('utf8')
    for (;;) {
      let i = 0
      while (i < raw.length) {
        const ch = raw[i]
        if (ch === ' ') {
          i++
        } else if (ch === '"') {
          let word = ''
          i++
          while (i < raw.length && raw[i] !== '"') {
            if (raw[i] === '\\') i++
            word += raw[i++]
          }
          i++
          words.push(word)
        } else if (ch === '{') {
          const size = Number(/^\{(\d+)\+?\}/.exec(raw.slice(i))?.[1])
          if (!Number.isInteger(size)) throw new Error('Unreadable literal')
          await this.need(size)
          words.push(this.buffer.subarray(0, size).toString('utf8'))
          this.buffer = this.buffer.subarray(size)
          // The line goes on after the literal
          raw = (await this.rawLine()).toString('utf8')
          i = 0
        } else {
          const end = raw.indexOf(' ', i)
          words.push(end === -1 ? raw.slice(i) : raw.slice(i, end))
          i = end === -1 ? raw.length : end
        }
      }
      return words
    }
  }

  // Lines up to and including the one that says OK, NO or BYE. A line that is just a quoted string
  // (the server answering a login with an error) comes back as the reply, for the caller to see.
  async reply(onChallenge?: () => void): Promise<Reply> {
    const lines: Line[] = []
    for (;;) {
      const line = await this.line()
      const first = line[0]?.toUpperCase()
      if (first === 'OK' || first === 'NO' || first === 'BYE') {
        return { status: first, message: line.slice(1).join(' '), lines }
      }
      lines.push(line)
      // A login that goes wrong is answered with a line on its own, which the client has to answer with an empty one
      if (onChallenge && line.length === 1) onChallenge()
    }
  }
}

// --- Talking to the server ---

const quote = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export interface Session {
  list(): Promise<SieveScript[]>
  get(name: string): Promise<string | null>
  put(name: string, script: string): Promise<void>
  activate(name: string | null): Promise<void>
  logout(): Promise<void>
}

// What the server offers, from its first reply: lines like "SASL" "OAUTHBEARER XOAUTH2"
const capability = (reply: Reply, key: string) => reply.lines.find(line => line[0]?.toUpperCase() === key)?.[1] ?? ''

// Logs in on a connection that is already encrypted and has said hello, and returns what can be done on it
export async function openSession(socket: Socket, reader: SieveReader, greeting: Reply, account: Account): Promise<Session> {
  const write = (text: string | Buffer) => socket.write(text)
  const mechanisms = capability(greeting, 'SASL').toUpperCase().split(/\s+/)

  // OAUTHBEARER is what Dovecot calls the standard one; XOAUTH2 is what many servers still use
  const bearer = mechanisms.includes('OAUTHBEARER')
  if (!bearer && !mechanisms.includes('XOAUTH2')) throw new SieveRefused('The server does not take access tokens')
  const initial = bearer
    ? `n,a=${account.email},\u0001auth=Bearer ${account.token}\u0001\u0001`
    : `user=${account.email}\u0001auth=Bearer ${account.token}\u0001\u0001`
  write(`AUTHENTICATE ${quote(bearer ? 'OAUTHBEARER' : 'XOAUTH2')} ${quote(Buffer.from(initial).toString('base64'))}\r\n`)

  // A refused token is answered with an error message first, which has to be answered with an empty line before the final NO
  const first = await reader.reply(() => write('""\r\n')).catch(() => null)
  if (!first) throw new SieveRefused('No answer to the login')
  if (first.status !== 'OK') {
    throw new SieveRefused(`The server refused the login: ${first.message || first.lines.map(line => line.join(' ')).join(' ')}`)
  }

  const run = async (command: string) => {
    write(`${command}\r\n`)
    return reader.reply()
  }

  return {
    async list() {
      const reply = await run('LISTSCRIPTS')
      if (reply.status !== 'OK') throw new SieveRefused(reply.message)
      return reply.lines.map(line => ({ name: line[0], active: line.slice(1).some(word => word.toUpperCase() === 'ACTIVE') }))
    },
    async get(name) {
      const reply = await run(`GETSCRIPT ${quote(name)}`)
      if (reply.status === 'NO') return null
      return reply.lines[0]?.[0] ?? ''
    },
    async put(name, script) {
      const body = Buffer.from(script, 'utf8')
      // A literal that is sent without waiting for the server to ask for it: {n+}
      write(Buffer.concat([Buffer.from(`PUTSCRIPT ${quote(name)} {${body.length}+}\r\n`), body, Buffer.from('\r\n')]))
      const reply = await reader.reply()
      if (reply.status !== 'OK') throw new SieveRefused(reply.message)
    },
    async activate(name) {
      const reply = await run(`SETACTIVE ${quote(name ?? '')}`)
      if (reply.status !== 'OK') throw new SieveRefused(reply.message)
    },
    async logout() {
      write('LOGOUT\r\n')
      socket.end()
    },
  }
}

// Connects, switches to an encrypted connection, logs in as the member, does the work and hangs up
async function withSession<T>(account: Account, work: (session: Session) => Promise<T>): Promise<T> {
  const { sieveHost, sievePort } = config.mail
  let socket: Socket | TLSSocket | null = null
  try {
    const plain = tcpConnect({ host: sieveHost, port: sievePort })
    plain.setTimeout(TIMEOUT_MS * 3, () => plain.destroy(new Error('The connection timed out')))
    const plainReader = new SieveReader(plain)
    await plainReader.reply()

    // The token is only ever sent over an encrypted connection
    plain.write('STARTTLS\r\n')
    const started = await plainReader.reply()
    if (started.status !== 'OK') throw new SieveRefused('The server does not offer an encrypted connection')
    plainReader.detach()
    const secure = tlsConnect({ socket: plain, servername: sieveHost })
    socket = secure
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', resolve)
      secure.once('error', reject)
    })
    const reader = new SieveReader(secure)
    const greeting = await reader.reply()

    const session = await openSession(secure, reader, greeting, account)
    try {
      return await work(session)
    } finally {
      await session.logout().catch(() => {})
    }
  } catch (err) {
    if (err instanceof SieveRefused) throw err
    console.error('Talking to the ManageSieve server failed:', err)
    throw unavailable()
  } finally {
    socket?.destroy()
  }
}

export const listSieve = (account: Account) => withSession(account, session => session.list())
export const getSieve = (account: Account, name: string) => withSession(account, session => session.get(name))
export const putSieve = (account: Account, name: string, script: string) => withSession(account, session => session.put(name, script))
export const activateSieve = (account: Account, name: string | null) => withSession(account, session => session.activate(name))
