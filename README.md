# tebonsma-api

Small HTTP API for tebonsma.no. It lets logged-in members view and edit their own account
in LLDAP (the site's `/konto` page), keeps the scoreboards for the site's games, runs
the news feed (`/feed`), and is the back end of the webmail on the site (`/mail`).

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
| POST | `/feed/posts` | Write a post: `{ body, visibility, attachmentIds, pollOptions }`. With `event: { title, location, startsAt, endsAt }` the post is an event, and every member is notified |
| PATCH | `/feed/posts/:id` | Edit own post: `{ body, visibility, attachmentIds }`, and `event` when it is one |
| DELETE | `/feed/posts/:id` | Delete own post (admins: any post) |
| PUT, DELETE | `/feed/posts/:id/like` | Like or unlike |
| GET | `/feed/posts/:id/likes` | Who liked it |
| PUT | `/feed/posts/:id/vote` | Vote in the poll: `{ optionId }`, or `null` to take the vote back |
| PUT, DELETE | `/feed/posts/:id/pin` | Pin to the top or unpin (admins) |
| POST | `/feed/posts/:id/report` | Report a post: `{ reason }` |
| GET | `/feed/reports` | Reported posts (admins) |
| DELETE | `/feed/posts/:id/reports` | Dismiss the reports on a post (admins) |
| GET | `/feed/posts/:id/comments` | Comments, oldest first; replies carry `parentId` |
| POST | `/feed/posts/:id/comments` | Comment: `{ body, parentId, attachmentIds }`, with up to 4 files |
| DELETE | `/feed/comments/:id` | Delete own comment (admins: any comment) |
| PUT, DELETE | `/feed/comments/:id/like` | Like or unlike a comment |
| GET | `/feed/comments/:id/likes` | Who liked the comment |
| POST | `/feed/attachments` | Upload a file (multipart field `file`, max 10 MB) to attach to a post or comment |
| GET | `/feed/attachments/:id` | The file. Needs a login unless its post is public |
| GET | `/members/:id/avatar` | Profile picture of a feed author |
| GET | `/notifications` | Own notifications and the number of unread ones |
| POST | `/notifications/read` | Mark as read: `{ ids }`, or everything without `ids` |
| GET | `/events?from=&to=` | Events in the order they take place, the ones without a date last. Visitors get the public ones |
| PUT | `/events/:id/rsvp` | Answer a closed (`members`) event: `{ answer }` is `yes`, `no`, or `null` to take it back |
| GET | `/events/:id/rsvps` | Who answered what |
| POST | `/events/:id/announcements` | Message from the organizer to every member: `{ body }` |

- **Admins** are members of the `ADMIN_GROUP` group. Only they can pin posts and see
  reports, and they can delete other members' posts and comments.
- **Names and pictures** come from LLDAP and are copied to the database for up to ten
  minutes. Members are identified by a random id in the feed, never by username.
- **Notifications** are made when someone comments on your post or replies to your comment.
  A new event, and a message from its organizer, is a notification for every other member.
- **Events** are posts with a title, a place and a time, so they are seen, commented on,
  edited and deleted like any post. Only closed (`members`) events have sign-up, and it
  closes when the event is over. Whether an event is planned, on or done follows from its
  times and isn't stored.
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

### Mail

Members read and write the mail in their own `@tebonsma.no` mailbox on the site. The API
is not a mail server: it talks to the one that is already there, Dovecot for reading and
filing mail and Postfix for sending, and it does so **as the member**, logging in to their
mailbox with the same access token the member uses for everything else (OAuth2, `XOAUTH2`).
Dovecot checks the token with the login provider, so these are the same LLDAP accounts as
before. The API never sees a password, and no master account exists. It can only open a
mailbox while the member is logged in on the site, or has given the permission described
under "Sending later".

Everything below needs a login. `:id` is a mail's id in the API (its folder, the folder's
UID validity and its UID, so an id stops working if the server rebuilds the folder).
Everything that changes mail takes a list of ids, so one mail and a selection are the same call.

