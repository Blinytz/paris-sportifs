-- ============================================================
-- RPC place_bet — placement de pari atomique (règle 8, section 4)
--
-- Pourquoi une fonction et pas des insert côté client :
-- la RLS interdit toute écriture client sur eclats_ledger (anti-triche),
-- mais la règle 8 exige que le débit de la mise soit créé atomiquement
-- avec la ligne de pari. Cette fonction SECURITY DEFINER est donc le
-- seul chemin d'écriture autorisé pour placer un pari : elle vérifie
-- tout côté serveur (match ouvert, cote courante, solde) puis crée
-- bets + eclats_ledger dans la même transaction.
--
-- À exécuter APRÈS schema.sql.
-- ============================================================

create or replace function place_bet(
  p_match_id uuid,
  p_selection text,
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
  v_sport text;
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
  if p_selection not in ('home', 'draw', 'away') then
    raise exception 'Sélection invalide';
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

  select l.sport into v_sport from leagues l where l.id = v_match.league_id;
  if v_sport = 'rugby' and p_selection = 'draw' then
    raise exception 'Marché 2 voies en rugby : pas de pari sur le nul';
  end if;

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
  v_odd := case p_selection
    when 'home' then v_odds.home_odds
    when 'draw' then v_odds.draw_odds
    else v_odds.away_odds
  end;
  if v_odd is null then
    raise exception 'Cote indisponible pour cette sélection';
  end if;

  -- Règle 8 : solde = somme de toutes les entrées ledger, toutes sources
  select coalesce(sum(amount), 0) into v_balance
  from eclats_ledger where user_id = v_user;
  if v_balance < p_stake then
    raise exception 'Solde insuffisant : % Éclats disponibles', v_balance;
  end if;

  insert into bets (user_id, match_id, selection, stake_eclats, odds_at_bet, potential_payout)
  values (v_user, p_match_id, p_selection, p_stake, v_odd, round(p_stake * v_odd, 2))
  returning id into v_bet_id;

  insert into eclats_ledger (user_id, amount, source, reference_id)
  values (v_user, -p_stake, 'paris_sportifs_mise', v_bet_id);

  return v_bet_id;
end
$$;

revoke all on function place_bet(uuid, text, numeric) from public, anon;
grant execute on function place_bet(uuid, text, numeric) to authenticated;
