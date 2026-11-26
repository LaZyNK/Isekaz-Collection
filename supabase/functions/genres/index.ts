// Isekaz Collection — infos d'une œuvre via AniList : genres, public (shōnen…) et autres titres (japonais, anglais…).
// POST { titre: "Blue Lock" }  → met à jour toutes les éditions de cette œuvre et renvoie { genres, public, titres, fusion }.
//      Les fausses éditions qui ne sont qu'un autre titre de l'œuvre (« Red Eyes Sword - Akame ga Kill! ») sont regroupées.
// POST { recherche: "Akame ga kill" } → renvoie { titres } : tous les titres connus des œuvres trouvées, pour la recherche du site.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
const normT = (s: string) => (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Genres AniList gardés tels quels (traduits côté site) + quelques thèmes utiles
const GENRES = new Set(["Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music",
  "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"]);
const THEMES = new Set(["School", "Isekai", "Historical", "Martial Arts", "Survival", "Post-Apocalyptic", "Ghost", "Football",
  "Basketball", "Cooking", "Military", "Samurai", "Vampire", "Time Manipulation", "Super Power", "Detective", "Medicine", "Idol"]);
const PUBLICS: Record<string, string> = { Shounen: "shonen", Seinen: "seinen", Shoujo: "shojo", Josei: "josei", Kids: "kodomo" };

const QUERY = `query ($s: String) { Page(perPage: 6) { media(search: $s, type: MANGA) {
  title { romaji english native } synonyms genres tags { name rank isMediaSpoiler } } } }`;

async function anilist(s: string): Promise<any[]> {
  try {
    const r = await fetch("https://graphql.anilist.co", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { s } }),
    });
    return (await r.json())?.data?.Page?.media ?? [];
  } catch (e) { console.log("anilist", String(e)); return []; }
}
const titresDe = (m: any): string[] =>
  [...new Set([m.title?.romaji, m.title?.english, m.title?.native, ...(m.synonyms ?? [])].filter((x) => x && x.length <= 120))].slice(0, 20);

// Séries de la base dont le titre (à la ponctuation près) est l'un de ces titres
async function seriesDeTitres(titres: string[]) {
  const vus = new Map<number, any>();
  for (const t of titres.slice(0, 10)) {
    const mot = (t.match(/[\p{L}\p{N}]{2,}/u) ?? [t])[0].replace(/[%_]/g, "");
    if (!mot) continue;
    const { data } = await db.from("series").select("id, titre, edition, editeur, langue, public, genres, genres_maj, titres_alt, titres_maj")
      .ilike("titre", `%${mot}%`).limit(300);
    for (const s of data ?? []) if (normT(s.titre) === normT(t)) vus.set(s.id, s);
  }
  return [...vus.values()];
}

