-- Poker Ledger — schema v3 (multi-user app)
-- A NIGHT holds up to 6 TOURNAMENTS; each tournament has players with
-- entries/re-entries. Payouts are computed from the agreed payout structure
-- (field size = TOTAL entries incl. re-entries). Balances net across a weekly
-- SETTLEMENT PERIOD into minimum transfers, which players confirm two-sided.
--
-- Money = integer cents (AUD). Balances DERIVED from ledger_entries.

-- ---------------------------------------------------------------------------
-- Players / users (login + role)
-- ---------------------------------------------------------------------------
CREATE TABLE players (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,              -- display name
  username      TEXT        NOT NULL UNIQUE,       -- login
  password_hash TEXT,                              -- set on provisioning / first login
  role          TEXT        NOT NULL DEFAULT 'player',  -- 'superadmin' | 'admin' | 'player'
  capabilities  JSONB       NOT NULL DEFAULT '[]'::jsonb, -- granted capability keys (admins only)
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE, -- force change after temp password
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT players_role_chk CHECK (role IN ('superadmin','admin','player'))
);

-- Club screen-names -> player, for matching lobby screenshots. May differ from login username.
CREATE TABLE handle_aliases (
  id        BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  platform  TEXT   NOT NULL DEFAULT 'club',
  handle    TEXT   NOT NULL,
  UNIQUE (platform, handle)
);

-- ---------------------------------------------------------------------------
-- Payout structures — configurable agreed real-cash payout tables
-- ---------------------------------------------------------------------------
-- field_by = "total_entries": tier chosen by SUM(entries + reentries).
CREATE TABLE payout_structures (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT        NOT NULL UNIQUE,
  payload    JSONB       NOT NULL,
  is_default BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Nights & tournaments
-- ---------------------------------------------------------------------------
CREATE TABLE nights (
  id         BIGSERIAL PRIMARY KEY,
  played_on  DATE        NOT NULL,
  label      TEXT,
  status     TEXT        NOT NULL DEFAULT 'open',   -- open | closed
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tournaments (
  id                  BIGSERIAL PRIMARY KEY,
  night_id            BIGINT      REFERENCES nights(id) ON DELETE CASCADE, -- legacy, unused
  played_on           DATE        NOT NULL DEFAULT CURRENT_DATE,           -- the tournament's date
  seq                 INTEGER     NOT NULL DEFAULT 1,      -- legacy ordering
  game_type           TEXT,
  tournament_type     TEXT        NOT NULL DEFAULT 'Regular',
  buyin_cents         INTEGER     NOT NULL,
  reentry_cents       INTEGER     NOT NULL DEFAULT 0,      -- 0 => freezeout
  rego_open           BOOLEAN     NOT NULL DEFAULT TRUE,   -- manual fallback when no start time is set
  starts_at           TIMESTAMPTZ,                          -- scheduled start (drives live countdowns)
  late_reg_minutes    INTEGER,                              -- minutes late registration stays open after start
  currency            TEXT        NOT NULL DEFAULT 'AUD',
  payout_structure_id BIGINT      REFERENCES payout_structures(id),
  status              TEXT        NOT NULL DEFAULT 'draft',-- draft | live | reconciled | finalized
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (night_id, seq),
  CONSTRAINT tournaments_status_chk CHECK (status IN ('draft','live','reconciled','finalized'))
);

-- One row per player per tournament. invested = entries*buyin + reentries*reentry.
-- During 'live' play we update entries/reentries so pool + payouts recompute in real time.
CREATE TABLE tournament_players (
  id               BIGSERIAL PRIMARY KEY,
  tournament_id    BIGINT  NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id        BIGINT  NOT NULL REFERENCES players(id),
  entries          INTEGER NOT NULL DEFAULT 1,
  reentries        INTEGER NOT NULL DEFAULT 0,
  invested_cents   INTEGER NOT NULL DEFAULT 0,
  finish_position  INTEGER,
  play_prize_cents INTEGER,
  payout_cents     INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  UNIQUE (tournament_id, player_id)
);

-- ---------------------------------------------------------------------------
-- Ledger — source of truth for balances
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  player_id     BIGINT  NOT NULL REFERENCES players(id),
  tournament_id BIGINT  REFERENCES tournaments(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL,           -- 'buyin' | 'payout' | 'adjustment' | 'settlement'
  amount_cents  INTEGER NOT NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_player_idx ON ledger_entries(player_id);
CREATE INDEX ledger_entries_tournament_idx ON ledger_entries(tournament_id);

-- ---------------------------------------------------------------------------
-- Weekly settlement: lock a period, then two-sided confirmation per transfer
-- ---------------------------------------------------------------------------
CREATE TABLE settlement_periods (
  id         BIGSERIAL PRIMARY KEY,
  label      TEXT,                                   -- 'Week of 27 Jul 2026'
  starts_on  DATE,
  ends_on    DATE,
  status            TEXT        NOT NULL DEFAULT 'open',    -- open | locked | settled
  locked_at         TIMESTAMPTZ,
  balances_reset_at TIMESTAMPTZ,                             -- when this week's balances were zeroed (new week started)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT settlement_periods_status_chk CHECK (status IN ('open','locked','settled'))
);

-- A directed transfer produced by the optimiser when a period locks.
-- payer marks paid -> receiver confirms received. Done only when both agree.
CREATE TABLE settlements (
  id                   BIGSERIAL PRIMARY KEY,
  period_id            BIGINT  NOT NULL REFERENCES settlement_periods(id) ON DELETE CASCADE,
  from_player_id       BIGINT  NOT NULL REFERENCES players(id),   -- pays
  to_player_id         BIGINT  NOT NULL REFERENCES players(id),   -- receives
  amount_cents         INTEGER NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'pending',        -- pending | paid | confirmed | disputed
  payer_marked_at      TIMESTAMPTZ,
  receiver_confirmed_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT settlements_status_chk CHECK (status IN ('pending','paid','confirmed','disputed'))
);
CREATE INDEX settlements_period_idx ON settlements(period_id);
CREATE INDEX settlements_from_idx ON settlements(from_player_id);
CREATE INDEX settlements_to_idx ON settlements(to_player_id);

-- Drafted / sent WhatsApp posts (Phase 3).
CREATE TABLE whatsapp_posts (
  id         BIGSERIAL PRIMARY KEY,
  night_id   BIGINT REFERENCES nights(id) ON DELETE CASCADE,
  body       TEXT   NOT NULL,
  status     TEXT   NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at    TIMESTAMPTZ
);

-- Current balance per player, derived from the ledger.
CREATE VIEW player_balances AS
  SELECT p.id AS player_id, p.name,
         COALESCE(SUM(le.amount_cents), 0) AS balance_cents
  FROM players p
  LEFT JOIN ledger_entries le ON le.player_id = p.id
  GROUP BY p.id, p.name;
