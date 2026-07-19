"""Calcul Elo et génération des cotes (section 6 de la spec).

Toutes les fonctions reçoivent le dict `settings` = ligne model_settings
(règle 10 : aucun paramètre en dur, tout vient de la base). ELO_START est
la seule vraie constante (point de départ neutre obligatoire).

Test rapide : `python elo.py` vérifie l'exemple chiffré de la spec.
"""

ELO_START = 1500  # fixe, jamais modifiable


def _advantage(sport, settings):
    return float(settings["home_advantage_football"] if sport == "football"
                 else settings["home_advantage_rugby"])


def update_elo(rating_home, rating_away, result, sport, settings):
    """result : 1.0 victoire domicile, 0.5 nul, 0.0 victoire extérieur.
    Retourne (nouveau_rating_home, nouveau_rating_away)."""
    k = float(settings["elo_k_factor"])
    advantage = _advantage(sport, settings)
    expected_home = 1 / (1 + 10 ** ((rating_away - rating_home - advantage) / 400))
    expected_away = 1 - expected_home

    new_home = rating_home + k * (result - expected_home)
    new_away = rating_away + k * ((1 - result) - expected_away)
    return round(new_home, 1), round(new_away, 1)


def generate_odds(rating_home, rating_away, sport, settings):
    """Retourne {"home": cote, "draw": cote_ou_None, "away": cote}."""
    margin = float(settings["margin_factor"])
    odds_max = float(settings["odds_max"])
    advantage = _advantage(sport, settings)
    p_home_raw = 1 / (1 + 10 ** ((rating_away - rating_home - advantage) / 400))

    def cote(p):
        return _clamp_odds(1 / (p * margin), settings) if p > 0 else odds_max

    if sport == "football":
        gap = abs(rating_home - rating_away)
        p_draw = max(float(settings["draw_min_prob"]),
                     min(float(settings["draw_max_prob"]),
                         float(settings["draw_base_prob"]) - gap / float(settings["draw_gap_divisor"])))
        remaining = 1 - p_draw
        p_home = p_home_raw * remaining
        p_away = remaining - p_home
        return {"home": cote(p_home), "draw": cote(p_draw), "away": cote(p_away)}

    # rugby : marché 2 voies
    return {"home": cote(p_home_raw), "draw": None, "away": cote(1 - p_home_raw)}


def _clamp_odds(value, settings):
    return round(max(float(settings["odds_min"]),
                     min(float(settings["odds_max"]), value)), 2)


if __name__ == "__main__":
    # Exemple chiffré de la spec (section 6) : 1500 vs 1500, foot.
    # Attendu avant marge : dom ≈ 2.36, nul ≈ 3.57, ext ≈ 3.37.
    # (La spec arrondit p_home_raw à 0.588 ; la valeur exacte est 0.5925,
    # d'où des cotes exactes de 2.34 / 3.57 / 3.41 — même ordre de grandeur.)
    defaults = {
        "elo_k_factor": 32, "home_advantage_football": 65, "home_advantage_rugby": 50,
        "margin_factor": 1.0,  # marge neutralisée pour comparer "avant marge"
        "odds_min": 1.05, "odds_max": 15.00,
        "draw_base_prob": 0.28, "draw_min_prob": 0.15, "draw_max_prob": 0.30,
        "draw_gap_divisor": 4000, "form_window_size": 5,
    }
    odds = generate_odds(1500, 1500, "football", defaults)
    assert abs(odds["home"] - 2.36) < 0.05, odds
    assert abs(odds["draw"] - 3.57) < 0.05, odds
    assert abs(odds["away"] - 3.37) < 0.05, odds

    nh, na = update_elo(1500, 1500, 1.0, "football", defaults)
    assert nh > 1500 > na and nh - 1500 < 32, (nh, na)
    print("elo.py : tous les tests passent", odds, (nh, na))
