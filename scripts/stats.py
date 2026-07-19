"""Mise à jour de team_competition_stats après un match terminé
(règle 11, section 4 de la spec).

Appelé par sync_matches.py pour chaque match qui vient de passer à
'finished' (en même temps que la mise à jour Elo, règle 3).
"""

import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)

# Fenêtre de lecture pour recalculer la série en cours : la série peut
# dépasser form_window_size (ex. "V8"), on lit donc large.
STREAK_LOOKBACK = 30


def update_stats_for_match(db, match, settings):
    """match : ligne de `matches` avec status='finished' et scores non nuls."""
    for team_id, is_home in ((match["home_team_id"], True),
                             (match["away_team_id"], False)):
        _update_team(db, team_id, match["league_id"], is_home,
                     match["score_home"], match["score_away"], settings)


def _result_code(team_id, m):
    """'V'/'N'/'D' du point de vue de team_id pour un match terminé."""
    if m["score_home"] == m["score_away"]:
        return "N"
    home_won = m["score_home"] > m["score_away"]
    is_home = m["home_team_id"] == team_id
    return "V" if home_won == is_home else "D"


def _recompute_form(db, team_id, league_id, settings):
    """Recalcule last_results (fenêtre form_window_size, plus récent en
    premier) et current_streak (ex. 'V3', 'D1') depuis l'historique des
    matchs terminés de cette équipe dans cette compétition."""
    window = int(settings["form_window_size"])
    rows = db.select("matches", {
        "league_id": f"eq.{league_id}",
        "status": "eq.finished",
        "or": f"(home_team_id.eq.{team_id},away_team_id.eq.{team_id})",
        "score_home": "not.is.null",
        "score_away": "not.is.null",
        "order": "kickoff_at.desc",
        "limit": str(max(window, STREAK_LOOKBACK)),
        "select": "home_team_id,away_team_id,score_home,score_away",
    })
    codes = [_result_code(team_id, m) for m in rows]
    last_results = ",".join(codes[:window]) if codes else None

    current_streak = None
    if codes:
        n = 1
        while n < len(codes) and codes[n] == codes[0]:
            n += 1
        current_streak = f"{codes[0]}{n}"
    return last_results, current_streak


def _update_team(db, team_id, league_id, is_home, score_home, score_away, settings):
    rows = db.select("team_competition_stats", {
        "team_id": f"eq.{team_id}", "league_id": f"eq.{league_id}",
    })
    row = rows[0] if rows else None

    gf, ga = (score_home, score_away) if is_home else (score_away, score_home)
    if gf > ga:
        outcome = "wins"
    elif gf < ga:
        outcome = "losses"
    else:
        outcome = "draws"
    side = "home" if is_home else "away"

    def cur(key):
        return row[key] if row else 0

    values = {
        "matches_played": cur("matches_played") + 1,
        outcome: cur(outcome) + 1,
        "score_for": cur("score_for") + gf,
        "score_against": cur("score_against") + ga,
        f"{side}_matches_played": cur(f"{side}_matches_played") + 1,
        f"{side}_{outcome}": cur(f"{side}_{outcome}") + 1,
        f"{side}_score_for": cur(f"{side}_score_for") + gf,
        f"{side}_score_against": cur(f"{side}_score_against") + ga,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    last_results, current_streak = _recompute_form(db, team_id, league_id, settings)
    values["last_results"] = last_results
    values["current_streak"] = current_streak

    if row:
        db.update("team_competition_stats", values,
                  {"id": f"eq.{row['id']}"})
    else:
        values.update({"team_id": team_id, "league_id": league_id})
        db.insert("team_competition_stats", [values])
