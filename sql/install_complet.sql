-- ============================================================
-- INSTALLATION COMPLÈTE — fichier généré, ne pas éditer à la main.
-- Concaténation de schema.sql + rpc_place_bet.sql + standings.sql
-- (à coller tel quel dans l'éditeur SQL de Supabase).
-- Régénérer après toute modif : voir README.
-- ============================================================

-- ============================================================
-- TABLES
-- ============================================================

create table leagues (
  id uuid primary key default gen_random_uuid(),
  sport text not null check (sport in ('football', 'rugby')),
  external_id integer not null unique,
  name text not null,
  country text,
  category text not null check (category in (
    'championnat', 'coupe_nationale', 'coupe_continentale', 'international'
  )),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table teams (
  id uuid primary key default gen_random_uuid(),
  sport text not null check (sport in ('football', 'rugby')),
  external_id integer not null,
  name text not null,
  rating numeric not null default 1500,
  matches_played integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (sport, external_id)
);

create table matches (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id),
  external_id integer not null unique,
  home_team_id uuid not null references teams(id),
  away_team_id uuid not null references teams(id),
  kickoff_at timestamptz not null,
  status text not null default 'scheduled' check (status in (
    'scheduled', 'live', 'finished', 'postponed', 'cancelled'
  )),
  score_home integer,
  score_away integer,
  odds_locked boolean not null default false,
  elo_applied boolean not null default false,
  last_synced_at timestamptz not null default now()
);

create index idx_matches_kickoff on matches (kickoff_at);
create index idx_matches_status on matches (status);
create index idx_matches_league on matches (league_id);

create table odds_generated (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches(id),
  market text not null default '1x2',
  home_odds numeric not null,
  draw_odds numeric,
  away_odds numeric not null,
  model_version text not null default 'elo-v1',
  generated_at timestamptz not null default now()
);

create index idx_odds_match on odds_generated (match_id);

-- Pari sur le SCORE exact (décision du 20/07/2026, remplace le 1x2 simple) :
-- l'issue (selection) est dérivée du pronostic. Règlement à 3 niveaux :
--   bonne issue           -> gain = potential_payout (mise × cote de l'issue)
--   + bon écart signé     -> gain × bonus_ecart   (model_settings, déf. 1.5)
--   + score exact         -> gain × bonus_score_exact (model_settings, déf. 2)
-- bonus_multiplier est rempli au règlement (1 / 1.5 / 2 selon le cas).
create table bets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  match_id uuid not null references matches(id),
  market text not null default 'score',
  predicted_home integer not null check (predicted_home between 0 and 199),
  predicted_away integer not null check (predicted_away between 0 and 199),
  selection text not null check (selection in ('home', 'draw', 'away')),
  stake_eclats numeric not null check (stake_eclats > 0),
  odds_at_bet numeric not null,
  potential_payout numeric not null,
  bonus_multiplier numeric,
  status text not null default 'pending' check (status in (
    'pending', 'won', 'lost', 'void'
  )),
  placed_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index idx_bets_user on bets (user_id);
create index idx_bets_match on bets (match_id);
create index idx_bets_status on bets (status);

create table eclats_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  amount numeric not null,
  source text not null default 'paris_sportifs',
  reference_id uuid,
  created_at timestamptz not null default now()
);

create index idx_ledger_user on eclats_ledger (user_id);

-- ============================================================
-- RLS (Row Level Security)
-- ============================================================

alter table leagues enable row level security;
alter table teams enable row level security;
alter table matches enable row level security;
alter table odds_generated enable row level security;
alter table bets enable row level security;
alter table eclats_ledger enable row level security;

-- Lecture publique (authentifié) sur les données sportives
create policy "leagues_read_all" on leagues for select using (auth.role() = 'authenticated');
create policy "teams_read_all" on teams for select using (auth.role() = 'authenticated');
create policy "matches_read_all" on matches for select using (auth.role() = 'authenticated');
create policy "odds_read_all" on odds_generated for select using (auth.role() = 'authenticated');

-- Écriture sur ces 4 tables réservée au rôle service (le script de sync), jamais au client
-- (pas de policy insert/update pour le rôle authenticated = refusé par défaut)

-- bets : chacun ne voit et ne modifie que ses propres paris
create policy "bets_select_own" on bets for select using (auth.uid() = user_id);
create policy "bets_insert_own" on bets for insert with check (auth.uid() = user_id);
-- pas de policy update/delete côté client : la résolution des paris se fait uniquement
-- via le script de settlement (rôle service, qui bypass RLS)

-- eclats_ledger : chacun ne voit que ses propres transactions, écriture réservée au service
create policy "ledger_select_own" on eclats_ledger for select using (auth.uid() = user_id);
-- pas de policy insert côté client : toute écriture de solde passe par le service role
-- (évite qu'un client triche sur son propre solde d'Éclats)

-- Paramètres du modèle, modifiables via la page réglages de la PWA.
-- Une seule ligne (singleton). Le script de sync lit ces valeurs à
-- chaque run au lieu d'utiliser des constantes en dur.
create table model_settings (
  id text primary key default 'default',
  elo_k_factor numeric not null default 32,
  home_advantage_football numeric not null default 65,
  home_advantage_rugby numeric not null default 50,
  margin_factor numeric not null default 1.05,
  odds_min numeric not null default 1.05,
  odds_max numeric not null default 15.00,
  draw_base_prob numeric not null default 0.28,
  draw_min_prob numeric not null default 0.15,
  draw_max_prob numeric not null default 0.30,
  draw_gap_divisor numeric not null default 4000,
  -- Nul au rugby : pariable aussi (marché 3 voies), probabilité faible
  draw_base_prob_rugby numeric not null default 0.04,
  draw_min_prob_rugby numeric not null default 0.02,
  draw_max_prob_rugby numeric not null default 0.05,
  -- Bonus du pari sur score : bon écart signé / score exact.
  -- Cas particulier : un pronostic de nul gagnant a toujours le bon écart
  -- (0), son bonus écart est donc réduit (bonus_ecart_nul) pour ne pas
  -- rendre le pari nul systématiquement trop rentable.
  bonus_ecart numeric not null default 1.5,
  bonus_ecart_nul numeric not null default 1.25,
  bonus_score_exact numeric not null default 2.0,
  form_window_size integer not null default 5,
  updated_at timestamptz not null default now()
);

insert into model_settings (id) values ('default');

-- Statistiques par équipe ET par compétition, recalculées après chaque
-- match terminé de cette équipe dans cette compétition. La vue globale
-- (toutes compétitions confondues) est calculée à la volée par agrégation
-- (voir vue team_global_stats plus bas), jamais stockée séparément.
create table team_competition_stats (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id),
  league_id uuid not null references leagues(id),
  matches_played integer not null default 0,
  wins integer not null default 0,
  draws integer not null default 0,
  losses integer not null default 0,
  score_for integer not null default 0,
  score_against integer not null default 0,
  home_matches_played integer not null default 0,
  home_wins integer not null default 0,
  home_draws integer not null default 0,
  home_losses integer not null default 0,
  home_score_for integer not null default 0,
  home_score_against integer not null default 0,
  away_matches_played integer not null default 0,
  away_wins integer not null default 0,
  away_draws integer not null default 0,
  away_losses integer not null default 0,
  away_score_for integer not null default 0,
  away_score_against integer not null default 0,
  current_streak text,
  last_results text,
  updated_at timestamptz not null default now(),
  unique (team_id, league_id)
);

