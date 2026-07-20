#!/usr/bin/env python3
"""Script principal de synchronisation (sections 4 et 5 de la spec).

Usage : python sync_matches.py --sport football|rugby

Déroulé d'un run (sync piloté par le calendrier, décision du 20/07/2026) :
  1. charge model_settings (règle 10)
  2. pour chaque ligue active du sport (championnats d'abord), appelle
     /matches uniquement sur les dates utiles : sonde de découverte J+9
     chaque jour + jours de la fenêtre de suivi (foot J-1..J+1, rugby
     J-1..J+7) où des matchs sont connus en base. Une compétition sans
     activité (coupe entre deux tours, tournoi hors période) ne coûte que
     1 requête/jour. Plafond dur : dépassement de quota impossible.
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

# Fenêtres de SUIVI par sport (jours relatifs à aujourd'hui UTC) : à
# l'intérieur, un jour n'est interrogé que si des matchs y sont connus
WINDOWS = {"football": (-1, 1), "rugby": (-1, 7)}

# Sonde de découverte quotidienne : chaque jour, chaque ligue est sondée à
# J+9 (« tapis roulant » : toute date future passe une fois par J+9, donc
# tout match annoncé au moins 9 jours à l'avance est découvert). Les
# matchs plus proches sont ensuite suivis via la fenêtre ci-dessus.
PROBE_OFFSET = 9

# Quota Highlightly : 100 requêtes/jour par sous-API. Réserve de sécurité
# + réserve pour les classements (1 par championnat actif) ; le sync des
# matchs s'arrête net s'il atteint son plafond (dépassement impossible).
QUOTA_JOURNALIER = 100
QUOTA_RESERVE = 1

# Ordre de passage sous contrainte de quota : les championnats d'abord
# (paris + classements), l'international en dernier
PRIORITE_CATEGORIE = {"championnat": 0, "coupe_continentale": 1,
                      "coupe_nationale": 2, "international": 3}

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


def dates_pour_ligue(db, league, sport):
    """Dates à interroger pour cette ligue aujourd'hui (sync piloté par le
    calendrier) :
    - jamais visitée -> bootstrap complet J-1..J+9 ;
    - sinon : la sonde J+9, plus chaque jour de la fenêtre de suivi où la
      base connaît un match encore à suivre (à venir, en cours, ou terminé
      sans score exploitable). Une ligue sans activité coûte 1 requête/jour.
    """
    today = datetime.now(timezone.utc).date()
    if league.get("last_checked_at") is None:
        return [(today + timedelta(days=d)).isoformat()
                for d in range(-1, PROBE_OFFSET + 1)]

    first, last = WINDOWS[sport]
    debut = (today + timedelta(days=first)).isoformat()
    fin = (today + timedelta(days=last + 1)).isoformat()
    rows = db.select("matches", {
        "league_id": f"eq.{league['id']}",
        "and": f"(kickoff_at.gte.{debut}T00:00:00Z,kickoff_at.lt.{fin}T00:00:00Z)",
        "or": ("(status.in.(scheduled,live),"
               "and(status.eq.finished,score_home.is.null))"),
        "select": "kickoff_at",
    })
    dates = {r["kickoff_at"][:10] for r in rows}
    dates.add((today + timedelta(days=PROBE_OFFSET)).isoformat())
    return sorted(dates)


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
                  "rating": ELO_START}
                 for t in {t["id"]: t for t in missing}.values()],
                on_conflict="sport,external_id", ignore_duplicates=True,
            )
            ids = ",".join(str(t["id"]) for t in missing)
            for row in self.db.select("teams", {
                "sport": f"eq.{self.sport}", "external_id": f"in.({ids})",
            }):
                self.by_ext[row["external_id"]] = row


def sync_league(db, client, league, dates, team_cache):
    """Synchronise une ligue sur la fenêtre de dates. Retourne la saison la
    plus récente vue dans les réponses /matches (sert à /standings)."""
    now_iso = datetime.now(timezone.utc).isoformat()
    saison_max = None
    for date in dates:
        try:
            api_matches = client.get_matches(league["external_id"], date)
        except Exception:
            log.exception("Échec /matches ligue=%s date=%s — on continue",
                          league["name"], date)
            continue
        if not api_matches:
            continue

        team_cache.ensure([m["homeTeam"] for m in api_matches]
                          + [m["awayTeam"] for m in api_matches])

        ext_ids = ",".join(str(m["id"]) for m in api_matches)
        existing = {row["external_id"]: row for row in db.select(
            "matches", {"external_id": f"in.({ext_ids})"})}

        for m in api_matches:
            saison = (m.get("league") or {}).get("season")
            if saison and (saison_max is None or saison > saison_max):
                saison_max = saison
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
            except Exception:
                # Un match illisible (ex. statut hors contrainte CHECK) ne
                # doit pas faire échouer tout le run
                log.exception("Échec upsert match external_id=%s", m["id"])
    return saison_max


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
    args = parser.parse_args()
    sport = args.sport

    db = SupabaseDB()
    settings = load_settings(db)
    client = HighlightlyClient(sport)
    leagues = db.select("leagues", {"sport": f"eq.{sport}", "active": "is.true"})
    leagues.sort(key=lambda l: (PRIORITE_CATEGORIE.get(l["category"], 9), l["name"]))

    # Plafond dur du sync des matchs : quota - réserve - budget classements
    # (1 requête par championnat actif). Dépassement impossible.
    nb_championnats = sum(1 for l in leagues if l["category"] == "championnat")
    plafond_matchs = QUOTA_JOURNALIER - QUOTA_RESERVE - nb_championnats
    log.info("Sync %s : %d ligues, plafond matchs %d requêtes, réserve "
             "classements %d", sport, len(leagues), plafond_matchs, nb_championnats)

    team_cache = TeamCache(db, sport)
    now_iso = datetime.now(timezone.utc).isoformat()
    for league in leagues:
        dates = dates_pour_ligue(db, league, sport)
        if client.request_count + len(dates) > plafond_matchs:
            log.warning("Plafond quota atteint (%d requêtes) : ligue %s et "
                        "suivantes reportées au prochain run",
                        client.request_count, league["name"])
            break
        saison = sync_league(db, client, league, dates, team_cache)
        if saison and saison != league.get("current_season"):
            db.update("leagues", {"current_season": saison},
                      {"id": f"eq.{league['id']}"})
        db.update("leagues", {"last_checked_at": now_iso},
                  {"id": f"eq.{league['id']}"})

    lock_started_matches(db)
    apply_elo_and_stats(db, sport, settings)
    generate_upcoming_odds(db, sport, settings)
    sync_standings(db, client, sport, team_cache)
    log.info("Sync %s terminé : %d requêtes Highlightly consommées sur %d",
             sport, client.request_count, QUOTA_JOURNALIER)


if __name__ == "__main__":
    sys.exit(main())
