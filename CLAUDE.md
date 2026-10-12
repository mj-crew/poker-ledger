# Flawless Poker Room 9♦4♦ — ledger (poker-ledger)

Multi-user web app + Postgres running the **real-cash ledger** for a ~20-friend
home poker game. **Live in production** at https://www.fp94.vip (Railway,
auto-deploys on every push to `main` of mj-crew/poker-ledger). Treat every push
as a production deploy; when asked to "work local only", commit but do NOT push.

## Stack & layout

- Backend: Node 20, Fastify, `pg`, `zod`, JWT auth (`@fastify/jwt`), bcryptjs.
  One service serves the API (`/api/*`) **and** the built React SPA (`web/dist`)
  — single origin, SPA fallback in `src/server.js`.
- Frontend: React + Vite in `web/` (`web/src/pages/*.jsx`, shared client in
  `web/src/api.js`, auth context in `web/src/auth.jsx`).
- DB: Postgres. Local dev via `docker-compose.yml` → container
  `poker_ledger_db` on port **5433**. Schema in `db/schema.sql`; everything
  since launch is **idempotent alters** in `db/migrate.js` (plus a guarded
  `one_time_migrations` table for one-off data fixes). `npm start` =
  `node db/migrate.js --seed && node src/server.js` — migrations run on every
  production boot, so new tables/columns ship just by pushing.
- Screenshot OCR: Claude vision via `@anthropic-ai/sdk` (setup/entries/results/
  ClubGG balances). Needs `ANTHROPIC_API_KEY`.

## Money rules (do not break)

- All money is **integer cents**. Display formatting lives in `web/src/api.js`.
- Balances are **derived from `ledger_entries`** (view `player_balances`),
  never stored. Settlement = greedy min-cash-flow (`src/lib/settlement.js`).
  Everything must stay **zero-sum**; the lock refuses unbalanced weeks.
- Payouts (`src/lib/payouts.js`): house structure `tiered_percent`
  (1–5 entries → 100%; 6–10 → 65/35; 11+ → 50/30/20 — editable in Settings),
  exact to the cent, winner absorbs the remainder, prizes assigned by **actual
  finish position**.
- Expenses are covered **prorata by rake share** and reimbursed to the claimer
  (`src/lib/prorata.js` — largest-remainder, sums exactly). An expense claimed
  by someone not in the settlement is excluded + warned (would leak money).
- pg type parsers in `src/db.js` return DATE columns as raw `YYYY-MM-DD`
  strings — do not remove (Sydney timezone off-by-one bug otherwise).

## The weekly cycle (domain logic)

1. Mon: everyone gets a ClubGG chip allocation (default $2000, editable).
2. Through the week: tournaments on PokerStars (run live in the app) and
   ClubGG; **midweek GG positions** via screenshot upload. The *running week*
   advances **only when a week is reset** — never just because it's Monday
   (`GET /settlement/running-week`).
3. Settlement day (Sun/Mon): import the **ClubGG weekly export (.xlsx)** on the
   Settlement tab (`src/lib/clubgg-import.js` + `/clubgg/import`). Two
   independent jobs per upload: stats → `gg_*` tables; balances → finishing
   stacks (Club Member Balance tab) + rake (Club Overview "Fee" column).
   Reconciliation checks report any drift for review.
4. ClubGG tournament prizes are **re-paid by the house structure** by actual
   finishing position (export row order = finish order) — ClubGG's own payout
   table is ignored for stats; pool is always conserved.
5. Once an **end-of-week balance** is entered, the midweek position stops
   counting (greys out). Lock refuses lingering midweek-only players.
6. **Lock** freezes who-pays-whom, folds the ClubGG net into the ledger
   (kind `clubgg`), and snapshots every player's line into
   `settlement_recaps` (shown as the Weekly recap on My Balance).
7. Players mark paid / confirm received; **Reset** starts the new week
   (offsets ledger, clears stacks to NULL, re-allocates).
8. Between lock and reset the ClubGG fold is already in the ledger while the
   stacks still show it — every balance display must count it **once**
   (see `/account`, `/standings`, `/clubgg/week`; bug fixed 2026-08-24).

## Auth & permissions

- Roles: superadmin (Michal, `eMJey55`) / admin / player, plus individually
  grantable capabilities (`src/capabilities.js`) incl. `members.actas` —
  "act as a member" with audit log (`act_as_log`) and escalation guards.
- Members tab is the roster admin; ClubGG nicknames live in `handle_aliases`
  (platform `clubgg`); ClubGG GG-ids learned automatically on import.

## Dev commands

```bash
docker compose up -d          # Postgres on localhost:5433
node db/migrate.js --seed     # schema + idempotent alters (+ seed when empty)
npm run dev                   # backend :4000 (node --watch)
cd web && npx vite            # frontend :5173 (proxies same-origin via VITE_API_URL="")
cd web && npx vite build      # always build before committing frontend changes
```

Secrets in `.env` (never committed — copy from the old machine or fill
`.env.example`): DATABASE_URL, JWT_SECRET, PORT, CORS_ORIGIN,
ADMIN_BOOTSTRAP_PASSWORD, ANTHROPIC_API_KEY.

## Production

- Railway project, service **poker-ledger** (NOT the unrelated `poker-tnmt`
  project/service — mixing these up has caused outages before). Postgres is a
  Railway service referenced via `${{Postgres.DATABASE_URL}}`.
- Domain: **www.fp94.vip** (GoDaddy DNS: CNAME `www` → Railway target + TXT
  `_railway-verify.www`; apex forwards to www). Default URL:
  poker-ledger-production-2b54.up.railway.app.
- `railway.json`: build installs+builds `web/`, start = `npm start`.

## Conventions

- Verify money-flow changes with a scripted end-to-end test against
  localhost:4000 before pushing (see git history for examples).
- UI: dark theme, gold accents, `Tile`/badge/chip patterns in
  `web/src/styles.css`; platform logos via `web/src/components/PlatformLogo.jsx`.
- Commit messages explain the WHY; production data is real money — never seed,
  reset, or import sample data against prod.
