-- ============================================================
-- Paliers réglables depuis la page Réglages (23/07/2026)
--
-- Même principe que le reste du modèle : rien n'est figé dans le code.
-- Le barème des points de pronostiqueur rejoint model_settings, et les
-- seuils/primes de chaque palier deviennent modifiables par l'utilisateur.
-- ============================================================

-- 1. Barème des points de pronostiqueur (était en dur dans la fonction)
alter table model_settings
  add column if not exists pp_par_pari numeric not null default 10,
  add column if not exists pp_bonne_issue numeric not null default 15,
  add column if not exists pp_bon_ecart numeric not null default 25,
  add column if not exists pp_score_exact numeric not null default 50;

-- 2. La fonction lit désormais le barème au lieu de constantes
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

-- 3. Seuils et primes des paliers modifiables depuis l'app.
-- Seules ces deux colonnes sont censées bouger ; les noms et l'ordre des
-- paliers restent définis par le seed (relancer ce fichier les restaure).
drop policy if exists "paliers_update" on paliers;
create policy "paliers_update" on paliers
  for update using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

grant update on paliers to authenticated;
