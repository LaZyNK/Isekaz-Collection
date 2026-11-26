#!/usr/bin/env python3
"""
Isekaz Collection — pré-remplissage du catalogue avec tous les mangas publiés en France.

Source : catalogue de la BnF (dépôt légal, API SRU gratuite, sans clé).
On interroge éditeur par éditeur et année par année, on garde les mangas, on range
les tomes par série (titre + éditeur + format, pour séparer par ex. l'édition originale
18 cm de la Perfect Edition 21 cm), un seul ISBN par numéro de tome.
Tout ce qui est créé est marqué source = 'bnf' (facile à retirer si besoin).
Les ISBN déjà présents dans la base ne sont jamais modifiés.

Exemples :
  python scripts/prefill_bnf.py --editeurs Pika --depuis 2024 --jusqua 2024 --dry-run
  python scripts/prefill_bnf.py --editeurs tous --depuis 1990
  python scripts/prefill_bnf.py --editeurs tous --nouveautes        # année en cours + précédente

Variables d'environnement (pas besoin avec --dry-run) : SUPABASE_URL, SUPABASE_SERVICE_KEY
"""
import argparse
import datetime as dt
import os
import re
import sys
import time
import unicodedata
import xml.etree.ElementTree as ET
from collections import defaultdict

import requests

SRU = "https://catalogue.bnf.fr/api/SRU"
NS = {"srw": "http://www.loc.gov/zing/srw/", "mxc": "info:lc/xmlns/marcxchange-v2"}
PAGE = 50
UA = {"User-Agent": "IsekazCollection/1.0 (catalogue manga; contact via GitHub LaZyNK/Isekaz-Collection)"}

# Éditeur (nom affiché) -> (texte cherché à la BnF, ne publie que du manga ?)
EDITEURS = {
    "Pika": ("Pika", True), "Kana": ("Kana", False), "Glénat": ("Glénat", False), "Ki-oon": ("Ki-oon", True),
    "Kurokawa": ("Kurokawa", True), "Kazé": ("Kazé", True), "Crunchyroll": ("Crunchyroll", True),
    "Delcourt/Tonkam": ("Tonkam", False), "Delcourt": ("Delcourt", False), "Akata": ("Akata", True),
    "Doki-Doki": ("Doki-Doki", True), "Komikku": ("Komikku", True), "Meian": ("Meian", True),
    "Mangetsu": ("Mangetsu", True), "Noeve Grafx": ("Noeve", True), "Ototo": ("Ototo", True),
    "Taifu": ("Taifu", True), "Panini": ("Panini", False), "Soleil": ("Soleil", False),
    "Casterman": ("Casterman", False), "Vega-Dupuis": ("Vega", False), "Michel Lafon": ("Michel Lafon", False),
    "Nobi Nobi": ("Nobi nobi", True), "Isan Manga": ("Isan", True), "Black Box": ("Black box", True),
    "Kotoji": ("Kotoji", True), "Naban": ("Naban", True), "Shiba": ("Shiba", True), "Hana": ("Hana", True),
    "Dupuis": ("Dupuis", False), "Bamboo": ("Bamboo", False), "Mana Books": ("Mana books", False),
}
MANGA_MOTS = re.compile(r"manga|sh[oōô]nen|shounen|seinen|sh[oōô]jo|shoujo|josei|kodomo|webtoon|manhwa|manhua|ki-oon|tonkam|kurokawa", re.I)
COLLECTOR = re.compile(r"collector|[ée]dition limit[ée]e|tirage limit[ée]", re.I)
STARTER = re.compile(r"starter|pack d[ée]couverte|kit de d[ée]marrage", re.I)
BUNDLE = re.compile(r"bundle|pack\b|lot de", re.I)
COFFRET = re.compile(r"coffret|bo[iî]te|[ée]tui", re.I)


def public_de(txt: str):
    t = txt.lower()
    for mot, val in ((r"sh[oōô]u?jo", "shojo"), (r"josei", "josei"), (r"seinen", "seinen"), (r"kodomo", "kodomo"), (r"sh[oōô]u?nen", "shonen")):
        if re.search(mot, t):
            return val
    return None


def norm(t: str) -> str:
    t = unicodedata.normalize("NFKD", t or "")
    return re.sub(r"\s+", " ", "".join(c for c in t if not unicodedata.combining(c))).lower().strip(" .,:;-")


