# Setting up the API on N0C with `git clone` and the terminal

This guide installs **sunu-market-api** on PlanetHoster **N0C** by cloning it from GitHub in the terminal, in the folder `sunumarketapi`, with a **PostgreSQL** database on the same account. It is the alternative to the automatic FTP deployment in `DEPLOYMENT.md`: use one method or the other, not both.

- **Set up once:** steps 1 to 10.
- **Every update:** push from your computer, then run one command on the server (step 11).

Set up the API **before** the website (repository `sunu-market-web`, its own `SETUP.md`): the website calls the API for every page.

Examples used below: replace them with your own values.

| What | Example |
|---|---|
| API address | `https://api.votredomaine.com` |
| Website address | `https://votredomaine.com` |
| GitHub repository | `<your-account>/sunu-market-api` |
| Folder on N0C | `~/sunumarketapi` |
| Node.js version | `22` |

---

## Already tried and it does not start? The usual causes

| # | Cause | Why it breaks | Fix |
|---|---|---|---|
| 1 | **No `.env`, or a wrong value** | The API stops at start-up without `DATABASE_URL` or `JWT_SECRET`, or if the database refuses the connection. | Step 6. |
| 2 | **Packages not installed** | A clone does not contain `node_modules`. | Step 8 installs them. |
| 3 | **Wrong Node** | Without activating the app's Node environment, the terminal uses the server's default Node, often older than 22. | Activate the environment first (step 7). |
| 4 | **`node_modules` is a real folder** | On N0C it must be a link to the Node environment. Running `npm install` before creating the Node.js app creates a real folder. | `rm -rf node_modules`, activate the environment, install again. |
| 5 | **App settings** | Startup file not `server.cjs`, or the application root is not `sunumarketapi`. | Step 5. |
| 6 | **Database** | Missing privileges, or old code still asking for the `pgcrypto` extension (N0C does not provide it). | Step 2; `git pull` the current code. |

**To see the real error**, start the API by hand in the terminal (after step 7). If it fails, the error is printed:

```bash
API_PORT=3998 timeout 30 node server.cjs & sleep 10; curl -s http://127.0.0.1:3998/health; echo; wait
```

`{"ok":true}` means the API works, and the problem is in the N0C app settings (cause 5) or the restart. Any error message points to one of causes 1 to 6.

---

## 1. Before you start

- The code is on GitHub (a private repository is fine).
- You can open a **terminal** on the server: N0C → **Advanced → Terminal**, or SSH from your computer.
- The subdomain `api.votredomaine.com` exists (N0C → **Domains → Subdomains**), with an **SSL certificate** active (N0C → **Domains → SSL/TLS**).

## 2. Create the PostgreSQL database

1. N0C → **Databases → PostgreSQL**.
2. Create a **database** (for example `sunumarket`) and a **user** with a strong password, and give the user **all privileges** on the database. N0C usually prefixes both names with your account name, for example `abcd_sunumarket`: use the full names it shows.
3. Note the details. The database runs on the same server: address `localhost`, port `5432`.

The API needs no PostgreSQL extension (no `pgcrypto`): UUIDs and the audit-log fingerprints use functions built into PostgreSQL 13 and later. N0C provides PostgreSQL 16.

> Production starts from an **empty** database. Do not copy the development database: it holds demo accounts and test data.

## 3. Give the server read access to GitHub (deploy key)

A **deploy key** lets the server download this one repository, read-only. GitHub accepts a given deploy key on only **one** repository, so the website uses its own key.

In the terminal:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
ssh-keygen -t ed25519 -N "" -C "n0c-sunumarketapi" -f ~/.ssh/sunumarketapi_github
cat ~/.ssh/sunumarketapi_github.pub
```

Copy the line shown (it starts with `ssh-ed25519`). On GitHub, open the repository → **Settings → Deploy keys → Add deploy key**, paste it, give it a title (for example `N0C`), leave **Allow write access** unchecked, and save.

Then tell the server which key to use for this repository. GitHub's port 443 works even where port 22 is blocked:

```bash
cat >> ~/.ssh/config <<'EOF'

