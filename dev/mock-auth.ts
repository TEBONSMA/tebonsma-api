import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { html } from 'hono/html'

// Stands in for Authelia (OIDC login) and LLDAP (user directory) during local development,
// so the site and the API run their normal login flow without the real services.
// Never deployed: the Docker image only contains src/.

interface MockUser {
  email: string
  displayName: string
  firstName: string
  lastName: string
  avatar: string | null
  groups: string[]
  createdAt: string
}

// Profile edits are kept in memory and reset when the server restarts
const users = new Map<string, MockUser>([
  [
    'dev',
    {
      email: 'dev@tebonsma.test',
      displayName: 'Dev Bruker',
      firstName: 'Dev',
      lastName: 'Bruker',
      avatar: null,
      groups: ['tebonsma'],
      createdAt: '2025-01-01T12:00:00Z',
    },
  ],
  [
    'kari',
    {
      email: 'kari@tebonsma.test',
      displayName: 'Kari Nordmann',
      firstName: 'Kari',
      lastName: 'Nordmann',
      avatar: null,
      groups: ['tebonsma'],
      createdAt: '2025-01-01T12:00:00Z',
    },
  ],
  [
    'ola',
    {
      email: 'ola@tebonsma.test',
      displayName: 'Ola Nordmann',
      firstName: 'Ola',
      lastName: 'Nordmann',
      avatar: null,
      groups: ['tebonsma'],
      createdAt: '2025-01-01T12:00:00Z',
    },
  ],
  [
    'admin',
    {
      email: 'admin@tebonsma.test',
      displayName: 'Admin Bruker',
      firstName: 'Admin',
      lastName: 'Bruker',
      avatar: null,
      groups: ['tebonsma', 'lldap_admin'],
      createdAt: '2025-01-01T12:00:00Z',
    },
  ],
])

// Tokens only carry the username, so logins survive restarts of this server
const ACCESS_PREFIX = 'mock-access.'
const REFRESH_PREFIX = 'mock-refresh.'
const TOKEN_LIFETIME_SECONDS = 8 * 60 * 60

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

const unsignedJwt = (payload: Record<string, unknown>) => `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`

// Login and logout only ever send the browser back to a site running on this machine
const isLocalUrl = (url: string | undefined): url is string => {
  if (!url || !URL.canParse(url)) return false
  return ['localhost', '127.0.0.1'].includes(new URL(url).hostname)
}

const page = (title: string, body: unknown) => html`<!doctype html>
  <html lang="no">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title}</title>
      <style>
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0a0a; color: #fff; font-family: system-ui, sans-serif; }
        main { width: min(360px, calc(100vw - 32px)); }
        h1 { font-size: 20px; margin: 0 0 4px; }
        p { color: #ffffff99; font-size: 14px; margin: 0 0 20px; }
        a.user { display: block; padding: 12px 14px; margin-bottom: 8px; border: 1px solid #ffffff1a; border-radius: 8px; color: #fff; text-decoration: none; }
        a.user:hover { border-color: #ff8c42; }
        small { display: block; color: #ffffff99; margin-top: 2px; }
      </style>
    </head>
    <body>
      <main>${body}</main>
    </body>
  </html>`

