# Pronos

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
  standings.sql          # classements officiels + colonnes de suivi du sync
  grants.sql             # droits des rôles (nouveaux projets Supabase)
.github/workflows/       # sync-football.yml et sync-rugby.yml (cron 2h45 UTC)
pwa/                     # la PWA (routes en hash : #/match/{id}, #/equipe/{id}…)
```

## Mise en route

1. **Supabase** : créer (ou réutiliser) un projet, puis dans l'éditeur SQL
   coller `sql/install_complet.sql` en un seul coup (généré — équivaut à
   `schema.sql` + `rpc_place_bet.sql` + `standings.sql` dans l'ordre ;
   régénérer après modif : `cat schema.sql rpc_place_bet.sql standings.sql`
   avec l'en-tête, voir historique git).
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
   *Run workflow* (idem rugby). Ensuite le cron tourne seul à 2h45 UTC,
   soit 4h45 en heure française d'été : tout est à jour avant 5h.

## Système de pari : sur le score (remplace le 1x2 de la spec, 20/07/2026)

On parie un **score exact** (ex. 2-1), pas une simple issue. Au règlement :

| Résultat du pronostic | Gain |
|---|---|
| Mauvaise issue (vainqueur/nul raté) | Perdu (mise débitée au pari) |
| Bonne issue | mise × cote de l'issue |
| + bon **écart signé** (ex. 1-0 pronostiqué, 2-1 réel : +1 = +1) | gain × **1,5** (`bonus_ecart`) |
| + bon écart sur un **pronostic de nul** (toujours le cas si l'issue est bonne) | gain × **1,25** (`bonus_ecart_nul`, réduit exprès) |
| + **score exact** | gain × **2** (`bonus_score_exact`) |

Précisions :
- L'écart est **signé** : 1-0 pronostiqué (+1) avec un 1-2 réel (−1), c'est
  perdu — l'issue est fausse.
- Le **nul est pariable au rugby** comme au foot (marché 3 voies partout).
  Sa probabilité rugby est basse (paramètres `*_rugby` des réglages), donc
  sa cote est haute (plafonnée par la cote maximale). Un pronostic de nul
  gagnant a d'office le bon écart (0) → c'est pour ça que son bonus écart
  est réduit à ×1,25 (sinon parier nul serait systématiquement trop
  rentable). L'ancienne règle « nul rugby = remboursement » est supprimée.
- Au règlement, le libellé du bonus appliqué est affiché explicitement
  (« score exact ×2 », « bon écart ×1,5 », « bon écart (nul) ×1,25 »,
  « bonne issue seule, sans bonus ») dans Mes paris et sur la page du
  match terminé.
- Les bonus sont réglables dans la page Réglages (lus à chaque run,
  règle 10). `python scripts/settle_bets.py --test` vérifie la grille.

## Cycle de vie d'un pronostic

- Dès que les deux scores sont saisis, le pronostic est enregistré comme
  brouillon et reste modifiable jusqu'à l'heure du coup d'envoi.
- L'heure du coup d'envoi verrouille toujours la saisie, même si le statut
  fourni par l'API sportive est encore provisoirement `scheduled`.
- Au passage serveur suivant, le brouillon verrouillé devient un pari et
  la mise est débitée. Pendant ce délai, l'interface affiche « validation
  en cours » et ne présente plus le score comme modifiable.
- Convention visuelle : gris pour vide ou annulé, or pour enregistré,
  bleu pour verrouillé/en jeu, vert pour gagné et rouge pour perdu.
- Sur les cartes terminées, le résultat porte toujours le libellé
  **Score final** et la saisie personnelle le libellé **Mon pronostic**.

### Correctif des validations bloquées du 24/07/2026

Le rôle `service_role` avait perdu le droit d'exécuter
`validate_due_drafts()`. Les tâches GitHub recevaient HTTP 403, mais le
script masquait l'erreur et terminait en succès. Le code accorde désormais
explicitement ce droit et laisse l'exécution échouer si la validation
échoue. Pour une base déjà installée, exécuter une fois
`sql/correctif_validation_brouillons.sql`, puis relancer `sync-resultats`.

## Quota API : sync par date (refonte du 21/07/2026)

Quota : 100 requêtes/jour par sous-API (foot et rugby séparés, reset à
minuit UTC).

**Découverte clé** (sonde `scripts/probe_api.py`, 21/07/2026) :
`/matches?date=YYYY-MM-DD` **sans `leagueId`** renvoie les matchs de
**toutes** les ligues de cette date (188 matchs, 28 ligues en une seule
requête). Le plan de la spec (une requête par ligue et par date, ~93/jour)
est donc remplacé par une boucle sur les dates :

- **Fenêtre J-1 à J+9 synchronisée intégralement à chaque run**, pour les
  deux sports. J-1 est traité en premier (résultats de la veille), puis
  J0, J+1... Le filtrage sur les 39 compétitions suivies se fait en local.
- **Coût réel mesuré au premier run** : **29 requêtes foot** (236 matchs
  écrits, 236 cotes générées) et **11 requêtes rugby**, sur 100.
  La pagination ajoute une requête par tranche de 100 matchs mondiaux et
  par date (plafond de 8 pages par date).
- Ni bootstrap ni sonde de découverte : tout le calendrier à 10 jours est
  en base dès le premier run, tournois et coupes compris.
- **Classements** (`/standings`, une requête par championnat) : rafraîchis
  chaque matin pour les seuls championnats ayant eu un match terminé
  depuis leur dernière mise à jour. La saison vient de `/matches`
  (`leagues.current_season`).
- **Plafond dur** conservé : le sync des matchs s'arrête avant d'entamer
  la réserve (1 requête de sécurité + 1 par championnat actif) ; les dates
  restantes passent au run suivant. Dépassement impossible.
- Les 39 compétitions de la spec sont actives, A-League comprise.
- La marge est telle qu'un run manuel supplémentaire dans la journée ne
  pose plus de problème (~30 requêtes chacun).

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
- **Classements (hors spec initiale)** : page `#/classement/{league_id}`
  (tableau complet par poule), position affichée sur la page équipe (en-tête
  + cartes par compétition) et sur la page match (face à face). Données :
  endpoint `/standings` de Highlightly. Si une ligue n'a pas encore de
  classement en base, lien de secours vers une recherche externe.
  `python scripts/highlightly_client.py` teste le parseur sur les formats
  foot et rugby.
