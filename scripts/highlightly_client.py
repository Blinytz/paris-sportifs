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
