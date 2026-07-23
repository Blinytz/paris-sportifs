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
