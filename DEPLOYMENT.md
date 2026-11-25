# Deploying the API to PlanetHoster N0C with GitHub Actions

This guide puts **sunu-market-api** online on a PlanetHoster **N0C** account, in the folder `sunumarketapi`, with a **PostgreSQL** database on the same account. After the one-time setup, every push to the `main` branch tests and deploys the API automatically, using **FTP only**.

> Deploy the **API first**, then the website (`sunu-market-web`, see its own guide): the website needs the API's address.

The domain names below are examples: replace `votredomaine.com` with your domain everywhere.

| What | Example |
|---|---|
| API address | `https://api.votredomaine.com` |
| Website address | `https://votredomaine.com` |
| Folder on N0C | `/home/<n0c-user>/sunumarketapi` |

## How the automatic deployment works

When you push to `main`, GitHub Actions:

1. **Runs the tests** on a throwaway PostgreSQL database. If a test fails, nothing is sent.
2. **Uploads the API by FTP** to `sunumarketapi` (only the files that changed; never `.env`, `node_modules` or `storage/`). It also uploads a new `tmp/restart.txt`.
3. **Restarts by itself**: N0C runs Node.js apps with Phusion Passenger, which restarts the app when `tmp/restart.txt` changes. When the new version starts, it **applies any new database migrations** before accepting requests.
4. **Checks** that `https://api.votredomaine.com/health` answers (if you set `HEALTH_URL`).

So a normal push needs nothing from you.

### When you still click a button: new packages

FTP copies files but cannot run programs. The packages the API depends on (`node_modules`) live in N0C's Node environment and have to be installed by N0C itself. That is only needed:

- on the **very first deployment**, and
- when **`package.json` changes** (a package added, removed or updated).

In those cases the GitHub run shows a yellow warning, and you click **Run NPM Install** then **Restart** in N0C → **Languages → Node.js** (about one minute).

### Optional: SSH for fully hands-free deployments

If you add SSH access (step 7), the workflow also installs packages by itself when `package.json` changes, so you never have to click anything. SSH is a secure remote command line: FTP can only copy files, SSH can run commands such as `npm install`. Everything else works the same without it.

N0C menu names below are those of the English interface; the French interface uses the same structure (for example "Langages" for "Languages"). If a label differs slightly on your account, look for the closest one.

---

## 1. Create the PostgreSQL database

1. N0C → **Databases → PostgreSQL**.
2. Create a **database** (for example `sunumarket`) and a **user** with a strong password, and give the user **all privileges** on the database. N0C usually prefixes both names with your account name, for example `abcd_sunumarket`: use the full names it shows.
3. Note the details. The database runs on the same server: address `localhost`, port `5432`.

The API needs no PostgreSQL extension (no `pgcrypto`): UUIDs and the audit-log fingerprints use functions built into PostgreSQL 13 and later. N0C provides PostgreSQL 16.

> Production starts from an **empty** database. Do not copy the development database (Neon): it holds demo accounts and test data.

## 2. Create the API subdomain

