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