Host github-sunumarketapi
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile ~/.ssh/sunumarketapi_github
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh -T github-sunumarketapi
```

Answer `yes` to the first-connection question. The last command must say **"You've successfully authenticated"** (it also says GitHub does not provide shell access, which is normal).

## 4. Get the code into `~/sunumarketapi`

**If `~/sunumarketapi` does not exist yet:**

```bash
git clone github-sunumarketapi:<your-account>/sunu-market-api.git ~/sunumarketapi
```

**If the folder already exists** (created by N0C or by an earlier upload), `git clone` refuses a non-empty folder. Attach the existing folder to GitHub instead:

```bash
cd ~/sunumarketapi
git init -b main
git remote add origin github-sunumarketapi:<your-account>/sunu-market-api.git
git fetch origin
git reset --hard origin/main
git branch --set-upstream-to=origin/main main
```

`git reset --hard` replaces the repository's files with the GitHub version; files that are not in the repository (`.env`, `storage/` content, `tmp/`) are kept.

Then check for an old `node_modules` folder (cause 4):

```bash
ls -ld ~/sunumarketapi/node_modules
```

If the line starts with `d` (a real folder), delete it: `rm -rf ~/sunumarketapi/node_modules`. If it starts with `l` (a link) or the folder does not exist, all is fine.

## 5. Create or check the Node.js application

N0C → **Languages → Node.js**. Create the application, or edit it if it already exists:

| Field | Value |
|---|---|
| Node.js version | **22** (or the highest available ≥ 22) |
| Application mode | **Production** |
| Application root | `sunumarketapi` |
| Application URL | `api.votredomaine.com` |
| Application startup file | `server.cjs` |

Leave the environment variables empty: the API reads them from `.env`. Save. The application page shows the command to **enter the virtual environment** (step 7).

## 6. Create the `.env` file

```bash
cd ~/sunumarketapi
nano .env
```

Paste this, fill in the values, then save with Ctrl+O, Enter, and quit with Ctrl+X:

```ini
NODE_ENV=production

# ---------- Base de données (N0C, même serveur) ----------
DATABASE_URL=postgresql://abcd_sunumarket:MOT_DE_PASSE@localhost:5432/abcd_sunumarket
DB_DRIVER=pg

# ---------- Sécurité : 64 caractères aléatoires (openssl rand -hex 32) ----------
JWT_SECRET=

# ---------- Adresses ----------
WEB_ORIGIN=https://votredomaine.com
API_PUBLIC_URL=https://api.votredomaine.com

# ---------- Tâches de fond : lancées par le cron (étape 10) ----------
JOBS_DISABLED=1

# ---------- SMS : en production « orange » ou « http » (« console » n'envoie rien) ----------
SMS_PROVIDER=orange
OTP_REQUIRED=true
ORANGE_SMS_CLIENT_ID=
ORANGE_SMS_CLIENT_SECRET=
ORANGE_SMS_SENDER=
SMS_HTTP_URL=
SMS_HTTP_TOKEN=

# ---------- SM-IA ----------
ANTHROPIC_API_KEY=

# ---------- Paiements des services (vide = déclaration manuelle confirmée par l'équipe) ----------
WAVE_API_KEY=
WAVE_SIGNING_SECRET=
WAVE_WEBHOOK_SECRET=
OM_CLIENT_ID=
OM_CLIENT_SECRET=
OM_MERCHANT_KEY=
OM_WEBPAY_URL=
OM_STATUS_URL=
```

Generate `JWT_SECRET` with:

```bash
openssl rand -hex 32
```

If the database password contains `@ : / ? #`, percent-encode them in `DATABASE_URL` (`@` becomes `%40`).

## 7. Activate the application's Node environment

Do this **every time** you open the terminal to work on the API: it selects Node 22 and the app's packages.

```bash
source ~/nodevenv/sunumarketapi/22/bin/activate && cd ~/sunumarketapi
node -v
```

`node -v` must show `v22` or higher. (Use the exact command shown on the app page in N0C if it differs.)

## 8. Install and start

```bash
bash scripts/server-update.sh
```

The script checks Node, `node_modules` and `.env`, then:

