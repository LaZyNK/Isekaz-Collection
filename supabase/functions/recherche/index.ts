// Isekaz Collection — recherche à la volée.
// POST { q: "texte" }  ou  { isbn: "978..." }
// 1. cherche dans la base ; 2. sinon interroge Google Books (puis Open Library pour un ISBN) ;
// 3. ajoute les séries et tomes trouvés, pour que la recherche suivante soit instantanée.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GOOGLE_KEY = Deno.env.get("GOOGLE_BOOKS_KEY") ?? "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Tome = { titre: string; edition: string | null; editeur: string; auteur: string | null; langue: string;
              numero: number; isbn13: string; date: string | null; couverture: string | null;
              description?: string | null; prix?: number | null; devise?: string | null;
              variante?: string | null; variante_nom?: string | null; public?: string | null };

// Public visé (shōnen…) d'après les catégories / collections
function publicDe(txt: string): string | null {
  const t = txt.toLowerCase();
  if (/sh[oōô]u?jo/.test(t)) return "shojo";
  if (/josei/.test(t)) return "josei";
  if (/seinen/.test(t)) return "seinen";
  if (/kodomo/.test(t)) return "kodomo";
  if (/sh[oōô]u?nen/.test(t)) return "shonen";
  return null;
}
// Édition collector / limitée : c'est une édition spéciale du même tome, pas une autre série
const COLLECTOR = /\s*[-–:(]?\s*(?:[ée]dition\s+)?(collector|limit[ée]e|limited edition|sammelband|edizione limitata)\)?/i;
function sansCollector(t: { titre: string; edition: string | null }) {
  const full = `${t.titre} ${t.edition ?? ""}`;
  const m = full.match(COLLECTOR);
  if (!m) return { variante: null, variante_nom: null, edition: t.edition };
  const edition = t.edition ? clean(t.edition.replace(COLLECTOR, " ")).replace(/^[-–:\s]+|[-–:\s]+$/g, "") || null : null;
  return { variante: /limit/i.test(m[1]) ? "limitee" : "collector", variante_nom: clean(m[0].replace(/^[-–:(\s]+|\)$/g, "")), edition };
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
// Langue probable d'après le groupe de l'ISBN (si Google ne la donne pas)
function langueIsbn(isbn: string): string {
  const pref: [string, string][] = [["97910", "fr"], ["9782", "fr"], ["9780", "en"], ["9781", "en"], ["9783", "de"],
    ["97884", "es"], ["97888", "it"], ["97912", "it"], ["9784", "ja"], ["97885", "pt"], ["97889", "ko"], ["97911", "ko"],
    ["97890", "nl"], ["97894", "nl"], ["97883", "pl"], ["9787", "zh"]];
  return pref.find(([p]) => isbn.startsWith(p))?.[1] ?? "autre";
}
const INCONNU = "Inconnu";

// Google ne donne pas toujours l'éditeur : on le retrouve grâce au préfixe éditeur de l'ISBN
// (ex. 978-2-8116… et 979-10-433… = Pika) en le comparant aux autres tomes trouvés.
function resoudreEditeurs(tomes: Tome[]): Tome[] {
  const connus = tomes.filter((t) => t.editeur !== INCONNU);
  const out: Tome[] = [];
  for (const t of tomes) {
    if (t.editeur !== INCONNU) { out.push(t); continue; }
    let trouve: string | null = null;
    for (const len of [9, 8, 7]) {
      const c = connus.find((k) => k.isbn13.slice(0, len) === t.isbn13.slice(0, len));
      if (c) { trouve = c.editeur; break; }
    }
    if (trouve) out.push({ ...t, editeur: trouve }); // sinon on l'écarte : éditeur introuvable
  }
  return out;
}

function sansDoublons(tomes: Tome[]): Tome[] {
  const vus = new Set<string>();
  return tomes.filter((t) => !vus.has(t.isbn13) && vus.add(t.isbn13));
}

function editeurPropre(p: string): string {
  return clean(p.replace(/(^|\s)(mangas?|[ée]ditions?|sas|sarl)(?=\s|,|$)/giu, " ").replace(/[,.]+$/, "")) || p;
}

// "Dragon Ball - Édition originale - Tome 04" → { titre: "Dragon Ball", edition: "Édition originale", numero: 4 }
function analyseTitre(full: string): { titre: string; edition: string | null; numero: number } | null {
  // « tome », « vol. », « T. », « Band »/« Bd. » (allemand), « tomo », « volumen », « n° », « 巻 »…
  const re = /[\s\-–,:.(]+(?:tome|tomo|volumen|vol(?:ume)?\.?|band|bd\.?|t\.?|n°|nr\.?|#)\s*0*(\d{1,3})\b.*$/i;
  let m = full.match(re);
  let base: string, numero: number;
  if (m && m.index !== undefined && m.index > 0) {
    numero = +m[1];
    base = full.slice(0, m.index);
  } else {
    m = full.match(/^(.*\D)\s+0*(\d{1,3})\s*$/);
    if (!m) return null;
    base = m[1];
    numero = +m[2];
  }
  if (!numero || numero > 300) return null;
  const parts = clean(base).replace(/[\s\-–:,]+$/, "").split(/\s+[-–:]\s+/);
  return { titre: clean(parts[0]), edition: parts.length > 1 ? clean(parts.slice(1).join(" - ")) : null, numero };
}

const sansHtml = (h?: string) => h ? clean(h.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")).slice(0, 4000) : null;

// Fiche brute d'un ISBN chez Google (sert aussi aux one-shots et coffrets sans numéro de tome)
async function googleBrut(isbn: string): Promise<any | null> {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", `isbn:${isbn}`);
  if (GOOGLE_KEY) url.searchParams.set("key", GOOGLE_KEY);
  const r = await fetch(url);
  if (!r.ok) { console.log("google", r.status); return null; }
  const items = (await r.json()).items ?? [];
  return items.find((it: any) => (it.volumeInfo?.industryIdentifiers ?? []).some((i: any) => i.identifier === isbn)) ?? items[0] ?? null;
}

function infosVente(it: any): { prix: number | null; devise: string | null } {
  const p = it?.saleInfo?.listPrice ?? it?.saleInfo?.retailPrice;
  return p?.amount ? { prix: Math.round(p.amount * 100) / 100, devise: p.currencyCode ?? null } : { prix: null, devise: null };
}

async function google(q: string, start = 0): Promise<Tome[]> {
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", q);
  url.searchParams.set("maxResults", "40");
  url.searchParams.set("startIndex", String(start));
  url.searchParams.set("printType", "books");
  if (GOOGLE_KEY) url.searchParams.set("key", GOOGLE_KEY);
  const r = await fetch(url);
  if (!r.ok) { console.log("google", r.status, await r.text()); return []; }
  const items = (await r.json()).items ?? [];
  const out: Tome[] = [];
  for (const it of items) {
    const vi = it.volumeInfo ?? {};
    const isbn = (vi.industryIdentifiers ?? []).find((i: any) => i.type === "ISBN_13")?.identifier;
    if (!isbn || !/^97[89]\d{10}$/.test(isbn)) continue;
    const t = analyseTitre(clean(`${vi.title ?? ""} ${vi.subtitle ? "- " + vi.subtitle : ""}`)) ?? analyseTitre(vi.title ?? "");
    if (!t) continue;
    out.push({ ...t, ...sansCollector(t), public: publicDe((vi.categories ?? []).join(" ")),
      editeur: editeurPropre(vi.publisher ?? INCONNU), auteur: vi.authors?.[0] ?? null,
      langue: (vi.language || langueIsbn(isbn)).slice(0, 2),
      isbn13: isbn, date: /^\d{4}-\d{2}-\d{2}$/.test(vi.publishedDate ?? "") ? vi.publishedDate : null,
      couverture: vi.imageLinks?.thumbnail?.replace("http://", "https://") ?? null,
      description: sansHtml(vi.description), ...infosVente(it) });
  }
  return out;
}

async function openLibrary(isbn: string): Promise<Tome[]> {
  const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
  if (!r.ok) return [];
  const b = (await r.json())[`ISBN:${isbn}`];
  if (!b) return [];
  const t = analyseTitre(clean(`${b.title ?? ""} ${b.subtitle ? "- " + b.subtitle : ""}`));
  if (!t) return [];
  return [{ ...t, editeur: editeurPropre(b.publishers?.[0]?.name ?? INCONNU), auteur: b.authors?.[0]?.name ?? null,
    langue: langueIsbn(isbn),
    isbn13: isbn, date: null, couverture: b.cover?.medium ?? null }];
}

// Range les tomes par série et les enregistre ; renvoie les id des séries touchées.
async function enregistrer(tomes: Tome[]): Promise<number[]> {
  const groupes = new Map<string, Tome[]>();
  for (const t of tomes) {
    const k = `${t.titre.toLowerCase()}|${(t.edition ?? "").toLowerCase()}|${t.editeur.toLowerCase()}|${t.langue}`;
    groupes.set(k, [...(groupes.get(k) ?? []), t]);
  }
  const ids: number[] = [];
  for (const g of groupes.values()) {
    const s = g[0];
    let q = db.from("series").select("id").ilike("titre", s.titre).ilike("editeur", s.editeur).eq("langue", s.langue);
    q = s.edition ? q.ilike("edition", s.edition) : q.is("edition", null);
    const { data: found } = await q.limit(1);
    let id = found?.[0]?.id;
    if (!id) {
      const { data, error } = await db.from("series")
        .insert({ titre: s.titre, edition: s.edition, editeur: s.editeur, auteur: s.auteur, langue: s.langue, source: "recherche",
                  public: g.map((x) => x.public).find(Boolean) ?? null })
        .select("id").single();
      if (error) { console.log("serie", error.message); continue; }
      id = data.id;
    }
    ids.push(id);
    const { data: deja } = await db.from("volumes").select("numero, variante, variante_nom").eq("serie_id", id);
    const cle = (n: number, v?: string | null, vn?: string | null) => `${n}|${v ?? ""}|${(vn ?? "").toLowerCase()}`;
    const pris = new Set((deja ?? []).map((v: any) => cle(v.numero, v.variante, v.variante_nom)));
    const lignes = [];
    for (const t of g.sort((a, b) => a.numero - b.numero)) {
      const k = cle(t.numero, t.variante, t.variante_nom);
      if (pris.has(k)) continue;
      pris.add(k);
      lignes.push({ serie_id: id, numero: t.numero, isbn13: t.isbn13, date_parution: t.date, couverture_url: t.couverture,
        description: t.description ?? null, prix: t.prix ?? null, devise: t.devise ?? null,
        variante: t.variante ?? null, variante_nom: t.variante_nom ?? null });
    }
    // un par un : un ISBN déjà connu ailleurs ne bloque pas les autres
    for (const l of lignes) await db.from("volumes").insert(l);
  }
  return ids;
}

async function lireTome(isbn: string) {
  const { data } = await db.from("volumes").select("*, series(*)").eq("isbn13", isbn).maybeSingle();
  return data;
}

// Ajoute la série d'un ISBN (et ses autres tomes). Sans numéro de tome (one-shot, coffret…), il devient le n°1 de sa propre fiche.
async function ajouterIsbn(isbn: string): Promise<number[]> {
  let tomes = await google(`isbn:${isbn}`);
  if (!tomes.length) tomes = await openLibrary(isbn);
  if (!tomes.length) {
    const it = await googleBrut(isbn);
    const vi = it?.volumeInfo;
    if (!vi?.title) return [];
    const titre = clean(`${vi.title}${vi.subtitle ? " - " + vi.subtitle : ""}`).slice(0, 200);
    return enregistrer([{ titre, edition: null, editeur: editeurPropre(vi.publisher ?? INCONNU), auteur: vi.authors?.[0] ?? null,
      langue: (vi.language || langueIsbn(isbn)).slice(0, 2), numero: 1, isbn13: isbn,
      date: /^\d{4}-\d{2}-\d{2}$/.test(vi.publishedDate ?? "") ? vi.publishedDate : null,
      couverture: vi.imageLinks?.thumbnail?.replace("http://", "https://") ?? null,
      description: sansHtml(vi.description), ...infosVente(it) }]);
  }
  const t = tomes.find((x) => x.isbn13 === isbn) ?? tomes[0];
  // on profite de la recherche pour récupérer les autres tomes de la série
  const cible = t.editeur === INCONNU ? `intitle:"${t.titre}"` : `intitle:"${t.titre}" inpublisher:"${t.editeur}"`;
  const autres = (await Promise.all([0, 40].map((s) => google(cible, s)))).flat();
  const liste = resoudreEditeurs(sansDoublons([t, ...autres])).filter((a) => a.titre.toLowerCase() === t.titre.toLowerCase());
  // le tome scanné est toujours gardé, même si son éditeur reste inconnu
  const scanne = liste.find((a) => a.isbn13 === isbn) ?? t;
  return enregistrer([scanne, ...liste.filter((a) => a.isbn13 !== isbn && a.editeur === scanne.editeur)]);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let body: any = {};
  try { body = await req.json(); } catch { /* corps vide */ }

  // Fiche produit : le tome + sa série, complétés (description, prix, date) au premier affichage
  const fiche = String(body.fiche ?? "").replace(/[^0-9]/g, "");
  if (fiche) {
    if (!/^97[89]\d{10}$/.test(fiche)) return json({ error: "ISBN-13 invalide" }, 400);
    let v = await lireTome(fiche);
    if (!v) { await ajouterIsbn(fiche); v = await lireTome(fiche); }
    if (!v) {
      // le numéro existe déjà avec un autre ISBN (réimpression, tirage spécial…) : rangé à part pour ne pas le perdre
      const t = (await google(`isbn:${fiche}`)).find((x) => x.isbn13 === fiche);
      if (t) await enregistrer([{ ...t, variante: t.variante ?? "autre", variante_nom: t.variante_nom ?? "Autre tirage (à vérifier)" }]);
      v = await lireTome(fiche);
    }
    if (!v) return json({ volume: null, source: "introuvable" });
    if (!v.fiche_maj) {
      const it = await googleBrut(fiche);
      const vi = it?.volumeInfo ?? {};
      const maj: Record<string, unknown> = { fiche_maj: new Date().toISOString() };
      if (!v.description && vi.description) maj.description = sansHtml(vi.description);
      const vente = infosVente(it);
      if (v.prix == null && vente.prix != null) { maj.prix = vente.prix; maj.devise = vente.devise; }
      if (!v.date_parution && /^\d{4}-\d{2}-\d{2}$/.test(vi.publishedDate ?? "")) maj.date_parution = vi.publishedDate;
      if (!v.couverture_url && vi.imageLinks?.thumbnail) maj.couverture_url = vi.imageLinks.thumbnail.replace("http://", "https://");
      if (!v.titre && vi.title) maj.titre = clean(`${vi.title}${vi.subtitle ? " - " + vi.subtitle : ""}`).slice(0, 200);
      await db.from("volumes").update(maj).eq("id", v.id);
      v = await lireTome(fiche);
    }
    return json({ volume: v, source: "base" });
  }

  const isbn = String(body.isbn ?? "").replace(/[^0-9Xx]/g, "");
  if (isbn) {
    if (!/^97[89]\d{10}$/.test(isbn)) return json({ error: "ISBN-13 invalide" }, 400);
    const { data: v } = await db.from("volumes").select("serie_id").eq("isbn13", isbn).maybeSingle();
    if (v) return json({ series: [v.serie_id], source: "base" });
    const ids = await ajouterIsbn(isbn);
    return json({ series: ids, source: ids.length ? "ajout" : "introuvable" });
  }

  const q = clean(String(body.q ?? ""));
  if (q.length < 3 || q.length > 80) return json({ error: "Recherche trop courte ou trop longue" }, 400);
  const mots = q.toLowerCase().split(/\s+/);
  const garde = (t: Tome) => mots.every((m) => `${t.titre} ${t.edition ?? ""}`.toLowerCase().includes(m));
  const pages = await Promise.all([google(`intitle:${q}`, 0), google(`intitle:${q}`, 40)]);
  let tomes = resoudreEditeurs(sansDoublons(pages.flat())).filter(garde);
  // 2e passage ciblé « titre + éditeur » pour compléter les tomes manquants (les 4 séries les plus fournies)
  const compte = new Map<string, { t: Tome; n: number }>();
  for (const t of tomes) {
    const k = `${t.titre}|${t.editeur}`.toLowerCase();
    compte.set(k, { t, n: (compte.get(k)?.n ?? 0) + 1 });
  }
  const cibles = [...compte.values()].sort((a, b) => b.n - a.n).slice(0, 4).map((c) => c.t);
  const complements = await Promise.all(cibles.flatMap((c) =>
    [0, 40].map((s) => google(`intitle:"${c.titre}" inpublisher:"${c.editeur}"`, s))));
  tomes = resoudreEditeurs(sansDoublons([...tomes, ...complements.flat()])).filter(garde);
  const ids = await enregistrer(tomes);
  return json({ series: [...new Set(ids)], source: tomes.length ? "ajout" : "introuvable" });
});
