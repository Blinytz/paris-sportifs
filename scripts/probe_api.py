#!/usr/bin/env python3
"""Sonde ponctuelle de l'API Highlightly (quelques requêtes seulement).

Usage :
  python probe_api.py dates      # /matches?date=X sans leagueId
  python probe_api.py leagues rugby [motif]   # cherche une compétition
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone

import requests

HOSTS = {"football": "https://soccer.highlightly.net",
         "rugby": "https://rugby.highlightly.net"}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def _entetes():
    return {"x-rapidapi-key": os.environ["HIGHLIGHTLY_API_KEY"], "User-Agent": UA}


def sonde_dates():
    demain = (datetime.now(timezone.utc).date() + timedelta(days=1)).isoformat()
    for sport in ("football", "rugby"):
        r = requests.get(f"{HOSTS[sport]}/matches",
                         params={"date": demain, "limit": 100},
                         headers=_entetes(), timeout=30)
        print(f"\n=== {sport} date seule -> HTTP {r.status_code}")
        if r.status_code != 200:
            print("   ", r.text[:200]); continue
        payload = r.json()
        ligues = {}
        for m in payload.get("data", []):
            nom = (m.get("league") or {}).get("name", "?")
            ligues[nom] = ligues.get(nom, 0) + 1
        print(f"   {payload.get('pagination')} · {len(ligues)} ligues")
        for nom, n in sorted(ligues.items(), key=lambda x: -x[1])[:15]:
            print(f"     - {nom} : {n}")


def sonde_leagues(sport, motif=None):
    """Liste les compétitions du sport, filtrées par motif (insensible à
    la casse). Sert à retrouver l'external_id d'une compétition absente
    de notre seed."""
    trouvees, offset = [], 0
    while True:
        r = requests.get(f"{HOSTS[sport]}/leagues",
                         params={"limit": 100, "offset": offset},
                         headers=_entetes(), timeout=30)
        if r.status_code != 200:
            print(f"HTTP {r.status_code} : {r.text[:200]}")
            return
        payload = r.json()
        for l in payload.get("data", []):
            nom = l.get("name") or ""
            if not motif or motif.lower() in nom.lower():
                trouvees.append({
                    "id": l.get("id"), "name": nom,
                    "country": (l.get("country") or {}).get("name"),
                    "seasons": [s.get("season") for s in (l.get("seasons") or [])][:3],
                })
        pagination = payload.get("pagination", {})
        offset += 100
        if offset >= pagination.get("totalCount", 0):
            break
    print(f"\n=== {sport} : {len(trouvees)} compétition(s) pour le motif {motif!r}")
    for t in trouvees:
        print("   ", json.dumps(t, ensure_ascii=False))


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "dates"
    if action == "leagues":
        sport = sys.argv[2] if len(sys.argv) > 2 else "rugby"
        motif = sys.argv[3] if len(sys.argv) > 3 else None
        sonde_leagues(sport, motif)
    else:
        sonde_dates()


if __name__ == "__main__":
    sys.exit(main())