create index idx_team_comp_stats_team on team_competition_stats (team_id);
create index idx_team_comp_stats_league on team_competition_stats (league_id);

create view team_global_stats as
select
  team_id,
  sum(matches_played) as matches_played,
  sum(wins) as wins,
  sum(draws) as draws,
  sum(losses) as losses,
  sum(score_for) as score_for,
  sum(score_against) as score_against,
  sum(home_matches_played) as home_matches_played,
  sum(home_wins) as home_wins,
  sum(home_draws) as home_draws,
  sum(home_losses) as home_losses,
  sum(home_score_for) as home_score_for,
  sum(home_score_against) as home_score_against,
  sum(away_matches_played) as away_matches_played,
  sum(away_wins) as away_wins,
  sum(away_draws) as away_draws,
  sum(away_losses) as away_losses,
  sum(away_score_for) as away_score_for,
  sum(away_score_against) as away_score_against
from team_competition_stats
group by team_id;

-- ============================================================
-- SEED : les 39 compétitions (section 1)
-- ============================================================

insert into leagues (sport, category, external_id, name, country) values
('football', 'championnat', 52695, 'Ligue 1', 'France'),
('football', 'championnat', 53546, 'Ligue 2', 'France'),
('football', 'championnat', 33973, 'Premier League', 'England'),
('football', 'championnat', 119924, 'La Liga', 'Spain'),
('football', 'championnat', 67162, 'Bundesliga', 'Germany'),
('football', 'championnat', 115669, 'Serie A', 'Italy'),
('football', 'championnat', 84182, 'J1 League', 'Japan'),
('football', 'championnat', 61205, 'Serie A', 'Brazil'),
('football', 'championnat', 223746, 'Liga MX', 'Mexico'),
('football', 'championnat', 160772, 'A-League', 'Australia'),
('football', 'championnat', 249276, 'K League 1', 'South Korea'),
('football', 'championnat', 216087, 'Major League Soccer', 'USA'),
('football', 'championnat', 55248, 'Feminine Division 1', 'France'),
('football', 'coupe_nationale', 39079, 'FA Cup', 'England'),
('football', 'coupe_nationale', 56950, 'Coupe de France', 'France'),
('football', 'coupe_nationale', 117371, 'Coppa Italia', 'Italy'),
('football', 'coupe_nationale', 69715, 'DFB Pokal', 'Germany'),
('football', 'coupe_nationale', 122477, 'Copa del Rey', 'Spain'),
('football', 'coupe_continentale', 2486, 'UEFA Champions League', 'World'),
('football', 'coupe_continentale', 3337, 'UEFA Europa League', 'World'),
('football', 'coupe_continentale', 722432, 'UEFA Europa Conference League', 'World'),
('football', 'coupe_continentale', 11847, 'CONMEBOL Libertadores', 'World'),
('football', 'coupe_continentale', 10145, 'CONMEBOL Sudamericana', 'World'),
('football', 'international', 1635, 'World Cup', 'World'),
('football', 'international', 4188, 'Euro Championship', 'World'),
('football', 'international', 5039, 'UEFA Nations League', 'World'),
('football', 'international', 8443, 'Copa America', 'World'),
('football', 'international', 5890, 'Africa Cup of Nations', 'World'),
('football', 'international', 6741, 'Asian Cup', 'World'),
('football', 'international', 19506, 'CONCACAF Gold Cup', 'World'),
('football', 'international', 456920, 'CONCACAF Nations League', 'World'),
('rugby', 'championnat', 14400, 'Top 14', 'France'),
('rugby', 'championnat', 15251, 'Pro D2', 'France'),
('rugby', 'coupe_continentale', 46738, 'European Rugby Champions Cup', 'World'),
('rugby', 'coupe_continentale', 45036, 'Challenge Cup', 'World'),
('rugby', 'international', 44185, 'Six Nations', 'World'),
('rugby', 'international', 48440, 'Six Nations U20', 'World'),
('rugby', 'international', 73119, 'Rugby Championship', 'World'),
('rugby', 'international', 59503, 'World Cup', 'World');

