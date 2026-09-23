const CACHE = "hoornbeeck-route-v2"; // ophogen bij elke wijziging, anders blijft de oude versie in de cache
const ASSETS = [
  "./", "./index.html", "./style.css", "./app.js", "./manifest.json", "./icon.svg",
  "./assets/gebouwroute-hero.png", "./assets/app-overview.png", "./assets/aula.png",
  "./kaarten/index.json", ...["-1", "0", "1", "2", "3", "4", "5", "6", "7"].map(f => `./kaarten/${f}.svg`)
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if(e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request).then(r => {
    const copy = r.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match("./index.html"))));
});
