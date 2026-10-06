const required = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

// Send later needs the API to get new access tokens for a member who has said yes, through a client of its
// own at the login provider. Without all three settings the feature is off.
function offlineConfig(userinfoUrl: string, redirectOrigin: string) {
  const clientId = process.env.MAIL_OFFLINE_CLIENT_ID
  const clientSecret = process.env.MAIL_OFFLINE_CLIENT_SECRET
  const rawKey = process.env.MAIL_OFFLINE_KEY
  if (!clientId || !clientSecret || !rawKey) return null

  const key = /^[0-9a-f]{64}$/i.test(rawKey) ? Buffer.from(rawKey, 'hex') : Buffer.from(rawKey, 'base64')
  if (key.length !== 32) throw new Error('MAIL_OFFLINE_KEY must be 32 bytes, written as 64 hex characters or as base64')
  const provider = new URL(userinfoUrl).origin
  return {
    clientId,
    clientSecret,
    key,
    authorizeUrl: process.env.MAIL_OFFLINE_AUTHORIZE_URL ?? `${provider}/api/oidc/authorization`,
    tokenUrl: process.env.MAIL_OFFLINE_TOKEN_URL ?? `${provider}/api/oidc/token`,
    revokeUrl: process.env.MAIL_OFFLINE_REVOKE_URL ?? `${provider}/api/oidc/revocation`,
    redirectUri: process.env.MAIL_OFFLINE_REDIRECT_URI ?? `${redirectOrigin}/mail/tillatelse`,
  }
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'https://tebonsma.no')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)
const userinfoUrl = process.env.OIDC_USERINFO_URL ?? 'https://auth.tebonsma.no/api/oidc/userinfo'

export const config = {
  port: Number(process.env.PORT ?? 8080),
  allowedOrigins,
  userinfoUrl,
  // Where the site is, for links back to it from calendars
  siteUrl: (process.env.SITE_URL ?? 'https://tebonsma.no').replace(/\/$/, ''),
  dataDir: process.env.DATA_DIR ?? './data',
  // Members of this group can pin posts, handle reports and remove other members' posts
  adminGroup: process.env.ADMIN_GROUP ?? 'lldap_admin',
  // The members of TEBONSMA, as opposed to other accounts in the directory
  memberGroup: process.env.MEMBER_GROUP ?? 'medlemmer',
  // Members' mailboxes. The API logs in as the member with their own access token (XOAUTH2).
  mail: {
    imapHost: process.env.MAIL_IMAP_HOST ?? 'mail.tebonsma.no',
    imapPort: Number(process.env.MAIL_IMAP_PORT ?? 993),
    smtpHost: process.env.MAIL_SMTP_HOST ?? 'mail.tebonsma.no',
    smtpPort: Number(process.env.MAIL_SMTP_PORT ?? 465),
    sieveHost: process.env.MAIL_SIEVE_HOST ?? 'mail.tebonsma.no',
    sievePort: Number(process.env.MAIL_SIEVE_PORT ?? 4190),
    offline: offlineConfig(userinfoUrl, allowedOrigins[0] ?? 'https://tebonsma.no'),
  },
  lldap: {
    url: (process.env.LLDAP_URL ?? 'http://lldap:17170').replace(/\/$/, ''),
    username: required('LLDAP_USERNAME'),
    password: required('LLDAP_PASSWORD'),
  },
}
