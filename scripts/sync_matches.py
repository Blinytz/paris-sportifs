#!/usr/bin/env python3
"""Script principal de synchronisation (sections 4 et 5 de la spec).

Usage : python sync_matches.py --sport football|rugby

Déroulé d'un run (sync par date, refonte du 21/07/2026) :
  1. charge model_settings (règle 10)
  2. pour chaque date de J-1 à J+9, appelle /matches?date=X SANS leagueId :
     une requête (plus pagination) ramène les matchs de toutes les ligues,
     on ne garde que les nôtres. Coût : quelques requêtes par jour au lieu
     d'une par ligue. Plafond dur : dépassement de quota impossible.
  3. upsert équipes (règle 2) et matchs (règle 1)
  4. verrouille les cotes des matchs dont le coup d'envoi est passé (règle 4)
  5. applique le Elo + stats sur les matchs nouvellement terminés (règles 3 et 11)
  6. génère les cotes des matchs à venir non verrouillés (section 6, règle 9)
  7. rafraîchit les classements des championnats ayant joué depuis leur
     dernière mise à jour (budget dynamique sur le quota restant)

settle_bets.py s'exécute juste après, dans le même job GitHub Actions.
"""

import argparse
import logging
import sys
from datetime import datetime, timedelta, timezone

from db import SupabaseDB, load_settings
from elo import ELO_START, generate_odds, update_elo
from highlightly_client import HighlightlyClient, parse_standings
from stats import update_stats_for_match

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("sync")

# Fenêtre synchronisée chaque jour : J-1 (résultats de la veille) à J+9.
# Une requête /matches?date=X couvre toutes les ligues à la fois (vérifié
# le 21/07/2026), donc la fenêtre coûte quelques requêtes par jour, pas
# une par ligue : ni bootstrap ni sonde nécessaires.
FENETRE_JOURS = 9

# Quota Highlightly : 100 requêtes/jour par sous-API. Réserve de sécurité
# + réserve pour les classements (1 par championnat actif) ; le sync des
# matchs s'arrête net s'il atteint son plafond (dépassement impossible).
QUOTA_JOURNALIER = 100
QUOTA_RESERVE = 1


# Mapping state.description Highlightly -> status en base. Clés en
# minuscules : l'API réelle renvoie « Not started » là où la spec disait
# « Not Started » (constaté au premier run du 20/07/2026).
STATUS_MAP = {
    "not started": "scheduled",
    "live": "live",
    "1st half": "live",
    "first half": "live",
    "2nd half": "live",
    "second half": "live",
    "half time": "live",
    "halftime": "live",
    "extra time": "live",
    "penalties": "live",
    "finished": "finished",
    "finished after extra time": "finished",
    "finished after penalties": "finished",
    "postponed": "postponed",
    "cancelled": "cancelled",
    "canceled": "cancelled",
    "abandoned": "cancelled",
}


def dates_en_attente_de_resultat(db, sport):
    """Dates des matchs dont on attend encore le résultat : coup d'envoi
    passé (avec une marge) et pas encore de score exploitable en base.

    Sert au mode « résultats » (run léger toutes les 2 h) : s'il n'y a
    rien à récupérer, aucune requête API n'est consommée."""
    maintenant = datetime.now(timezone.utc)
    # Un match reste « en attente » jusqu'à 2 jours après son coup d'envoi
    # (au-delà, l'API ne le finalisera plus : inutile de le repayer)
    rows = db.select("matches", {
        "select": "kickoff_at,league:leagues!inner(sport)",
        "league.sport": f"eq.{sport}",
        "kickoff_at": f"lt.{maintenant.isoformat()}",
        "and": (f"(kickoff_at.gt.{(maintenant - timedelta(days=2)).isoformat()},"
                "or(status.neq.finished,score_home.is.null))"),
    })
    return sorted({r["kickoff_at"][:10] for r in rows})


def dates_fenetre():
    """J-1 d'abord (résultats de la veille), puis J0, J+1... J+9. Cet
    ordre garantit que sous contrainte de quota, ce sont les dates les
    plus utiles qui passent en premier."""
    today = datetime.now(timezone.utc).date()
    return [(today + timedelta(days=d)).isoformat()
            for d in range(-1, FENETRE_JOURS + 1)]


def map_status(raw):
    cle = (raw or "").strip().lower()
    if cle in STATUS_MAP:
        return STATUS_MAP[cle]
    # Valeur inconnue : stockée telle quelle sans planter (section 2). La
    # contrainte CHECK de la base peut la refuser — géré par l'appelant.
    log.warning("Statut Highlightly inconnu : %r (stocké tel quel)", raw)
    return raw


