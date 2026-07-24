-- ============================================================
-- MISE À JOUR à coller dans l'éditeur SQL de Supabase.
-- Rejouable sans risque : n'efface aucune donnée.
-- ============================================================

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

-- Appliquer ensuite reservation_immediate.sql : cette migration remplace
-- le débit différé par une réservation immédiate et remboursable.

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
grant select on paliers to authenticated;
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
    10 + case when status = 'won' then
      case when bonus_multiplier >= 2 then 50
           when bonus_multiplier > 1 then 25
           else 15 end
    else 0 end
  ), 0)::integer
  from bets
  where user_id = auth.uid() and status in ('won', 'lost');
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
