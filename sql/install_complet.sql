-- ============================================================
-- INSTALLATION COMPLÈTE (base neuve) — fichier généré.
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
  logo_url text,
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
  resolved_at timestamptz,
  -- Collecte manuelle : les gains ne rejoignent le portefeuille que
  -- lorsque l'utilisateur les récolte dans l'app (voir collect_winnings)
  collected_at timestamptz
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

-- bets : chacun ne voit que ses propres paris. Toute création passe par
-- place_bet(), qui vérifie atomiquement la cote, le solde et le débit.
create policy "bets_select_own" on bets for select using (auth.uid() = user_id);
revoke insert on bets from authenticated;
-- pas de policy update/delete côté client : la résolution des paris se fait uniquement
-- via le script de settlement (rôle service, qui bypass RLS)

-- eclats_ledger : chacun ne voit que ses propres transactions, écriture réservée au service
create policy "ledger_select_own" on eclats_ledger for select using (auth.uid() = user_id);
-- pas de policy insert côté client : toute écriture de solde passe par le service role
-- (évite qu'un client triche sur son propre solde d'Éclats)

-- Compte(s) autorisé(s) à administrer les réglages économiques.
create table app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table app_admins enable row level security;
revoke all on app_admins from anon, authenticated;

create or replace function is_app_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from app_admins where user_id = auth.uid()
  );
$$;
revoke all on function is_app_admin() from public, anon;
grant execute on function is_app_admin() to authenticated;

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
  -- Mise appliquée automatiquement par les paris rapides (accueil)
  default_stake numeric not null default 100,
  form_window_size integer not null default 5,
  pp_par_pari numeric not null default 10,
  pp_bonne_issue numeric not null default 15,
  pp_bon_ecart numeric not null default 25,
  pp_score_exact numeric not null default 50,
  updated_at timestamptz not null default now()
);

insert into model_settings (id) values ('default');

-- Les nouveaux projets Supabase activent la RLS par défaut sur toute
-- table créée : sans policy, l'utilisateur connecté ne voit rien (constaté
-- le 20/07/2026). Lecture + modification (page Réglages) explicites :
alter table model_settings enable row level security;
create policy "settings_read_auth" on model_settings
  for select using (auth.role() = 'authenticated');
create policy "settings_update_admin" on model_settings
  for update using (is_app_admin())
  with check (is_app_admin());

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

-- Même raison que model_settings : RLS par défaut, lecture authentifiée
-- explicite (écriture réservée au rôle service, comme les autres stats)
alter table team_competition_stats enable row level security;
create policy "team_comp_stats_read_all" on team_competition_stats
  for select using (auth.role() = 'authenticated');

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
('rugby', 'international', 124179, 'Nations Championship', 'World'),
('rugby', 'international', 77374, 'Pacific Nations Cup', 'World'),
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
          v_selection, p_stake, v_odd, ceil(p_stake * v_odd))
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

-- ============================================================
-- Refonte du 22/07/2026 : logos d'équipes + collecte manuelle des gains
--
-- Migration à exécuter sur une base déjà installée (schema.sql neuf
-- contient déjà tout ceci).
-- ============================================================

