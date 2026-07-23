-- ============================================================
-- Migration de sécurité préparée le 23/07/2026 — NON EXÉCUTÉE
-- À relire puis exécuter manuellement dans Supabase.
-- ============================================================

begin;

-- 1. Interdire la création directe d'un pari : place_bet() reste l'unique
-- chemin atomique (cote serveur + débit du ledger + insertion).
drop policy if exists "bets_insert_own" on bets;
revoke insert on bets from authenticated;

-- 2. Déclarer explicitement le compte propriétaire.
create table if not exists app_admins (
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

-- 3. Réserver les réglages et les paliers à ce propriétaire.
drop policy if exists "settings_update_auth" on model_settings;
drop policy if exists "settings_update_admin" on model_settings;
create policy "settings_update_admin" on model_settings
  for update using (is_app_admin())
  with check (is_app_admin());

drop policy if exists "paliers_update" on paliers;
drop policy if exists "paliers_update_admin" on paliers;
create policy "paliers_update_admin" on paliers
  for update using (is_app_admin())
  with check (is_app_admin());
grant update on paliers to authenticated;

commit;

-- APRÈS vérification de l'UUID du propriétaire, exécuter séparément :
-- insert into app_admins(user_id) values ('UUID_DU_PROPRIETAIRE')
-- on conflict (user_id) do nothing;
