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
  userinfoUrl: process.env.OIDC_USERINFO_URL ?? 'https://auth.tebonsma.no/api/oidc/userinfo',
  lldap: {
    url: (process.env.LLDAP_URL ?? 'http://lldap:17170').replace(/\/$/, ''),
    username: required('LLDAP_USERNAME'),
    password: required('LLDAP_PASSWORD'),
  },
}
