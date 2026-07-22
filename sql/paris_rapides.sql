-- ============================================================
-- Paris rapides : mise par défaut appliquée automatiquement depuis
-- l'accueil (décision du 22/07/2026).
--
-- Migration à exécuter sur une base déjà installée. Sur une base neuve,
-- schema.sql contient déjà la colonne.
-- ============================================================

alter table model_settings
  add column if not exists default_stake numeric not null default 100;
