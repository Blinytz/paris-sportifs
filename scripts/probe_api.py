#!/usr/bin/env python3
"""Sonde ponctuelle de l'API Highlightly (quelques requêtes seulement).

But : vérifier si /matches accepte une date SANS leagueId. Si oui, une
requête couvre toutes les ligues d'une date au lieu d'une par ligue, ce
qui change radicalement l'économie du quota (voir README).
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone

import requests

HOSTS = {"football": "https://soccer.highlightly.net",
         "rugby": "https://rugby.highlightly.net"}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def essai(sport, params, libelle):
    r = requests.get(f"{HOSTS[sport]}/matches",
                     params=params,
                     headers={"x-rapidapi-key": os.environ["HIGHLIGHTLY_API_KEY"],
                              "User-Agent": UA},
                     timeout=30)
    print(f"\n=== {libelle} ({sport}) -> HTTP {r.status_code}")
    if r.status_code != 200:
        print("   corps :", r.text[:300])
        return
    payload = r.json()
    data = payload.get("data", [])
    pagination = payload.get("pagination", {})
    ligues = {}
    for m in data:
        nom = (m.get("league") or {}).get("name", "?")
        ligues[nom] = ligues.get(nom, 0) + 1
    print(f"   pagination : {pagination}")
    print(f"   {len(data)} matchs, {len(ligues)} ligues distinctes")
    for nom, n in sorted(ligues.items(), key=lambda x: -x[1])[:12]:
        print(f"     - {nom} : {n}")
    if data:
        m = data[0]
        print("   exemple :", json.dumps({
            "id": m.get("id"), "date": m.get("date"),
            "league": m.get("league"), "state": m.get("state"),
        }, ensure_ascii=False)[:400])


def main():
    today = datetime.now(timezone.utc).date()
    demain = (today + timedelta(days=1)).isoformat()
    # 1. date seule, sans leagueId : le test qui compte
    essai("football", {"date": demain, "limit": 100}, "date seule")
    # 2. même chose côté rugby
    essai("rugby", {"date": demain, "limit": 100}, "date seule")
    # 3. contrôle : la forme actuelle (date + leagueId), Ligue 1
    essai("football", {"date": demain, "leagueId": 52695, "limit": 100},
          "date + leagueId (contrôle)")


if __name__ == "__main__":
    sys.exit(main())