-- 1. Logos des équipes (fournis par Highlightly, jamais stockés jusqu'ici)
alter table teams add column if not exists logo_url text;

-- 2. Collecte manuelle : un pari gagné (ou remboursé) n'est plus crédité
-- automatiquement. Le script de règlement le marque seulement ; les
-- Éclats n'arrivent au portefeuille que lorsque l'utilisateur les
-- récolte depuis l'app.
alter table bets add column if not exists collected_at timestamptz;

-- 3. Fonction de collecte. SECURITY DEFINER pour la même raison que
-- place_bet : la RLS interdit toute écriture client sur eclats_ledger.
-- Idempotente et atomique : le verrou de ligne + le filtre
-- collected_at is null empêchent tout double crédit, même si l'app
-- envoie deux fois la demande.
create or replace function collect_winnings(p_bet_ids uuid[] default null)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_bet record;
  v_montant numeric;
  v_total numeric := 0;
begin
  if v_user is null then
    raise exception 'Non authentifié';
  end if;

  -- Sérialise les collectes d'un même utilisateur
  perform pg_advisory_xact_lock(hashtext(v_user::text));

  for v_bet in
    select * from bets
    where user_id = v_user
      and collected_at is null
      and status in ('won', 'void')
      and (p_bet_ids is null or id = any(p_bet_ids))
    order by resolved_at
    for update
  loop
    -- Pari gagné : mise × cote × bonus. Pari remboursé : la mise.
    v_montant := case v_bet.status
      when 'won' then ceil(v_bet.potential_payout
                           * coalesce(v_bet.bonus_multiplier, 1))
      else v_bet.stake_eclats
    end;

    insert into eclats_ledger (user_id, amount, source, reference_id)
    values (v_user, v_montant,
            case v_bet.status when 'won' then 'paris_sportifs_gain'
                              else 'paris_sportifs_remboursement' end,
            v_bet.id);

    update bets set collected_at = now() where id = v_bet.id;
    v_total := v_total + v_montant;
  end loop;

  return v_total;
end
$$;

revoke all on function collect_winnings(uuid[]) from public, anon;
grant execute on function collect_winnings(uuid[]) to authenticated;

-- 4. Reprise de l'existant : les paris déjà réglés avant cette refonte
-- ont été crédités automatiquement ; on les marque comme collectés pour
-- qu'ils n'apparaissent pas à tort dans « à collecter ».
update bets set collected_at = resolved_at
where collected_at is null and status in ('won', 'lost', 'void');

-- ============================================================
-- Brouillons de pronostic + bonus rugby (23/07/2026)
--
-- Principe (calqué sur MPP) : un score saisi est ENREGISTRÉ tout de
-- suite, mais le pari n'est VALIDÉ qu'au coup d'envoi. Tant que le match
-- n'a pas commencé, le pronostic reste modifiable de partout ; à
-- l'heure du match il devient un pari ferme et la mise est débitée.
-- ============================================================

-- 1. Bonus propres au rugby : le score exact y est bien plus difficile
-- (×10), et le « bon écart » se juge par tranche de points.
alter table model_settings
  add column if not exists bonus_score_exact_rugby numeric not null default 10,
  add column if not exists bonus_ecart_rugby numeric not null default 1.5;

-- 2. Brouillons : un seul par match et par utilisateur.
-- Aucun Éclat n'est engagé à ce stade, donc le client peut écrire
-- directement (contrairement à bets et eclats_ledger).
create table if not exists bet_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  match_id uuid not null references matches(id),
  predicted_home integer not null check (predicted_home between 0 and 199),
  predicted_away integer not null check (predicted_away between 0 and 199),
  stake_eclats numeric not null check (stake_eclats > 0),
  updated_at timestamptz not null default now(),
  -- Renseignés si la validation au coup d'envoi a échoué (solde
  -- insuffisant, cote manquante) : le brouillon reste alors visible dans
  -- l'app avec sa raison, au lieu de disparaître sans explication.
  rejected_at timestamptz,
  rejected_reason text,
  unique (user_id, match_id)
);

alter table bet_drafts add column if not exists rejected_at timestamptz;
alter table bet_drafts add column if not exists rejected_reason text;

create index if not exists idx_drafts_user on bet_drafts (user_id);

alter table bet_drafts enable row level security;

-- Lecture de ses propres brouillons
drop policy if exists "drafts_select_own" on bet_drafts;
create policy "drafts_select_own" on bet_drafts
  for select using (auth.uid() = user_id);

-- Écriture autorisée uniquement tant que le match n'a pas commencé :
-- c'est la base qui fige le pronostic à l'heure du coup d'envoi.
drop policy if exists "drafts_insert_own" on bet_drafts;
create policy "drafts_insert_own" on bet_drafts
  for insert with check (
    auth.uid() = user_id and exists (
      select 1 from matches m where m.id = match_id
        and m.status = 'scheduled' and m.kickoff_at > now()));