def parse_score(state, status):
    """Score final quand finished. La spec annonçait une string "2 - 1" ;
    l'API réelle renvoie un objet {"current": "2 - 1", "penalties": ...}
    (constaté au premier run du 20/07/2026) : on gère les deux formes."""
    if status != "finished":
        return None, None
    raw = (state or {}).get("score")
    if isinstance(raw, dict):
        raw = raw.get("current")
    try:
        home, away = raw.split(" - ")
        return int(home.strip()), int(away.strip())
    except (AttributeError, ValueError):
        log.warning("Score illisible : %r ; scores laissés à null", raw)
        return None, None


class TeamCache:
    """Cache (sport, external_id) -> ligne teams, avec création à la volée
    (règle 2 : rating initial 1500, jamais de recréation)."""

    def __init__(self, db, sport):
        self.db = db
        self.sport = sport
        self.by_ext = {}

    def ensure(self, api_teams):
        missing = [t for t in api_teams if t["id"] not in self.by_ext]
        if missing:
            self.db.insert(
                "teams",
                [{"sport": self.sport, "external_id": t["id"],
                  "name": t.get("name") or f"Équipe {t['id']}",
                  "logo_url": t.get("logo"),
                  "rating": ELO_START}
                 for t in {t["id"]: t for t in missing}.values()],
                on_conflict="sport,external_id", ignore_duplicates=True,
            )
            ids = ",".join(str(t["id"]) for t in missing)
            for row in self.db.select("teams", {
                "sport": f"eq.{self.sport}", "external_id": f"in.({ids})",
            }):
                self.by_ext[row["external_id"]] = row
            # Complète le logo des équipes créées avant son stockage
            logos = {t["id"]: t.get("logo") for t in missing if t.get("logo")}
            for ext_id, logo in logos.items():
                row = self.by_ext.get(ext_id)
                if row and not row.get("logo_url"):
                    self.db.update("teams", {"logo_url": logo},
                                   {"id": f"eq.{row['id']}"})
                    row["logo_url"] = logo


def sync_date(db, client, date, ligues_par_ext, team_cache, saisons):
    """Synchronise TOUS les matchs d'une date en une requête (plus
    pagination), puis ne garde que ceux de nos ligues suivies.

    `saisons` est enrichi au passage : league_id -> saison la plus récente
    vue (paramètre de /standings)."""
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        api_matches = client.get_matches_by_date(date)
    except Exception:
        log.exception("Échec /matches date=%s ; on continue", date)
        return 0

    suivis = [m for m in api_matches
              if (m.get("league") or {}).get("id") in ligues_par_ext]
    if not suivis:
        return 0

    team_cache.ensure([m["homeTeam"] for m in suivis]
                      + [m["awayTeam"] for m in suivis])

    ext_ids = ",".join(str(m["id"]) for m in suivis)
    existing = {row["external_id"] for row in db.select(
        "matches", {"external_id": f"in.({ext_ids})", "select": "external_id"})}

    ecrits = 0
    for m in suivis:
        league = ligues_par_ext[m["league"]["id"]]
        saison = m["league"].get("season")
        if saison and saison > saisons.get(league["id"], 0):
            saisons[league["id"]] = saison
        state = m.get("state") or {}
        status = map_status(state.get("description") or "Not Started")
        score_home, score_away = parse_score(state, status)
        try:
            if m["id"] in existing:
                # Règle 1 : ne jamais toucher kickoff_at ni les équipes
                db.update("matches", {
                    "status": status,
                    "score_home": score_home,
                    "score_away": score_away,
                    "last_synced_at": now_iso,
                }, {"external_id": f"eq.{m['id']}"})
            else:
                db.insert("matches", [{
                    "league_id": league["id"],
                    "external_id": m["id"],
                    "home_team_id": team_cache.by_ext[m["homeTeam"]["id"]]["id"],
                    "away_team_id": team_cache.by_ext[m["awayTeam"]["id"]]["id"],
                    "kickoff_at": m["date"],
                    "status": status,
                    "score_home": score_home,
                    "score_away": score_away,
                    "last_synced_at": now_iso,
                }])
            ecrits += 1
        except Exception:
            # Un match illisible (ex. statut hors contrainte CHECK) ne
            # doit pas faire échouer tout le run
            log.exception("Échec upsert match external_id=%s", m["id"])
    return ecrits


def _standings_a_rafraichir(db, league):
    """Un classement ne bouge que si un match s'est terminé : inutile de
    dépenser une requête sinon."""
    if not league.get("standings_synced_at"):
        return True
    rows = db.select("matches", {
        "league_id": f"eq.{league['id']}",
        "status": "eq.finished",
        "kickoff_at": f"gt.{league['standings_synced_at']}",
        "select": "id", "limit": "1",
    })
    return bool(rows)


