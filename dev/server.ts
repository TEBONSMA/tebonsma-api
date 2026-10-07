import { rmSync } from 'node:fs'
import { useBackend } from '../src/mail/backend.ts'
import { mockMail } from './mock-mail.ts'
import { mockPush } from './mock-push.ts'
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
process.env.SITE_URL ??= 'http://localhost:5173'
// The bot reads the news and ESPN; only with --bots
if (!process.argv.includes('--bots')) process.env.BOTS ??= 'off'
// The site and TebBet (bet.tebonsma.no) on their own dev ports
process.env.ALLOWED_ORIGINS ??= 'http://localhost:5173,http://localhost:5174'
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

// Push: without keys of its own, each run gets a fresh pair so the sites can turn notifications
// on, and pushes are printed instead of sent. With VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY set,
// they really go out.
if (!process.env.VAPID_PUBLIC_KEY) {
  const { default: webpush } = await import('web-push')
  const keys = webpush.generateVAPIDKeys()
  process.env.VAPID_PUBLIC_KEY = keys.publicKey
  process.env.VAPID_PRIVATE_KEY = keys.privateKey
  const { usePushSender } = await import('../src/push.ts')
  usePushSender(mockPush)
}

await import('../src/server.ts')

// npm run dev:mock:demo: example events with TebBet markets
if (process.argv.includes('--demo')) await import('./demo.ts')
