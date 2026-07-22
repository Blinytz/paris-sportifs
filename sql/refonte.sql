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
