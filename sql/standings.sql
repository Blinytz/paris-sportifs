-- ============================================================
-- Classements officiels (endpoint /standings de Highlightly)
-- Migration additive — à exécuter APRÈS schema.sql.
--
-- Rafraîchis par sync_matches.py chaque matin pour les championnats
-- ayant eu un match terminé depuis leur dernière mise à jour, sur le
-- quota restant du run (sync piloté par le calendrier, voir README).
-- ============================================================

-- Saison courante d'une ligue, capturée depuis les réponses /matches
-- (champ league.season) — sert de paramètre `season` à /standings.
alter table leagues add column current_season integer;
-- Date du dernier rafraîchissement du classement (pilote la rotation)
alter table leagues add column standings_synced_at timestamptz;
-- Date du dernier passage du sync sur cette ligue (null = jamais visitée,
-- déclenche le bootstrap J-1..J+9 ; ensuite le sync est piloté par le
-- calendrier : sonde quotidienne J+9 + suivi des seuls jours de match)
alter table leagues add column last_checked_at timestamptz;

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
