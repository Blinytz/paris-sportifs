-- ============================================================
-- Réservation immédiate des mises de pronostics — 24/07/2026
--
-- À exécuter sur une base existante après brouillons.sql.
-- La saisie réserve désormais les Éclats immédiatement. La mise demandée
-- est plafonnée au solde réellement disponible. Effacer le brouillon
-- rembourse la réservation. Le coup d'envoi transforme la réservation
-- en pari sans effectuer un second débit.
-- ============================================================

-- Répare le rejeu accidentel de l'ancienne migration refonte.sql :
-- celle-ci marque tous les paris déjà réglés comme collectés en copiant
-- resolved_at dans collected_at, même si aucun gain/remboursement n'a
-- réellement été inscrit dans le registre. Les anciens règlements qui
-- avaient bien été crédités restent intacts grâce au test sur le ledger.
update bets b
set collected_at = null
where b.status in ('won', 'void')
  and b.resolved_at is not null
  and b.collected_at = b.resolved_at
  and not exists (
    select 1
    from eclats_ledger l
    where l.user_id = b.user_id
      and l.reference_id = b.id
      and l.source in (
        'paris_sportifs_gain',
        'paris_sportifs_remboursement'
      )
  );

alter table bet_drafts
  add column if not exists stake_reserved boolean not null default false;

-- Le navigateur ne doit plus contourner la réservation en écrivant la
-- table directement. La lecture reste protégée par la RLS existante.
drop policy if exists "drafts_insert_own" on bet_drafts;
drop policy if exists "drafts_update_own" on bet_drafts;
drop policy if exists "drafts_delete_own" on bet_drafts;
revoke insert, update, delete on bet_drafts from authenticated;
grant select on bet_drafts to authenticated;
grant all on bet_drafts to service_role;

create or replace function save_bet_draft(
  p_match_id uuid,
  p_home integer,
  p_away integer,
  p_requested_stake numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_match matches%rowtype;
  v_existing bet_drafts%rowtype;
  v_has_existing boolean := false;
  v_balance numeric;
  v_available_pool numeric;
  v_reserved numeric;
  v_delta numeric;
  v_draft_id uuid;
begin
  if v_user is null then
    raise exception 'Non authentifié';
  end if;
  if p_home is null or p_away is null
     or p_home not between 0 and 199 or p_away not between 0 and 199 then
    raise exception 'Score pronostiqué invalide';
  end if;
  if p_requested_stake is null or p_requested_stake <= 0 then
    raise exception 'Mise invalide';
  end if;

  -- Une seule opération de portefeuille à la fois pour cet utilisateur.
  perform pg_advisory_xact_lock(hashtext(v_user::text));

  select * into v_match
  from matches
  where id = p_match_id
  for update;
  if not found then
    raise exception 'Match introuvable';
  end if;
  if v_match.status <> 'scheduled'
     or v_match.odds_locked
     or v_match.kickoff_at <= now() then
    raise exception 'Pronostics fermés sur ce match';
  end if;

  select * into v_existing
  from bet_drafts
  where user_id = v_user and match_id = p_match_id
  for update;
  v_has_existing := found;

  select coalesce(sum(amount), 0) into v_balance
  from eclats_ledger
  where user_id = v_user;

  -- Une réservation existante appartient encore à l'utilisateur lors
  -- d'une modification : elle peut être réallouée à la nouvelle mise.
  v_available_pool := greatest(v_balance, 0)
    + case when v_has_existing and v_existing.stake_reserved
      then v_existing.stake_eclats else 0 end;
  v_reserved := least(p_requested_stake, v_available_pool);

  if v_reserved <= 0 then
    raise exception 'Solde insuffisant : aucun Éclat disponible';
  end if;

  if v_has_existing then
    update bet_drafts
    set predicted_home = p_home,
        predicted_away = p_away,
        stake_eclats = v_reserved,
        stake_reserved = true,
        rejected_at = null,
        rejected_reason = null,
        updated_at = now()
    where id = v_existing.id
    returning id into v_draft_id;
  else
    insert into bet_drafts (
      user_id, match_id, predicted_home, predicted_away,
      stake_eclats, stake_reserved
    ) values (
      v_user, p_match_id, p_home, p_away, v_reserved, true
    )
    returning id into v_draft_id;
  end if;

  v_delta := case
    when v_has_existing and v_existing.stake_reserved
      then v_existing.stake_eclats - v_reserved
    else -v_reserved
  end;

  if v_delta <> 0 then
    insert into eclats_ledger (user_id, amount, source, reference_id)
    values (
      v_user,
      v_delta,
      case
        when v_has_existing and v_existing.stake_reserved
          then 'paris_sportifs_ajustement'
        else 'paris_sportifs_reservation'
      end,
      v_draft_id
    );
  end if;

  return jsonb_build_object(
    'id', v_draft_id,
    'stake_eclats', v_reserved,
    'requested_stake', p_requested_stake,
    'adjusted', v_reserved < p_requested_stake,
    'available_after', v_balance + v_delta
  );
end
$$;

revoke all on function save_bet_draft(uuid, integer, integer, numeric)
  from public, anon;
grant execute on function save_bet_draft(uuid, integer, integer, numeric)
  to authenticated;

create or replace function delete_bet_draft(p_match_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_draft bet_drafts%rowtype;
  v_refund numeric := 0;
begin
  if v_user is null then
    raise exception 'Non authentifié';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user::text));

  select * into v_draft
  from bet_drafts
  where user_id = v_user and match_id = p_match_id
  for update;

  if not found then
    return jsonb_build_object('deleted', false, 'refunded', 0);
  end if;

  if v_draft.rejected_at is null and not exists (
    select 1 from matches m
    where m.id = p_match_id
      and m.status = 'scheduled'
      and not m.odds_locked
      and m.kickoff_at > now()
  ) then
    raise exception 'Pronostic déjà verrouillé';
  end if;

  if v_draft.stake_reserved then
    v_refund := v_draft.stake_eclats;
    insert into eclats_ledger (user_id, amount, source, reference_id)
    values (
      v_user, v_refund, 'paris_sportifs_annulation', v_draft.id
    );
  end if;

  delete from bet_drafts where id = v_draft.id;

  return jsonb_build_object(
    'deleted', true,
    'refunded', v_refund
  );
