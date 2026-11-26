// Isekaz Collection — service worker : fait marcher le site sans réseau.
// - pages et fichiers du site : réseau d'abord (pour avoir la dernière version), sinon copie locale ;
// - bibliothèques et polices : copie locale d'abord ;
// - couvertures : copie locale d'abord, gardées pour le mode hors ligne ;
// - données Supabase : jamais ici, le site gère sa propre copie (IndexedDB).
const VERSION = "isekaz-v1";
const SHELL = `${VERSION}-site`;
const LIBS = `${VERSION}-libs`;
const COVERS = `${VERSION}-covers`;
const MAX_COVERS = 800;
const SHELL_FILES = ["./", "./index.html", "./manifest.webmanifest", "./assets/favicon.png",
  "./assets/isekaz-512.jpg", "./assets/icon-192.png", "./assets/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!k.startsWith(VERSION)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const LIB_HOSTS = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];
const COVER_HOSTS = ["books.google.com", "books.googleusercontent.com", "covers.openlibrary.org", "archive.org"];

async function trimCovers() {
  const c = await caches.open(COVERS);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_COVERS; i++) await c.delete(keys[i]);
}

async function cacheFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") {
    c.put(req, res.clone());
    if (cacheName === COVERS) trimCovers();
  }
  return res;
}

async function networkFirst(req) {
  const c = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch {
    return (await c.match(req, { ignoreSearch: true })) ||
      (req.mode === "navigate" ? await c.match("./index.html") : undefined) ||
      new Response("Hors ligne", { status: 503 });
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) return e.respondWith(networkFirst(req));
  if (LIB_HOSTS.some((h) => url.hostname.endsWith(h))) return e.respondWith(cacheFirst(req, LIBS));
  if (COVER_HOSTS.some((h) => url.hostname.endsWith(h))) {
    return e.respondWith(cacheFirst(req, COVERS).catch(() => new Response("", { status: 504 })));
  }
  // tout le reste (Supabase, etc.) passe normalement
});
