/* Hoornbeeck Gebouwenroute: schermen, badges, plattegrond, live locatie en routes.
   De routeplanner zelf zit in route.js, de kaarten komen uit kaarten/ (gemaakt door ../tools/kaarten-bouwen.mjs).

   Opbouw van dit bestand:
   1. hulpjes en opslag   4. lokalenlijst        7. live locatie
   2. schermen en melding  5. kaart (zoomen)      8. route
   3. badges              6. markers             9. koppelen en starten */

/* ---------------- 1. hulpjes en opslag ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const icon = id => `<svg class="ic"><use href="#${id}"/></svg>`;
const shortFloor = f => f === "0" ? "BG" : f;
// "A.1.01", "a1.01" en "a101" moeten allemaal matchen: puntjes en spaties tellen niet mee
const searchKey = s => s.toLowerCase().replace(/[.\s]/g, "");

// localStorage kan ontbreken of vol zijn (privévenster): dan werkt de app gewoon zonder opslag
const load = (key, fallback) => { try{ return JSON.parse(localStorage.getItem(key)) ?? fallback; }catch{ return fallback; } };
const save = (key, value) => { try{ localStorage.setItem(key, JSON.stringify(value)); }catch{} };

const STORE_KEY = "hgr_v4"; // v4: { dest } — de gekozen bestemming blijft bewaard
const store = { dest: null, ...load(STORE_KEY, {}) };
const saveStore = () => save(STORE_KEY, store);

const floorIndex = fetch("kaarten/index.json").then(r => r.json()); // per verdieping: naam, georeferentie, deuren, lokalen
let floors = {}; // dezelfde gegevens, zodra geladen (voor wie niet kan wachten)
floorIndex.then(idx => { floors = idx; });

/* ---------------- 2. schermen en melding ---------------- */
function showView(name, push = true){
  const target = $(`[data-view="${name}"]`);
  if(!target) return;
  $$(".view").forEach(v => v.classList.toggle("active", v === target));
  $$("[data-nav]").forEach(b => b.classList.toggle("active", b.dataset.nav === name));
  if(push) history.pushState({ view: name }, "", `#${name}`);
  window.scrollTo(0, 0);
  if(name !== "buildings") setPick(false);
  if(name === "route") requestAnimationFrame(fitFloorplan); // pas als het scherm zichtbaar is heeft de kaart een formaat
}

