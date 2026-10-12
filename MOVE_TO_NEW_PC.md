# Moving poker-ledger (and Claude) to a new PC

Everything lives in the GitHub repo except **one file: `.env`** (your secrets).
Production is untouched by any of this — it runs on Railway and deploys from
GitHub, not from your PC.

## What to carry over by hand

| Item | From (old PC) | Why |
|---|---|---|
| `.env` | `poker-ledger/.env` | Secrets: DB URL, JWT secret, admin bootstrap password, Anthropic API key. Git-ignored on purpose. Copy via USB/OneDrive **privately** — never commit it. |
| (optional) Claude memory | `C:\Users\micha\.claude\projects\<project-folder>\memory\` | Claude's notes about this project. Optional — `CLAUDE.md` in the repo now carries the important context, so a fresh Claude is fully briefed without it. |
| (optional) local DB data | see "Local database" below | Local Postgres holds **test data only**; usually skip. |

## 1. Install on the new PC

1. **Git** — git-scm.com (or `winget install Git.Git`)
2. **Node.js 20+** — nodejs.org LTS (or `winget install OpenJS.NodeJS.LTS`)
3. **Docker Desktop** — docker.com (for local Postgres)
4. **Claude Code** — the desktop app, or CLI: `npm install -g @anthropic-ai/claude-code`

## 2. Get the code

```bash
git clone https://github.com/mj-crew/poker-ledger.git
cd poker-ledger
```

The repo is private — Git will pop a browser window to sign in to GitHub
(mj-crew) the first time; the credential manager remembers it afterwards.

## 3. Secrets

Copy `.env` from the old PC into the repo root. If you can't, copy
`.env.example` to `.env` and fill in:

- `DATABASE_URL=postgres://poker:poker@localhost:5433/poker_ledger` (local default)
- `JWT_SECRET=` any long random string (changing it logs everyone out locally — fine)
- `PORT=4000`, `CORS_ORIGIN=http://localhost:5173`
- `ADMIN_BOOTSTRAP_PASSWORD=` temp password for the seeded admin
- `ANTHROPIC_API_KEY=` from console.anthropic.com (screenshot OCR features)

Production has its own copies in Railway → poker-ledger service → Variables,
so nothing here affects the live app.

## 4. Install & run

```bash
npm install
npm install --prefix web
docker compose up -d            # Postgres on localhost:5433
node db/migrate.js --seed       # schema + migrations (+ seed roster if DB is empty)
npm run dev                     # backend on http://localhost:4000
```

Second terminal:

```bash
cd web
npx vite                        # frontend on http://localhost:5173
```

Open http://localhost:5173 — a fresh DB is seeded with the roster; admin
`eMJey55` signs in with `ADMIN_BOOTSTRAP_PASSWORD` and is forced to change it.

## 5. Claude on the new PC

1. Open the cloned `poker-ledger` folder in Claude Code.
2. `CLAUDE.md` (in the repo) briefs Claude automatically: stack, money rules,
   the weekly settlement cycle, deploy flow, and the gotchas we hit.
3. Optional: copy the old memory folder (path in the table above) into the same
   path on the new PC (the `<project-folder>` name is derived from the working
   directory, so keep the same folder layout or just skip this — CLAUDE.md covers it).

Working agreement that has served well: build + verify locally ("don't push"),
then deploy everything in one go — **every `git push` to `main` goes live** on
Railway within ~3 minutes.

## 6. Deploying from the new PC

Nothing to set up: `git push` → GitHub → Railway auto-builds → live at
https://www.fp94.vip. Railway and GoDaddy (domain) are managed in their web
dashboards, not from the PC.

## Local database (optional)

Local Postgres contains **test data only** — normally just re-seed fresh.
If you really want to carry it:

```bash
# old PC
docker exec poker_ledger_db pg_dump -U poker poker_ledger > poker_ledger_local.sql
# new PC (after docker compose up -d, before migrate)
docker exec -i poker_ledger_db psql -U poker -d poker_ledger < poker_ledger_local.sql
```

## Old PC cleanup (once the new one works)

- Delete the local folder if you like — GitHub is the source of truth.
- `.env` is the only thing on the old PC that's secret; remove it with the folder.
