# tebonsma-api

Small HTTP API for tebonsma.no. It lets logged-in members view and edit their own account
in LLDAP (the site's `/konto` page), keeps the scoreboards for the site's games, runs
the news feed (`/feed`), and is the backend of TebBet, the members' betting site at
bet.tebonsma.no.

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

### TebBet

Members bet TEB coins, which are only for fun, on things that may happen at an event. Every
member starts with 1 000 coins the first time they open TebBet and gets 100 more every Monday
(Norwegian time). Everything under `/bet` needs a login.

A **market** is a question: yes/no, two to ten named outcomes of which one comes true, two to
ten of which several can (multi, like who ends up on the cleaning crew; every right pick wins),
or over/under, where members pick a line on a count (like 4,5 beers) and bet over or under it. Markets on an event are run
(opened, closed, decided, called off, reopened) by the event's organizer and admins; the
organizer can turn betting off for an event (`event.betting` on the post), which hides it from
TebBet. Admins can also open markets that aren't about an event. Whoever opens a market can
keep members out of it, typically the one it is about: they see it but can't play on it, and
bets they placed before stand. A **slip** is one bet:
a stake on one outcome (single), or on outcomes in several markets that must all happen
(combination, odds multiplied). Odds are locked when a slip is played. When a market is
decided, slips are paid at once; when it is called off, or its event deleted, stakes are paid
back, and in a combination it counts as odds 1,00. Reopening a decided market takes what it
paid back out again.

| Method | Path | Does |
|---|---|---|
| GET | `/bet/me` | Own balance, coins in play and the next Monday |
| GET | `/bet/events` | Coming events and recent results, with their markets and current odds |
| GET | `/bet/events/:id` | One event, every market on it and the latest bets |
| GET | `/bet/other` | The markets that aren't about an event, and their latest bets |
| GET | `/bet/members` | The members (`MEMBER_GROUP`), to keep out of a market or add as its outcomes |
| POST | `/bet/events/:id/markets` | Open a market: `{ question, kind, outcomes: [{ label, odds }], closesAt, excluded }` |
| POST | `/bet/markets` | Open a market that isn't about an event (admins), same body |
| PATCH | `/bet/markets/:id` | Change `question`, `closesAt` or `excluded` of an undecided market |
| POST | `/bet/events/:id/sections`, `/bet/other/sections` | Add a section heading: `{ title }` |
| PATCH, DELETE | `/bet/sections/:id` | Rename a section (`{ title }`), or remove it; its markets stay, under no section |
| PUT | `/bet/events/:id/layout`, `/bet/other/layout` | Order sections and markets: `{ groups: [{ sectionId, marketIds }] }`, `sectionId` null for no section |
| POST | `/bet/markets/:id/close` | Stop betting now |
| POST | `/bet/markets/:id/settle` | Decide it: `{ outcomeId }`, `{ outcomeIds }` (every outcome that came true, maybe none) for multi, or `{ value }` for over/under |
| POST | `/bet/markets/:id/void` | Call it off and pay the stakes back |
| POST | `/bet/markets/:id/reopen` | Take the decision back |
| DELETE | `/bet/markets/:id` | Remove a market nobody has played on |
| POST | `/bet/slips` | Play: `{ slips: [{ stake, selections }] }`, all or none. A selection is `{ outcomeId, odds }`, or `{ marketId, side, line, odds }` for over/under |
| GET | `/bet/slips?status=open\|settled` | Own slips |
| GET | `/bet/ledger` | Own account statement |
| GET | `/bet/leaderboard` | Everyone who has played, by coins in hand plus coins in play |

`kind` is `yesno`, `choice`, `multi` or `overunder`. A multi market also takes `winners`,
about how many of its outcomes will come true (at least 1, fewer than the outcomes, like
`2.5`). An over/under market takes `line` (where over and
under start out even, like `4.5`), `lowest` and `highest` (the ends of the slider, `lowest`
0 if left out) and `spread` (`low`, `medium` or `high`) instead of `outcomes`.
`excluded` is a list of member ids from `/bet/members`; everyone sees who is kept out.
`sectionId` puts a new market at the end of a section. `closesAt` left out means when the
event starts; `null` means open until closed by hand.
The `odds` sent with a slip are the ones the member was shown. If the odds have moved since,
the slip is refused with 409 and the site shows the new ones.

**How the odds move** (`src/odds.ts`): the organizer's opening odds are turned into
probabilities, and from there a market maker using Hanson's logarithmic market scoring rule
(LMSR) moves them. Every coin played on an outcome makes it likelier, so its odds fall and the
others rise. A stake gets the average price over its own move, which is why a large stake gets
a little less than the odds shown, and why nobody can earn coins for sure by betting on every
side. The bank keeps 5 % of every payout. `DEFAULT_LIQUIDITY` (2 000 coins) sets how fast the
odds move. Coins only move through the ledger table, so a balance is the sum of its rows.

**Multi** markets price every outcome on its own, as a yes/no market of which only yes is
sold. The organizer's odds are turned into probabilities that add up to `winners` (none above
95 %), and from there each moves with what is played on it. A combination has one pick per
market, except on a multi market, where it can pick several outcomes (all must come true) and
their odds are multiplied like any other. Since only so many can come true, that is a little
less than a fair price, never more.

**Over/under** is the same market maker over the numbers from `lowest` to `highest`, which
also stand for anything below and above them. Betting over 4,5 buys every number from 5 up at
once, so the odds on all lines hang together and can't be played against each other. The
opening chances follow a log-normal curve with the organizer's line in the middle, lopsided
the way counts and waits are: twice the line is as likely as half of it. `spread` sets how wide
it is (0,3, 0,6 or 1,0 on a log scale). Lines lie halfway between whole numbers, so a result is
always over or under.

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
| `ALLOWED_ORIGINS` | `https://tebonsma.no` | Comma-separated sites allowed to call the API (CORS). TebBet needs `https://bet.tebonsma.no` here too |
| `PORT` | `8080` | Port to listen on |
| `DATA_DIR` | `./data` (`/app/data` in Docker) | Folder for the SQLite database |
| `ADMIN_GROUP` | `lldap_admin` | Group whose members moderate the feed |
| `MEMBER_GROUP` | `medlemmer` | Group of the members of TEBONSMA, for TebBet's list of members |

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
| `dev` | `medlemmer` | An ordinary member |
| `kari`, `ola` | `medlemmer` | More members, for TebBet and keeping members out of markets |
| `admin` | `lldap_admin` | What admins see |

Profile edits, scores and the feed are reset when the server restarts, which also happens
when you save a file. They are kept in `./data/mock` while it runs; set `DATA_DIR` to
keep scores and the feed between restarts. Add or change users in `dev/mock-auth.ts`.

To use it from the site, run `npm run dev:mock` in the Tebonsma.no repo's `teb-app` folder
as well, and for TebBet in the tebbet repo (it runs on port 5174; both ports are allowed).

`npm run dev:mock:demo` does the same and adds three example events with TebBet markets and
a few bets: one coming up next week (with an over/under market Dev Bruker is kept out of and
a multi market), one
in two days, and one that is over, with a decided market and one waiting for its result. There
is also a market that isn't about an event. To call the API directly, the access token is `mock-access.<username>`:

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