drop policy if exists "drafts_update_own" on bet_drafts;
create policy "drafts_update_own" on bet_drafts
  for update using (
    auth.uid() = user_id and exists (
      select 1 from matches m where m.id = match_id
        and m.status = 'scheduled' and m.kickoff_at > now()))
  with check (auth.uid() = user_id);

-- Suppression : tant que le match n'a pas commencé, ou bien à tout
-- moment pour se débarrasser d'un brouillon rejeté (accusé de réception)
drop policy if exists "drafts_delete_own" on bet_drafts;
create policy "drafts_delete_own" on bet_drafts
  for delete using (
    auth.uid() = user_id and (
      rejected_at is not null
      or exists (
        select 1 from matches m where m.id = match_id
          and m.status = 'scheduled' and m.kickoff_at > now())));

grant select, insert, update, delete on bet_drafts to authenticated;
grant all on bet_drafts to service_role;

-- 3. Validation automatique : transforme en paris fermes tous les
-- brouillons dont le match a commencé. Appelée par les scripts de sync
-- (rôle service), donc sans dépendre de l'app ouverte.
-- Idempotente : le brouillon est supprimé une fois converti.
create or replace function validate_due_drafts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft record;
  v_odds odds_generated%rowtype;
  v_selection text;
  v_odd numeric;
  v_solde numeric;
  v_bet_id uuid;
  v_valides integer := 0;
begin
  for v_draft in
    select d.*, m.kickoff_at
    from bet_drafts d
    join matches m on m.id = d.match_id
    where m.kickoff_at <= now()
      and d.rejected_at is null
    order by m.kickoff_at   -- premier match commencé, premier servi
    for update of d
  loop
    -- Cote figée avant le coup d'envoi (jamais une cote postérieure)
    select * into v_odds
    from odds_generated
    where match_id = v_draft.match_id
      and generated_at <= v_draft.kickoff_at
    order by generated_at desc
    limit 1;

    v_selection := case
      when v_draft.predicted_home > v_draft.predicted_away then 'home'
      when v_draft.predicted_home < v_draft.predicted_away then 'away'
      else 'draw'
    end;
    v_odd := case v_selection
      when 'home' then v_odds.home_odds
      when 'draw' then v_odds.draw_odds
      else v_odds.away_odds
    end;

    select coalesce(sum(amount), 0) into v_solde
    from eclats_ledger where user_id = v_draft.user_id;

    -- Rien n'est jamais forcé : sans cote ou sans solde suffisant, aucun
    -- Éclat n'est engagé et aucune dette n'est créée. Mais le brouillon
    -- n'est pas effacé pour autant : il est marqué avec sa raison, pour
    -- que l'app puisse l'expliquer au lieu de le faire disparaître.
    if v_odd is null then
      update bet_drafts
      set rejected_at = now(),
          rejected_reason = 'Aucune cote disponible pour ce match'
      where id = v_draft.id;
    elsif v_solde < v_draft.stake_eclats then
      update bet_drafts
      set rejected_at = now(),
          rejected_reason = 'Solde insuffisant au coup d''envoi : '
            || round(v_solde) || ' Éclats disponibles pour une mise de '
            || round(v_draft.stake_eclats)
      where id = v_draft.id;
    else
      insert into bets (user_id, match_id, predicted_home, predicted_away,
                        selection, stake_eclats, odds_at_bet, potential_payout)
      values (v_draft.user_id, v_draft.match_id, v_draft.predicted_home,
              v_draft.predicted_away, v_selection, v_draft.stake_eclats,
              v_odd, ceil(v_draft.stake_eclats * v_odd))
      returning id into v_bet_id;

      insert into eclats_ledger (user_id, amount, source, reference_id)
      values (v_draft.user_id, -v_draft.stake_eclats,
              'paris_sportifs_mise', v_bet_id);

      v_valides := v_valides + 1;
      delete from bet_drafts where id = v_draft.id;
    end if;
  end loop;

  return v_valides;
end
$$;

revoke all on function validate_due_drafts() from public, anon, authenticated;
grant execute on function validate_due_drafts() to service_role;

