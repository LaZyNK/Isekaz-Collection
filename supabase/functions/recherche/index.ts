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
              numero: number; isbn13: string; date: string | null; couverture: string | null };

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
    out.push({ ...t, editeur: editeurPropre(vi.publisher ?? INCONNU), auteur: vi.authors?.[0] ?? null,
      langue: (vi.language || langueIsbn(isbn)).slice(0, 2),
      isbn13: isbn, date: /^\d{4}-\d{2}-\d{2}$/.test(vi.publishedDate ?? "") ? vi.publishedDate : null,
      couverture: vi.imageLinks?.thumbnail?.replace("http://", "https://") ?? null });
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
        .insert({ titre: s.titre, edition: s.edition, editeur: s.editeur, auteur: s.auteur, langue: s.langue, source: "recherche" })
        .select("id").single();
      if (error) { console.log("serie", error.message); continue; }
      id = data.id;
    }
    ids.push(id);
    const { data: deja } = await db.from("volumes").select("numero").eq("serie_id", id);
    const pris = new Set((deja ?? []).map((v: any) => v.numero));
    const lignes = [];
    for (const t of g.sort((a, b) => a.numero - b.numero)) {
      if (pris.has(t.numero)) continue;
      pris.add(t.numero);
      lignes.push({ serie_id: id, numero: t.numero, isbn13: t.isbn13, date_parution: t.date, couverture_url: t.couverture });
    }
    // un par un : un ISBN déjà connu ailleurs ne bloque pas les autres
    for (const l of lignes) await db.from("volumes").insert(l);
  }
  return ids;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let body: any = {};
  try { body = await req.json(); } catch { /* corps vide */ }

  const isbn = String(body.isbn ?? "").replace(/[^0-9Xx]/g, "");
  if (isbn) {
    if (!/^97[89]\d{10}$/.test(isbn)) return json({ error: "ISBN-13 invalide" }, 400);
    const { data: v } = await db.from("volumes").select("serie_id").eq("isbn13", isbn).maybeSingle();
    if (v) return json({ series: [v.serie_id], source: "base" });
    let tomes = await google(`isbn:${isbn}`);
    if (!tomes.length) tomes = await openLibrary(isbn);
    if (!tomes.length) return json({ series: [], source: "introuvable" });
    const t = tomes[0];
    // on profite de la recherche pour récupérer les autres tomes de la série
    const cible = t.editeur === INCONNU ? `intitle:"${t.titre}"` : `intitle:"${t.titre}" inpublisher:"${t.editeur}"`;
    const autres = (await Promise.all([0, 40].map((s) => google(cible, s)))).flat();
    const ids = await enregistrer(resoudreEditeurs(sansDoublons([t, ...autres]))
      .filter((a) => a.titre.toLowerCase() === t.titre.toLowerCase()));
    return json({ series: ids.slice(0, 1).concat(ids.slice(1)), source: "ajout" });
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