end
$$;

revoke all on function delete_bet_draft(uuid) from public, anon;
grant execute on function delete_bet_draft(uuid) to authenticated;

-- Conversion des réservations au coup d'envoi. Les anciens brouillons
-- créés avant cette migration sont réservés et plafonnés ici une seule
-- fois, afin de pouvoir débloquer l'historique sans solde négatif.
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
  v_balance numeric;
  v_bet_id uuid;
  v_valides integer := 0;
begin
  for v_draft in
    select d.*, m.kickoff_at, m.status as match_status
    from bet_drafts d
    join matches m on m.id = d.match_id
    where m.kickoff_at <= now()
      and d.rejected_at is null
    order by m.kickoff_at
    for update of d
  loop
    perform pg_advisory_xact_lock(hashtext(v_draft.user_id::text));

    if v_draft.match_status in ('postponed', 'cancelled') then
      if v_draft.stake_reserved then
        insert into eclats_ledger (user_id, amount, source, reference_id)
        values (
          v_draft.user_id, v_draft.stake_eclats,
          'paris_sportifs_annulation', v_draft.id
        );
      end if;
      update bet_drafts
      set stake_reserved = false,
          rejected_at = now(),
          rejected_reason = case
            when v_draft.match_status = 'postponed' then 'Match reporté'
            else 'Match annulé'
          end
      where id = v_draft.id;
      continue;
    end if;

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

    if v_odd is null then
      if v_draft.stake_reserved then
        insert into eclats_ledger (user_id, amount, source, reference_id)
        values (
          v_draft.user_id, v_draft.stake_eclats,
          'paris_sportifs_annulation', v_draft.id
        );
      end if;
      update bet_drafts
      set stake_reserved = false,
          rejected_at = now(),
          rejected_reason = 'Aucune cote disponible pour ce match'
      where id = v_draft.id;
      continue;
    end if;

    -- Compatibilité avec les brouillons déjà présents : ils n'avaient
    -- encore rien réservé. Leur mise est plafonnée au solde du moment.
    if not v_draft.stake_reserved then
      select greatest(coalesce(sum(amount), 0), 0) into v_balance
      from eclats_ledger
      where user_id = v_draft.user_id;

      v_draft.stake_eclats := least(v_draft.stake_eclats, v_balance);
      if v_draft.stake_eclats <= 0 then
        update bet_drafts
        set rejected_at = now(),
            rejected_reason = 'Aucun Éclat disponible lors de la validation'
        where id = v_draft.id;
        continue;
      end if;

      insert into eclats_ledger (user_id, amount, source, reference_id)
      values (
        v_draft.user_id, -v_draft.stake_eclats,
        'paris_sportifs_reservation', v_draft.id
      );
      update bet_drafts
      set stake_eclats = v_draft.stake_eclats,
          stake_reserved = true
      where id = v_draft.id;
    end if;

    insert into bets (
      user_id, match_id, predicted_home, predicted_away,
      selection, stake_eclats, odds_at_bet, potential_payout
    ) values (
      v_draft.user_id, v_draft.match_id,
      v_draft.predicted_home, v_draft.predicted_away,
      v_selection, v_draft.stake_eclats, v_odd,
      ceil(v_draft.stake_eclats * v_odd)
    )
    returning id into v_bet_id;

    -- Aucun débit ici : la mise est déjà réservée.
    v_valides := v_valides + 1;
    delete from bet_drafts where id = v_draft.id;
  end loop;

  return v_valides;
end
$$;

revoke all on function validate_due_drafts()
  from public, anon, authenticated;
grant execute on function validate_due_drafts() to service_role;