-- ============================================================
-- RPC place_bet — placement de pari sur SCORE, atomique (règle 8)
--
-- Pourquoi une fonction et pas des insert côté client :
-- la RLS interdit toute écriture client sur eclats_ledger (anti-triche),
-- mais le débit de la mise doit être créé atomiquement avec la ligne de
-- pari. Cette fonction SECURITY DEFINER est donc le seul chemin d'écriture
-- autorisé pour placer un pari : elle vérifie tout côté serveur (match
-- ouvert, cote courante, solde) puis crée bets + eclats_ledger dans la
-- même transaction.
--
-- Le pari porte sur un score exact (p_home / p_away). L'issue (home/draw/
-- away) en est dérivée ; la cote appliquée est celle de cette issue. Le
-- nul est pariable au rugby comme au foot (marché 3 voies partout).
--
-- À exécuter APRÈS schema.sql.
-- ============================================================

create or replace function place_bet(
  p_match_id uuid,
  p_home integer,
  p_away integer,
  p_stake numeric
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_match matches%rowtype;
  v_odds odds_generated%rowtype;
  v_selection text;
  v_odd numeric;
  v_balance numeric;
  v_bet_id uuid;
begin
  if v_user is null then
    raise exception 'Non authentifié';
  end if;
  if p_stake is null or p_stake <= 0 then
    raise exception 'Mise invalide';
  end if;
  if p_home is null or p_away is null
     or p_home not between 0 and 199 or p_away not between 0 and 199 then
    raise exception 'Score pronostiqué invalide';
  end if;

  -- Sérialise les paris d'un même utilisateur (évite deux paris simultanés
  -- qui passeraient chacun le contrôle de solde)
  perform pg_advisory_xact_lock(hashtext(v_user::text));

  select * into v_match from matches where id = p_match_id for update;
  if not found then
    raise exception 'Match introuvable';
  end if;
  -- Règle 4 : aucun pari si cotes verrouillées ou match non "scheduled"
  if v_match.status <> 'scheduled' or v_match.odds_locked or v_match.kickoff_at <= now() then
    raise exception 'Paris fermés sur ce match';
  end if;

  v_selection := case
    when p_home > p_away then 'home'
    when p_home < p_away then 'away'
    else 'draw'
  end;

  -- Cote courante = la plus récente générée pour ce match (prise côté
  -- serveur, jamais fournie par le client)
  select * into v_odds
  from odds_generated
  where match_id = p_match_id
  order by generated_at desc
  limit 1;
  if not found then
    raise exception 'Aucune cote disponible pour ce match';
  end if;
  v_odd := case v_selection
    when 'home' then v_odds.home_odds
    when 'draw' then v_odds.draw_odds
    else v_odds.away_odds
  end;
  if v_odd is null then
    raise exception 'Cote indisponible pour cette issue';
  end if;

  -- Règle 8 : solde = somme de toutes les entrées ledger, toutes sources
  select coalesce(sum(amount), 0) into v_balance
  from eclats_ledger where user_id = v_user;
  if v_balance < p_stake then
    raise exception 'Solde insuffisant : % Éclats disponibles', v_balance;
  end if;

  insert into bets (user_id, match_id, predicted_home, predicted_away,
                    selection, stake_eclats, odds_at_bet, potential_payout)
  values (v_user, p_match_id, p_home, p_away,
          v_selection, p_stake, v_odd, round(p_stake * v_odd, 2))
  returning id into v_bet_id;

  insert into eclats_ledger (user_id, amount, source, reference_id)
  values (v_user, -p_stake, 'paris_sportifs_mise', v_bet_id);

  return v_bet_id;
end
$$;

revoke all on function place_bet(uuid, integer, integer, numeric) from public, anon;
grant execute on function place_bet(uuid, integer, integer, numeric) to authenticated;

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
