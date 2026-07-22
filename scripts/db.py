"""Mini-client PostgREST pour Supabase, côté service (bypass RLS).

Utilisé par sync_matches.py, settle_bets.py et stats.py. Seule dépendance :
requests. Les variables d'environnement SUPABASE_URL et SUPABASE_SERVICE_KEY
sont requises (section 9 de la spec).
"""

import logging
import os

import requests

log = logging.getLogger(__name__)


class SupabaseDB:
    def __init__(self):
        try:
            url = os.environ["SUPABASE_URL"]
            key = os.environ["SUPABASE_SERVICE_KEY"]
        except KeyError as exc:
            raise SystemExit(f"Variable d'environnement manquante : {exc}") from exc
        # Tolère une URL collée avec son suffixe /rest/v1
        url = url.rstrip("/")
        if url.endswith("/rest/v1"):
            url = url[: -len("/rest/v1")]
        self.base = url + "/rest/v1"
        self.session = requests.Session()
        headers = {"apikey": key, "Content-Type": "application/json"}
        # Clés legacy = JWT à passer aussi en Bearer ; les clés nouveau
        # format (sb_secret_*) ne se passent que dans apikey
        if not key.startswith("sb_"):
            headers["Authorization"] = f"Bearer {key}"
        self.session.headers.update(headers)

    def select(self, table, params=None):
        r = self.session.get(f"{self.base}/{table}", params=params or {}, timeout=30)
        r.raise_for_status()
        return r.json()

    def insert(self, table, rows, on_conflict=None, ignore_duplicates=False):
        """Insert (ou upsert si on_conflict est fourni) d'une liste de lignes."""
        if not rows:
            return
        params = {}
        prefer = ["return=minimal"]
        if on_conflict:
            params["on_conflict"] = on_conflict
            prefer.append("resolution=ignore-duplicates" if ignore_duplicates
                          else "resolution=merge-duplicates")
        r = self.session.post(
            f"{self.base}/{table}", params=params, json=rows,
            headers={"Prefer": ",".join(prefer)}, timeout=30,
        )
        r.raise_for_status()

    def update(self, table, values, params, return_rows=False):
        """PATCH sur les lignes filtrées par params. Si return_rows, renvoie
        les lignes effectivement modifiées (liste vide = aucun match du filtre)."""
        headers = {"Prefer": "return=representation" if return_rows else "return=minimal"}
        r = self.session.patch(
            f"{self.base}/{table}", params=params, json=values,
            headers=headers, timeout=30,
        )
        r.raise_for_status()
        return r.json() if return_rows else None

    def rpc(self, fonction, args=None):
        """Appel d'une fonction SQL (POST /rest/v1/rpc/...)."""
        r = self.session.post(f"{self.base}/rpc/{fonction}",
                              json=args or {}, timeout=30)
        r.raise_for_status()
        return r.json() if r.content else None

    def delete(self, table, params):
        """DELETE sur les lignes filtrées par params (params obligatoire :
        jamais de delete sans filtre)."""
        if not params:
            raise ValueError("delete sans filtre refusé")
        r = self.session.delete(f"{self.base}/{table}", params=params,
                                headers={"Prefer": "return=minimal"}, timeout=30)
        r.raise_for_status()


def load_settings(db):
    """Charge la ligne unique de model_settings (règle 10 : jamais de
    constante en dur — tout est relu à chaque exécution)."""
    rows = db.select("model_settings", {"id": "eq.default"})
    if not rows:
        raise SystemExit("model_settings (id='default') introuvable — exécuter sql/schema.sql")
    return rows[0]
