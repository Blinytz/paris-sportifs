-- ============================================================
-- Classements officiels (endpoint /standings de Highlightly)
-- Migration additive — à exécuter APRÈS schema.sql.
--
-- Rafraîchis par sync_matches.py en rotation par ancienneté, uniquement
-- pour les ligues de catégorie 'championnat', avec un budget quotidien
-- strict (5 requêtes foot, 2 rugby) pour rester sous le quota de
-- 100 requêtes/jour par sous-API :
--   foot  : 31 ligues × 3 dates = 93  + 5 classements = 98/100
--   rugby :  7 ligues × 9 dates = 63  + 2 classements = 65/100
-- ============================================================

-- L'A-League australienne est désactivée pour libérer du quota
-- (décision du 20/07/2026 — priorité : ne jamais dépasser 100/jour).
update leagues set active = false where external_id = 160772;

-- Saison courante d'une ligue, capturée depuis les réponses /matches
-- (champ league.season) — sert de paramètre `season` à /standings.
alter table leagues add column current_season integer;
-- Date du dernier rafraîchissement du classement (pilote la rotation)
alter table leagues add column standings_synced_at timestamptz;

create table standings (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id),
  season integer not null,
  team_id uuid not null references teams(id),
  group_name text,
  position integer not null,
  points numeric,
  games_played integer,
  wins integer,
  draws integer,
  losses integer,
  score_for integer,
  score_against integer,
  synced_at timestamptz not null default now(),
  unique (league_id, season, team_id)
);

create index idx_standings_league on standings (league_id, season);
create index idx_standings_team on standings (team_id);

alter table standings enable row level security;

-- Même modèle que les autres données sportives : lecture authentifiée,
-- écriture réservée au rôle service (aucune policy insert/update client)
create policy "standings_read_all" on standings
  for select using (auth.role() = 'authenticated');