export function startMockAuth(port: number) {
  const issuer = `http://localhost:${port}`
  const app = new Hono()

  app.use('*', cors())

  // --- Authelia: OIDC provider ---

  app.get('/.well-known/openid-configuration', c =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/api/oidc/authorization`,
      token_endpoint: `${issuer}/api/oidc/token`,
      userinfo_endpoint: `${issuer}/api/oidc/userinfo`,
      revocation_endpoint: `${issuer}/api/oidc/revocation`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
    }),
  )

  // The login page: pick who to log in as, no password
  app.get('/api/oidc/authorization', c => {
    const { redirect_uri, state, nonce, client_id } = c.req.query()
    if (!isLocalUrl(redirect_uri)) return c.text('redirect_uri must point to localhost', 400)

    const callbackFor = (username: string) => {
      const url = new URL(redirect_uri)
      url.searchParams.set('code', encode({ username, nonce, client_id }))
      if (state) url.searchParams.set('state', state)
      return url.toString()
    }

    return c.html(
      page(
        'Mock-innlogging',
        html`<h1>Mock-innlogging</h1>
          <p>Lokal utvikling. Velg hvem du vil logge inn som.</p>
          ${[...users].map(
            ([username, user]) =>
              html`<a class="user" href="${callbackFor(username)}">
                ${user.displayName}
                <small>${username} · ${user.groups.join(', ')}</small>
              </a>`,
          )}`,
      ),
    )
  })

  app.post('/api/oidc/token', async c => {
    const form = await c.req.parseBody()
    let username: string | undefined
    let nonce: string | undefined
    let clientId: string | undefined

    if (form.grant_type === 'authorization_code' && typeof form.code === 'string') {
      try {
        ;({ username, nonce, client_id: clientId } = JSON.parse(Buffer.from(form.code, 'base64url').toString()))
      } catch {
        // Falls through to invalid_grant
      }
    } else if (form.grant_type === 'refresh_token' && typeof form.refresh_token === 'string') {
      if (form.refresh_token.startsWith(REFRESH_PREFIX)) username = form.refresh_token.slice(REFRESH_PREFIX.length)
    }
    if (!username || !users.has(username)) return c.json({ error: 'invalid_grant' }, 400)

    const now = Math.floor(Date.now() / 1000)
    return c.json({
      access_token: ACCESS_PREFIX + username,
      refresh_token: REFRESH_PREFIX + username,
      token_type: 'Bearer',
      expires_in: TOKEN_LIFETIME_SECONDS,
      scope: 'openid profile email groups offline_access',
      id_token: unsignedJwt({
        iss: issuer,
        sub: username,
        aud: clientId ?? form.client_id,
        iat: now,
        exp: now + TOKEN_LIFETIME_SECONDS,
        ...(nonce && { nonce }),
      }),
    })
  })

  app.get('/api/oidc/userinfo', c => {
    const token = c.req.header('Authorization')?.match(/^Bearer (.+)$/)?.[1]
    const username = token?.startsWith(ACCESS_PREFIX) ? token.slice(ACCESS_PREFIX.length) : undefined
    const user = username ? users.get(username) : undefined
    if (!user) return c.json({ error: 'invalid_token' }, 401)
    return c.json({
      sub: username,
      preferred_username: username,
      name: user.displayName,
      email: user.email,
      groups: user.groups,
    })
  })

  app.post('/api/oidc/revocation', c => c.json({}))

  // Authelia's portal pages that the site links to
  app.get('/logout', c => {
    const rd = c.req.query('rd')
    return isLocalUrl(rd) ? c.redirect(rd) : c.html(page('Logget ut', html`<h1>Logget ut</h1>`))
  })

  app.get('/settings/security', c =>
    c.html(
      page(
        'Mock-innlogging',
        html`<h1>Bytt passord</h1>
          <p>Mock-brukerne har ikke passord. På tebonsma.no åpnes Authelia sin side her.</p>`,
      ),
    ),
  )

  // --- LLDAP: user directory ---

  app.post('/auth/simple/login', c =>
    c.json({ token: unsignedJwt({ exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60 }) }),
  )

  // Answers the operations in src/lldap.ts by name. Anything else is an error, so a new LLDAP
  // call in the API shows up here instead of quietly getting a wrong answer.
  app.post('/api/graphql', async c => {
    const { query = '', variables = {} } = (await c.req.json()) as {
      query?: string
      variables?: {
        id?: string
        user?: {
          id: string
          displayName?: string
          insertAttributes?: { name: string; value: string[] }[]
          removeAttributes?: string[]
        }
      }
    }
    const operation = query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1]
    // Every account, like LLDAP's own admin and the API's service account in the real directory
    if (operation === 'Users') {
      return c.json({ data: { users: [...users.keys(), 'mock'].map(id => ({ id })) } })
    }
    if (operation !== 'User' && operation !== 'Update') {
      return c.json({
        errors: [{ message: `The mock LLDAP does not know the operation '${operation ?? 'unnamed'}'. Add it to dev/mock-auth.ts.` }],
      })
    }

    const username = (operation === 'Update' ? variables.user?.id : variables.id) ?? ''
    const user = users.get(username)
    if (!user) return c.json({ errors: [{ message: `Entity not found: \`No such user: '${username}'\`` }] })

    if (operation === 'Update' && variables.user) {
      const { displayName, insertAttributes = [], removeAttributes = [] } = variables.user
      const attributes = { first_name: 'firstName', last_name: 'lastName', avatar: 'avatar' } as const
      const isKnown = (name: string): name is keyof typeof attributes => name in attributes

      if (displayName !== undefined) user.displayName = displayName
      for (const { name, value } of insertAttributes) if (isKnown(name)) user[attributes[name]] = value[0]
      for (const name of removeAttributes) {
        if (name === 'avatar') user.avatar = null
        else if (isKnown(name)) user[attributes[name]] = ''
      }
      return c.json({ data: { updateUser: { ok: true } } })
    }

    return c.json({
      data: {
        user: {
          id: username,
          email: user.email,
          displayName: user.displayName,
          firstName: user.firstName,
          lastName: user.lastName,
          avatar: user.avatar,
          creationDate: user.createdAt,
          groups: user.groups.map(displayName => ({ displayName })),
        },
      },
    })
  })

  // Loopback only, since anyone who can reach this can log in as anyone
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
    console.log(`mock auth (Authelia + LLDAP) listening on ${issuer}, users: ${[...users.keys()].join(', ')}`)
  })

  return issuer
}