-- Finaliser l'installation avec reservation_immediate.sql pour activer
-- la réservation immédiate et atomique des mises.

-- ============================================================
-- Compétitions ajoutées le 23/07/2026
--
-- Nations Championship : nouveau tournoi opposant les meilleures
-- nations de l'hémisphère nord et sud, absent de la spec initiale
-- (première édition en 2026). Identifiant retrouvé via probe_api.py.
-- Pacific Nations Cup ajoutée dans la foulée : elle occupe la même
-- fenêtre estivale et complète le calendrier international.
-- ============================================================

insert into leagues (sport, category, external_id, name, country)
values
  ('rugby', 'international', 124179, 'Nations Championship', 'World'),
  ('rugby', 'international', 77374, 'Pacific Nations Cup', 'World')
on conflict (external_id) do nothing;

-- ============================================================
-- Paliers et points de pronostiqueur (23/07/2026)
--
-- Progression PROPRE AUX PARIS, indépendante du solde d'Éclats (qui est
-- partagé avec les autres apps). Les « points de pronostiqueur » (PP) ne
-- font que monter : ils récompensent l'activité et l'adresse, jamais le
-- solde courant.
--
-- 18 paliers : D4→D1 avec 4 rangs chacun (Remplaçant, Titulaire, Cadre,
-- Capitaine), puis International, puis Ballon d'Or. Chaque palier atteint
-- débloque une prime d'Éclats à réclamer manuellement.
-- ============================================================

-- ---------- Table de définition des paliers (source unique) ----------
create table if not exists paliers (
  idx integer primary key,
  division text not null,
  rang text,
  name text not null,
  pp_min integer not null,
  eclats_bonus numeric not null default 0
);

alter table paliers enable row level security;
drop policy if exists "paliers_read" on paliers;
create policy "paliers_read" on paliers
  for select using (auth.role() = 'authenticated');
create policy "paliers_update_admin" on paliers
  for update using (is_app_admin())
  with check (is_app_admin());
grant select on paliers to authenticated;
grant update on paliers to authenticated;
grant all on paliers to service_role;

insert into paliers (idx, division, rang, name, pp_min, eclats_bonus) values
  (1,  'D4', 'Remplaçant', 'D4 Remplaçant', 0,     0),
  (2,  'D4', 'Titulaire',  'D4 Titulaire',  150,   250),
  (3,  'D4', 'Cadre',      'D4 Cadre',      400,   500),
  (4,  'D4', 'Capitaine',  'D4 Capitaine',  800,   500),
  (5,  'D3', 'Remplaçant', 'D3 Remplaçant', 1400,  750),
  (6,  'D3', 'Titulaire',  'D3 Titulaire',  2200,  750),
  (7,  'D3', 'Cadre',      'D3 Cadre',      3200,  1000),
  (8,  'D3', 'Capitaine',  'D3 Capitaine',  4400,  1000),
  (9,  'D2', 'Remplaçant', 'D2 Remplaçant', 5800,  1500),
  (10, 'D2', 'Titulaire',  'D2 Titulaire',  7500,  1500),
  (11, 'D2', 'Cadre',      'D2 Cadre',      9500,  2000),
  (12, 'D2', 'Capitaine',  'D2 Capitaine',  12000, 2500),
  (13, 'D1', 'Remplaçant', 'D1 Remplaçant', 15000, 3000),
  (14, 'D1', 'Titulaire',  'D1 Titulaire',  18500, 4000),
  (15, 'D1', 'Cadre',      'D1 Cadre',      22500, 5000),
  (16, 'D1', 'Capitaine',  'D1 Capitaine',  27000, 6000),
  (17, 'International', null, 'International', 33000, 8000),
  (18, 'Ballon d''Or',   null, 'Ballon d''Or', 40000, 10000)
on conflict (idx) do update set
  division = excluded.division, rang = excluded.rang, name = excluded.name,
  pp_min = excluded.pp_min, eclats_bonus = excluded.eclats_bonus;

