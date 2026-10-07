import { config } from './config.ts'

export interface Profile {
  username: string
  email: string
  displayName: string
  firstName: string
  lastName: string
  avatar: string | null
  groups: string[]
  createdAt: string
}

export interface ProfileChanges {
  displayName?: string
  firstName?: string
  lastName?: string
}

// The service account's JWT, reused until shortly before it expires
let session: { token: string; expiresAt: number } | null = null

async function login() {
  const res = await fetch(`${config.lldap.url}/auth/simple/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.lldap.username, password: config.lldap.password }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`LLDAP login failed with HTTP ${res.status}`)
  const { token } = (await res.json()) as { token: string }
  const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { exp: number }
  session = { token, expiresAt: exp * 1000 }
  return token
}

async function serviceToken() {
  if (session && session.expiresAt - Date.now() > 60_000) return session.token
  return login()
}

async function graphql<T>(query: string, variables: Record<string, unknown>, retried = false): Promise<T> {
  const res = await fetch(`${config.lldap.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await serviceToken()}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 401 && !retried) {
    session = null
    return graphql(query, variables, true)
  }
  if (!res.ok) throw new Error(`LLDAP GraphQL returned HTTP ${res.status}`)
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
  // A token keeps the group memberships from when it was issued, so log in again once
  // in case the service account was added to lldap_admin after that
  if (!retried && body.errors?.some(e => /unauthorized/i.test(e.message))) {
    session = null
    return graphql(query, variables, true)
  }
  if (body.errors?.length) throw new Error(`LLDAP GraphQL error: ${body.errors.map(e => e.message).join('; ')}`)
  return body.data as T
}

const USER_QUERY = `
  query User($id: String!) {
    user(userId: $id) {
      id email displayName firstName lastName avatar creationDate
      groups { displayName }
    }
  }
`

const USERS_QUERY = `
  query Users {
    users {
      id email displayName firstName lastName avatar creationDate
      groups { displayName }
    }
  }
`

const MEMBERS_QUERY = `
  query Members($group: String!) {
    users(filters: { memberOf: $group }) { id }
  }
`

const UPDATE_MUTATION = `
  mutation Update($user: UpdateUserInput!) {
    updateUser(user: $user) { ok }
  }
`

export async function getProfile(username: string): Promise<Profile> {
  const { user } = await graphql<{
    user: {
      id: string
      email: string
      displayName: string
      firstName: string
      lastName: string
      avatar: string | null
      creationDate: string
      groups: { displayName: string }[]
    }
  }>(USER_QUERY, { id: username })

  return {
    username: user.id,
    email: user.email,
    displayName: user.displayName,
    firstName: user.firstName,
    lastName: user.lastName,
    avatar: user.avatar || null,
    groups: user.groups.map(g => g.displayName),
    createdAt: user.creationDate,
  }
}

export async function listUsers(): Promise<Profile[]> {
  const { users } = await graphql<{
    users: {
      id: string
      email: string
      displayName: string
      firstName: string
      lastName: string
      avatar: string | null
      creationDate: string
      groups: { displayName: string }[]
    }[]
  }>(USERS_QUERY, {})

  return users.map(user => ({
    username: user.id,
    email: user.email,
    displayName: user.displayName,
    firstName: user.firstName,
    lastName: user.lastName,
    avatar: user.avatar || null,
    groups: user.groups.map(g => g.displayName),
    createdAt: user.creationDate,
  }))
}

// The usernames of everyone in a group
export async function listGroupMembers(group: string) {
  const { users } = await graphql<{ users: { id: string }[] }>(MEMBERS_QUERY, { group })
  return users.map(user => user.id)
}

export async function updateProfile(username: string, changes: ProfileChanges) {
  const insertAttributes: { name: string; value: string[] }[] = []
  const removeAttributes: string[] = []
  // Names are attributes in LLDAP 0.6; an empty value clears the attribute
  for (const [field, attribute] of [['firstName', 'first_name'], ['lastName', 'last_name']] as const) {
    const value = changes[field]
    if (value === undefined) continue
    if (value) insertAttributes.push({ name: attribute, value: [value] })
    else removeAttributes.push(attribute)
  }

  await graphql(UPDATE_MUTATION, {
    user: {
      id: username,
      ...(changes.displayName !== undefined && { displayName: changes.displayName }),
      insertAttributes,
      removeAttributes,
    },
  })
}

export async function setAvatar(username: string, jpegBase64: string | null) {
  await graphql(UPDATE_MUTATION, {
    user: jpegBase64
      ? { id: username, insertAttributes: [{ name: 'avatar', value: [jpegBase64] }] }
      : { id: username, removeAttributes: ['avatar'] },
  })
}
