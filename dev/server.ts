import { rmSync } from 'node:fs'
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
// The site and TebBet (bet.tebonsma.no) on their own dev ports
process.env.ALLOWED_ORIGINS ??= 'http://localhost:5173,http://localhost:5174'

// Like the mock users' profiles, the scoreboard starts empty on every restart
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = './data/mock'
  rmSync(process.env.DATA_DIR, { recursive: true, force: true })
}

await import('../src/server.ts')

// npm run dev:mock:demo: example events with TebBet markets
if (process.argv.includes('--demo')) await import('./demo.ts')
