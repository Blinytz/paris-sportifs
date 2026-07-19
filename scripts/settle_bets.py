#!/usr/bin/env python3
"""Règlement des paris (règles 5, 6 et 7 de la section 4).

S'exécute juste après sync_matches.py dans le même job GitHub Actions.
Sport-agnostique : règle tous les paris pending dont le match a atteint un
état final, quel que soit le sport.

- Match cancelled/postponed  -> void + remboursement intégral (règle 6)
- Rugby terminé sur égalité  -> void + remboursement intégral (règle 5)
- Match finished score connu -> won (crédit potential_payout) ou lost (règle 7)

Idempotence : le passage pending -> état final est fait par un PATCH
conditionné sur status=pending ; l'entrée ledger n'est créée que si ce
PATCH a réellement modifié la ligne. Un re-run ne crédite jamais deux fois.
"""

import logging
import sys
from datetime import datetime, timezone

from db import SupabaseDB

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("settle")


def _close_bet(db, bet, new_status):
    """Passe le pari de pending à new_status. Renvoie True si la transition
    a bien eu lieu dans ce run (False si déjà réglée par un run précédent)."""
    changed = db.update("bets", {
        "status": new_status,
        "resolved_at": datetime.now(timezone.utc).isoformat(),
    }, {"id": f"eq.{bet['id']}", "status": "eq.pending"}, return_rows=True)
    return bool(changed)


def _credit(db, bet, amount, source):
    db.insert("eclats_ledger", [{
        "user_id": bet["user_id"],
        "amount": amount,
        "source": source,
        "reference_id": bet["id"],
    }])


def settle_all(db):
    pending = db.select("bets", {
        "status": "eq.pending",
        "select": ("*,match:matches(id,status,score_home,score_away,"
                   "league:leagues(sport))"),
    })
    counts = {"won": 0, "lost": 0, "void": 0}
    for bet in pending:
        match = bet["match"]
        status = match["status"]

        # Règle 6 : match annulé ou reporté -> void + remboursement
        if status in ("cancelled", "postponed"):
            if _close_bet(db, bet, "void"):
                _credit(db, bet, bet["stake_eclats"], "paris_sportifs_remboursement")
                counts["void"] += 1
            continue

        if status != "finished":
            continue
        score_home, score_away = match["score_home"], match["score_away"]
        if score_home is None or score_away is None:
            log.warning("Match %s finished sans score — pari %s laissé pending",
                        match["id"], bet["id"])
            continue

        # Règle 5 : égalité en rugby (marché 2 voies) -> void + remboursement
        sport = (match.get("league") or {}).get("sport")
        if sport == "rugby" and score_home == score_away:
            if _close_bet(db, bet, "void"):
                _credit(db, bet, bet["stake_eclats"], "paris_sportifs_remboursement")
                counts["void"] += 1
            continue

        # Règle 7 : résultat réel puis won/lost
        if score_home > score_away:
            outcome = "home"
        elif score_home < score_away:
            outcome = "away"
        else:
            outcome = "draw"

        if bet["selection"] == outcome:
            if _close_bet(db, bet, "won"):
                _credit(db, bet, bet["potential_payout"], "paris_sportifs_gain")
                counts["won"] += 1
        else:
            if _close_bet(db, bet, "lost"):
                counts["lost"] += 1  # mise déjà débitée au pari (règle 8)

    log.info("Règlement terminé : %d gagnés, %d perdus, %d remboursés",
             counts["won"], counts["lost"], counts["void"])


def main():
    settle_all(SupabaseDB())


if __name__ == "__main__":
    sys.exit(main())
