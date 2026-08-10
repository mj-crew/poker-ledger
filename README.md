# Poker Ledger

Real-cash ledger + live dashboard for the Flawless Poker Room home game.
See [PLAN.md](PLAN.md) for the full design.

## Run locally

Prereqs: Node 20+, Docker Desktop (for Postgres).

```bash
cp .env.example .env            # then edit JWT_SECRET etc.
npm install
npm run db:up                   # start Postgres (docker-compose, port 5433)
npm run seed                    # create schema + roster + admin bootstrap password
npm run dev                     # API on http://localhost:4000
npm test                        # engine unit tests
```

Log in as admin: username `eMJey55`, password = `ADMIN_BOOTSTRAP_PASSWORD` from `.env`
(you'll be forced to change it on first login).

## API shape

- `POST /api/auth/login` · `POST /api/auth/change-password` · `GET /api/auth/me`
- `GET/POST /api/players`, `PATCH /api/players/:id`  (admin creates accounts)
- `GET/POST /api/nights`, `GET /api/nights/:id`
- `POST /api/nights/:id/tournaments`, `PATCH /api/tournaments/:id`
- `PUT /api/tournaments/:id/players`  (live entries → pool/payouts recompute)
- `PUT /api/tournaments/:id/results`  (finishes → payouts)
- `POST /api/tournaments/:id/finalize`  (zero-sum check → writes ledger)
- `GET /api/live` · `GET /api/standings`  (dashboard, polled)
- `GET /api/account`  (my balance, ledger, who I owe / who owes me)
- `POST /api/settlement/periods/lock`  (admin: snapshot + optimise transfers)
- `POST /api/settlements/:id/mark-paid` · `POST /api/settlements/:id/confirm`
- `POST /api/settlement/periods/:id/settle`  (admin: zero balances)

## Layout

```
db/       schema.sql, seed.sql, migrate.js, docker-compose (Postgres)
src/      server.js, db.js, auth.js
src/lib/  payouts.js, settlement.js   (pure, unit-tested)
src/routes/  auth, players, nights, live, account, settlement
web/      front-end (Vite/React) — next
```
