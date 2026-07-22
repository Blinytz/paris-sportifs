#!/usr/bin/env python3
"""Règlement des paris sur SCORE (système du 20/07/2026).

S'exécute juste après sync_matches.py dans le même job GitHub Actions.
Sport-agnostique : règle tous les paris pending dont le match a atteint un
état final.

Depuis le 22/07/2026, le règlement ne crédite plus le portefeuille : il
marque seulement le pari (won / lost / void) et son multiplicateur. Les
Éclats ne rejoignent le solde que lorsque l'utilisateur les récolte dans
l'app (fonction SQL collect_winnings, colonne bets.collected_at).

- Match cancelled/postponed -> void, mise à récolter
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


# Rugby : le « bon écart » se juge par tranche de points, l'écart exact
# étant hors de portée (décision du 23/07/2026). Bornes hautes incluses.
TRANCHES_ECART_RUGBY = (7, 14, 21, 28, 40)


def tranche_ecart_rugby(ecart):
    """Indice de tranche d'un écart en valeur absolue :
    0 -> 0-7, 1 -> 8-14, 2 -> 15-21, 3 -> 22-28, 4 -> 29-40, 5 -> 41+."""
    ecart = abs(ecart)
    for i, borne in enumerate(TRANCHES_ECART_RUGBY):
        if ecart <= borne:
            return i
    return len(TRANCHES_ECART_RUGBY)


def compute_settlement(pred_h, pred_a, score_h, score_a, settings, sport="football"):
    """Retourne (gagne, multiplicateur) pour un pronostic face au score réel.
    multiplicateur : None si perdu, sinon 1 / bonus_ecart / bonus_ecart_nul
    / bonus_score_exact.

    Football : écart exact -> bonus_ecart ; score exact -> bonus_score_exact.
    Un pronostic de nul gagnant a toujours le bon écart (0), son bonus est
    donc réduit (bonus_ecart_nul) pour ne pas le rendre trop rentable.

    Rugby : score exact -> bonus_score_exact_rugby (×10 par défaut, c'est
    quasi impossible) ; écart tombant dans la bonne tranche de points
    (0-7, 8-14, 15-21, 22-28, 29-40, 41+) -> bonus_ecart_rugby."""
    if _outcome(pred_h, pred_a) != _outcome(score_h, score_a):
        return False, None

    if sport == "rugby":
        if pred_h == score_h and pred_a == score_a:
            return True, float(settings["bonus_score_exact_rugby"])
        if tranche_ecart_rugby(pred_h - pred_a) == tranche_ecart_rugby(score_h - score_a):
            return True, float(settings["bonus_ecart_rugby"])
        return True, 1.0

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


def settle_all(db, settings):
    pending = db.select("bets", {
        "status": "eq.pending",
        "select": ("*,match:matches(id,status,score_home,score_away,"
                   "league:leagues(sport))"),
    })
    counts = {"won": 0, "lost": 0, "void": 0}
    for bet in pending:
        match = bet["match"]
        status = match["status"]

        # Match annulé ou reporté -> void, mise à récolter par l'utilisateur
        if status in ("cancelled", "postponed"):
            if _close_bet(db, bet, "void"):
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
            sport = ((match.get("league") or {}).get("sport")) or "football"
            gagne, multiplier = compute_settlement(
                bet["predicted_home"], bet["predicted_away"],
                score_home, score_away, settings, sport)

        if gagne:
            if _close_bet(db, bet, "won", multiplier):
                counts["won"] += 1  # gain à récolter dans l'app
        else:
            if _close_bet(db, bet, "lost"):
                counts["lost"] += 1  # mise déjà débitée au pari

    log.info("Règlement terminé : %d gagnés, %d perdus, %d remboursés "
             "(gains à récolter dans l'app)",
             counts["won"], counts["lost"], counts["void"])


def _tests():
    s = {"bonus_ecart": 1.5, "bonus_ecart_nul": 1.25, "bonus_score_exact": 2.0,
         "bonus_ecart_rugby": 1.5, "bonus_score_exact_rugby": 10.0}
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

    # --- Rugby (décision du 23/07/2026) ---
    r = lambda ph, pa, sh, sa: compute_settlement(ph, pa, sh, sa, s, "rugby")
    # Score exact -> ×10
    assert r(24, 17, 24, 17) == (True, 10.0)
    # Écart 7 pronostiqué, écart 3 réel : même tranche 0-7 -> ×1.5
    assert r(24, 17, 20, 17) == (True, 1.5)
    # Écart 7 (tranche 0-7) contre écart 9 (tranche 8-14) -> bonne issue seule
    assert r(24, 17, 26, 17) == (True, 1.0)
    # Tranche 15-21 des deux côtés -> ×1.5
    assert r(30, 12, 40, 21) == (True, 1.5)
    # Tranche 41+ des deux côtés -> ×1.5
    assert r(60, 5, 70, 3) == (True, 1.5)
    # Bonne tranche mais mauvaise issue -> perdu
    assert r(24, 17, 17, 24) == (False, None)
    # Vérification des bornes de tranches
    assert tranche_ecart_rugby(7) == 0 and tranche_ecart_rugby(8) == 1
    assert tranche_ecart_rugby(14) == 1 and tranche_ecart_rugby(15) == 2
    assert tranche_ecart_rugby(28) == 3 and tranche_ecart_rugby(29) == 4
    assert tranche_ecart_rugby(40) == 4 and tranche_ecart_rugby(41) == 5
    print("settle_bets.py : grille de gains foot et rugby OK")


def valider_brouillons(db):
    """Transforme en paris fermes les brouillons dont le match a commencé
    (fonction SQL validate_due_drafts). À faire avant le règlement : un
    match peut être terminé avant notre premier passage."""
    try:
        valides = db.rpc("validate_due_drafts")
        if valides:
            log.info("%s brouillon(s) validé(s) en pari ferme", valides)
    except Exception:
        log.exception("Échec de la validation des brouillons")


def main():
    if "--test" in sys.argv:
        _tests()
        return
    db = SupabaseDB()
    valider_brouillons(db)
    settle_all(db, load_settings(db))


if __name__ == "__main__":
    sys.exit(main())
