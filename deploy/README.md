# Deploying

`deploy.sh` keeps the host that runs the API on the newest commit of `main`. The host asks
GitHub every few minutes; nothing on GitHub's side needs access to the host.

When `main` has moved, the script:

1. Records a GitHub Deployment for the commit, so the repository shows what is being deployed.
2. Downloads the commit, backs up the database (`sqlite3 .backup`), the running image (tagged
   `rollback`) and the files in `APP_DIR`.
3. Replaces the repository's folders in `APP_DIR` (`.env` and everything else there stay) and runs
   `docker compose up -d --build`.
4. Waits for the container's health check, then checks that the open endpoints answer and the
   member endpoints ask for a login, and that the database is sound.
5. If any of that fails, restores the files and the previous image and starts them again, and marks
   the deployment as failed. The same commit is not tried again by itself; fix the cause and run
   `deploy.sh --force`, or merge a fix.

The outcome shows up in three places on GitHub: under **Deployments** on the repository's front
page (the `production` environment, with the commit that is live), on the commit, and on the pull
request that was merged.

## Setting it up

1. Make a fine-grained personal access token for this repository only, with **Contents: read** and
   **Deployments: read and write**. Note its expiry; the deploys stop when it runs out.
2. On the host, as root:

   ```bash
   install -m 755 deploy/deploy.sh /usr/local/bin/tebonsma-api-deploy.sh
   install -m 600 deploy/deploy.env.example /etc/tebonsma-api-deploy.env
   ```

   Put the token in `/etc/tebonsma-api-deploy.env`.
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
