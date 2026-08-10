# Deploying to Railway

The app is one Node service (Fastify) that serves both the API **and** the built
front-end, plus a Postgres database. One Railway project hosts both.

## 1. Push this repo to GitHub

Already committed locally. Create an **empty** GitHub repo (no README), then:

```bash
git remote add origin https://github.com/<you>/poker-ledger.git
git push -u origin main
```

## 2. Create the Railway project

1. Go to <https://railway.app> → **New Project** → **Deploy from GitHub repo** → pick `poker-ledger`.
2. In the project, click **+ New** → **Database** → **Add PostgreSQL**.
   Railway creates a `DATABASE_URL` variable automatically.
3. Open the **web service** (the Node one) → **Variables** → reference the DB and add the rest:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference the Postgres service) |
| `JWT_SECRET` | a long random string (see below) |
| `ADMIN_BOOTSTRAP_PASSWORD` | the first-login password for **eMJey55** (change after login) |
| `ANTHROPIC_API_KEY` | your Anthropic key — only needed for screenshot reading |
| `NODE_ENV` | `production` |
| `DATABASE_SSL` | leave unset if using the `${{Postgres.DATABASE_URL}}` reference; set `true` only if you use the DB's **public** URL |

Generate a `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## 3. Deploy

Railway builds automatically (`railway.json` runs the front-end build; `npm start`
runs migrations + seed, then boots the server). Watch the deploy logs — you should
see `Done.` (migrations) then the server listening.

- **Migrations run on every boot** — they're idempotent and additive.
- **Seed runs only when the DB is empty** — it creates the 13-player roster and the
  house payout structure, and sets **eMJey55**'s password to `ADMIN_BOOTSTRAP_PASSWORD`.

## 4. First login

Open the Railway-provided URL → log in as **`eMJey55`** with `ADMIN_BOOTSTRAP_PASSWORD`
→ you'll be forced to set a new password. Then create/adjust members, set ClubGG
screen names, and you're live.

## Notes

- **Custom domain:** Railway → service → **Settings → Networking → Custom Domain**.
- **Carrying over local data (optional):** to move your current local database instead
  of seeding fresh, `pg_dump` your local DB and `psql` it into the Railway Postgres
  *before* the first app boot (or the seed will already have run — that's fine, it
  skips seeding when players exist). Ask and I'll give exact commands.
- **Screenshot upload** returns a friendly 503 until `ANTHROPIC_API_KEY` is set — the
  rest of the app works without it.
