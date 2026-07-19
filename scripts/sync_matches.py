#!/usr/bin/env python3
"""Script principal de synchronisation (sections 4 et 5 de la spec).

Usage : python sync_matches.py --sport football|rugby

Déroulé d'un run :
  1. charge model_settings (règle 10)
  2. pour chaque ligue active du sport, appelle /matches sur la fenêtre de
     dates (foot : J-1 à J+1 ; rugby : J-1 à J+7) — budget quota section 5
  3. upsert équipes (règle 2) et matchs (règle 1)
  4. verrouille les cotes des matchs dont le coup d'envoi est passé (règle 4)
  5. applique le Elo + stats sur les matchs nouvellement terminés (règles 3 et 11)
  6. génère les cotes des matchs à venir non verrouillés (section 6, règle 9)

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

# Fenêtres de dates par sport (jours relatifs à aujourd'hui UTC) — section 5
WINDOWS = {"football": (-1, 1), "rugby": (-1, 7)}

# Budget quotidien de requêtes /standings, en rotation par ancienneté sur
# les ligues 'championnat'. Budget total par run :
#   foot  : 31 ligues actives × 3 dates = 93  + 5 = 98/100
#   rugby :  7 ligues × 9 dates        = 63  + 2 = 65/100
# (l'A-League est désactivée en base — voir sql/standings.sql)
STANDINGS_BUDGET = {"football": 5, "rugby": 2}

# Mapping state.description Highlightly -> status en base (section 2)
STATUS_MAP = {
    "Not Started": "scheduled",
    "Live": "live",
    "1st Half": "live",
    "2nd Half": "live",
    "Half Time": "live",
    "Finished": "finished",
    "Postponed": "postponed",
    "Cancelled": "cancelled",
    "Abandoned": "cancelled",
}


def date_window(sport):
    today = datetime.now(timezone.utc).date()
    first, last = WINDOWS[sport]
    return [(today + timedelta(days=d)).isoformat() for d in range(first, last + 1)]


def map_status(raw):
    if raw in STATUS_MAP:
        return STATUS_MAP[raw]
    # Valeur inconnue : stockée telle quelle sans planter (section 2). La
    # contrainte CHECK de la base peut la refuser — géré par l'appelant.
    log.warning("Statut Highlightly inconnu : %r (stocké tel quel)", raw)
    return raw


def parse_score(state, status):
    """state.score = "2 - 1" (home - away), présent quand finished."""
    if status != "finished":
        return None, None
    raw = (state or {}).get("score")
    try:
        home, away = raw.split(" - ")
        return int(home.strip()), int(away.strip())
    except (AttributeError, ValueError):
        log.warning("Score illisible : %r — scores laissés à null", raw)
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


def sync_standings(db, client, sport, team_cache):
    """Rafraîchit les classements officiels (endpoint /standings) pour les
    ligues 'championnat', en rotation par ancienneté, dans la limite du
    budget quotidien STANDINGS_BUDGET. Le remplacement des lignes se fait
    par (league_id, season) entier : delete puis insert."""
    now_iso = datetime.now(timezone.utc).isoformat()
    candidates = db.select("leagues", {
        "sport": f"eq.{sport}", "active": "is.true",
        "category": "eq.championnat",
        "current_season": "not.is.null",
        "order": "standings_synced_at.asc.nullsfirst",
        "limit": str(STANDINGS_BUDGET[sport]),
    })
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
    dates = date_window(sport)
    log.info("Sync %s : %d ligues × %d dates = %d requêtes prévues",
             sport, len(leagues), len(dates), len(leagues) * len(dates))

    team_cache = TeamCache(db, sport)
    for league in leagues:
        saison = sync_league(db, client, league, dates, team_cache)
        if saison and saison != league.get("current_season"):
            db.update("leagues", {"current_season": saison},
                      {"id": f"eq.{league['id']}"})

    lock_started_matches(db)
    apply_elo_and_stats(db, sport, settings)
    generate_upcoming_odds(db, sport, settings)
    sync_standings(db, client, sport, team_cache)
    log.info("Sync %s terminé — %d requêtes Highlightly consommées",
             sport, client.request_count)


if __name__ == "__main__":
    sys.exit(main())