def propre(t: str) -> str:
    """Nettoie un titre BnF : crochets, guillemets, ponctuation finale, majuscule initiale."""
    t = re.sub(r"[\[\]«»\"]", "", t or "")
    t = re.sub(r"\s+", " ", t).strip(" .,:;/=-")
    return t[:1].upper() + t[1:] if t else t


def isbn13(raw: str):
    d = re.sub(r"[^0-9Xx]", "", raw or "").upper()
    if len(d) == 10:
        core = "978" + d[:9]
        d = core + str((10 - sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(core)) % 10) % 10)
    if len(d) != 13 or not d.isdigit() or not d.startswith(("978", "979")):
        return None
    total = sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(d[:12]))
    return d if (10 - total % 10) % 10 == int(d[12]) else None


def sf(rec, tag):
    out = []
    for df in rec.findall(f"mxc:datafield[@tag='{tag}']", NS):
        d = defaultdict(list)
        for s in df.findall("mxc:subfield", NS):
            d[s.get("code")].append((s.text or "").strip())
        out.append(d)
    return out


def premier(fields, code):
    for f in fields:
        if f.get(code):
            return f[code][0]
    return ""


def numero(txt: str):
    m = re.search(r"(\d{1,3})", txt or "")
    n = int(m.group(1)) if m else None
    return n if n and n <= 300 else None


def analyse(rec):
    """Transforme une notice UNIMARC en tome, ou None si ce n'est pas exploitable."""
    f = {t: sf(rec, t) for t in ("010", "101", "200", "205", "210", "214", "215", "225", "410", "461", "606", "608", "700")}
    isbn = next((i for x in f["010"] for i in map(isbn13, x.get("a", [])) if i), None)
    if not isbn:
        return None
    serie = nom_tome = None
    titre = premier(f["200"], "a")
    sous = premier(f["200"], "i") or premier(f["200"], "e")
    n = numero(premier(f["200"], "h"))
    if n:  # « Blue lock. 5 » : la série est le titre propre
        serie, nom_tome = titre, sous
    else:  # « Sangoku » dans la collection « Dragon Ball ; 1 »
        for tag in ("461", "410", "225"):
            for x in f[tag]:
                v = x.get("v", [""])[0]
                if numero(v):
                    n, serie, nom_tome = numero(v), (x.get("t") or x.get("a") or [""])[0], titre
                    break
            if n:
                break
    # coffrets, starters, bundles, collectors : éditions spéciales rattachées au tome
    texte = f"{titre} {sous} {premier(f['205'], 'a')}"
    variante = contenu = None
    if STARTER.search(texte):
        variante = "starter"
    elif BUNDLE.search(texte):
        variante = "bundle"
    elif COFFRET.search(texte):
        variante = "coffret"
    elif COLLECTOR.search(texte):
        variante = "limitee" if re.search(r"limit", texte, re.I) else "collector"
    if variante in ("starter", "bundle", "coffret"):
        m = re.search(r"(?:tomes?|vol(?:umes?)?\.?|t\.)\s*(\d{1,3})\s*(?:[àa\-–]|et)\s*(\d{1,3})", texte, re.I)
        if m:
            n = n or int(m.group(1))
            contenu = f"Tomes {int(m.group(1))} à {int(m.group(2))}"
        if not serie:  # « Coffret One Piece » sans série identifiée
            serie = re.sub(r"(?i)^(coffret|starter( pack)?|pack|bundle)\s*[:-]?\s*", "", titre).split(" - ")[0]
        n = n or 1
    if not n or not serie:
        return None
    langue = premier(f["101"], "a")
    taille = ""
    for x in f["215"]:
        m = re.search(r"(\d{2})\s*(?:x\s*\d+\s*)?cm", " ".join(x.get("d", [])))
        if m:
            taille = m.group(1)
    prix = None
    for x in f["010"]:
        m = re.search(r"(\d+)[,.](\d{2})\s*(?:EUR|€)", " ".join(x.get("d", [])))
        if m:
            prix = float(f"{m.group(1)}.{m.group(2)}")
    annee = ""
    for tag in ("214", "210"):
        for x in f[tag]:
            m = re.search(r"(19|20)\d{2}", " ".join(x.get("d", [])))
            if m and not annee:
                annee = m.group(0)
    genre = " ".join(v for tag in ("225", "410", "461", "606", "608") for x in f[tag] for vals in x.values() for v in vals)
    auteur = ""
    for x in f["700"]:
        auteur = " ".join(filter(None, [x.get("b", [""])[0], x.get("a", [""])[0]])).strip()
        if auteur:
            break
    return {"isbn13": isbn, "numero": n, "serie": propre(serie), "titre_tome": propre(nom_tome) or None,
            "variante": variante, "variante_nom": propre(sous or premier(f["205"], "a") or titre)[:120] if variante else None, "contenu": contenu,
            "public": public_de(f"{titre} " + " ".join(v for tag in ("225", "410", "461", "606", "608") for x in f[tag] for vals in x.values() for v in vals)),
            "langue": langue, "taille": taille, "prix": prix, "annee": annee, "genre": genre, "auteur": auteur or None}


