#!/usr/bin/env python3
"""
Isekaz Collection — import automatique des tomes d'une série manga et de leurs ISBN.

Source : catalogue de la Bibliothèque nationale de France (API SRU, gratuite, sans clé),
qui reçoit le dépôt légal de chaque livre publié en France.
Destination : tables `series` et `volumes` du projet Supabase.

Exemples :
  python scripts/import_isbn.py --titre "Dragon Ball" --editeur "Glénat" \
      --edition "Édition originale" --nb-tomes 42 --dry-run
  python scripts/import_isbn.py --titre "One Piece" --editeur "Glénat"

Variables d'environnement (pas besoin avec --dry-run) :
  SUPABASE_URL           ex. https://rohiqowmjtcrrailkgdb.supabase.co
  SUPABASE_SERVICE_KEY   clé "service_role" (secrète, jamais dans le site !)
"""
import argparse
import os
import re
import sys
import time
import unicodedata
import xml.etree.ElementTree as ET

import requests

SRU_URL = "https://catalogue.bnf.fr/api/SRU"
NS = {
    "srw": "http://www.loc.gov/zing/srw/",
    "mxc": "info:lc/xmlns/marcxchange-v2",
}
PAGE = 50  # notices par requête


def norm(txt: str) -> str:
    """Minuscules sans accents, pour comparer des titres."""
    txt = unicodedata.normalize("NFKD", txt or "")
    return "".join(c for c in txt if not unicodedata.combining(c)).lower().strip()


def isbn13(raw: str) -> str | None:
    """Nettoie un ISBN et le convertit en ISBN-13 si besoin."""
    digits = re.sub(r"[^0-9Xx]", "", raw or "").upper()
    if len(digits) == 13 and digits.isdigit():
        return digits
    if len(digits) == 10:
        core = "978" + digits[:9]
        total = sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(core))
        return core + str((10 - total % 10) % 10)
    return None


def subfields(record, tag):
    """Liste des sous-champs {code: [valeurs]} pour chaque occurrence d'un champ UNIMARC."""
    out = []
    for df in record.findall(f"mxc:datafield[@tag='{tag}']", NS):
        d = {}
        for sf in df.findall("mxc:subfield", NS):
            d.setdefault(sf.get("code"), []).append((sf.text or "").strip())
        out.append(d)
    return out


def tome_number(rec_fields) -> int | None:
    """Cherche le numéro de tome (200$h, puis 461$v / 225$v)."""
    candidates = []
    for f in rec_fields.get("200", []):
        candidates += f.get("h", [])
    for tag in ("461", "225"):
        for f in rec_fields.get(tag, []):
            candidates += f.get("v", [])
    for c in candidates:
        m = re.search(r"\d+", c)
        if m:
            return int(m.group())
    return None


def parse_record(record):
    fields = {tag: subfields(record, tag) for tag in ("010", "200", "205", "210", "214", "225", "461")}
    isbns = [isbn13(v) for f in fields["010"] for v in f.get("a", [])]
    isbns = [i for i in isbns if i]
    titre = " ".join(v for f in fields["200"] for v in f.get("a", []))
    sous_titre = " ".join(v for f in fields["200"] for v in f.get("i", []) + f.get("e", []))
    edition = " ".join(v for f in fields["205"] for v in f.get("a", []))
    collection = " ".join(v for tag in ("225", "461") for f in fields[tag] for v in f.get("a", []))
    editeur = " ".join(v for tag in ("214", "210") for f in fields[tag] for v in f.get("c", []))
    date = ""
    for tag in ("214", "210"):
        for f in fields[tag]:
            for v in f.get("d", []):
                m = re.search(r"\d{4}", v)
                if m and not date:
                    date = m.group()
    return {
        "isbns": isbns,
        "numero": tome_number(fields),
        "titre": titre,
        "sous_titre": sous_titre,
        "edition": edition,
        "collection": collection,
        "editeur": editeur,
        "annee": date,
    }


def search_bnf(titre: str, editeur: str | None):
    query = f'bib.title all "{titre}"'
    if editeur:
        query += f' and bib.publisher all "{editeur}"'
    query += ' and bib.doctype any "a"'  # documents imprimés
    start = 1
    while True:
        params = {
            "version": "1.2",
            "operation": "searchRetrieve",
            "query": query,
            "recordSchema": "unimarcxchange",
            "maximumRecords": PAGE,
            "startRecord": start,
        }
        r = requests.get(SRU_URL, params=params, timeout=60)
        r.raise_for_status()
        root = ET.fromstring(r.content)
        total = int(root.findtext("srw:numberOfRecords", "0", NS))
        records = root.findall(".//srw:recordData/mxc:record", NS)
        for rec in records:
            yield parse_record(rec)
        start += PAGE
        if start > total or not records:
            break
        time.sleep(0.5)  # on reste poli avec la BnF