def sync_standings(db, client, sport, team_cache):
    """Rafraîchit les classements officiels (endpoint /standings) des
    ligues 'championnat' dont un match s'est terminé depuis la dernière
    mise à jour, plus ancien rafraîchissement d'abord, dans la limite du
    quota restant du jour (budget dynamique : quota - réserve - requêtes
    déjà consommées par le sync des matchs). Le remplacement des lignes se
    fait par (league_id, season) entier : delete puis insert."""
    now_iso = datetime.now(timezone.utc).isoformat()
    budget = QUOTA_JOURNALIER - QUOTA_RESERVE - client.request_count
    if budget <= 0:
        log.warning("Aucun budget quota restant pour les classements (%d requêtes consommées)",
                    client.request_count)
        return
    candidates = [l for l in db.select("leagues", {
        "sport": f"eq.{sport}", "active": "is.true",
        "category": "eq.championnat",
        "current_season": "not.is.null",
        "order": "standings_synced_at.asc.nullsfirst",
    }) if _standings_a_rafraichir(db, l)]
    if len(candidates) > budget:
        log.warning("Classements : %d ligues à rafraîchir mais budget de %d ; "
                    "les restantes passeront au prochain run",
                    len(candidates), budget)
        candidates = candidates[:budget]
    for league in candidates:
        try:
            payload = client.get_standings(league["external_id"],
                                           league["current_season"])
            lignes = parse_standings(payload)
        except Exception:
            log.exception("Échec /standings ligue=%s — on continue", league["name"])
            continue
        try:
            if lignes:
                team_cache.ensure([{"id": l["team_external_id"], "name": l["team_name"]}
                                   for l in lignes])
                rows = []
                for l in lignes:
                    team = team_cache.by_ext.get(l["team_external_id"])
                    if not team:
                        log.warning("Équipe %s du classement introuvable en base",
                                    l["team_external_id"])
                        continue
                    rows.append({
                        "league_id": league["id"],
                        "season": league["current_season"],
                        "team_id": team["id"],
                        "group_name": l["group_name"],
                        "position": l["position"],
                        "points": l["points"],
                        "games_played": l["games_played"],
                        "wins": l["wins"],
                        "draws": l["draws"],
                        "losses": l["losses"],
                        "score_for": l["score_for"],
                        "score_against": l["score_against"],
                        "synced_at": now_iso,
                    })
                db.delete("standings", {
                    "league_id": f"eq.{league['id']}",
                    "season": f"eq.{league['current_season']}",
                })
                db.insert("standings", rows)
                log.info("Classement %s (saison %s) : %d équipes",
                         league["name"], league["current_season"], len(rows))
            else:
                log.warning("Classement vide pour %s (saison %s)",
                            league["name"], league["current_season"])
        except Exception:
            log.exception("Échec écriture classement ligue=%s", league["name"])
        # Toujours dater le passage, même vide : la rotation ne doit pas
        # rester bloquée sur une ligue sans classement disponible
        db.update("leagues", {"standings_synced_at": now_iso},
                  {"id": f"eq.{league['id']}"})


def lock_started_matches(db):
    """Règle 4 : odds_locked=true dès que kickoff_at <= now()."""
    now_iso = datetime.now(timezone.utc).isoformat()
    db.update("matches", {"odds_locked": True}, {
        "kickoff_at": f"lte.{now_iso}", "odds_locked": "is.false",
    })


def apply_elo_and_stats(db, sport, settings):
    """Règles 3 et 11 : pour chaque match finished non encore appliqué,
    dans l'ordre chronologique, met à jour les ratings Elo, les stats des
    deux équipes, puis marque elo_applied=true."""
    rows = db.select("matches", {
        "status": "eq.finished", "elo_applied": "is.false",
        "score_home": "not.is.null", "score_away": "not.is.null",
        "select": "*,league:leagues!inner(sport)",
        "league.sport": f"eq.{sport}",
        "order": "kickoff_at.asc",
    })
    ratings = {}  # cache team_id -> (rating, matches_played), maj au fil de l'eau

    def team_state(team_id):
        if team_id not in ratings:
            t = db.select("teams", {"id": f"eq.{team_id}",
                                    "select": "rating,matches_played"})[0]
            ratings[team_id] = [float(t["rating"]), t["matches_played"]]
        return ratings[team_id]

    for m in rows:
        home, away = team_state(m["home_team_id"]), team_state(m["away_team_id"])
        if m["score_home"] > m["score_away"]:
            result = 1.0
        elif m["score_home"] < m["score_away"]:
            result = 0.0
        else:
            result = 0.5
        new_home, new_away = update_elo(home[0], away[0], result, sport, settings)
        now_iso = datetime.now(timezone.utc).isoformat()
        for team_id, state, new_rating in (
                (m["home_team_id"], home, new_home),
                (m["away_team_id"], away, new_away)):
            state[0], state[1] = new_rating, state[1] + 1
            db.update("teams", {"rating": new_rating, "matches_played": state[1],
                                "updated_at": now_iso},
                      {"id": f"eq.{team_id}"})
        update_stats_for_match(db, m, settings)
        db.update("matches", {"elo_applied": True}, {"id": f"eq.{m['id']}"})
        log.info("Elo appliqué : match %s (%s-%s)", m["external_id"],
                 m["score_home"], m["score_away"])