let toastTimer;
function showToast(message){
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

/* ---------------- 3. badges: verdien je door de app te gebruiken; staat alleen in je eigen browser ---------------- */
const BADGES = [
  { id: "route",     title: "Route gestart", xp: 25,  how: "Kies een bestemming",                                   done: s => s.rooms.length >= 1 },
  { id: "gevonden",  title: "Gevonden",      xp: 25,  how: "Zet live locatie aan of tik op de kaart waar je staat", done: s => s.located },
  { id: "ontdekker", title: "Ontdekker",     xp: 50,  how: "Bekijk 3 verdiepingen",                                 done: s => s.floors.length >= 3 },
  { id: "trap",      title: "Trappenloper",  xp: 50,  how: "Zoek een route naar een andere verdieping",             done: s => s.crossed },
  { id: "lokalen",   title: "5 lokalen",     xp: 50,  how: "Kies 5 verschillende lokalen",                          done: s => s.rooms.length >= 5 },
  { id: "gebouw",    title: "Heel gebouw",   xp: 100, how: "Bekijk alle 7 verdiepingen",                            done: s => s.floors.length >= 7 },
];
const XP_PER_LEVEL = 75;
const PROGRESS_KEY = "hgr_progress";
const emptyProgress = () => ({ floors: [], rooms: [], located: false, crossed: false, earned: [] });
const progress = { ...emptyProgress(), ...load(PROGRESS_KEY, {}) };
progress.floors = progress.floors.filter(f => +f <= 5); // verdieping 6 bestaat niet meer

function renderBadges(){
  const xp = BADGES.filter(b => progress.earned.includes(b.id)).reduce((n, b) => n + b.xp, 0);
  const level = 1 + Math.floor(xp / XP_PER_LEVEL), into = xp - (level - 1) * XP_PER_LEVEL;
  const set = (sel, v) => $$(sel).forEach(el => el.textContent = v);
  set("[data-level]", level);
  set("[data-xp]", xp);
  set("[data-xp-next]", level * XP_PER_LEVEL);
  set("[data-xp-left]", `Nog ${level * XP_PER_LEVEL - xp} XP tot level ${level + 1}`);
  set("[data-badge-count]", `${progress.earned.length} van ${BADGES.length}`);
  set("[data-stat-floors]", `${progress.floors.length} van 7`);
  set("[data-stat-rooms]", progress.rooms.length);
  const bar = $("#xpBar");
  bar.style.width = (into / XP_PER_LEVEL * 100) + "%";
  bar.parentElement.setAttribute("aria-valuenow", into);
  $("#badgeGrid").innerHTML = BADGES.map(b => {
    const got = progress.earned.includes(b.id);
    return `<button class="badge ${got ? "unlocked" : "locked"}" data-badge="${b.id}"><span>${icon(got ? "i-check" : "i-lock")}</span><b>${b.title}</b><small>${got ? b.xp + " XP behaald" : b.how}</small></button>`;
  }).join("");
}

// gebeurtenissen uit de app: kijk daarna of er een badge bij is gekomen
function track(type, val){
  const add = (list, v) => list.includes(v) || list.push(v);
  if(type === "floor") add(progress.floors, val);
  else if(type === "dest") add(progress.rooms, val);
  else if(type === "located") progress.located = true;
  else if(type === "crossed") progress.crossed = true;
  const fresh = BADGES.filter(b => !progress.earned.includes(b.id) && b.done(progress));
  progress.earned.push(...fresh.map(b => b.id));
  save(PROGRESS_KEY, progress);
  renderBadges();
  if(fresh.length) showToast(`Badge behaald: ${fresh.map(b => b.title).join(", ")} (+${fresh.reduce((n, b) => n + b.xp, 0)} XP)`);
}

function showBadge(id){
  const badge = BADGES.find(b => b.id === id);
  showToast(progress.earned.includes(id) ? `${badge.title}: behaald` : `${badge.title}: ${badge.how.charAt(0).toLowerCase() + badge.how.slice(1)}`);
}

function resetProgress(){
  Object.assign(progress, emptyProgress());
  try{ localStorage.removeItem(PROGRESS_KEY); }catch{}
  renderBadges();
  showToast("Voortgang gewist");
}

/* ---------------- 4. lokalenlijst en home ---------------- */
function renderLists(){
  const byFloor = dir => Object.entries(floors).sort(([a], [b]) => dir * (a - b));
  $("#buildingList").innerHTML = byFloor(1)
    .map(([f, fl]) => `<details class="floor-group" data-floor="${f}"><summary><span class="num">${shortFloor(f)}</span><span class="what"><b>${fl.label}</b><small>${fl.rooms.length} lokalen · <span class="hint-open">tik om uit te klappen</span><span class="hint-close">tik om in te klappen</span></small></span>${icon("i-chev")}</summary>${fl.rooms.map(r => `<button class="building-row" data-room="${r.code}" data-floor="${f}" data-search="${esc(searchKey(`${r.code}|${r.name}|${fl.label}`))}"><div><b>${r.code}</b>${r.name ? `<small>${esc(r.name)}</small>` : ""}</div>${icon("i-chev")}</button>`).join("")}</details>`)
    .join("");
  // home: verdiepingsbord (hoogste bovenaan, zoals bij de lift) en de laatst gekozen bestemming
  $("#floorBoard").innerHTML = byFloor(-1)
    .map(([f, fl]) => `<li><button data-open-floor="${f}"><span class="num">${shortFloor(f)}</span><span class="what"><b>${fl.label}</b><small>${fl.rooms.length} lokalen</small></span>${icon("i-chev")}</button></li>`).join("");
  const d = store.dest, last = $("#lastRoute");
  if(d && floors[d.floor]){
    last.dataset.room = d.code;
    last.dataset.floor = d.floor;
    last.hidden = false;
    last.innerHTML = `<span class="code">${esc(d.code)}</span><span><b>Verder naar je laatste bestemming</b>${esc(d.name || floors[d.floor].label)}</span>${icon("i-chev")}`;
  }
}

/* ---------------- 5. kaart: plattegrond tonen, zoomen en slepen ---------------- */
const floorplanWrap = $("#floorplanWrap");
const floorplanCanvas = $("#floorplanCanvas");
const floorplanImg = $("#floorplanImg");
const floorTabs = $("#floorTabs");

let floor = "0";
let mapW = 1000, mapH = 1000; // grootte van de huidige plattegrond in kaart-eenheden (komt uit de SVG)
let scale = 1, minScale = 1, maxScale = 4, tx = 0, ty = 0; // zoom en verschuiving van de kaart
let kTimer = 0;

const floorSvgs = {};
const loadFloorSvg = f => floorSvgs[f] ??= fetch(`kaarten/${f}.svg`).then(r => {
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
});

async function setFloor(f){
  floor = String(f);
  const tab = floorTabs.querySelector(`button[data-floor="${floor}"]`);
  floorTabs.querySelectorAll("button").forEach(b => {
    b.classList.toggle("active", b === tab);
    b.setAttribute("aria-selected", b === tab ? "true" : "false");
  });
  let text;
  try{ text = await loadFloorSvg(floor); }
  catch{ delete floorSvgs[floor]; showToast("Plattegrond kon niet geladen worden."); return; }
  if(floor !== String(f)) return; // intussen al een andere verdieping gekozen
  track("floor", floor);
  const svg = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
  mapW = +svg.getAttribute("width");
  mapH = +svg.getAttribute("height");
  ["viewBox", "width", "height"].forEach(a => floorplanImg.setAttribute(a, svg.getAttribute(a)));
  floorplanImg.replaceChildren(...[...svg.childNodes].map(n => document.importNode(n, true)));
  floorplanImg.setAttribute("aria-label", `Plattegrond ${tab?.querySelector("small")?.textContent || ""}`);
  fitToContainer();
  renderPin();
  renderStart();
  renderLiveMarker();
  updateRoute();
}

const wrapBox = () => floorplanWrap.getBoundingClientRect();

function applyTransform(){
  floorplanCanvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  // --m houdt de markers even groot op het scherm (goedkoop, elk frame)
  floorplanCanvas.style.setProperty("--m", 1 / scale);
  // --k houdt de lokaalteksten even groot; dat herschildert de hele kaart, dus pas als het zoomen stopt
  clearTimeout(kTimer);
  kTimer = setTimeout(() => {
    floorplanCanvas.style.setProperty("--k", 1 / scale);
    floorplanWrap.classList.toggle("far", scale < 0.45);
  }, 120);
  // uitgezoomd scrolt 1 vinger de pagina, ingezoomd versleept 1 vinger de kaart
  floorplanWrap.style.touchAction = scale > minScale * 1.05 ? "none" : "pan-y";
}

function fitToContainer(){
  const box = wrapBox();
  if(box.width < 10 || box.height < 10) return;
  minScale = Math.min(box.width / mapW, box.height / mapH);
  scale = minScale;
  maxScale = Math.max(1.5, minScale * 4);
  tx = (box.width - mapW * scale) / 2;
  ty = (box.height - mapH * scale) / 2;
  applyTransform();
}

function clampPan(){
  const box = wrapBox(), margin = 60;
  tx = Math.min(margin, Math.max(box.width - mapW * scale - margin, tx));
  ty = Math.min(margin, Math.max(box.height - mapH * scale - margin, ty));
}

// zoom met `factor` rond een punt van het scherm, zodat dat punt op zijn plek blijft
function zoomAt(clientX, clientY, factor){
  const box = wrapBox();
  const px = clientX - box.left, py = clientY - box.top;
  const localX = (px - tx) / scale, localY = (py - ty) / scale;
  scale = Math.min(maxScale, Math.max(minScale, scale * factor));
  tx = px - localX * scale;
  ty = py - localY * scale;
  clampPan();
  applyTransform();
}

function zoomCenter(factor){
  const box = wrapBox();
  zoomAt(box.left + box.width / 2, box.top + box.height / 2, factor);
}

function focusOn(x, y){
  const box = wrapBox();
  scale = Math.min(maxScale, Math.max(minScale, 0.6));
  tx = box.width / 2 - x * scale;
  ty = box.height / 2 - y * scale;
  clampPan();
  applyTransform();
}

const screenToMap = (clientX, clientY) => {
  const box = wrapBox();
  return { x: (clientX - box.left - tx) / scale, y: (clientY - box.top - ty) / scale };
};

// alleen opnieuw passend maken als de breedte echt verandert: op telefoons vuurt "resize" ook
// als de adresbalk in-/uitschuift tijdens scrollen, en dan zou je zoom steeds verspringen
let lastWidth = window.innerWidth;
window.addEventListener("resize", () => {
  if(window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  fitToContainer();
});
function fitFloorplan(){ fitToContainer(); renderPin(); renderLiveMarker(); }

/* Gebaren: 1 vinger of muis = slepen (of tikken), 2 vingers = knijpen, muiswiel met ctrl = zoomen */
const pointers = new Map();
let pinchStartDist = 0, pinchStartScale = 1;
let dragStart = null, moved = false;

floorplanWrap.addEventListener("wheel", e => {
  if(!e.ctrlKey && scale <= minScale * 1.05) return; // uitgezoomd: gewoon de pagina scrollen
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
}, { passive: false });

const pinch = () => {
  const [a, b] = [...pointers.values()];
  return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
};

floorplanWrap.addEventListener("pointerdown", e => {
  if(e.target.closest(".floorplan-zoom")) return; // de zoomknoppen moeten zelf een klik krijgen (geen pointer-capture)
  floorplanWrap.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if(pointers.size === 1){
    dragStart = { x: e.clientX, y: e.clientY, tx, ty, t: Date.now() };
    moved = false;
    floorplanCanvas.classList.add("dragging");
  } else if(pointers.size === 2){
    pinchStartDist = pinch().dist;
    pinchStartScale = scale;
  }
});

floorplanWrap.addEventListener("pointermove", e => {
  if(!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if(pointers.size === 2){
    const { dist, midX, midY } = pinch();
    zoomAt(midX, midY, pinchStartScale * (dist / pinchStartDist) / scale);
    moved = true;
  } else if(pointers.size === 1 && dragStart){
    const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
    if(Math.hypot(dx, dy) > 5) moved = true;
    tx = dragStart.tx + dx;
    ty = dragStart.ty + dy;
    clampPan();
    applyTransform();
  }
});

function endPointer(e){
  const wasTap = pointers.size === 1 && dragStart && !moved && (Date.now() - dragStart.t < 500);
  pointers.delete(e.pointerId);
  floorplanCanvas.classList.remove("dragging");
  if(wasTap) handleTap(dragStart.x, dragStart.y);
  if(pointers.size === 0) dragStart = null;
}
floorplanWrap.addEventListener("pointerup", endPointer);
floorplanWrap.addEventListener("pointercancel", e => { moved = true; endPointer(e); }); // browser pakte het gebaar over (paginascroll): geen tik

/* ---------------- 6. markers: bestemming, startpunt ---------------- */
let manualStart = null; // { floor, x, y, label? } — getikt of via een lokaal gekozen "hier ben ik" (als er geen GPS is)
let pickStart = false;  // de lokalenlijst kiest nu je startpunt in plaats van je bestemming
function setPick(start){
  pickStart = start;
  $("#buildingsTitle").textContent = start ? "Waar sta je?" : "Lokalen";
}

function place(el, pt){
  el.hidden = !pt;
  if(pt){ el.style.left = pt.x + "px"; el.style.top = pt.y + "px"; }
}
// de pin staat net boven het lokaalnummer, zodat dat leesbaar blijft
function renderPin(){
  const d = store.dest, here = d && d.floor === floor;
  place($("#pinMarker"), here ? { x: d.x, y: d.y - 16 } : null);
  floorplanImg.querySelectorAll(".mp-room.active").forEach(r => r.classList.remove("active"));
  if(here) floorplanImg.querySelector(`[data-code="${CSS.escape(d.code)}"]`)?.classList.add("active");
}
const renderStart = () => place($("#startMarker"), manualStart?.floor === floor ? manualStart : null);

// tikken = "hier ben ik": startpunt van de route op deze verdieping
function handleTap(clientX, clientY){
  manualStart = { floor, ...screenToMap(clientX, clientY) };
  track("located");
  via = null;
  renderStart();
  updateRoute();
  $("#mapHint").textContent = "Startpunt gezet.";
}

// startpunt = een lokaal: handig als je weet waar je bent maar geen GPS hebt
async function setStartRoom(f, code){
  await floorIndex;
  const room = floors[f]?.rooms.find(r => r.code === code);
  if(!room) return showToast(`${code} staat niet op de plattegrond.`);
  manualStart = { floor: String(f), x: room.x, y: room.y, label: code };
  track("located");
  via = null;
  await setFloor(f);
  await new Promise(requestAnimationFrame);
  focusOn(room.x, room.y);
  $("#mapHint").textContent = `Je start bij ${code}.`;
}

/* Bestemming kiezen: pin op het lokaal en de route ernaartoe. De kaart blijft op de verdieping
   waar je nu bent (daar begint de route); zonder startpunt springen we naar de bestemming. */
async function showRoom(f, code){
  await floorIndex;
  const room = floors[f]?.rooms.find(r => r.code === code);
  if(!room) return showToast(`${code} staat niet op de plattegrond.`);
  store.dest = { floor: String(f), code, name: room.name, x: room.x, y: room.y };
  track("dest", `${f}|${code}`);
  saveStore();
  via = null;
  await setFloor(manualStart || lastFix ? floor : f);
  await new Promise(requestAnimationFrame); // showView() past de kaart ook nog in; daarna pas inzoomen
  if(floor === store.dest.floor) focusOn(room.x, room.y);
}

/* ---------------- 7. live locatie (Geolocation API) ----------------
   De plattegronden zijn gegeorefereerd (kaarten/index.json → geo, zie tools/kaarten-bouwen.mjs):
   een lat/lng rekent direct om naar een punt op de kaart, dus kalibreren is niet nodig.
   GPS weet niet op welke verdieping je bent — die kies je zelf met de tabs. */
let gpsWatchId = null, lastFix = null;

function projectLatLng(lat, lng, fl = floor){
  const g = floors[fl]?.geo;
  if(!g) return null;
  const [a, b, c, d, e, f] = g.m;
  return { x: a*lat + b*lng + c, y: d*lat + e*lng + f, pxPerMeter: g.pxPerMeter };
}
// omgekeerd: kaartpunt -> lat/lng (om bv. een trap van de ene naar de andere verdieping over te zetten)
function toLatLng(x, y, fl = floor){
  const [a, b, c, d, e, f] = floors[fl].geo.m, det = a*e - b*d;
  return { lat: (e*(x - c) - b*(y - f)) / det, lng: (a*(y - f) - d*(x - c)) / det };
}
const onMap = p => p.x >= 0 && p.y >= 0 && p.x <= mapW && p.y <= mapH;

/* Binnen is een losse GPS/wifi-meting grof (10-60 m). Daarom:
   1. middelen: recente metingen tellen zwaarder, nauwkeurige metingen veel zwaarder (gewicht 1/acc²). Hoe lang een meting
      meetelt hangt van de nauwkeurigheid af: bij een goed signaal volgt de stip je snel, bij een slecht signaal middelen we langer;
   2. de stip altijd op een loopbare plek zetten (niet in een muur of buiten het gebouw);
   3. tijdens een route: valt de stip binnen de meetonzekerheid van de lijn, dan zetten we hem óp de lijn
      (zoals Google Maps). Dat maakt de meting niet echt nauwkeuriger, wel bruikbaarder. */
const fixes = [];
const FIX_WINDOW_MS = 12000;
// halfwaardetijd = 150 ms per meter onnauwkeurigheid (gemiddelde van de laatste 3 metingen), tussen 1 en 5 s
const halfLife = () => Math.min(5000, Math.max(1000, 150 * fixes.slice(-3).reduce((s, f) => s + f.acc, 0) / Math.min(fixes.length, 3)));

function addFix(c){
  const now = Date.now();
  fixes.push({ lat: c.latitude, lng: c.longitude, acc: Math.max(c.accuracy || 30, 3), t: now });
  while(fixes.length && now - fixes[0].t > FIX_WINDOW_MS) fixes.shift();
  const half = halfLife();
  let sw = 0, lat = 0, lng = 0;
  for(const f of fixes){
    const w = Math.pow(0.5, (now - f.t) / half) / (f.acc * f.acc);
    sw += w; lat += w * f.lat; lng += w * f.lng;
  }
  const best = Math.min(...fixes.map(f => f.acc));
  // gecombineerde onzekerheid, maar nooit beter dan de helft van de beste losse meting
  return { lat: lat / sw, lng: lng / sw, accuracy: Math.max(best * 0.5, 1 / Math.sqrt(sw)), raw: c.accuracy };
}

const gridReady = {}; // verdieping -> raster, zodra geladen (voor synchrone snap)
const nearestWalkable = p => (gridReady[floor] && Route.nearest(gridReady[floor], p)) || p;

function closestOnLine(pts, p){
  let best = null, bd = Infinity;
  for(let k = 1; k < pts.length; k++){
    const a = pts[k - 1], b = pts[k], dx = b.x - a.x, dy = b.y - a.y, L = dx*dx + dy*dy;
    const t = L ? Math.max(0, Math.min(1, ((p.x - a.x)*dx + (p.y - a.y)*dy) / L)) : 0;
    const q = { x: a.x + t*dx, y: a.y + t*dy }, d = Math.hypot(q.x - p.x, q.y - p.y);
    if(d < bd){ bd = d; best = q; }
  }
  return { q: best, d: bd };
}

// positie uit GPS op deze verdieping, op een loopbare plek; null als je niet in het gebouw bent
function gpsPoint(){
  const p = lastFix && projectLatLng(lastFix.lat, lastFix.lng);
  return p && onMap(p) ? { ...nearestWalkable(p), pxPerMeter: p.pxPerMeter } : null;
}

let routeLine = null; // punten van de getekende route op deze verdieping
function renderLiveMarker(){
  const me = $("#meMarker"), accuracy = $("#accuracyMarker");
  let p = gpsPoint();
  me.hidden = accuracy.hidden = !p;
  if(!p) return;
  if(routeLine){
    const { q, d } = closestOnLine(routeLine, p);
    if(q && d <= Math.max(lastFix.accuracy, 8) * p.pxPerMeter) p = { ...q, pxPerMeter: p.pxPerMeter };
  }
  me.style.left = accuracy.style.left = p.x + "px";
  me.style.top = accuracy.style.top = p.y + "px";
  accuracy.style.width = accuracy.style.height = (Math.max(8, lastFix.accuracy * p.pxPerMeter) * 2) + "px";
}

function setGpsStatus(state, text, sub){
  const dot = $("#gpsDot");
  dot.classList.remove("on", "error");
  if(state) dot.classList.add(state);
  if(text) $("#gpsStatusText").textContent = text;
  if(sub !== undefined) $("#gpsAccuracyText").textContent = sub;
}

// GeolocationPositionError.code: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
const GEO_ERRORS = {
  1: "Geen toestemming. Sta locatie toe voor deze site in je browserinstellingen.",
  2: "Positie niet beschikbaar. Zet locatie (en wifi) aan op je telefoon.",
  3: "Het duurt lang om je positie te bepalen, we blijven zoeken…",
};

// beide knoppen (de knop "Mijn locatie" rechtsboven en de grote knop in de locatiekaart) tonen de status
function setLocateUi(on){
  $$("[data-locate]").forEach(b => {
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    const label = b.querySelector(".locate-label");
    if(label) label.textContent = b.id === "locateBtn" ? (on ? "Locatie aan" : "Mijn locatie") : (on ? "Live locatie uitzetten" : "Live locatie aanzetten");
  });
}

function stopWatch(){
  if(gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
  gpsWatchId = null;
  lastFix = null;
  fixes.length = 0;
  renderLiveMarker();
  setLocateUi(false);
}

function onPosition(pos){
  const first = !lastFix;
  lastFix = addFix(pos.coords);
  if(first) track("located");
  const p = projectLatLng(lastFix.lat, lastFix.lng);
  const acc = `± ${Math.round(lastFix.accuracy)} m nauwkeurig`;
  if(p && onMap(p)){
    setGpsStatus("on", "Live locatie actief", acc);
    if(first) focusOn(p.x, p.y);
  } else if(p){
    const dist = Math.hypot(p.x - mapW/2, p.y - mapH/2) / p.pxPerMeter;
    setGpsStatus("on", "Je bent niet in het gebouw", `${acc} · ongeveer ${dist < 1000 ? Math.round(dist) + " m" : (dist/1000).toFixed(1) + " km"} weg`);
  }
  renderLiveMarker();
  // een nieuwe route zoeken is zwaar: pas als je >1,5 m van het vorige startpunt staat
  const q = gpsPoint();
  if(!manualStart && !(q && routedFrom?.floor === floor && Math.hypot(q.x - routedFrom.x, q.y - routedFrom.y) < 1.5 * q.pxPerMeter)) updateRoute();
}

function onError(err){
  setGpsStatus("error", "Locatie niet beschikbaar", GEO_ERRORS[err.code] || err.message);
  if(err.code === 1) stopWatch(); // zonder toestemming heeft blijven kijken geen zin
}

function toggleLocate(){
  if(gpsWatchId !== null){
    stopWatch();
    return setGpsStatus(null, "Live locatie uitgeschakeld", "");
  }
  if(!("geolocation" in navigator)) return setGpsStatus("error", "Locatie niet ondersteund", "Deze browser ondersteunt de Geolocation API niet.");
  if(!window.isSecureContext) return setGpsStatus("error", "Locatie werkt alleen via https", "Open de app via https.");
  setGpsStatus(null, "Locatie zoeken…", "");
  setLocateUi(true);
  manualStart = null; // live locatie gaat voor een getikt startpunt
  renderStart();
  gpsWatchId = navigator.geolocation.watchPosition(onPosition, onError, {
    enableHighAccuracy: true, // GPS + wifi gebruiken i.p.v. alleen een snelle, grove schatting
    maximumAge: 0,            // altijd een verse positie
    timeout: 27000,
  });
}

/* ---------------- 8. route (zoals Google Maps) ----------------
   Start = getikt punt, anders je live locatie, anders (net van de trap af) de trap waar je vandaan komt.
   Bestemming op een andere verdieping: route naar de beste trap; trappen koppelen we tussen
   verdiepingen via hun lat/lng (ze staan recht boven elkaar; de nummers verschillen per verdieping). */
const grids = {}, stairs = {}, restCache = new Map();
let routeSeq = 0, routedFrom = null; // routedFrom: startpunt van de laatst berekende route
let via = null; // { lat, lng } van de trap waarlangs de route naar een andere verdieping gaat

// de originele muurlijnen voor de routeplanner staan los van de tekening (kaarten/<f>.nav.json)
const gridFor = f => grids[f] ??= Promise.all([loadFloorSvg(f), fetch(`kaarten/${f}.nav.json`).then(r => r.json()), floorIndex]).then(([text, nav]) => {
  const [, w, h] = text.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const fl = floors[f];
  return gridReady[f] = Route.buildGrid(nav.walls, nav.thin, fl.doors || [], +w, +h, fl.geo.pxPerMeter, fl.openings || [], fl.air || [], Route.labels(text));
});
const stairsOf = f => stairs[f] ??= loadFloorSvg(f).then(text =>
  [...text.matchAll(/class="mp-room trap" data-code="[^"]*" transform="translate\(([\d.]+),([\d.]+)\)"/g)]
    .map(m => toLatLng(+m[1], +m[2], f)));

const floorLabel = f => floors[f]?.label || `Verdieping ${f}`;
const meters = (r, f) => r.length / floors[f].geo.pxPerMeter;
const walkText = m => `${Math.round(m)} m · ± ${Math.max(1, Math.round(m / 1.3 / 60))} min lopen`;
// de tekening mist ergens een doorgang: de lijn stopt zo dichtbij als het kan (nooit door een muur)
const partialText = (r, f, what = "je bestemming") =>
  `${walkText(meters(r, f))} tot zo dicht mogelijk bij ${what}. Daarna ontbreekt de doorgang op de kaart: zoek de deur.`;

function currentStart(){
  if(manualStart?.floor === floor) return manualStart;
  const p = gpsPoint();
  if(p) return p;
  if(via && floor === store.dest?.floor) return projectLatLng(via.lat, via.lng); // net van de trap af
  return null;
}

/* route in woorden: de lijn op de kaart als "loop 15 m tot bij A.1.04, sla linksaf en loop 8 m". De routeplanner geeft
   alleen de hoekpunten; een bocht onder 35° telt als rechtdoor en een stuk korter dan 3 m wordt bij het volgende gevoegd.
   Een lokaal binnen 8 m van de bocht dient als oriëntatiepunt (niet twee keer hetzelfde achter elkaar). */
function routeSteps(pts, f, last){
  const ppm = floors[f].geo.pxPerMeter, rooms = floors[f].rooms;
  const landmark = p => rooms.reduce((best, r) => { const d = Math.hypot(r.x - p.x, r.y - p.y); return d < best.d ? { d, code: r.code } : best; }, { d: 8 * ppm }).code;
  const text = (say, run, at) => `${say} ${Math.max(1, Math.round(run / ppm))} m${at ? ` tot bij ${at}` : ""}`;
  const steps = [];
  let run = 0, say = "Loop", lastAt = null;
  for(let k = 1; k < pts.length - 1; k++){
    const a = pts[k - 1], b = pts[k], c = pts[k + 1], ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    run += Math.hypot(ux, uy);
    const turn = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * 180 / Math.PI; // y wijst omlaag: positief = rechts
    if(Math.abs(turn) < 35 || run < 3 * ppm) continue;
    const at = landmark(b);
    steps.push(text(say, run, at !== lastAt ? at : null));
    lastAt = at;
    const dir = turn > 0 ? "rechts" : "links";
    say = Math.abs(turn) < 60 ? `Ga schuin ${dir} en loop` : `Sla ${dir}af en loop`;
    run = 0;
  }
  const end = pts.length > 1 ? run + Math.hypot(pts[pts.length - 1].x - pts[pts.length - 2].x, pts[pts.length - 1].y - pts[pts.length - 2].y) : 0;
  if(end >= 2 * ppm || !steps.length) steps.push(text(say, end, null));
  return [...steps, last];
}
function renderSteps(r, f, last){
  $("#routeSteps").hidden = !r;
  if(!r) return;
  const steps = routeSteps(r.points, f, last);
  $("#routeStepCount").textContent = `${steps.length} stappen`;
  $("#routeStepList").innerHTML = steps.map(s => `<li>${esc(s)}</li>`).join("");
}

function drawRoute(r, last){
  floorplanImg.querySelector(".mp-route")?.remove();
  const wasDrawn = !!routeLine;
  renderSteps(r, floor, last);
  routeLine = r ? r.points : null;
  renderLiveMarker();
  if(!r) return;
  const pts = r.points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("class", wasDrawn ? "mp-route" : "mp-route draw"); // de lijn tekent zich alleen in bij een nieuwe route, niet bij elke GPS-meting
  g.innerHTML = `<polyline class="mp-route-casing" pathLength="1" points="${pts}"/><polyline class="mp-route-line" pathLength="1" points="${pts}"/>`;
  floorplanImg.querySelector(".mp-rooms")?.before(g); // onder de lokaalnummers, zodat die leesbaar blijven
}

function routeCard(title, meta, next){
  $("#routeTitle").textContent = title;
  $("#routeMeta").textContent = meta;
  const nextBtn = $("#routeNext");
  nextBtn.hidden = !next;
  if(next){ nextBtn.textContent = next.label; nextBtn.onclick = next.action; }
  $("#routePick").textContent = store.dest ? "Andere bestemming" : "Kies bestemming";
  $("#routeStop").hidden = !store.dest;
}

// Kies de trap met de kortste totale route: eerst naar de trap op deze verdieping (here), dan verder op de doelverdieping (there).
// Kortste eerst op een ondergrens (hemelsbreed + rest); zodra die niet meer onder de beste route ligt, stoppen.
function bestStairs(candidates, start, dest, here, there){
  const lower = s => { const p = projectLatLng(s.lat, s.lng); return Math.hypot(p.x - start.x, p.y - start.y) / floors[floor].geo.pxPerMeter; };
  const rests = candidates.map(s => {
    const key = `${dest.floor}|${dest.code}|${s.lat.toFixed(6)},${s.lng.toFixed(6)}`;
    if(!restCache.has(key)){
      const r2 = Route.find(there, projectLatLng(s.lat, s.lng, dest.floor), dest);
      restCache.set(key, r2 && { m: meters(r2, dest.floor), partial: r2.partial });
    }
    const rest = restCache.get(key);
    return rest && { s, rest, lb: lower(s) + rest.m };
  }).filter(Boolean).sort((p, q) => p.lb - q.lb);
  let best = null;
  for(const { s, rest, lb } of rests){
    if(best && lb >= best.total) break;
    const r1 = Route.find(here, start, projectLatLng(s.lat, s.lng));
    if(!r1) continue;
    // een route die helemaal klopt gaat altijd voor een route met een onbekend stuk
    const total = meters(r1, floor) + rest.m + (r1.partial || rest.partial ? 1e6 : 0);
    if(!best || total < best.total) best = { total, r1, rest, s };
  }
  return best;
}

async function updateRoute(){
  const seq = ++routeSeq, dest = store.dest;
  const stale = () => seq !== routeSeq; // er is intussen een nieuwere route aangevraagd
  if(!dest){ drawRoute(null); return routeCard("Waar wil je heen?", "Kies een lokaal."); }
  await floorIndex;
  const start = currentStart();
  const title = `${start === manualStart && start.label ? `Van ${start.label} naar` : "Naar"} ${dest.code}${dest.name ? " · " + dest.name : ""}`;
  routedFrom = start && { floor, x: start.x, y: start.y };
  if(!start){
    drawRoute(null);
    return routeCard(title, `${floorLabel(dest.floor)}. Tik op de kaart waar je staat of kies "Ik sta bij een lokaal".`);
  }
  const here = await gridFor(floor);
  if(stale()) return;

  if(floor === dest.floor){
    const r = Route.find(here, start, dest);
    drawRoute(r, r?.partial ? `Hier stopt de route op de kaart. Zoek daar de deur naar ${dest.code}.` : `Je bent bij ${dest.code}.`);
    return routeCard(title, !r ? "Geen route gevonden vanaf dit punt." : r.partial ? partialText(r, floor) : walkText(meters(r, floor)));
  }

  // andere verdieping: probeer elke trap (van deze én de doelverdieping)
  const there = await gridFor(dest.floor);
  const candidates = [...await stairsOf(floor), ...await stairsOf(dest.floor)]
    .filter((s, i, all) => all.findIndex(o => Math.hypot(o.lat - s.lat, (o.lng - s.lng) * 0.62) < 3e-5) === i); // dubbele (<3 m) weg
  if(stale()) return;
  const best = bestStairs(candidates, start, dest, here, there);
  if(!best){ drawRoute(null); return routeCard(title, "Geen trap gevonden naar die verdieping."); }
  via = best.s;
  track("crossed");
  const destFloor = floorLabel(dest.floor).toLowerCase();
  drawRoute(best.r1, best.r1.partial ? "Hier stopt de route op de kaart. Zoek daar de trap." : `Neem de trap naar ${destFloor}.`);
  routeCard(title, best.r1.partial ? partialText(best.r1, floor, "de trap")
      : `Naar de trap: ${walkText(meters(best.r1, floor))}. Daarna nog ${Math.round(best.rest.m)} m${best.rest.partial ? ", laatste stuk niet op de kaart" : ""}.`,
    { label: `Ik ben op ${destFloor} →`, action: () => { manualStart = null; setFloor(dest.floor); } });
}

/* ---------------- 9. koppelen en starten ---------------- */
// één luisteraar voor alle knoppen die via data-attributen werken (ook de knoppen die pas later in de lijst komen)
document.addEventListener("click", e => {
  const hit = sel => e.target.closest(sel);
  const go = hit("[data-go]"), badge = hit("[data-badge]"), openFloor = hit("[data-open-floor]"), room = hit("[data-room]");
  if(go){
    showView(go.dataset.go);
    if(go.dataset.focus) document.getElementById(go.dataset.focus).focus();
  }
  else if(badge) showBadge(badge.dataset.badge);
  else if(openFloor) openFloorList(openFloor.dataset.openFloor); // verdiepingsbord op home: kies een lokaal op die verdieping
  else if(room){
    const start = pickStart;
    showView("route");
    if(start) setStartRoom(room.dataset.floor, room.dataset.room);
    else showRoom(room.dataset.floor, room.dataset.room);
  }
  else if(hit("[data-locate]")) toggleLocate();
});
window.addEventListener("popstate", e => showView(e.state?.view || location.hash.slice(1) || "home", false));

// Lokalen-scherm met alleen deze verdieping uitgeklapt
function openFloorList(f){
  const search = $("#buildingSearch");
  if(search.value){ search.value = ""; search.dispatchEvent(new Event("input")); } // een oude zoekopdracht zou groepen verbergen
  showView("buildings");
  $$(".floor-group").forEach(g => g.open = g.dataset.floor === f);
  $(`.floor-group[data-floor="${f}"]`)?.scrollIntoView();
}

$("#buildingSearch").addEventListener("input", e => {
  const q = searchKey(e.target.value);
  let shown = 0;
  $$(".floor-group").forEach(g => {
    let hits = 0;
    g.querySelectorAll(".building-row").forEach(row => { row.hidden = q && !row.dataset.search.includes(q); hits += !row.hidden; });
    g.hidden = !hits;
    g.open = !!q;
    shown += !!hits;
  });
  const none = $("#noResults");
  none.hidden = !q || shown > 0;
  $("#buildingList").hidden = !none.hidden;
  none.textContent = `Geen lokaal gevonden voor "${e.target.value.trim()}". Probeer bijvoorbeeld A.1.01 of een verdieping.`;
});
floorTabs.addEventListener("click", e => {
  const btn = e.target.closest("button[data-floor]");
  if(btn) setFloor(btn.dataset.floor);
});
$("#zoomIn").addEventListener("click", () => zoomCenter(1.4));
$("#zoomOut").addEventListener("click", () => zoomCenter(1 / 1.4));
$("#zoomReset").addEventListener("click", fitToContainer);
$("#routePick").addEventListener("click", () => {
  showView("buildings");
  $("#buildingSearch").focus();
});
$("#routeFrom").addEventListener("click", () => {
  showView("buildings");
  setPick(true);
  $("#buildingSearch").focus();
});
$("#routeStop").addEventListener("click", () => {
  store.dest = null;
  via = null;
  saveStore();
  renderPin();
  updateRoute();
});
$("#resetProgress").addEventListener("click", resetProgress);

// de app installeren (Chrome/Android): de installatieknop verschijnt pas als de browser dat aanbiedt
let deferredPrompt;
const installBtn = $("#installBtn");
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.hidden = false;
});
installBtn.addEventListener("click", async () => {
  if(!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.hidden = true;
});
window.addEventListener("appinstalled", () => {
  installBtn.hidden = true;
  showToast("Hoornbeeck Gebouwenroute is geïnstalleerd.");
});
if("serviceWorker" in navigator){
  // een nieuwe service worker neemt de pagina over: de open pagina draait dan nog de oude code, dus vraag om te vernieuwen
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if(hadController) $("#updateBtn").hidden = false; });
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").then(reg => {
    // een geïnstalleerde app blijft vaak dagen open op de achtergrond: zoek bij terugkomen naar een nieuwe versie
    document.addEventListener("visibilitychange", () => { if(!document.hidden) reg.update().catch(() => {}); });
  }).catch(console.warn));
}
$("#updateBtn").addEventListener("click", () => location.reload());

floorIndex.then(() => { renderLists(); renderLiveMarker(); })
  .catch(() => { $("#buildingList").innerHTML = `<p class="map-hint">Lokalenlijst kon niet geladen worden.</p>`; });
renderBadges();
const firstView = location.hash.slice(1);
showView($(`[data-view="${firstView}"]`) ? firstView : "home", false);
setFloor("0");
