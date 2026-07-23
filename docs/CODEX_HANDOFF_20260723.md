# Relais Codex — 23 juillet 2026

## Sauvegarde

L'état interrompu de Claude est conservé dans la branche locale
`codex/claude-handoff-20260723` (commit `945c30a`). La poursuite se trouve dans
`codex/finish-claude-20260723`.

## Travail terminé localement

- les quatre paramètres de points de pronostiqueur sont éditables ;
- les seuils et primes des 18 paliers sont éditables depuis Réglages ;
- l'ordre des seuils est validé avant enregistrement ;
- les nouvelles installations n'autorisent plus l'insertion directe dans
  `bets` : `place_bet()` reste l'unique chemin de création ;
- les réglages économiques et les paliers sont réservés à un compte déclaré
  dans `app_admins` ;
- une migration de sécurité réexécutable est prête dans
  `sql/securite_administration.sql` ;
- des tests statiques et de syntaxe ont été ajoutés.

## Important : aucune migration exécutée

Codex n'a touché ni à Supabase ni à la production. Pour appliquer plus tard :

1. sauvegarder la base ;
2. vérifier l'UUID du compte propriétaire dans Supabase Auth ;
3. relire puis exécuter `sql/securite_administration.sql` ;
4. ajouter séparément cet UUID à `app_admins` avec la requête commentée en fin
   de fichier ;
5. exécuter ensuite `sql/paliers_reglables.sql` ;
6. tester connexion, placement atomique, réglages, profil et collecte.

Sans l'étape 4, les réglages restent lisibles mais aucune modification n'est
autorisée : c'est le comportement de sécurité attendu.

## Vérification locale

```powershell
node tests/run.mjs
git diff --check
```

Le dépôt GitHub étant public, cette branche n'a pas été poussée automatiquement.
