// Isekaz Collection — genres d'une œuvre (Action, Romance, Sport…) et public (shōnen…), via AniList.
// POST { titre: "Blue Lock" } → met à jour toutes les éditions de cette œuvre et renvoie { genres, public }.
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
const normT = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Genres AniList gardés tels quels (traduits côté site) + quelques thèmes utiles
const GENRES = new Set(["Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music",
  "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"]);
const THEMES = new Set(["School", "Isekai", "Historical", "Martial Arts", "Survival", "Post-Apocalyptic", "Ghost", "Football",
  "Basketball", "Cooking", "Military", "Samurai", "Vampire", "Time Manipulation", "Super Power", "Detective", "Medicine", "Idol"]);
const PUBLICS: Record<string, string> = { Shounen: "shonen", Seinen: "seinen", Shoujo: "shojo", Josei: "josei", Kids: "kodomo" };

const QUERY = `query ($s: String) { Page(perPage: 5) { media(search: $s, type: MANGA) {
  title { romaji english native } synonyms genres tags { name rank isMediaSpoiler } } } }`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let body: any = {};
  try { body = await req.json(); } catch { /* vide */ }
  const titre = String(body.titre ?? "").trim().slice(0, 120);
  if (titre.length < 2) return json({ error: "titre manquant" }, 400);

  // les éditions de cette œuvre dans la base
  const mot = (titre.match(/[\p{L}\p{N}]{2,}/u) ?? [titre])[0].replace(/[%_]/g, "");
  const { data: cands } = await db.from("series").select("id, titre, public, genres, genres_maj").ilike("titre", `%${mot}%`).limit(500);
  const eds = (cands ?? []).filter((c: any) => normT(c.titre) === normT(titre));
  if (!eds.length) return json({ error: "œuvre inconnue" }, 404);
  const deja = eds.find((e: any) => e.genres_maj);
  if (deja) return json({ genres: deja.genres ?? [], public: eds.find((e: any) => e.public)?.public ?? null, source: "base" });

  let genres: string[] = [], pub: string | null = null;
  try {
    const r = await fetch("https://graphql.anilist.co", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { s: titre } }),
    });
    const medias = (await r.json())?.data?.Page?.media ?? [];
    // le bon résultat : un titre (romaji, anglais, synonyme) identique à la ponctuation près, sinon le premier
    const m = medias.find((x: any) => [x.title?.romaji, x.title?.english, ...(x.synonyms ?? [])].filter(Boolean).some((t: string) => normT(t) === normT(titre)))
      ?? medias[0];
    if (m) {
      genres = (m.genres ?? []).filter((g: string) => GENRES.has(g));
      for (const tg of m.tags ?? []) {
        if (tg.isMediaSpoiler || tg.rank < 60) continue;
        if (PUBLICS[tg.name] && !pub) pub = PUBLICS[tg.name];
        else if (THEMES.has(tg.name) && genres.length < 10) genres.push(tg.name);
      }
    }
  } catch (e) { console.log("anilist", String(e)); }

  const maj = new Date().toISOString();
  for (const e of eds) {
    await db.from("series").update({ genres, genres_maj: maj, ...(pub && !e.public ? { public: pub } : {}) }).eq("id", e.id);
  }
  return json({ genres, public: eds.find((e: any) => e.public)?.public ?? pub, source: "anilist" });
});
