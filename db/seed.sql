-- Seed: house payout structure + roster (from Flawless Poker Room workbook).
-- Login username defaults to the club username. password_hash is set by the app
-- (admin provisioning / first login) — never stored here. Michal is the admin.

-- House payout structure (agreed rule). field_by = total_entries (entries + re-entries).
--   1-5   -> 1 place  (100%)
--   6-10  -> 2 places (65/35)
--   11+   -> 3 places (50/30/20)
-- Paid exact to the cent (no rounding); winner absorbs the sub-cent remainder (zero-sum).
INSERT INTO payout_structures (name, payload, is_default) VALUES (
  'House standard',
  '{
     "type": "tiered_percent",
     "rounding": "exact_cent_winner_absorbs",
     "field_by": "total_entries",
     "tiers": [
       {"min": 1,  "max": 5,    "places": [100]},
       {"min": 6,  "max": 10,   "places": [65, 35]},
       {"min": 11, "max": null, "places": [50, 30, 20]}
     ]
   }'::jsonb,
   TRUE
);

-- Roster: first_name, login username (= PokerStars screen name), role.
-- `name` is set below to the display label "First [PokerStars name]".
INSERT INTO players (first_name, last_name, name, username, role) VALUES
  ('Noel',    '', 'Noel',    'ThrowingBoos',  'player'),
  ('Peter',   '', 'Peter',   'BigTommyNuts',  'player'),
  ('Michal',  '', 'Michal',  'eMJey55',       'superadmin'),
  ('Toby',    '', 'Toby',    'Toby585',       'player'),
  ('Pranav',  '', 'Pranav',  'Pranav0011',    'player'),
  ('Dan',     '', 'Dan',     'Heretoodohn8',  'player'),
  ('Sleiman', '', 'Sleiman', 'SleimanM',      'player'),
  ('Brahim',  '', 'Brahim',  'GrinderMB',     'player'),
  ('George',  '', 'George',  'KingG007',      'player'),
  ('Will',    '', 'Will',    'Wavies1991',    'player'),
  ('Henry',   '', 'Henry',   '2ezdisgaim',    'player'),
  ('Keegan',  '', 'Keegan',  '9K33GS6',       'player'),
  ('Joe',     '', 'Joe',     'flairwoo85',    'player');
UPDATE players SET name = first_name || ' [' || username || ']';

-- Club screen-names for screenshot matching (same as login username here).
INSERT INTO handle_aliases (player_id, platform, handle)
SELECT id, 'club', username FROM players;
