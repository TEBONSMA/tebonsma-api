import { rmSync } from 'node:fs'
import { useBackend } from '../src/mail/backend.ts'
import { mockMail } from './mock-mail.ts'
import { startMockAuth } from './mock-auth.ts'

// Local development entry point (npm run dev:mock): starts the mock login provider and
// user directory, then the real API pointed at them. The code in src/ runs unchanged.

if (process.env.NODE_ENV === 'production') {
  throw new Error('The mock auth server must not run in production')
}

const mockUrl = startMockAuth(Number(process.env.MOCK_AUTH_PORT ?? 9091))

// Not 8080: other local software often has it, and a browser may reach that instead of the API
process.env.PORT ??= '8787'
process.env.OIDC_USERINFO_URL ??= `${mockUrl}/api/oidc/userinfo`
process.env.LLDAP_URL ??= mockUrl
process.env.LLDAP_USERNAME ??= 'mock'
process.env.LLDAP_PASSWORD ??= 'mock'
process.env.ALLOWED_ORIGINS ??= 'http://localhost:5173'
// Send later talks to the mock login server, which gives out tokens to anyone
process.env.MAIL_OFFLINE_CLIENT_ID ??= 'tebonsma-mail'
process.env.MAIL_OFFLINE_CLIENT_SECRET ??= 'mock'
process.env.MAIL_OFFLINE_KEY ??= '6d6f636b2d6b65792d666f722d6c6f63616c2d646576656c6f706d656e742d6f6e6c79'.slice(0, 64)

// Like the mock users' profiles, the scoreboard starts empty on every restart
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = './data/mock'
  rmSync(process.env.DATA_DIR, { recursive: true, force: true })
}

// Mail lives in memory too, so no mail server is needed
useBackend(mockMail)

await import('../src/server.ts')