// Déplace les tomes de la série « de » vers « vers ». Un numéro déjà présent devient une réimpression (autre ISBN),
// et sa couverture / date / prix / résumé complètent le tome principal s'il lui en manque.
async function fusionner(de: number, vers: number) {
  const { data: cible } = await db.from("volumes").select("id, numero, variante, variante_nom, couverture_url, date_parution, prix, description").eq("serie_id", vers);
  const cle = (v: any) => `${v.numero}|${v.variante ?? ""}|${(v.variante_nom ?? "").toLowerCase()}`;
  const parCle = new Map((cible ?? []).map((v: any) => [cle(v), v]));
  const { data: vols } = await db.from("volumes").select("*").eq("serie_id", de);
  for (const v of vols ?? []) {
    const deja = parCle.get(cle(v));
    if (!deja) { await db.from("volumes").update({ serie_id: vers }).eq("id", v.id); continue; }
    const maj: Record<string, unknown> = {};
    if (!deja.couverture_url && v.couverture_url) maj.couverture_url = v.couverture_url;
    if (!deja.date_parution && v.date_parution) maj.date_parution = v.date_parution;
    if (deja.prix == null && v.prix != null) { maj.prix = v.prix; maj.devise = v.devise; }
    if (!deja.description && v.description) maj.description = v.description;
    if (Object.keys(maj).length) await db.from("volumes").update(maj).eq("id", deja.id);
    await db.from("volumes").update({ serie_id: vers, variante: v.variante ?? "autre",
      variante_nom: `${v.variante_nom ? v.variante_nom + " — " : ""}Réimpression ${v.isbn13 ?? ""}`.trim().slice(0, 120) }).eq("id", v.id);
  }
  await db.from("suivis").update({ serie_id: vers }).eq("serie_id", de);
  const { count } = await db.from("volumes").select("id", { count: "exact", head: true }).eq("serie_id", de);
  if (!count) await db.from("series").delete().eq("id", de);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let body: any = {};
  try { body = await req.json(); } catch { /* vide */ }

  // ---- Recherche par un autre titre (japonais, anglais…) ----
  const recherche = String(body.recherche ?? "").trim().slice(0, 80);
  if (recherche) {
    if (recherche.length < 3) return json({ titres: [] });
    const medias = (await anilist(recherche)).slice(0, 3);
    const titres = [...new Set(medias.flatMap(titresDe))];
    // on mémorise ces titres sur les séries correspondantes : la recherche suivante sera instantanée
    for (const m of medias) {
      const ts = titresDe(m);
      for (const s of await seriesDeTitres(ts)) {
        if (!s.titres_maj) await db.from("series").update({ titres_alt: ts, titres_maj: new Date().toISOString() }).eq("id", s.id);
      }
    }
    return json({ titres });
  }

  // ---- Infos d'une œuvre ----
  const titre = String(body.titre ?? "").trim().slice(0, 120);
  if (titre.length < 2) return json({ error: "titre manquant" }, 400);
  let eds = await seriesDeTitres([titre]);
  if (!eds.length) return json({ error: "œuvre inconnue" }, 404);
  if (eds.every((e: any) => e.genres_maj && e.titres_maj)) {
    return json({ genres: eds.find((e: any) => e.genres_maj)?.genres ?? [], public: eds.find((e: any) => e.public)?.public ?? null,
      titres: eds.find((e: any) => e.titres_alt?.length)?.titres_alt ?? [], source: "base" });
  }

  const medias = await anilist(titre);
  // le bon résultat : un titre (romaji, anglais, synonyme) identique à la ponctuation près, sinon le premier
  const m = medias.find((x: any) => titresDe(x).some((t) => normT(t) === normT(titre))) ?? medias[0];
  let genres: string[] = [], pub: string | null = null;
  const titres = m ? titresDe(m) : [];
  if (m) {
    genres = (m.genres ?? []).filter((g: string) => GENRES.has(g));
    for (const tg of m.tags ?? []) {
      if (tg.isMediaSpoiler || tg.rank < 60) continue;
      if (PUBLICS[tg.name] && !pub) pub = PUBLICS[tg.name];
      else if (THEMES.has(tg.name) && genres.length < 10) genres.push(tg.name);
    }
  }

  // Fausses éditions : « Red Eyes Sword » édition « Akame ga Kill ! » = le titre japonais de la même œuvre → même édition.
  // On ne regroupe que si le nom d'édition est exactement un des titres AniList de l'œuvre (un spin-off garde sa fiche).
  let fusion = false;
  if (titres.length) {
    const cles = new Set(titres.map(normT));
    cles.add(normT(titre));
    // séries de la base qui portent directement un autre titre de l'œuvre (« Akame ga Kill ! » seul)
    const autres = (await seriesDeTitres(titres)).filter((s: any) => !eds.some((e: any) => e.id === s.id));
    for (const s of [...eds, ...autres]) {
      const pseudo = s.edition && cles.has(normT(s.edition));
      const autreTitre = !eds.some((e: any) => e.id === s.id);
      if (!pseudo && !autreTitre) continue;
      if (autreTitre && s.edition && !cles.has(normT(s.edition))) continue; // vraie édition sous un autre titre : on n'y touche pas
      // la série principale : même titre que l'œuvre ouverte, même éditeur, même langue, sans édition
      const cible = eds.find((e: any) => e.id !== s.id && !e.edition && e.editeur?.toLowerCase() === s.editeur?.toLowerCase() && e.langue === s.langue);
      if (cible) { await fusionner(s.id, cible.id); fusion = true; }
      else if (pseudo && !autreTitre) {
        const { error } = await db.from("series").update({ edition: null }).eq("id", s.id);
        if (!error) fusion = true;
      }
    }
    if (fusion) eds = await seriesDeTitres([titre]);
  }

  const maj = new Date().toISOString();
  for (const e of eds) {
    await db.from("series").update({
      ...(e.genres_maj ? {} : { genres, genres_maj: maj }), titres_alt: titres, titres_maj: maj,
      ...(pub && !e.public ? { public: pub } : {}),
    }).eq("id", e.id);
  }
  return json({ genres: eds.find((e: any) => e.genres_maj)?.genres ?? genres, public: eds.find((e: any) => e.public)?.public ?? pub,
    titres, fusion, source: "anilist" });
});
