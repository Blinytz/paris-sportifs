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
