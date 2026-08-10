-- Seed: house payout structure + roster (from Flawless Poker Room workbook).
-- Login username defaults to the club username. password_hash is set by the app
-- (admin provisioning / first login) — never stored here. Michal is the admin.

-- House payout structure (agreed rule). field_by = total_entries (entries + re-entries).
--   1-5   -> 1 place  (100%)
--   6-10  -> 2 places (65/35)
--   11+   -> 3 places (50/30/20)
-- Lower places round UP to nearest $5; winner absorbs the remainder (zero-sum).
INSERT INTO payout_structures (name, payload, is_default) VALUES (
  'House standard',
  '{
     "type": "tiered_percent",
     "step_cents": 500,
     "rounding": "up_lower_places_winner_absorbs",
     "field_by": "total_entries",
     "tiers": [
       {"min": 1,  "max": 5,    "places": [100]},
       {"min": 6,  "max": 10,   "places": [65, 35]},
       {"min": 11, "max": null, "places": [50, 30, 20]}
     ]
   }'::jsonb,
   TRUE
);

-- Roster: name, login username (= PokerStars screen name), role.
INSERT INTO players (name, username, role) VALUES
  ('Noel',     'ThrowingBoos',  'player'),
  ('Peter',    'BigTommyNuts',  'player'),
  ('Michal',   'eMJey55',       'superadmin'),
  ('Toby',     'Toby585',       'player'),
  ('Pranav',   'Pranav0011',    'player'),
  ('Dan',      'Heretoodohn8',  'player'),
  ('Sleiman',  'SleimanM',      'player'),
  ('Brahim',   'GrinderMB',     'player'),
  ('George',   'KingG007',      'player'),
  ('Will',     'Wavies1991',    'player'),
  ('Henry',    '2ezdisgaim',    'player'),
  ('Keegan',   '9K33GS6',       'player'),
  ('Joe',      'flairwoo85',    'player');

-- Club screen-names for screenshot matching (same as login username here).
INSERT INTO handle_aliases (player_id, platform, handle)
SELECT id, 'club', username FROM players;
