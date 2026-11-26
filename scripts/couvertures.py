#!/usr/bin/env python3
"""
Isekaz Collection — remplit les couvertures (et dates exactes, prix, résumés) des tomes qui n'en ont pas.

La BnF ne fournit pas d'images : on demande à Google Books, série par série, via la fonction « recherche »
(mode { completer: id }, 1 à 3 appels Google par série). Les séries possédées ou suivies par des membres passent en premier.
Google limite à environ 1 000 appels par jour : le script s'arrête tout seul quand le quota du jour est épuisé,
et reprend où il en était le lendemain (une série traitée n'est retentée qu'au bout de 30 jours).

  python scripts/couvertures.py --series 300
"""
import argparse, os, sys, time
import requests


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--series", type=int, default=300, help="nombre maximum de séries à traiter")
    a = p.parse_args()
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("❌ SUPABASE_URL et SUPABASE_SERVICE_KEY doivent être définies.")
    h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    r = requests.post(f"{url}/rest/v1/rpc/series_a_illustrer", headers=h, json={"limite": a.series}, timeout=120)
    r.raise_for_status()
    liste = r.json()
    print(f"🖼️  {len(liste)} séries avec des tomes sans couverture à traiter")
    total, appels = 0, 0
    for i, s in enumerate(liste, 1):
        try:
            res = requests.post(f"{url}/functions/v1/recherche", headers=h, json={"completer": s["id"]}, timeout=150)
        except Exception as e:
            print(f"   ⚠️  série {s['id']} : {str(e)[:100]}")
            time.sleep(5)
            continue
        if res.status_code == 429:
            print(f"⏸️  quota Google du jour atteint après {i - 1} séries — suite demain")
            break
        if not res.ok:
            print(f"   ⚠️  série {s['id']} : HTTP {res.status_code}")
            continue
        d = res.json()
        total += d.get("completes", 0)
        appels += d.get("appels", 1)
        if i % 20 == 0:
            print(f"   {i}/{len(liste)} séries · {total} tomes complétés · ~{appels} appels Google")
        time.sleep(0.5)
    print(f"✅ {total} tomes complétés (couverture, date, prix ou résumé), ~{appels} appels Google")


if __name__ == "__main__":
    main()