| Method | Path | Does |
|---|---|---|
| GET | `/mail/folders` | Folders with unread counts, the member's labels, and the count of shared mail |
| POST | `/mail/folders` | New folder: `{ name }` |
| GET | `/mail/messages?folder=&q=&from=&to=&subject=&unread=&flagged=&attachment=&label=&since=&before=&sort=&offset=&limit=` | A page of mail. `folder` is a folder key (`inbox`, `sent`, `drafts`, `archive`, `junk`, `trash`, `snoozed`, `scheduled`, or one of the member's own), or `all`, `favorites`, `unread` or `shared`. `sort` is `new`, `old`, `sender`, `subject` or `size` |
| GET | `/mail/messages/:id` | One mail, cleaned for showing (marks it as read). `?images=1` keeps pictures from other sites |
| GET | `/mail/threads/:id` | The whole conversation the mail is part of, oldest first (marks it as read) |
| GET | `/mail/messages/:id/attachments/:n` | An attachment |
| GET | `/mail/messages/:id/compose?mode=` | What a new mail starts with: `reply`, `replyAll`, `forward` or `draft` |
| POST | `/mail/messages/flags` | `{ ids, seen?, flagged? }` |
| POST | `/mail/messages/labels` | `{ ids, add, remove }` |
| POST | `/mail/messages/move` | `{ ids, folder }`, or `{ ids, restore: true }` for mail in the bin |
| POST | `/mail/messages/snooze` | `{ ids, until }`, where `until: null` takes snoozing off |
| POST | `/mail/messages/delete` | Delete for good (only from the bin) |
| POST | `/mail/trash/empty` | Empty the bin |
| GET, POST, PATCH, DELETE | `/mail/labels[/:id]` | Labels: a name and a colour |
| POST | `/mail/uploads` | Attach a file to a mail being written (multipart field `file`, up to 25 MB) |
| GET, DELETE | `/mail/uploads/:id` | Read or remove such a file |
| PUT, DELETE | `/mail/drafts/:id` | Save or discard a draft. The id is made by the site |
| POST | `/mail/send` | `{ to, cc, bcc, subject, html, uploadIds, draftId?, replyTo?, forwardOf?, threading?, sendAt? }`. Each recipient is an address or `{ memberId }`. Returns `{ outboxId, sendAt, draftId }`, or `{ scheduledId, sendAt }` when `sendAt` is given |
| DELETE | `/mail/outbox/:id` | Take sending back while there is still time |
| PATCH, DELETE | `/mail/scheduled/:id` | New time for a scheduled mail, or take it back to Drafts. `:id` is its id in the Scheduled folder |
| GET, DELETE | `/mail/offline` | Whether the member has given the permission for sending later, or take it back |
| POST | `/mail/offline/start`, `/mail/offline/callback` | Give the permission (see below) |
| GET, PUT | `/mail/auto-reply` | The auto-reply |
| GET, PUT | `/mail/settings` | `{ signature, undoSeconds, conversations }` |
| POST | `/mail/messages/:id/share/member` | Share a copy with a member: `{ memberId, note }` |
| POST | `/mail/messages/:id/share/feed` | Quote the mail in a feed post: `{ comment, visibility }` |
| GET, DELETE | `/mail/shared[/:id]`, `/mail/shared/:id/attachments/:n` | Mail others have shared with the member |
| POST | `/mail/shared/delete` | `{ ids }` |
| GET | `/members` | Everyone with an account, as random id, name and picture. Never usernames or addresses |
| GET | `/notifications` | Also returns `mailUnread`, and notifications about new mail (`mail`), shared mail (`mail_share`) and scheduled mail that could not be sent (`mail_failed`) |

- **Folders:** the standard ones are found through the server's special-use flags, or by
  name, and made when they are first needed. Snoozed and Scheduled are folders of our own.
- **Labels** are a keyword on the mail on the server (`$teb_<id>`), so other mail clients see
  them. Names and colours only exist here.
- **Reading** cleans every mail: no script, forms, frames or event handlers. Pictures from
  other sites are left out until the member asks for them, since loading them tells the
  sender the mail was opened. Pictures that came with the mail are shown. The site shows it
  in a sandboxed frame as a second wall.
- **Writing** is rich text (paragraphs, bold, italic, underline, lists, quotes, links). The
  HTML is cleaned again before sending, and every mail also gets a plain text version.
  Subjects can't carry line breaks, a mail has at most 50 recipients, and a member can send
  60 mails an hour. Blind copy is kept in the saved copy, never on what is sent.
- **Conversations** are put together here from the mails' own `Message-ID`, `In-Reply-To` and
  `References`, so they also work across folders (the replies in Sent). Replies with the same
  subject within 30 days count as one conversation even when the references are missing.
- **Snoozing** moves the mail to a folder and brings it back to the inbox, unread, at the
  time. The server has no timer for that, so it happens when the member is on the site, or
  at the time for members who gave the permission below.
- **The auto-reply** is a Sieve script (`tebonsma`) on the mail server, so it answers while
  the member is logged out. Its settings are written in a comment at the top of the script.
  If the member already had another active script, ours includes it, so their filters keep
  working, and it is brought back when the auto-reply is turned off.
- **Sharing** takes a copy of the mail (cleaned text, files and headers) into this API's
  database. The API can't write in anyone else's mailbox, so the member it is shared with
  sees the copy under "Delt med meg" and not as a mail of their own. Sharing to the feed
  quotes the mail in a post and copies its files, as far as the feed's limits allow.

#### Sending later

A mail that is to go at a certain time waits in the Scheduled folder on the mail server, where
other mail clients see it too, and a timer in the API sends it at the time. That means the API
needs a token for the member when they are not on the site, which is the one place the API
keeps a secret for a member:

- The member says yes once (`POST /mail/offline/start`, which gives an address at the login
  provider, and `/mail/offline/callback` when they come back). It uses a client of its own at
  the login provider, so it doesn't touch the refresh token the browser holds.
- The refresh token is stored encrypted (AES-256-GCM) with `MAIL_OFFLINE_KEY`, only for
  members who said yes, and is deleted when they take the permission back
  (`DELETE /mail/offline`) or the provider refuses it.
- If a scheduled mail can't be sent (the permission is gone, the mail server refuses it, or
  the hour's limit is used up) it goes to Drafts and the member gets a notification. It is
  never dropped quietly.

Without the three `MAIL_OFFLINE_*` variables the feature is off, and the rest of the mail works.

#### What the mail server needs

This is set up on the server, not in this repository:

1. **Dovecot:** an extra `passdb { driver = oauth2 }` next to the LDAP one, with
   `introspection_mode = auth`, `introspection_url = https://auth.tebonsma.no/api/oidc/userinfo`
   and `username_attribute` set to the field that matches the mail login (`email` or
   `preferred_username`). `auth_mechanisms` also gets `oauthbearer xoauth2`.
2. **Postfix** sends through Dovecot SASL on port 465, so sending comes with it. Check that
   `xoauth2` is offered in EHLO.
3. **Pigeonhole / ManageSieve** (port 4190) on, reachable from the API container, with the same
   oauth2 passdb. The API connects in plain text and switches to TLS with STARTTLS before it
   sends the token.
4. The API container must reach `mail.tebonsma.no` on ports 993, 465 and 4190.
5. For sending later: a confidential OIDC client in Authelia (for example `tebonsma-mail`) with
   the `authorization_code` and `refresh_token` grants, the scopes `openid profile email groups
   offline_access`, and `https://tebonsma.no/mail/tillatelse` as redirect URI. Its id and
   secret, and a 32-byte key, go in `.env`.

## Requirements

- Node.js 22.18 or newer, which runs the TypeScript sources directly (no build step), or Docker.
- An OIDC provider whose userinfo endpoint returns `preferred_username`, and optionally
  `groups`. Tested with Authelia 4.39.
- LLDAP 0.6 or newer, with a service account in the `lldap_admin` group. Admin rights are
  needed to edit other users' entries.
- For mail: Dovecot, Postfix and ManageSieve set up as described under "What the mail server needs".

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
| `MAIL_IMAP_HOST`, `MAIL_IMAP_PORT` | `mail.tebonsma.no`, `993` | Where mail is read (TLS from the start) |
| `MAIL_SMTP_HOST`, `MAIL_SMTP_PORT` | `mail.tebonsma.no`, `465` | Where mail is sent |
| `MAIL_SIEVE_HOST`, `MAIL_SIEVE_PORT` | `mail.tebonsma.no`, `4190` | ManageSieve, for the auto-reply |
| `MAIL_OFFLINE_CLIENT_ID` | none | Client id at the login provider, for sending later |
| `MAIL_OFFLINE_CLIENT_SECRET` | none | Its secret |
| `MAIL_OFFLINE_KEY` | none | 32-byte key (64 hex characters or base64) that stored refresh tokens are encrypted with. Make one with `openssl rand -hex 32`, and keep it: tokens written with another key can't be read |
| `MAIL_OFFLINE_REDIRECT_URI` | `<first ALLOWED_ORIGINS>/mail/tillatelse` | Where the login provider sends the member back |
| `MAIL_OFFLINE_AUTHORIZE_URL`, `MAIL_OFFLINE_TOKEN_URL`, `MAIL_OFFLINE_REVOKE_URL` | the provider's `/api/oidc/...` endpoints, taken from `OIDC_USERINFO_URL` | Only needed if the provider uses other addresses |

Put the credentials in `.env` (see `.env.example`). It is git-ignored and should never be
committed. That goes for `MAIL_OFFLINE_CLIENT_SECRET` and `MAIL_OFFLINE_KEY` too.

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

The database, with the scoreboards, the feed and its files, and the mail features' own data
(labels, settings, shared mails, scheduled sends and stored permissions), is kept in the `data` volume,
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
when you save a file. The same goes for mail: both users start with a few mails, including a
conversation of three, a mail with attachments, and one with a script, a form and a picture from
another site to check that none of it runs or loads. All mail is kept in memory, so there is no
mail server to set up, and mail between `dev` and `admin` is delivered, auto-replies included. They are kept in `./data/mock` while it runs; set `DATA_DIR` to
keep scores and the feed between restarts. Add or change users in `dev/mock-auth.ts`.

To use it from the site, run `npm run dev:mock` in the Tebonsma.no repo's `teb-app` folder
as well. To call the API directly, the access token is `mock-access.<username>`:

```bash
curl -H "Authorization: Bearer mock-access.dev" http://localhost:8787/me
```

The mock lives in `dev/`, which is not copied into the Docker image. It only listens on
127.0.0.1 and refuses to start when `NODE_ENV` is `production`. Its user directory only
answers the GraphQL operations the API uses today (`User`, `Users` and `Update`); a new one
returns an error until it is added to `dev/mock-auth.ts`. Sending later works against it
too: the permission page lets you pick who to log in as, and the mail goes out at the time
even after you have logged out.

## Security

- The service account is an LLDAP admin, so keep `.env` private. The API only exposes the
  self-service endpoints above; don't add endpoints that act on other users.
- Any valid access token from the OIDC provider is accepted, so only register clients
  there that you trust.
- The mail endpoints don't change that: they only ever open the mailbox of the member whose
  token is on the request, and nothing here acts on someone else's mailbox. Sharing is a copy
  in this API's database, which the member it is shared with can read and nobody else.
- The one secret kept for a member is the encrypted refresh token for sending later, and only
  for members who have said yes. Keep `MAIL_OFFLINE_KEY` and the data volume private, and
  remember that whoever has both can send mail as those members until the tokens are revoked.
- Mails from others are untrusted: they are cleaned here, shown by the site in a sandboxed
  frame, and attachments are only ever offered as downloads, with `nosniff` and a CSP that
  allows nothing.