def generate_upcoming_odds(db, sport, settings):
    """Section 6 : (re)génère les cotes des matchs scheduled non verrouillés.
    Une nouvelle ligne odds_generated par run — la PWA lit la plus récente."""
    rows = db.select("matches", {
        "status": "eq.scheduled", "odds_locked": "is.false",
        "select": ("id,league:leagues!inner(sport),"
                   "home:teams!matches_home_team_id_fkey(rating),"
                   "away:teams!matches_away_team_id_fkey(rating)"),
        "league.sport": f"eq.{sport}",
    })
    odds_rows = []
    for m in rows:
        odds = generate_odds(float(m["home"]["rating"]), float(m["away"]["rating"]),
                             sport, settings)
        odds_rows.append({
            "match_id": m["id"],
            "home_odds": odds["home"],
            "draw_odds": odds["draw"],
            "away_odds": odds["away"],
        })
    db.insert("odds_generated", odds_rows)
    log.info("Cotes générées pour %d matchs %s", len(odds_rows), sport)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sport", required=True, choices=("football", "rugby"))
    parser.add_argument(
        "--mode", default="complet", choices=("complet", "resultats"),
        help="complet : fenêtre J-1 à J+9 (1 fois/jour). resultats : "
             "seulement les dates dont on attend encore un score (run léger "
             "toutes les 2 h ; 0 requête s'il n'y a rien à récupérer).")
    args = parser.parse_args()
    sport, mode = args.sport, args.mode

    db = SupabaseDB()
    settings = load_settings(db)
    client = HighlightlyClient(sport)
    leagues = db.select("leagues", {"sport": f"eq.{sport}", "active": "is.true"})
    ligues_par_ext = {l["external_id"]: l for l in leagues}

    # Plafond dur du sync des matchs : quota - réserve - budget classements
    # (1 requête par championnat actif). Dépassement impossible.
    nb_championnats = sum(1 for l in leagues if l["category"] == "championnat")
    plafond_matchs = QUOTA_JOURNALIER - QUOTA_RESERVE - nb_championnats
    if mode == "resultats":
        dates = dates_en_attente_de_resultat(db, sport)
        if not dates:
            log.info("Mode résultats : aucun match en attente de score, "
                     "aucune requête API consommée")
            return
        log.info("Mode résultats %s : %d date(s) en attente (%s)",
                 sport, len(dates), ", ".join(dates))
    else:
        dates = dates_fenetre()
        log.info("Sync %s : %d ligues suivies, %d dates (J-1 à J+%d), plafond "
                 "matchs %d requêtes, réserve classements %d",
                 sport, len(leagues), len(dates), FENETRE_JOURS,
                 plafond_matchs, nb_championnats)

    team_cache = TeamCache(db, sport)
    saisons, total_ecrits = {}, 0
    for date in dates:
        if client.request_count >= plafond_matchs:
            log.warning("Plafond quota atteint (%d requêtes) : dates à partir "
                        "du %s reportées au prochain run",
                        client.request_count, date)
            break
        total_ecrits += sync_date(db, client, date, ligues_par_ext,
                                  team_cache, saisons)
    for league_id, saison in saisons.items():
        db.update("leagues", {"current_season": saison},
                  {"id": f"eq.{league_id}"})
    log.info("%d matchs suivis écrits ou mis à jour", total_ecrits)

    lock_started_matches(db)
    apply_elo_and_stats(db, sport, settings)
    if mode == "complet":
        # Les cotes ne se régénèrent que dans le run complet : un run léger
        # ne doit pas faire bouger les cotes entre deux paris de la journée
        generate_upcoming_odds(db, sport, settings)
        sync_standings(db, client, sport, team_cache)
    log.info("Sync %s terminé : %d requêtes Highlightly consommées sur %d",
             sport, client.request_count, QUOTA_JOURNALIER)


if __name__ == "__main__":
    sys.exit(main())
