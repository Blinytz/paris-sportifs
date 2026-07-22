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