-- ---------- Points de pronostiqueur ----------
-- Barème (par pari réglé, gagné ou perdu) :
--   10  base de participation
--   +15 bonne issue · +25 bon écart · +50 score exact (gagnés)
-- Les paris remboursés (match annulé) et en cours ne comptent pas.
-- Le niveau de bonus se lit sur bonus_multiplier : >1 = écart, >=2 = exact
-- (foot exact 2, rugby exact 10, écarts 1.25/1.5).
create or replace function pronostiqueur_points()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(sum(
    s.pp_par_pari + case when b.status = 'won' then
      case when b.bonus_multiplier >= 2 then s.pp_score_exact
           when b.bonus_multiplier > 1 then s.pp_bon_ecart
           else s.pp_bonne_issue end
    else 0 end
  ), 0)::integer
  from bets b
  cross join model_settings s
  where b.user_id = auth.uid()
    and b.status in ('won', 'lost')
    and s.id = 'default';
$$;

revoke all on function pronostiqueur_points() from public, anon;
grant execute on function pronostiqueur_points() to authenticated;

-- ---------- Suivi des primes déjà réclamées ----------
create table if not exists palier_claims (
  user_id uuid not null references auth.users(id),
  palier_idx integer not null references paliers(idx),
  claimed_at timestamptz not null default now(),
  primary key (user_id, palier_idx)
);

alter table palier_claims enable row level security;
drop policy if exists "claims_select_own" on palier_claims;
create policy "claims_select_own" on palier_claims
  for select using (auth.uid() = user_id);
-- Pas de policy d'écriture : seule la fonction claim (SECURITY DEFINER)
-- insère, ce qui empêche de s'auto-créditer une prime.
grant select on palier_claims to authenticated;
grant all on palier_claims to service_role;

-- ---------- Réclamation des primes de palier ----------
-- Crédite toutes les primes des paliers atteints mais pas encore réclamés.
-- Atomique et idempotente (clé primaire + advisory lock) : rejouer ne
-- crédite jamais deux fois. Retourne le total crédité.
create or replace function claim_palier_rewards()
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_pp integer;
  v_total numeric := 0;
  r record;
begin
  if v_user is null then
    raise exception 'Non authentifié';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_user::text || ':palier'));
  select pronostiqueur_points() into v_pp;

  for r in
    select p.idx, p.eclats_bonus
    from paliers p
    where p.pp_min <= v_pp and p.eclats_bonus > 0
      and not exists (
        select 1 from palier_claims c
        where c.user_id = v_user and c.palier_idx = p.idx)
    order by p.idx
  loop
    insert into palier_claims (user_id, palier_idx) values (v_user, r.idx);
    insert into eclats_ledger (user_id, amount, source)
      values (v_user, r.eclats_bonus, 'paris_sportifs_palier');
    v_total := v_total + r.eclats_bonus;
  end loop;

  return v_total;
end
$$;

revoke all on function claim_palier_rewards() from public, anon;
grant execute on function claim_palier_rewards() to authenticated;

-- ============================================================
-- Droits d'accès des rôles (nouveaux projets Supabase, 2025+)
--
-- Les nouveaux projets n'accordent plus de privilèges par défaut aux
-- rôles anon / authenticated / service_role sur le schéma public. La RLS
-- (voir schema.sql) reste la barrière fine ligne par ligne ; ces GRANT
-- ouvrent simplement la porte de la pièce. Le rôle anon ne reçoit RIEN :
-- l'app exige une connexion avant toute lecture.
--
-- À exécuter APRÈS schema.sql, rpc_place_bet.sql et standings.sql.
-- ============================================================

grant usage on schema public to authenticated, service_role;

-- Lecture pour l'utilisateur connecté (les policies RLS filtrent les lignes)
grant select on leagues, teams, matches, odds_generated, standings,
  bets, eclats_ledger, team_competition_stats, team_global_stats
  to authenticated;

-- Réglages du modèle : lisibles et modifiables depuis la page Réglages
grant select, update on model_settings to authenticated;

-- Le rôle service (scripts de sync et de règlement) a tous les droits,
-- y compris sur les tables futures
grant all on all tables in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
