"""Wrapper d'appel API Highlightly (section 2 de la spec).

- Hôtes séparés foot/rugby, quota 100 requêtes/jour par sous-API.
- Header x-rapidapi-key obligatoire, User-Agent recommandé (évite un 403
  Cloudflare observé sans ce header).
- Ne PAS appeler /leagues dans le sync courant : les 39 ligues sont en dur
  dans le seed SQL.
"""

import logging
import os

import requests

log = logging.getLogger(__name__)

HOSTS = {
    "football": "https://soccer.highlightly.net",
    "rugby": "https://rugby.highlightly.net",
}
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
PAGE_LIMIT = 100


class HighlightlyClient:
    def __init__(self, sport):
        if sport not in HOSTS:
            raise ValueError(f"Sport inconnu : {sport}")
        try:
            key = os.environ["HIGHLIGHTLY_API_KEY"]
        except KeyError as exc:
            raise SystemExit(f"Variable d'environnement manquante : {exc}") from exc
        self.base = HOSTS[sport]
        self.session = requests.Session()
        self.session.headers.update({
            "x-rapidapi-key": key,
            "User-Agent": USER_AGENT,
        })
        self.request_count = 0  # suivi du budget quota (section 5)

    def get_standings(self, league_external_id, season):
        """GET /standings?leagueId=X&season=Y — 1 requête dans le quota.
        Retourne la réponse brute (à passer à parse_standings)."""
        r = self.session.get(
            f"{self.base}/standings",
            params={"leagueId": league_external_id, "season": season},
            timeout=30,
        )
        self.request_count += 1
        r.raise_for_status()
        return r.json()

    def get_matches_by_date(self, date, max_pages=8):
        """GET /matches?date=YYYY-MM-DD SANS leagueId : renvoie les matchs
        de TOUTES les ligues de cette date (vérifié le 21/07/2026 : 188
        matchs / 28 ligues en une requête). C'est la façon économe de
        synchroniser ; le filtrage sur nos ligues se fait ensuite en local.

        max_pages borne le coût d'une journée très chargée. Retourne la
        liste des matchs (le compteur de requêtes est tenu par le client).
        """
        out, offset = [], 0
        for _ in range(max_pages):
            r = self.session.get(
                f"{self.base}/matches",
                params={"date": date, "limit": PAGE_LIMIT, "offset": offset},
                timeout=30,
            )
            self.request_count += 1
            r.raise_for_status()
            payload = r.json()
            out.extend(payload.get("data", []))
            total = payload.get("pagination", {}).get("totalCount", 0)
            offset += PAGE_LIMIT
            if offset >= total:
                return out
        log.warning("Date %s : plafond de %d pages atteint, matchs au-delà "
                    "ignorés", date, max_pages)
        return out

    def get_matches(self, league_external_id, date):
        """GET /matches?leagueId=X&date=YYYY-MM-DD, pagination comprise.

        Une date+ligue = 1 requête dans le budget quota (la pagination
        au-delà de 100 matchs est rarissime mais gérée).
        """
        out, offset = [], 0
        while True:
            r = self.session.get(
                f"{self.base}/matches",
                params={"leagueId": league_external_id, "date": date,
                        "limit": PAGE_LIMIT, "offset": offset},
                timeout=30,
            )
            self.request_count += 1
            r.raise_for_status()
            payload = r.json()
            out.extend(payload.get("data", []))
            pagination = payload.get("pagination", {})
            if pagination.get("totalCount", 0) > offset + PAGE_LIMIT:
                offset += PAGE_LIMIT
            else:
                return out


def _premier(d, *cles):
    """Première valeur non nulle parmi plusieurs noms de clés possibles
    (les sous-API foot et rugby ne nomment pas les champs pareil)."""
    for cle in cles:
        if d.get(cle) is not None:
            return d[cle]
    return None


def parse_standings(payload):
    """Normalise une réponse /standings (foot ou rugby) en liste de dicts :
    {group_name, position, points, team_external_id, team_name,
     games_played, wins, draws, losses, score_for, score_against}.

    Formats gérés :
    - enveloppe {"groups": [{"name": ..., "standings": [...]}]} ou liste/clé
      "standings" directe ;
    - lignes foot avec sous-objet "total" (games, wins, draws, loses,
      scoredGoals, receivedGoals) ; lignes rugby à plat (gamesPlayed,
      scoredPoints, receivedPoints, loses).
    """
    if isinstance(payload, dict):
        groupes = payload.get("groups")
        if not groupes:
            groupes = [{"name": None,
                        "standings": payload.get("standings") or payload.get("data") or []}]
    else:
        groupes = [{"name": None, "standings": payload or []}]

    lignes = []
    for groupe in groupes:
        nom_groupe = groupe.get("name")
        for rang in groupe.get("standings") or []:
            equipe = rang.get("team") or {}
            # Foot : les compteurs sont dans "total" ; rugby : à plat
            plat = {**rang, **(rang.get("total") or {})}
            if equipe.get("id") is None or rang.get("position") is None:
                log.warning("Ligne de classement illisible ignorée : %r", rang)
                continue
            lignes.append({
                "group_name": nom_groupe,
                "position": rang["position"],
                "points": _premier(plat, "points"),
                "team_external_id": equipe["id"],
                "team_name": equipe.get("name"),
                "games_played": _premier(plat, "gamesPlayed", "games", "played", "matches"),
                "wins": _premier(plat, "wins", "won"),
                "draws": _premier(plat, "draws", "drawn"),
                "losses": _premier(plat, "losses", "loses", "lost"),
                "score_for": _premier(plat, "scoredPoints", "scoredGoals",
                                      "goalsFor", "scored"),
                "score_against": _premier(plat, "receivedPoints", "receivedGoals",
                                          "goalsAgainst", "received"),
            })
    return lignes


if __name__ == "__main__":
    # Tests du parseur sur les deux formats documentés
    foot = {"groups": [{"name": None, "standings": [{
        "position": 1, "points": 84, "team": {"id": 90990, "name": "Paris SG"},
        "total": {"games": 34, "wins": 26, "draws": 6, "loses": 2,
                  "scoredGoals": 89, "receivedGoals": 31},
        "home": {}, "away": {},
    }]}]}
    lignes = parse_standings(foot)
    assert lignes[0]["team_external_id"] == 90990 and lignes[0]["wins"] == 26
    assert lignes[0]["score_for"] == 89 and lignes[0]["losses"] == 2

    rugby = {"groups": [{"name": "Poule unique", "standings": [{
        "position": 3, "points": 61, "team": {"id": 14401, "name": "Toulouse"},
        "gamesPlayed": 26, "wins": 18, "draws": 1, "loses": 7,
        "scoredPoints": 712, "receivedPoints": 501,
    }]}]}
    lignes = parse_standings(rugby)
    assert lignes[0]["games_played"] == 26 and lignes[0]["score_against"] == 501
    assert lignes[0]["group_name"] == "Poule unique"
    print("highlightly_client.py : parseur standings OK")
