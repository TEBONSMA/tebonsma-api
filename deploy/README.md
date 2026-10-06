# Deploying

`deploy.sh` keeps the host that runs the API on the newest commit of `main`. The host fetches
`main` every few minutes with a read-only deploy key; nothing on GitHub's side can reach the host,
and the host holds no GitHub credentials beyond that key.

When `main` has moved, the script:

1. Backs up the database (`sqlite3 .backup`), the running image (tagged `rollback`) and the files
   in `APP_DIR`.
2. Removes the previous commit's files from `APP_DIR` and copies in the new ones, so the folder
   matches the commit (the first run doesn't know the previous commit, and clears the repository's
   folders instead). `.env`, `version.env` and anything else the repository doesn't own stay.
   The commit goes into `version.env`, and the image is built.
3. Tries the new image first as a separate container on a copy of the database, with no network
   at all, so it can reach neither members nor mail. It has to become healthy, run its migrations
   and answer: `/version` reports the commit, the
   open endpoints answer, and the member endpoints ask for a login.
4. Only then replaces the real container, and checks it the same way, plus a database integrity
   check.
5. If any of that fails, puts everything back: the files, the previous image, and (when the real
   container had already started on the new version) the database from the backup. The same
   commit is not tried again by itself; fix the cause and run `deploy.sh --force`, or merge a fix.

The trial run means a version that doesn't start, or breaks on the real data, never serves a
request. A rollback of the real container restores the database, since the new version may have
changed it on start-up; what members wrote in the minute or two in between is lost, which is the
price of the old version meeting a database it understands.

GitHub finds out from the other side. The Deploy workflow (`.github/workflows/deploy.yml`) runs
on every push to `main`, records a GitHub Deployment, and waits for `/version` on the live API to
show that commit, then marks the deployment as succeeded, or as failed after 15 minutes. That
shows up under **Deployments** on the repository's front page (the `production` environment, with
the commit that is live), on the commit, and on the pull request that was merged.

## Setting it up

1. On the host, as root, make a key for fetching the repository and install the script:

   ```bash
   install -d -m 700 /etc/tebonsma-api-deploy
   ssh-keygen -t ed25519 -N '' -C 'tebonsma-api deploy' -f /etc/tebonsma-api-deploy/id_ed25519
   install -m 644 deploy/github_known_hosts /etc/tebonsma-api-deploy/known_hosts
   install -m 755 deploy/deploy.sh /usr/local/bin/tebonsma-api-deploy.sh
   install -m 644 deploy/deploy.env.example /etc/tebonsma-api-deploy.env
   ```
2. Add the public half (`/etc/tebonsma-api-deploy/id_ed25519.pub`) under the repository's
   Settings > Deploy keys, read-only.
3. Run it once by hand, which deploys the newest `main` and shows what it does:

   ```bash
   /usr/local/bin/tebonsma-api-deploy.sh --force
   ```
4. Let cron run it every five minutes. It is silent when there is nothing to do, so the log only
   grows when something is deployed:

   ```
   */5 * * * * /usr/local/bin/tebonsma-api-deploy.sh >> /var/log/tebonsma-api-deploy.log 2>&1
   ```

`github_known_hosts` pins GitHub's SSH host keys, taken from <https://api.github.com/meta>, so
the first connection can't be talked into trusting someone else. Should GitHub ever change them,
fetching stops until the file is updated.

The copy in `/usr/local/bin` is not updated by the script itself: when `deploy.sh` changes in the
repository, repeat the `install` line.

Backups land in `BACKUP_DIR` (root only, since the files include `.env`) and are removed after
`KEEP_BACKUP_DAYS` days. The nightly backup of the host should cover that folder too.

Since `main` is what runs, don't copy other branches to the host by hand: the next run would put
`main` back.
