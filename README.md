# tebonsma-api

Small API behind `https://api.tebonsma.no` that lets logged-in members edit their own
account from `tebonsma.no/konto`.

- **Login check:** the site sends its Authelia access token as `Authorization: Bearer …`.
  The API asks Authelia's userinfo endpoint who it belongs to. The account being changed is
  always that user's own; it never comes from the request body.
- **LLDAP:** updates go through LLDAP's GraphQL API as a service account.
- **Not editable here:** email is the mail login (Dovecot matches on the LLDAP `mail`
  attribute), so only admins change it. Passwords are changed on Authelia's settings page.

| Method | Path | Does |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/me` | Own profile: username, email, names, avatar, groups |
| PATCH | `/me` | Update `displayName`, `firstName`, `lastName` |
| PUT | `/me/avatar` | Set profile picture, body `{ "image": "<base64 JPEG>" }` |
| DELETE | `/me/avatar` | Remove profile picture |

## Running on bbot

Lives in `/opt/tebonsma-api`, on the `lldap_default` Docker network so both LLDAP and the
`konto-tebonsma` Cloudflare tunnel (route `api.tebonsma.no` → `http://tebonsma-api:8080`)
can reach it.

1. In LLDAP, create a user `tebonsma-api` and add it to `lldap_admin`.
2. Copy `.env.example` to `.env` and fill in that user's password.
3. `docker compose up -d --build`

### Deploying changes

From this folder, copy the code over (never `.env`, which only lives on bbot) and rebuild:

```bash
tar --exclude=node_modules --exclude=.env --exclude=.git -cf - . | ssh andersgar@bbot 'rm -rf ~/tebonsma-api-src && mkdir ~/tebonsma-api-src && tar -C ~/tebonsma-api-src -xf - && sudo cp -r ~/tebonsma-api-src/. /opt/tebonsma-api/ && rm -rf ~/tebonsma-api-src && cd /opt/tebonsma-api && sudo docker compose up -d --build'
```

The site that uses this API is in `TEBONSMA/Tebonsma.no` (page `/konto`).
