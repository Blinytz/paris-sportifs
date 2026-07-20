#!/usr/bin/env python3
"""Maintenance : remet le sync en mode bootstrap (last_checked_at à null
pour toutes les ligues). Le prochain run refait alors la découverte
complète J-1..J+9, étalée par le plafond de quota, championnats d'abord.

À déclencher (workflow maintenance) après une correction du parseur, pour
re-découvrir des matchs rejetés lors d'un run précédent. Ne consomme
aucune requête Highlightly.
"""

from db import SupabaseDB


def main():
    db = SupabaseDB()
    db.update("leagues", {"last_checked_at": None},
              {"last_checked_at": "not.is.null"})
    print("last_checked_at remis à zéro : bootstrap complet au prochain run")


if __name__ == "__main__":
    main()
