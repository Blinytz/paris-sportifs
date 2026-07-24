-- Correctif production du 24/07/2026.
--
-- La fonction validate_due_drafts() était bien protégée des utilisateurs
-- de l'application, mais le retrait du droit PUBLIC avait aussi privé le
-- rôle serveur de son droit d'exécution. Les synchronisations recevaient
-- donc HTTP 403 et les brouillons restaient bloqués après le coup d'envoi.
--
-- Cette commande ne valide et ne débite encore aucun pari. Elle rétablit
-- uniquement le droit du rôle technique. Le prochain appel explicite de
-- validate_due_drafts() effectuera les validations en attente.

grant execute on function public.validate_due_drafts() to service_role;
