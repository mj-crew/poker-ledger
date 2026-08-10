# Poker Ledger — Project Plan

A multi-user web app + database for our ~20-friend home game ("Flawless Poker Room" on Club GG).
We play free-money games but settle **real AUD** between ourselves. Players log in, see live
tournaments and their balance, and settle up weekly with two-sided payment confirmation.
Replaces a friend's Excel workbook (`Flawless_Poker_Room_6_Tournaments.xlsx`) with automation.

## Decisions locked in

| Decision        | Choice |
|-----------------|--------|
| Scope           | 20-friend **pooled group game** — multi-user app, group ledger, weekly settlement |
| Users / auth    | Each player logs in (username + password). **Two roles: Admin and Player.** |
| Payout basis    | Our agreed tiered table (configurable). Field size = **total entries incl. re-entries** |
| Format          | Mixed — each tournament is freezeout or has a re-entry price |
| Live updates    | Dashboard shows tournaments **in play** with payouts recomputing in real time |
| Settlement      | **Locked each Sunday**; two-sided confirm (payer marks Paid → receiver Confirms) |
| Stack           | Postgres + Node/Fastify API + React/Vite front-end, deployed on Railway |
| PayIDs          | Not stored — players exchange payment details themselves |
| WhatsApp        | Phase 3 — build the app first, add the bot once the format has settled |

### Payout rule (the House standard)
- 1–5 entries → 1 place (100%)
- 6–10 entries → 2 places (70/30)
- 11+ entries → 3 places (45/35/20)
- Lower places round **up** to nearest $5; the winner absorbs the remainder → payouts always sum
  exactly to the pool and stay $5-clean. (Verified in `test/engines.test.js`.)

## Roles

- **Admin** (Michal): create nights/tournaments, register entries + re-entries during live play
  (payouts update live for everyone), enter finishing positions, finalize a tournament (writes the
  ledger), lock the weekly settlement, manage the roster.
- **Player**: log in; see the dashboard (live tournaments + what each place pays), see **My Account**
  (running balance, everything owed to them and everything they owe); after Sunday lock, mark their
  own transfers **Paid** (as payer) and **Confirm received** (as receiver).

## Screens (Phase 1)

1. **Login**.
2. **Dashboard** — tournaments in play with live pool + payout-per-place; recent results.
3. **My Account** — current balance; list of "you owe X" / "Y owes you", with Paid/Confirm buttons
   once the week is locked.
4. **Admin: Night** — create a night, add up to 6 tournaments, set game/type/buy-in/re-entry, add
   players, update entries live, enter finishes, finalize.
5. **Admin: Settlement** — review the week's net positions, lock it, watch confirmations roll in.

## Safety rails
- **Never guess a person**: low-confidence screenshot handle matches are flagged, never auto-assigned.
- **Zero-sum reconciliation**: `sum(payouts) == pool` per tournament before finalize; settlement
  transfers must net to zero before a period can lock.

## Data model
`players` (login + role) · `handle_aliases` (club names → player) · `payout_structures` (configurable)
· `nights` → `tournaments` → `tournament_players` (entries/re-entries/finish/payout) · `ledger_entries`
(source of truth for balances) · `settlement_periods` (weekly lock) · `settlements` (two-sided confirm)
· `whatsapp_posts` (Phase 3). Full DDL: [db/schema.sql](db/schema.sql).

## Engines (built & tested — `node --test` green)
- [src/lib/payouts.js](src/lib/payouts.js) — tier selection, payout computation, finisher mapping,
  field-size / pool helpers.
- [src/lib/settlement.js](src/lib/settlement.js) — greedy min-cash-flow (≤ N−1 transfers), reproduces
  the workbook's weekly example.

## Phasing

**Phase 1 — the app.** Auth + roles, admin night/tournament entry with live payout updates, player
dashboard + My Account, weekly settlement lock with two-sided confirmation. Deployed on Railway.
(WhatsApp post is drafted here for copy-paste.)

**Phase 2 — screenshot ingest.** Upload the lobby screenshot → extract finish + handle + prize →
fuzzy-match to roster with a review screen → prefill results. Rebuy buy-ins stay manual.

**Phase 3 — WhatsApp bot.** Tiny poster service (Baileys/Whapi) on a **burner number** added as
"Ledger Bot" (never a personal number). One endpoint `POST /post`; app fires it after you approve.

## Build order (Phase 1)
1. Project skeleton: package.json, tsconfig, migration runner, `.env` config.
2. Auth: login, JWT, role middleware, admin account provisioning.
3. API: roster, nights/tournaments CRUD, live entries + payout recompute, finalize → ledger,
   balances, settlement lock + optimiser, two-sided confirm, post-draft generator.
4. Front-end: login, dashboard (live), My Account, admin night, admin settlement.
5. Real-time channel for the live dashboard.
6. Deploy to Railway.