def bnf(editeur_bnf: str, annee: int):
    q = f'bib.publisher all "{editeur_bnf}" and bib.doctype any "a" and bib.date any "{annee}"'
    start, total = 1, None
    while total is None or start <= total:
        for essai in range(4):
            try:
                r = requests.get(SRU, headers=UA, timeout=90, params={"version": "1.2", "operation": "searchRetrieve",
                                 "query": q, "recordSchema": "unimarcxchange", "maximumRecords": PAGE, "startRecord": start})
                r.raise_for_status()
                root = ET.fromstring(r.content)
                break
            except Exception as e:  # BnF parfois lente : on réessaie
                print(f"      ⚠️  {e} — nouvel essai")
                time.sleep(5 * (essai + 1))
        else:
            return
        total = int(root.findtext("srw:numberOfRecords", "0", NS))
        recs = root.findall(".//srw:recordData/mxc:record", NS)
        for rec in recs:
            yield rec
        if not recs:
            return
        start += PAGE
        time.sleep(0.4)


class Base:
    def __init__(self, url, key):
        self.u = url.rstrip("/") + "/rest/v1"
        self.h = {"apikey": key, "Content-Type": "application/json"}
        if not key.startswith("sb_"):
            self.h["Authorization"] = f"Bearer {key}"
        self.series = {}  # (titre normalisé, éditeur normalisé, édition normalisée) -> id
        self.isbns = set()

    def charger(self):
        for table, cols in (("series", "id,titre,edition,editeur"), ("volumes", "isbn13")):
            start = 0
            while True:
                r = requests.get(f"{self.u}/{table}", headers={**self.h, "Range": f"{start}-{start + 999}"},
                                 params={"select": cols, "order": "id"}, timeout=60)
                r.raise_for_status()
                rows = r.json()
                for x in rows:
                    if table == "series":
                        self.series[(norm(x["titre"]), norm(x["editeur"] or ""), norm(x["edition"] or ""))] = x["id"]
                    elif x["isbn13"]:
                        self.isbns.add(x["isbn13"])
                if len(rows) < 1000:
                    break
                start += 1000
        print(f"   base actuelle : {len(self.series)} séries, {len(self.isbns)} ISBN")

    def serie(self, titre, editeur, edition, auteur, public=None):
        k = (norm(titre), norm(editeur), norm(edition or ""))
        if k in self.series:
            return self.series[k]
        r = requests.post(f"{self.u}/series", headers={**self.h, "Prefer": "return=representation"}, timeout=60,
                          json={"titre": titre, "edition": edition, "editeur": editeur, "auteur": auteur, "langue": "fr", "source": "bnf",
                                "public": public})
        if r.status_code >= 300:
            print(f"      ❌ série {titre} : {r.text[:200]}")
            return None
        self.series[k] = r.json()[0]["id"]
        return self.series[k]

    def numeros_pris(self, sid):
        r = requests.get(f"{self.u}/volumes", headers=self.h, timeout=60,
                         params={"serie_id": f"eq.{sid}", "select": "numero,variante,variante_nom"})
        return {(x["numero"], x["variante"], (x["variante_nom"] or "").lower()) for x in r.json()} if r.ok else set()

    def tomes(self, rows):
        for i in range(0, len(rows), 500):
            r = requests.post(f"{self.u}/volumes", headers={**self.h, "Prefer": "resolution=ignore-duplicates"},
                              params={"on_conflict": "isbn13"}, json=rows[i:i + 500], timeout=120)
            if r.status_code >= 300:  # un conflit (série, numéro) bloque le lot : on passe un par un
                for row in rows[i:i + 500]:
                    requests.post(f"{self.u}/volumes", headers={**self.h, "Prefer": "resolution=ignore-duplicates"},
                                  params={"on_conflict": "isbn13"}, json=row, timeout=60)


