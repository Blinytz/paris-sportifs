# Paris Sportifs — Éclats ✦

Paris sportifs fictifs en Éclats sur 32 compétitions de foot et 7 de rugby,
avec cotes maison calculées par un modèle Elo. Aucune cote externe, aucun
argent réel.

- **Données** : [Highlightly API](https://highlightly.net) (foot + rugby), 100 requêtes/jour par sous-API
- **Backend** : Supabase (Postgres + PostgREST + Auth), scripts Python via GitHub Actions
- **Frontend** : PWA statique vanilla JS (convention gacha-wikipedia), hébergeable sur GitHub Pages

## Structure

```
scripts/
  sync_matches.py        # sync quotidien des matchs + Elo + stats + cotes
  settle_bets.py         # règlement des paris (won/lost/void + ledger)
  elo.py                 # modèle Elo + génération des cotes (python elo.py = test)
  stats.py               # mise à jour team_competition_stats
  highlightly_client.py  # wrapper API Highlightly
  db.py                  # mini-client PostgREST (rôle service)
sql/
  schema.sql             # tables + RLS + vue + seed des 39 ligues (spec section 3)
  rpc_place_bet.sql      # fonction SQL de placement de pari (voir note ci-dessous)
.github/workflows/       # sync-football.yml et sync-rugby.yml (cron 6h UTC)
pwa/                     # la PWA (routes en hash : #/match/{id}, #/equipe/{id}…)
```

## Mise en route

1. **Supabase** : créer (ou réutiliser) un projet, puis dans l'éditeur SQL
   exécuter `sql/schema.sql` **puis** `sql/rpc_place_bet.sql`.
2. **Utilisateur** : créer le compte partagé dans Authentication → Users
   (email + mot de passe), puis créditer le solde initial d'Éclats :
   ```sql
   insert into eclats_ledger (user_id, amount, source)
   values ('<user_id>', 1000, 'paris_sportifs_initial');
   ```
3. **Secrets GitHub Actions** (Settings → Secrets → Actions) :
   `HIGHLIGHTLY_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
4. **PWA** : renseigner `pwa/js/config.js` (URL du projet + clé anon) et
   publier le dossier `pwa/` sur GitHub Pages.
5. Lancer un premier run à la main : onglet Actions → `sync-football` →
   *Run workflow* (idem rugby). Ensuite le cron tourne seul à 6h UTC.

## Quota API (spec section 5)

- Foot : 32 ligues × 3 dates (J-1 à J+1) = 96 requêtes/jour (quota 100)
- Rugby : 7 ligues × 9 dates (J-1 à J+7) = 63 requêtes/jour (quota 100)
- Pas de run élargi hebdomadaire en v1.

## Écarts / précisions par rapport à la spec

- **`place_bet` en fonction SQL** : la règle 8 (débit atomique de la mise
  côté client) est incompatible avec la RLS de la spec (aucune écriture
  client sur `eclats_ledger`). Le placement passe donc par la fonction
  `place_bet` (SECURITY DEFINER, `sql/rpc_place_bet.sql`) qui vérifie
  match ouvert + cote courante + solde côté serveur et écrit `bets` +
  `eclats_ledger` dans la même transaction.
- **Routes en hash** : GitHub Pages ne réécrit pas les URL ; `/match/{id}`
  devient `#/match/{id}` (même contenu que la spec section 7).
- **Vue « avant le match » (7.3)** : les formes et moyennes sont recalculées
  depuis les matchs antérieurs au coup d'envoi, et les cotes affichées sont
  les dernières générées avant le kickoff. Le rating Elo d'avant-match n'est
  pas historisé (la spec ne prévoit pas de table d'historique) : la
  probabilité implicite affichée provient des cotes verrouillées, qui sont
  la photographie exacte du modèle d'avant-match.
- **Auth** : aucun projet existant n'utilisait encore Supabase — l'écran de
  connexion (email + mot de passe) est donc une implémentation neuve, prête
  à être partagée par les autres PWA (même `user_id`, champ `source` du
  ledger).
- **Test du modèle** : `python scripts/elo.py` vérifie l'exemple chiffré de
  la spec (la spec arrondit `p_home_raw` à 0.588, valeur exacte 0.5925 —
  cotes exactes 2.34 / 3.57 / 3.41).