1. installs the packages;
2. creates the database tables (`npm run migrate`);
3. touches `tmp/restart.txt`, which makes N0C restart the app.

It stops with a clear message if something is missing. A database error at the migration step means `DATABASE_URL` or the database privileges are wrong (step 2 and step 6).

## 9. First data and check

Still in the terminal, with the environment active:

```bash
# Catalogue : 12 catégories et 93 sous-catégories (jamais l'option --demo en production)
npm run seed

# Premier administrateur (téléphone sénégalais, mot de passe de 12 caractères minimum)
npm run create-admin -- "+2217XXXXXXXX" "MotDePasseTresSolide" "Prénom" "Nom"
```

Then open `https://api.votredomaine.com/health`: it must show `{"ok":true}`.

## 10. Background jobs (cron)

The API runs three jobs: checking Wave and Orange Money payments left pending, subscription reminders, and clean-up. N0C puts the app to sleep when nobody uses it, so they run from a cron job.

N0C → **Advanced → Cron jobs**, every **5 minutes** (`*/5 * * * *`):

```bash
/bin/bash -c 'source $HOME/nodevenv/sunumarketapi/22/bin/activate && cd $HOME/sunumarketapi && node scripts/run-jobs.mjs' >> $HOME/sunumarket-jobs.log 2>&1
```

Each run writes one line per job to `~/sunumarket-jobs.log`.

## 11. Updating the API later

1. On your computer: commit and push to `main`.
2. On the server:

   ```bash
   source ~/nodevenv/sunumarketapi/22/bin/activate && cd ~/sunumarketapi && bash scripts/server-update.sh
   ```

The script pulls the new code, installs packages, applies new database migrations and restarts.

> **About the GitHub workflow:** with this method, do not add FTP secrets to the repository. Without them, the workflow in `.github/workflows/deploy.yml` still runs the tests on GitHub at each push (a useful check) and uploads nothing.

## 12. Connect the services and back up

| Service | What to do |
|---|---|
| **Wave** | Webhook URL in the Wave Business dashboard: `https://api.votredomaine.com/api/payments/webhooks/wave`; then fill `WAVE_API_KEY` and `WAVE_WEBHOOK_SECRET` in `.env`. |
| **Orange Money** | Notification URL: `https://api.votredomaine.com/api/payments/webhooks/orange-money`. Check the formats against Sonatel's merchant documentation first (comments in `src/lib/payments.js`). |
| **SM-IA** | Add `ANTHROPIC_API_KEY`. |
| **SMS** | Fill the provider settings in `.env`. |

After any change to `.env`: `touch ~/sunumarketapi/tmp/restart.txt` (or **Restart** in N0C).

**Backups**: check that N0C backups include PostgreSQL, and back up `~/sunumarketapi/storage/` (listing photos, ID documents), which is not in GitHub.

## Troubleshooting

| Message or symptom | Cause | Fix |
|---|---|---|
| `Permission denied (publickey)` on `git clone` or `git pull` | Deploy key not added, or added to the other repository | Step 3: add `sunumarketapi_github.pub` to **this** repository's deploy keys. |
| `ssh: connect to host … port 22` | Port 22 blocked | Use the `github-sunumarketapi` alias from step 3 (port 443), not `git@github.com:`. |
| `destination path … already exists` | Folder exists | Use the "folder already exists" commands in step 4. |
| Script stops: "node introuvable" or "il faut Node 22" | Environment not activated | Step 7. |
| Script stops: "node_modules est un vrai dossier" | Cause 4 | `rm -rf node_modules`, then step 7 and the script again. |
| `Variable d'environnement manquante : …` | `.env` incomplete | Step 6. |
| `password authentication failed` or `ECONNREFUSED` | Wrong `DATABASE_URL` | Check user, password, database name and `localhost:5432`. |
| `extension "pgcrypto" is not available` | Old version of the code (before migration 005) | `git pull` (or push) the current code, then run the update again: no extension is needed any more. |
| `/health` shows an N0C error page | App not started or wrong settings | Run the manual start command at the top of this guide; check step 5. |
| Old version after an update | App not restarted | `touch ~/sunumarketapi/tmp/restart.txt`, or **Restart** in N0C. |
