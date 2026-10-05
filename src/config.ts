const required = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? 'https://tebonsma.no')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
  // Where the site is, for links back to it from calendars
  siteUrl: (process.env.SITE_URL ?? 'https://tebonsma.no').replace(/\/$/, ''),
  userinfoUrl: process.env.OIDC_USERINFO_URL ?? 'https://auth.tebonsma.no/api/oidc/userinfo',
  dataDir: process.env.DATA_DIR ?? './data',
  // Members of this group can pin posts, handle reports and remove other members' posts
  adminGroup: process.env.ADMIN_GROUP ?? 'lldap_admin',
  // The members of TEBONSMA, as opposed to other accounts in the directory
  memberGroup: process.env.MEMBER_GROUP ?? 'medlemmer',
  lldap: {
    url: (process.env.LLDAP_URL ?? 'http://lldap:17170').replace(/\/$/, ''),
    username: required('LLDAP_USERNAME'),
    password: required('LLDAP_PASSWORD'),
  },
}
