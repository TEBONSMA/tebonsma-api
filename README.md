# tebonsma-api

Small HTTP API for tebonsma.no. It lets logged-in members view and edit their own account
in LLDAP (the site's `/konto` page), keeps the scoreboards for the site's games, and runs
the news feed (`/feed`).

## How it works

- **Who is calling:** clients send the access token from their OIDC login as
  `Authorization: Bearer <token>`. The API asks the provider's userinfo endpoint who the
  token belongs to (`preferred_username`) and caches the answer for 60 seconds.
- **What it changes:** that user's own entry in LLDAP, through LLDAP's GraphQL API, logged
  in as a service account. The account being changed always comes from the token, never
  from the request body.
- **What it won't change:** only display name, first and last name, and profile picture
  are editable. Email is left alone because it doubles as the mail login, and passwords
  are changed through the login provider.

| Method | Path | Does |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/me` | Own profile: username, email, names, avatar, groups |
| PATCH | `/me` | Update `displayName`, `firstName`, `lastName` |
| PUT | `/me/avatar` | Set profile picture, body `{ "image": "<base64 JPEG>" }`, max 512 KB |
| DELETE | `/me/avatar` | Remove profile picture |
| POST | `/games/:game/runs` | Start a game run, returns `{ "runId": "…" }` |
| POST | `/games/:game/scores` | Submit a finished run, body `{ "runId": "…", "score": 12 }` |
| GET | `/games/:game/leaderboard` | Top 5, plus the caller's own best and rank |

`:game` is the game's slug on the site: `flappy-teb`, `snake-teb` or `2048-teb`. The older
`/flappy/runs`, `/flappy/scores` and `/flappy/leaderboard` still work and mean `flappy-teb`.

### News feed

Members write posts with text, pictures, files and an optional poll, and choose for each
post whether everyone can see it or only logged-in members. The read endpoints work without
a login and then return only public posts; everything else needs a member's token.

| Method | Path | Does |
|---|---|---|
| GET | `/feed/posts?sort=&offset=&limit=` | A page of posts, pinned ones first. `sort` is `new`, `old`, `likes` or `comments` |
| GET | `/feed/posts/:id` | One post |
| POST | `/feed/posts` | Write a post: `{ body, visibility, attachmentIds, pollOptions }` |
| PATCH | `/feed/posts/:id` | Edit own post: `{ body, visibility, attachmentIds }` |
| DELETE | `/feed/posts/:id` | Delete own post (admins: any post) |
| PUT, DELETE | `/feed/posts/:id/like` | Like or unlike |
| GET | `/feed/posts/:id/likes` | Who liked it |
| PUT | `/feed/posts/:id/vote` | Vote in the poll: `{ optionId }`, or `null` to take the vote back |
| PUT, DELETE | `/feed/posts/:id/pin` | Pin to the top or unpin (admins) |
| POST | `/feed/posts/:id/report` | Report a post: `{ reason }` |
| GET | `/feed/reports` | Reported posts (admins) |
| DELETE | `/feed/posts/:id/reports` | Dismiss the reports on a post (admins) |
| GET | `/feed/posts/:id/comments` | Comments, oldest first; replies carry `parentId` |
| POST | `/feed/posts/:id/comments` | Comment: `{ body, parentId }` |
| DELETE | `/feed/comments/:id` | Delete own comment (admins: any comment) |
| PUT, DELETE | `/feed/comments/:id/like` | Like or unlike a comment |
| GET | `/feed/comments/:id/likes` | Who liked the comment |
| POST | `/feed/attachments` | Upload a file (multipart field `file`, max 10 MB) to attach to a post |
| GET | `/feed/attachments/:id` | The file. Needs a login unless its post is public |
| GET | `/members/:id/avatar` | Profile picture of a feed author |
| GET | `/notifications` | Own notifications and the number of unread ones |
| POST | `/notifications/read` | Mark as read: `{ ids }`, or everything without `ids` |

- **Admins** are members of the `ADMIN_GROUP` group. Only they can pin posts and see
  reports, and they can delete other members' posts and comments.
- **Names and pictures** come from LLDAP and are copied to the database for up to ten
  minutes. Members are identified by a random id in the feed, never by username.
- **Notifications** are made when someone comments on your post or replies to your comment.
- **Files** are stored in the database. JPEG, PNG, GIF and WebP are shown as pictures;
  anything else is only offered as a download. An upload that isn't put in a post within a
  day is deleted. A poll can't be changed once the post is published.

### Game scoreboards

Each game has its own scoreboard, and each member has one entry per game: their best score
and the date they set it. The site fetches a run ticket when a game starts and submits the
score with it when the game ends. A ticket can be used once, only by the member and for the
game it was issued to, and the score has to be possible in the time since the ticket was
issued:

| Game | Most points possible |
|---|---|
| `flappy-teb` | 0.6 per second (a pipe at most every 100 steps at 60 steps per second) |
| `snake-teb` | 7.5 per second (a move at most every 8 frames, one bottle per move) |
| `2048-teb` | what 15 moves per second could earn by merging the tiles they add |

This stops casual cheating, not a determined player. To add a game, give it an entry in
`GAMES` in `src/scoreboard.ts`. Scores live in a SQLite database in `DATA_DIR`.

## Requirements

- Node.js 22.18 or newer, which runs the TypeScript sources directly (no build step), or Docker.
- An OIDC provider whose userinfo endpoint returns `preferred_username`, and optionally
  `groups`. Tested with Authelia 4.39.
- LLDAP 0.6 or newer, with a service account in the `lldap_admin` group. Admin rights are
  needed to edit other users' entries.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `LLDAP_USERNAME` | required | Service account username |
| `LLDAP_PASSWORD` | required | Service account password |
| `LLDAP_URL` | `http://lldap:17170` | LLDAP's HTTP address |
| `OIDC_USERINFO_URL` | `https://auth.tebonsma.no/api/oidc/userinfo` | Where tokens are checked |
| `ALLOWED_ORIGINS` | `https://tebonsma.no` | Comma-separated sites allowed to call the API (CORS) |
| `PORT` | `8080` | Port to listen on |
| `DATA_DIR` | `./data` (`/app/data` in Docker) | Folder for the SQLite database |
| `ADMIN_GROUP` | `lldap_admin` | Group whose members moderate the feed |

Put the credentials in `.env` (see `.env.example`). It is git-ignored and should never be
committed.

## Running with Docker Compose

1. In LLDAP, create the service account and add it to `lldap_admin`.
2. Copy `.env.example` to `.env` and fill in the password.
3. Check `docker-compose.yaml`. It joins an existing Docker network (`lldap_default`) so it
   can reach LLDAP by container name, and sets the URLs for tebonsma.no. Change these to
   match your setup.
4. Start it:

   ```bash
   docker compose up -d --build
   ```

The container doesn't publish a port. Put it behind a reverse proxy or tunnel that serves
it over HTTPS. The image has a healthcheck on `/health`.

The database, with the scoreboards and the feed and its files, is kept in the `data` volume,
so it survives rebuilds. To back it up, copy `tebonsma.db` out of that volume.

To update, get the new code in place and run `docker compose up -d --build` again. `.env`
and the data volume are left untouched.

## Running locally

```bash
npm install
```

Set the variables from the table in your shell, then start it. It restarts on file changes:

```bash
npm run dev
```

`npm run typecheck` checks types without running anything.

### Without Authelia and LLDAP (mock auth)

```bash
npm run dev:mock
```

This starts the API on port 8787 together with a mock server on `http://localhost:9091`
that stands in for both Authelia and LLDAP, so no credentials or environment variables are
needed. The API code in `src/` runs unchanged; it is only pointed at the mock. The port is
not 8080 because other local software often uses that, and the browser may then reach it
instead of the API. Set `PORT` to use another one, and `VITE_API_URL` in the site to match.

The mock's login page has no passwords. You pick who to log in as:

| User | Groups | For testing |
|---|---|---|
| `dev` | `tebonsma` | An ordinary member |
| `admin` | `tebonsma`, `lldap_admin` | What admins see |

Profile edits, scores and the feed are reset when the server restarts, which also happens
when you save a file. They are kept in `./data/mock` while it runs; set `DATA_DIR` to
keep scores and the feed between restarts. Add or change users in `dev/mock-auth.ts`.

To use it from the site, run `npm run dev:mock` in the Tebonsma.no repo's `teb-app` folder
as well. To call the API directly, the access token is `mock-access.<username>`:

```bash
curl -H "Authorization: Bearer mock-access.dev" http://localhost:8787/me
```

The mock lives in `dev/`, which is not copied into the Docker image. It only listens on
127.0.0.1 and refuses to start when `NODE_ENV` is `production`. Its user directory only
answers the GraphQL operations the API uses today (`User` and `Update`); a new one returns
an error until it is added to `dev/mock-auth.ts`.

## Security

- The service account is an LLDAP admin, so keep `.env` private. The API only exposes the
  self-service endpoints above; don't add endpoints that act on other users.
- Any valid access token from the OIDC provider is accepted, so only register clients
  there that you trust.
