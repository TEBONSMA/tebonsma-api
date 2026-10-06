# Deploying

`deploy.sh` keeps the host that runs the API on the newest commit of `main`. The host fetches
`main` every few minutes with a read-only deploy key; nothing on GitHub's side can reach the host,
and the host holds no GitHub credentials beyond that key.

When `main` has moved, the script:

1. Backs up the database (`sqlite3 .backup`), the running image (tagged `rollback`) and the files
   in `APP_DIR`.
2. Replaces the repository's folders in `APP_DIR` (`.env` and everything else there stay), writes
   the commit to `version.env`, and runs `docker compose up -d --build`.
3. Waits for the container's health check, then checks that `/version` reports the new commit,
   that the open endpoints answer and the member endpoints ask for a login, and that the database
   is sound.
4. If any of that fails, restores the files and the previous image and starts them again. The
   same commit is not tried again by itself; fix the cause and run `deploy.sh --force`, or merge
   a fix.

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

Backups land in `BACKUP_DIR` (root only, since the files include `.env`) and are removed after
`KEEP_BACKUP_DAYS` days. The nightly backup of the host should cover that folder too.

Since `main` is what runs, don't copy other branches to the host by hand: the next run would put
`main` back.