1. N0C → **Domains → Subdomains**: create `api.votredomaine.com`.
2. Activate an **SSL certificate** for it (N0C → **Domains → SSL/TLS**, Let's Encrypt is free).

## 3. Create the Node.js application

N0C → **Languages → Node.js → Create application**:

| Field | Value |
|---|---|
| Node.js version | **22** (or the highest available ≥ 22) |
| Application mode | **Production** |
| Application root | `sunumarketapi` |
| Application URL | `api.votredomaine.com` |
| Application startup file | `server.cjs` |

Leave the environment variables empty: the API reads them from `.env` (step 4).

> Never upload a `node_modules` folder yourself: on N0C, `node_modules` is a link to the Node environment, and a real folder stops the app from starting.

## 4. Create the `.env` file on the server

With N0C's **File Manager**, create `/home/<n0c-user>/sunumarketapi/.env`. It is never in GitHub and the deployment never touches it.

Generate each secret with one of these commands (once per secret):

```bash
openssl rand -hex 32
```

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```ini
NODE_ENV=production

# ---------- Base de données (N0C, même serveur) ----------
DATABASE_URL=postgresql://abcd_sunumarket:MOT_DE_PASSE@localhost:5432/abcd_sunumarket
DB_DRIVER=pg

# ---------- Sécurité ----------
# 64 caractères aléatoires (openssl rand -hex 32), jamais la valeur de développement
JWT_SECRET=

# ---------- Adresses ----------
WEB_ORIGIN=https://votredomaine.com
API_PUBLIC_URL=https://api.votredomaine.com

# ---------- Tâches de fond : lancées par le cron (étape 9) ----------
JOBS_DISABLED=1

# ---------- SMS (codes de connexion, notifications) ----------
# En production : « orange » ou « http » ; « console » n'envoie rien.
SMS_PROVIDER=orange
OTP_REQUIRED=true
ORANGE_SMS_CLIENT_ID=
ORANGE_SMS_CLIENT_SECRET=
ORANGE_SMS_SENDER=
SMS_HTTP_URL=
SMS_HTTP_TOKEN=

# ---------- SM-IA (voir le guide SM-IA) ----------
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

Notes:

- If the database password contains `@ : / ? #`, percent-encode them in `DATABASE_URL` (`@` becomes `%40`).
- `API_PORT` is not needed: Passenger chooses the port.
- To stop migrations from running automatically at start-up, add `AUTO_MIGRATE=0` (you then run `npm run migrate` yourself).
- Uploaded photos and ID documents are stored in `sunumarketapi/storage/`. Deployments never delete it; include it in backups (step 12).

## 5. Push the code to GitHub

Create an **empty private repository** on GitHub (for example `sunu-market-api`), then from the `sunu-market-api` folder:

```bash
git init
git add .
git commit -m "API Sunu-Market"
git branch -M main
git remote add origin https://github.com/<your-account>/sunu-market-api.git
git push -u origin main
```

Before the first push, check that `git status` does **not** list `.env` (it is excluded by `.gitignore`). This first push only runs the tests and warns that nothing was sent: the FTP secrets come next.

## 6. FTP access

1. N0C → **Files → FTP accounts**. Use the main account, or create one whose home is your account root (`/home/<n0c-user>`).
2. Note the **server** (for example `ftp.votredomaine.com`, or the name N0C shows), the **username** and the **password**.

If you create an FTP account limited to the `sunumarketapi` folder itself, set the GitHub variable `FTP_DIR` to `./` instead of the default `sunumarketapi/`.

## 7. SSH access (optional)

Skip this step if you are happy to click **Run NPM Install** when `package.json` changes.

1. On your computer, create a key used only for deployments (press Enter when asked for a passphrase):

   ```bash
   ssh-keygen -t ed25519 -C "github-deploy-sunumarket" -f sunumarket_deploy
   ```

   This creates `sunumarket_deploy` (private key) and `sunumarket_deploy.pub` (public key).
2. N0C → **Files → SSH keys** (or **Advanced → SSH access**): add the content of `sunumarket_deploy.pub` and **authorize** it.
3. Note the **SSH host**, the **port** (N0C commonly uses **5022**) and your **username**.
4. Test from your computer:

   ```bash
   ssh -i sunumarket_deploy -p 5022 <n0c-user>@<ssh-host>
   ```

The private key goes into GitHub in step 8. Never commit it; delete your local copy once it is stored in GitHub and in your password manager.

## 8. GitHub secrets and variables

In the repository: **Settings → Secrets and variables → Actions**.

**Secrets** (tab *Secrets*):

| Name | Value | Required |
|---|---|---|
| `FTP_SERVER` | FTP server from step 6 | yes |
| `FTP_USERNAME` | FTP username | yes |
| `FTP_PASSWORD` | FTP password | yes |
| `SSH_HOST` | SSH host from step 7 | only for SSH |
| `SSH_USERNAME` | your N0C username | only for SSH |
| `SSH_PRIVATE_KEY` | full content of `sunumarket_deploy`, including the `BEGIN` and `END` lines | only for SSH |

**Variables** (tab *Variables*):

| Name | Default | Set it when |
|---|---|---|
| `HEALTH_URL` | *(none)* | **recommended**: `https://api.votredomaine.com/health`, so each run checks the API is up |
| `APP_DIR` | `sunumarketapi` | another application root |
| `FTP_DIR` | `sunumarketapi/` | FTP account limited to the app folder (`./`) |
| `FTP_PROTOCOL` | `ftps` | your server only accepts plain `ftp` |
| `NODE_VERSION` | `22` | another Node version chosen in step 3 |
| `SSH_PORT` | `5022` | N0C shows another SSH port |

## 9. Background jobs (cron)

The API runs three jobs: checking Wave / Orange Money payments left pending, subscription reminders, and clean-up. Passenger puts the app to sleep when nobody uses it, so these jobs run from a cron job (hence `JOBS_DISABLED=1` in `.env`).

N0C → **Advanced → Cron jobs**, every **5 minutes** (`*/5 * * * *`):

```bash
/bin/bash -c 'source $HOME/nodevenv/sunumarketapi/22/bin/activate && cd $HOME/sunumarketapi && node scripts/run-jobs.mjs' >> $HOME/sunumarket-jobs.log 2>&1
```

Replace `22` if you chose another Node version. Each run writes one line per job to `~/sunumarket-jobs.log`.

## 10. First deployment

1. GitHub → **Actions → Mise en ligne de l'API → Run workflow** (or push a commit to `main`). The first upload takes a few minutes.
2. In N0C → **Languages → Node.js** → your app: click **Run NPM Install**, then **Restart**. (Skip this if you set up SSH.)
3. Open `https://api.votredomaine.com/health`: it must show `{"ok":true}`. The database tables were created automatically at start-up.
4. One-time data, from a terminal on the server (N0C terminal, or `ssh` as in step 7):

   ```bash
   source $HOME/nodevenv/sunumarketapi/22/bin/activate && cd $HOME/sunumarketapi

   # Catalogue : 12 catégories et 93 sous-catégories (jamais l'option --demo en production)
   npm run seed

   # Premier administrateur (téléphone sénégalais, mot de passe de 12 caractères minimum)
   npm run create-admin -- "+2217XXXXXXXX" "MotDePasseTresSolide" "Prénom" "Nom"
   ```

From now on, every push to `main` deploys by itself.

## 11. Connect the services

| Service | What to do |
|---|---|
| **Wave** | In the Wave Business dashboard, set the webhook URL `https://api.votredomaine.com/api/payments/webhooks/wave`, then fill `WAVE_API_KEY` and `WAVE_WEBHOOK_SECRET` in `.env`. |
| **Orange Money** | Notification URL: `https://api.votredomaine.com/api/payments/webhooks/orange-money`. Check the request formats against Sonatel's merchant documentation before enabling it (see the comments in `src/lib/payments.js`). |
| **SM-IA** | Add `ANTHROPIC_API_KEY` (see the SM-IA setup guide). |
| **SMS** | Fill the provider settings in `.env`. |

After any change to `.env`, restart the app (N0C → Node.js → **Restart**).

## 12. Backups

- **Database**: check that N0C backups include PostgreSQL. For an extra daily copy, add a cron job (daily, `0 3 * * *`), after creating `~/backups`:

  ```bash
  pg_dump "postgresql://abcd_sunumarket:MOT_DE_PASSE@localhost:5432/abcd_sunumarket" | gzip > $HOME/backups/sunumarket-$(date +\%F).sql.gz
  ```

- **Files**: `~/sunumarketapi/storage/` (listing photos, ID documents). It is not in GitHub.

## Day to day

| Task | How |
|---|---|
| Deploy | Push to `main`. |
| Yellow warning "package.json a peut-être changé" | N0C → Node.js → **Run NPM Install**, then **Restart** (not needed with SSH). |
| Deploy again without changes | GitHub → Actions → **Run workflow**. |
| Undo a bad deployment | `git revert <commit>` then push. Database migrations are not undone automatically. |
| Change a setting | Edit `.env` on the server, then **Restart**. |
| See errors | N0C → Node.js → your app → log, and the GitHub Actions run. |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Run warns "Secrets FTP absents" | Secrets missing or misspelled | Check the names in step 8. |
| FTP step cannot connect | Protocol or server | Try `FTP_PROTOCOL` = `ftp`; check the server name. |
| Health check fails after a push | New packages not installed, or the app did not restart | Click **Run NPM Install** then **Restart** in N0C, then **Re-run jobs** in GitHub. |
| `/health` returns 503, app does not start | Error at start-up | Read the app log in N0C: usually `DATABASE_URL`, a missing `JWT_SECRET`, or a failed migration. |
| `extension "pgcrypto" is not available` | Old version of the code (before migration 005) | Push the current code: the next deployment no longer asks for it: no extension is needed any more. |
| Log shows "Variable d'environnement manquante" | Required variable missing | Complete `.env`, then **Restart**. |
| App error mentioning `node_modules` and a symlink | A real `node_modules` folder exists | Delete `~/sunumarketapi/node_modules`, then **Run NPM Install**. |
| SSH step: "Permission denied (publickey)" | Key not authorized | Redo step 7.2: the public key goes to N0C, the private key to GitHub. |
| SSH step times out | Wrong port or SSH blocked from outside | Check the port; ask support; or remove the SSH secrets and use the button. |
| Old version still answering after a push | Passenger did not pick up `tmp/restart.txt` | Click **Restart** in N0C once and let us know: the workflow may need the SSH restart instead. |
| First request after a quiet period is slow | Passenger was asleep | Normal. |
