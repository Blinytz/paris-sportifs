#!/usr/bin/env python3
"""Règlement des paris sur SCORE (système du 20/07/2026).

S'exécute juste après sync_matches.py dans le même job GitHub Actions.
Sport-agnostique : règle tous les paris pending dont le match a atteint un
état final.

- Match cancelled/postponed -> void + remboursement intégral de la mise
- Match finished, score connu -> comparaison pronostic / score réel :
    issue fausse                       -> lost (mise déjà débitée au pari)
    bonne issue (vainqueur ou nul)     -> won, gain = potential_payout
    + bon écart signé (pred_h - pred_a == score_h - score_a)
                                       -> gain × bonus_ecart (déf. 1.5)
    + score exact                      -> gain × bonus_score_exact (déf. 2)
  Les bonus sont lus dans model_settings à chaque run (règle 10).
  Le nul est une issue comme une autre, au rugby comme au foot (un
  pronostic 12-12 gagne sur n'importe quel nul, ×bonus_ecart d'office
  puisque l'écart 0 est forcément le bon, ×bonus_score_exact si exact).

Idempotence : le passage pending -> état final est fait par un PATCH
conditionné sur status=pending ; l'entrée ledger n'est créée que si ce
PATCH a réellement modifié la ligne. Un re-run ne crédite jamais deux fois.

Test rapide : `python settle_bets.py --test` vérifie la grille de gains.
"""

import logging
import sys
from datetime import datetime, timezone

from db import SupabaseDB, load_settings

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("settle")


def _outcome(home, away):
    if home > away:
        return "home"
    if home < away:
        return "away"
    return "draw"


def compute_settlement(pred_h, pred_a, score_h, score_a, settings):
    """Retourne (gagne, multiplicateur) pour un pronostic face au score réel.
    multiplicateur : None si perdu, sinon 1 / bonus_ecart / bonus_ecart_nul
    / bonus_score_exact.

    Un pronostic de nul gagnant a toujours le bon écart (0) : son bonus
    écart est réduit (bonus_ecart_nul, déf. 1.25) pour ne pas rendre le
    pari nul systématiquement trop rentable."""
    if _outcome(pred_h, pred_a) != _outcome(score_h, score_a):
        return False, None
    if pred_h == score_h and pred_a == score_a:
        return True, float(settings["bonus_score_exact"])
    if (pred_h - pred_a) == (score_h - score_a):
        if pred_h == pred_a:
            return True, float(settings["bonus_ecart_nul"])
        return True, float(settings["bonus_ecart"])
    return True, 1.0


def _close_bet(db, bet, new_status, multiplier=None):
    """Passe le pari de pending à new_status. Renvoie True si la transition
    a bien eu lieu dans ce run (False si déjà réglée par un run précédent)."""
    values = {
        "status": new_status,
        "resolved_at": datetime.now(timezone.utc).isoformat(),
    }
    if multiplier is not None:
        values["bonus_multiplier"] = multiplier
    changed = db.update("bets", values, {
        "id": f"eq.{bet['id']}", "status": "eq.pending",
    }, return_rows=True)
    return bool(changed)


def _credit(db, bet, amount, source):
    db.insert("eclats_ledger", [{
        "user_id": bet["user_id"],
        "amount": round(float(amount), 2),
        "source": source,
        "reference_id": bet["id"],
    }])


def settle_all(db, settings):
    pending = db.select("bets", {
        "status": "eq.pending",
        "select": "*,match:matches(id,status,score_home,score_away)",
    })
    counts = {"won": 0, "lost": 0, "void": 0}
    for bet in pending:
        match = bet["match"]
        status = match["status"]

        # Match annulé ou reporté -> void + remboursement
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

        if bet.get("predicted_home") is None or bet.get("predicted_away") is None:
            # Garde-fou : ancien pari 1x2 sans pronostic de score
            gagne = bet["selection"] == _outcome(score_home, score_away)
            multiplier = 1.0 if gagne else None
        else:
            gagne, multiplier = compute_settlement(
                bet["predicted_home"], bet["predicted_away"],
                score_home, score_away, settings)

        if gagne:
            if _close_bet(db, bet, "won", multiplier):
                _credit(db, bet, float(bet["potential_payout"]) * multiplier,
                        "paris_sportifs_gain")
                counts["won"] += 1
        else:
            if _close_bet(db, bet, "lost"):
                counts["lost"] += 1  # mise déjà débitée au pari

    log.info("Règlement terminé : %d gagnés, %d perdus, %d remboursés",
             counts["won"], counts["lost"], counts["void"])


def _tests():
    s = {"bonus_ecart": 1.5, "bonus_ecart_nul": 1.25, "bonus_score_exact": 2.0}
    # Exemples de la décision du 20/07/2026 :
    # pronostic 1-0, score 2-1 : bonne issue + bon écart (+1) -> ×1.5
    assert compute_settlement(1, 0, 2, 1, s) == (True, 1.5)
    # pronostic 1-0, score 1-2 : écart +1 pronostiqué mais résultat -1 -> perdu
    assert compute_settlement(1, 0, 1, 2, s) == (False, None)
    # score exact -> ×2
    assert compute_settlement(2, 1, 2, 1, s) == (True, 2.0)
    # bonne issue, mauvais écart (1-0 pronostiqué, 3-0 réel) -> ×1
    assert compute_settlement(1, 0, 3, 0, s) == (True, 1.0)
    # nul pronostiqué, autre nul : écart 0 forcément bon mais bonus réduit
    # (décision du 20/07/2026) -> ×1.25 et pas ×1.5
    assert compute_settlement(1, 1, 2, 2, s) == (True, 1.25)
    # nul exact -> ×2 (valable rugby comme foot, ex. 12-12)
    assert compute_settlement(12, 12, 12, 12, s) == (True, 2.0)
    # nul pronostiqué, victoire réelle -> perdu
    assert compute_settlement(1, 1, 1, 0, s) == (False, None)
    print("settle_bets.py : grille de gains OK")


def main():
    if "--test" in sys.argv:
        _tests()
        return
    db = SupabaseDB()
    settle_all(db, load_settings(db))


if __name__ == "__main__":
    sys.exit(main())