def pick_volumes(notices, titre, edition, nb_tomes):
    """Garde un ISBN par numéro de tome, en filtrant sur le titre et l'édition."""
    t, e = norm(titre), norm(edition or "")
    volumes, doublons = {}, {}
    for n in notices:
        if not n["isbns"] or n["numero"] is None:
            continue
        if not norm(n["titre"]).startswith(t):
            continue
        if e:
            texte = norm(" ".join([n["edition"], n["collection"], n["sous_titre"], n["titre"]]))
            if e not in texte:
                continue
        if nb_tomes and not 1 <= n["numero"] <= nb_tomes:
            continue
        num = n["numero"]
        if num in volumes and volumes[num]["isbn13"] != n["isbns"][0]:
            doublons.setdefault(num, {volumes[num]["isbn13"]}).add(n["isbns"][0])
            # on garde la notice la plus récente (réimpression la plus courante en librairie)
            if (n["annee"] or "") <= (volumes[num]["annee"] or ""):
                continue
        volumes[num] = {"numero": num, "isbn13": n["isbns"][0], "annee": n["annee"],
                        "info": n["edition"] or n["collection"]}
    return dict(sorted(volumes.items())), doublons


class Supabase:
    def __init__(self, url, key):
        self.base = url.rstrip("/") + "/rest/v1"
        self.h = {"apikey": key, "Content-Type": "application/json"}
        # Les anciennes clés service_role (JWT) passent aussi en Bearer ;
        # les nouvelles clés secrètes (sb_secret_...) s'envoient uniquement dans "apikey".
        if not key.startswith("sb_"):
            self.h["Authorization"] = f"Bearer {key}"

    def serie_id(self, titre, edition, editeur, auteur, nb_tomes):
        params = {"titre": f"eq.{titre}", "editeur": f"eq.{editeur}", "select": "id"}
        params["edition"] = f"eq.{edition}" if edition else "is.null"
        r = requests.get(f"{self.base}/series", headers=self.h, params=params, timeout=30)
        r.raise_for_status()
        if r.json():
            return r.json()[0]["id"]
        body = {"titre": titre, "edition": edition, "editeur": editeur,
                "auteur": auteur, "nb_tomes": nb_tomes}
        r = requests.post(f"{self.base}/series", headers={**self.h, "Prefer": "return=representation"},
                          json=body, timeout=30)
        r.raise_for_status()
        return r.json()[0]["id"]

    def existing(self, serie_id):
        r = requests.get(f"{self.base}/volumes", headers=self.h,
                         params={"serie_id": f"eq.{serie_id}", "select": "numero,isbn13"}, timeout=30)
        r.raise_for_status()
        return {v["numero"]: v["isbn13"] for v in r.json()}

    def insert_volume(self, serie_id, v):
        body = {"serie_id": serie_id, "numero": v["numero"], "isbn13": v["isbn13"]}
        r = requests.post(f"{self.base}/volumes", headers=self.h, json=body, timeout=30)
        return r.status_code < 300, r.text


def main():
    p = argparse.ArgumentParser(description="Importe les ISBN d'une série depuis la BnF vers Supabase.")
    p.add_argument("--titre", required=True)
    p.add_argument("--editeur", required=True)
    p.add_argument("--edition", default="", help='ex. "Édition originale" (laisser vide si une seule édition)')
    p.add_argument("--auteur", default=None)
    p.add_argument("--nb-tomes", type=int, default=None)
    p.add_argument("--dry-run", action="store_true", help="affiche le résultat sans rien écrire")
    p.add_argument("--forcer", action="store_true", help="écrit même si plusieurs ISBN existent pour un tome")
    a = p.parse_args()

    print(f"🔎 Recherche BnF : {a.titre} / {a.editeur} {('/ ' + a.edition) if a.edition else ''}")
    notices = list(search_bnf(a.titre, a.editeur))
    print(f"   {len(notices)} notices trouvées")
    volumes, doublons = pick_volumes(notices, a.titre, a.edition, a.nb_tomes)
    print(f"   {len(volumes)} tomes avec ISBN retenus")
    for num, isbns in sorted(doublons.items()):
        print(f"   ⚠️  tome {num} : plusieurs ISBN possibles {sorted(isbns)} — à vérifier")
    if a.nb_tomes:
        manquants = [n for n in range(1, a.nb_tomes + 1) if n not in volumes]
        if manquants:
            print(f"   ❓ tomes non trouvés : {manquants}")

    if a.dry_run:
        for v in volumes.values():
            print(f"   T{v['numero']:>3}  {v['isbn13']}  ({v['annee']})  {v['info']}")
        return

    if doublons and not a.forcer:
        sys.exit("⛔ Rien n'a été écrit : plusieurs ISBN pour certains tomes, ce qui veut dire que "
                 "plusieurs éditions sont mélangées. Précise --edition (ou coche « forcer » si tu es sûr).")
    if not volumes:
        sys.exit("⛔ Rien n'a été écrit : aucun tome trouvé avec ces critères.")

    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("❌ SUPABASE_URL et SUPABASE_SERVICE_KEY doivent être définies (ou utilise --dry-run).")
    db = Supabase(url, key)
    sid = db.serie_id(a.titre, a.edition or None, a.editeur, a.auteur, a.nb_tomes)
    deja = db.existing(sid)
    ajoutes = 0
    for v in volumes.values():
        if v["numero"] in deja:
            if deja[v["numero"]] != v["isbn13"]:
                print(f"   ↔️  tome {v['numero']} déjà en base avec {deja[v['numero']]} (BnF : {v['isbn13']}) — conservé")
            continue
        ok, msg = db.insert_volume(sid, v)
        if ok:
            ajoutes += 1
        else:
            print(f"   ❌ tome {v['numero']} ({v['isbn13']}) : {msg}")
    print(f"✅ {ajoutes} tome(s) ajouté(s) à la série #{sid}")


if __name__ == "__main__":
    main()