def main():
    p = argparse.ArgumentParser(description="Pré-remplit le catalogue avec les mangas publiés en France (BnF).")
    p.add_argument("--editeurs", default="tous", help='« tous » ou une liste séparée par des virgules (ex. "Pika,Kana")')
    p.add_argument("--depuis", type=int, default=1990)
    p.add_argument("--jusqua", type=int, default=dt.date.today().year + 1)
    p.add_argument("--nouveautes", action="store_true", help="seulement l'année en cours et la précédente")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    if a.nouveautes:
        a.depuis, a.jusqua = dt.date.today().year - 1, dt.date.today().year + 1
    noms = list(EDITEURS) if a.editeurs.strip().lower() == "tous" else [e.strip() for e in a.editeurs.split(",") if e.strip()]
    inconnus = [e for e in noms if e not in EDITEURS]
    if inconnus:
        sys.exit(f"❌ éditeur(s) inconnu(s) : {inconnus}. Connus : {', '.join(EDITEURS)}")

    base = None
    if not a.dry_run:
        url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
        if not url or not key:
            sys.exit("❌ SUPABASE_URL et SUPABASE_SERVICE_KEY doivent être définies (ou utilise --dry-run).")
        base = Base(url, key)
        base.charger()

    bilan = {"notices": 0, "tomes": 0, "series": set(), "nouveaux": 0}
    for nom in noms:
        cherche, que_manga = EDITEURS[nom]
        print(f"\n📚 {nom}  ({a.depuis}–{a.jusqua})")
        tomes = {}
        for annee in range(a.depuis, a.jusqua + 1):
            n_avant = len(tomes)
            for rec in bnf(cherche, annee):
                bilan["notices"] += 1
                t = analyse(rec)
                if not t or (t["langue"] and t["langue"] != "fre"):
                    continue
                if not que_manga and not MANGA_MOTS.search(t["genre"]):
                    continue
                vieux = tomes.get(t["isbn13"])
                if not vieux or (t["annee"] or "") > (vieux["annee"] or ""):
                    tomes[t["isbn13"]] = t
            print(f"   {annee} : +{len(tomes) - n_avant} tomes")

        # séries = titre + format ; si une série existe en plusieurs formats, chaque format devient une édition
        par_titre = defaultdict(lambda: defaultdict(list))
        for t in tomes.values():
            par_titre[norm(t["serie"])][t["taille"]].append(t)
        for formats in par_titre.values():
            plusieurs = len([f for f in formats if f]) > 1
            for taille, liste in formats.items():
                titre = max((x["serie"] for x in liste), key=lambda s: sum(c.isupper() for c in s))
                edition = f"Format {taille} cm" if plusieurs and taille else None
                # un ISBN par numéro (et par édition spéciale) : la notice la plus récente (tirage actuel)
                choix = {}
                for x in sorted(liste, key=lambda x: x["annee"] or ""):
                    choix[(x["numero"], x["variante"], (x["variante_nom"] or "").lower())] = x
                bilan["series"].add((titre, nom, edition))
                bilan["tomes"] += len(choix)
                if a.dry_run:
                    std = sorted(k[0] for k in choix if not k[1])
                    spe = [f"{k[1]} n°{k[0]}" for k in choix if k[1]]
                    pub = next((x["public"] for x in liste if x["public"]), None)
                    print(f"   • {titre}{' — ' + edition if edition else ''}{' [' + pub + ']' if pub else ''} : {len(std)} tome(s)"
                          + (f" [{std[0]}…{std[-1]}]" if std else "") + (f" + {len(spe)} spéciale(s) : {', '.join(spe[:4])}" if spe else ""))
                    continue
                sid = base.serie(titre, nom, edition, next((x["auteur"] for x in liste if x["auteur"]), None),
                                 next((x["public"] for x in liste if x["public"]), None))
                if not sid:
                    continue
                pris = base.numeros_pris(sid)
                rows = [{"serie_id": sid, "numero": x["numero"], "isbn13": x["isbn13"], "titre": x["titre_tome"],
                         "prix": x["prix"], "devise": "EUR" if x["prix"] else None,
                         "variante": x["variante"], "variante_nom": x["variante_nom"], "contenu": x["contenu"]}
                        for k, x in choix.items() if x["isbn13"] not in base.isbns and k not in pris]
                if rows:
                    base.tomes(rows)
                    base.isbns.update(r["isbn13"] for r in rows)
                    bilan["nouveaux"] += len(rows)

    print(f"\n✅ {bilan['notices']} notices lues, {len(bilan['series'])} séries, {bilan['tomes']} tomes retenus"
          + ("" if a.dry_run else f", {bilan['nouveaux']} tomes ajoutés à la base"))


if __name__ == "__main__":
    main()
