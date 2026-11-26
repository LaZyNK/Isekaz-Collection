#!/usr/bin/env python3
"""
Isekaz Collection — import automatique des tomes d'une série manga et de leurs ISBN.

Sources (option --source) :
  - glenat : pages « série » du site Glénat (le plus fiable pour Glénat) ;
  - google : Google Books (la plupart des autres éditeurs) ;
  - bnf    : catalogue BnF (complet mais mélange les éditions et les coffrets).
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
    fields = {tag: subfields(record, tag) for tag in ("010", "200", "205", "210", "214", "215", "225", "461")}
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
    fmt = " ".join(v for f in fields["215"] for v in f.get("a", []) + f.get("d", []))
    prix = " ".join(v for f in fields["010"] for v in f.get("b", []) + f.get("d", []))
    return {
        "fmt": fmt,
        "prix": prix,
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


def slugify(txt: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", norm(txt)).strip("-")


def notice(isbn, numero, titre, edition="", annee="", info=""):
    return {"isbns": [isbn], "numero": numero, "titre": titre, "sous_titre": "",
            "edition": edition, "collection": info, "editeur": "", "annee": annee, "fmt": "", "prix": ""}


def search_glenat(titre, edition, url_serie=None):
    """Lit les pages « série » du site Glénat : chaque lien produit contient le n° de tome et l'EAN."""
    base = url_serie or f"https://www.glenat.com/glenat-manga/series-{slugify(f'{titre} {edition}')}/"
    base = base.rstrip("/") + "/"
    print(f"   page série Glénat : {base}")
    vus, page = set(), 1
    headers = {"User-Agent": "Mozilla/5.0 (Isekaz Collection; import ISBN)"}
    while page <= 20:
        url = base if page == 1 else f"{base}{page}/"
        r = requests.get(url, headers=headers, timeout=60)
        if r.status_code == 404:
            break
        r.raise_for_status()
        liens = re.findall(r'href="(?:https://www\.glenat\.com)?/glenat-manga/([^"/]*?)-tome-0*(\d+)-(\d{13})/?"', r.text)
        # on ne garde que les produits de CETTE série (pas les « même auteur » en bas de page)
        prefixe = slugify(f"{titre} {edition}")
        nouveaux = [l for l in liens if l[2] not in vus and l[0].startswith(prefixe)]
        if not nouveaux:
            break
        for slug, num, ean in nouveaux:
            vus.add(ean)
            yield notice(ean, int(num), titre, edition, info="glenat.com")
        page += 1
        time.sleep(0.5)


def search_google(titre, editeur, edition):
    """Google Books : marche pour la plupart des éditeurs français (Kana, Pika, Ki-oon, Kurokawa…)."""
    q = f'intitle:"{titre}"' + (f' intitle:"{edition}"' if edition else "") + f' inpublisher:"{editeur}"'
    for start in range(0, 400, 40):
        r = requests.get("https://www.googleapis.com/books/v1/volumes", timeout=60, params={
            "q": q, "maxResults": 40, "startIndex": start, "printType": "books", "langRestrict": "fr"})
        r.raise_for_status()
        items = r.json().get("items", [])
        for it in items:
            vi = it.get("volumeInfo", {})
            full = f"{vi.get('title', '')} {vi.get('subtitle', '')}"
            isbn = next((i["identifier"] for i in vi.get("industryIdentifiers", [])
                         if i.get("type") == "ISBN_13"), None)
            m = re.search(r"(?:tome|vol(?:ume)?\.?|t\.)\s*0*(\d+)", full, re.I) or re.search(r"\b0*(\d{1,3})\s*$", full.strip())
            if isbn and m:
                yield notice(isbn, int(m.group(1)), vi.get("title", ""), edition,
                             (vi.get("publishedDate") or "")[:4], info=full.strip()[:60])
        if len(items) < 40:
            break
        time.sleep(0.5)


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
    p = argparse.ArgumentParser(description="Importe les ISBN d'une série (site éditeur, Google Books ou BnF) vers Supabase.")
    p.add_argument("--titre", required=True)
    p.add_argument("--editeur", required=True)
    p.add_argument("--edition", default="", help='ex. "Édition originale" (laisser vide si une seule édition)')
    p.add_argument("--auteur", default=None)
    p.add_argument("--nb-tomes", type=int, default=None)
    p.add_argument("--dry-run", action="store_true", help="affiche le résultat sans rien écrire")
    p.add_argument("--source", default="auto", choices=["auto", "glenat", "google", "bnf"],
                   help="auto = site Glénat pour Glénat, Google Books sinon")
    p.add_argument("--url-serie", default=None, help="adresse de la page série chez l'éditeur (si l'adresse devinée ne marche pas)")
    p.add_argument("--detail", action="store_true", help="affiche toutes les notices BnF trouvées")
    p.add_argument("--forcer", action="store_true", help="écrit même si plusieurs ISBN existent pour un tome")
    a = p.parse_args()

    source = a.source
    if source == "auto":
        source = "glenat" if norm(a.editeur).startswith("glenat") else "google"
    print(f"🔎 Recherche ({source}) : {a.titre} / {a.editeur} {('/ ' + a.edition) if a.edition else ''}")
    if source == "glenat":
        notices = list(search_glenat(a.titre, a.edition, a.url_serie))
    elif source == "google":
        notices = list(search_google(a.titre, a.editeur, a.edition))
    else:
        notices = list(search_bnf(a.titre, a.editeur))
    print(f"   {len(notices)} notices trouvées")
    if a.detail:
        for n in sorted(notices, key=lambda n: (n["numero"] or 0, n["annee"])):
            print(f"   T{n['numero']!s:>4} | {','.join(n['isbns']) or '-':<28} | {n['annee']:<4} | "
                  f"{n['titre'][:25]:<25} | éd: {n['edition'][:25]:<25} | coll: {n['collection'][:30]:<30} | "
                  f"{n['fmt'][:25]} | {n['prix'][:30]}")
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
