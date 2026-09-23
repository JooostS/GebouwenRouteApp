const views = [...document.querySelectorAll(".view")];
const navButtons = [...document.querySelectorAll("[data-go]")];
const nav = [...document.querySelectorAll("[data-nav]")];
const toast = document.querySelector("#toast");
let currentView = "home";

function showView(name, push = true){
  const target = document.querySelector(`[data-view="${name}"]`);
  if(!target) return;
  views.forEach(v => v.classList.toggle("active", v === target));
  nav.forEach(b => b.classList.toggle("active", b.dataset.nav === name));
  currentView = name;
  if(push) history.pushState({view:name}, "", `#${name}`);
  window.scrollTo({top:0, behavior:"smooth"});
  if(name === "route" && typeof window.__fitFloorplan === "function"){
    requestAnimationFrame(() => window.__fitFloorplan());
  }
}

navButtons.forEach(btn => btn.addEventListener("click", () => showView(btn.dataset.go)));
window.addEventListener("popstate", e => showView(e.state?.view || location.hash.slice(1) || "home", false));

const initial = location.hash.slice(1);
if(initial && document.querySelector(`[data-view="${initial}"]`)) showView(initial, false);
else showView("home", false);

// "A.1.01", "a1.01" en "a101" moeten allemaal matchen: puntjes en spaties tellen niet mee
const searchKey = s => s.toLowerCase().replace(/[.\s]/g, "");
const search = document.querySelector("#buildingSearch");
if(search){
  search.addEventListener("input", () => {
    const q = searchKey(search.value);
    document.querySelectorAll(".building-row").forEach(row => {
      row.hidden = q && !row.dataset.search.includes(q);
    });
  });
}

function showToast(message){
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(window.__toast);
  window.__toast = setTimeout(() => toast.classList.remove("show"), 2600);
}

/* Lokalenlijst: komt uit kaarten/index.json (gegenereerd uit de bouwtekeningen door tools/kaarten-bouwen.mjs) */
const buildingList = document.querySelector("#buildingList");
const floorIndex = fetch("kaarten/index.json").then(r => r.json());
floorIndex.then(floors => {
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  buildingList.innerHTML = Object.entries(floors)
    .sort(([a], [b]) => a - b)
    .flatMap(([f, fl]) => fl.rooms.map(r => `<button class="building-row" data-room="${r.code}" data-floor="${f}" data-search="${esc(searchKey(`${r.code}|${r.name}|${fl.label}`))}"><span class="floor">${f === "0" ? "BG" : f}</span><div><b>${r.code}</b><small>${fl.label}${r.name ? " · " + esc(r.name) : ""}</small></div><i>›</i></button>`))
    .join("");
}).catch(() => { buildingList.innerHTML = `<p class="map-hint">Lokalenlijst kon niet geladen worden.</p>`; });

document.addEventListener("click", e => {
  const btn = e.target.closest("[data-room]");
  if(!btn) return;
  showView("route");
  window.showRoom?.(btn.dataset.floor, btn.dataset.room);
});

/* ---------------- Gebouwenroute: plattegrond uit de bouwtekeningen + live locatie ---------------- */
const STORE_KEY = "hgr_v4"; // v4: { dest } — de gekozen bestemming blijft bewaard
const floorSvgs = {};
const loadFloorSvg = f => floorSvgs[f] ??= fetch(`kaarten/${f}.svg`).then(r => {
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
});

const floorplanWrap = document.querySelector("#floorplanWrap");
const floorplanCanvas = document.querySelector("#floorplanCanvas");
const floorplanImg = document.querySelector("#floorplanImg");
const floorTabs = document.querySelector("#floorTabs");
const pinMarker = document.querySelector("#pinMarker");
const startMarker = document.querySelector("#startMarker");
const routeTitle = document.querySelector("#routeTitle");
const routeMeta = document.querySelector("#routeMeta");
const routeNext = document.querySelector("#routeNext");
const routePick = document.querySelector("#routePick");
const routeStop = document.querySelector("#routeStop");
const meMarker = document.querySelector("#meMarker");
const accuracyMarker = document.querySelector("#accuracyMarker");
const mapHint = document.querySelector("#mapHint");
const locateBtn = document.querySelector("#locateBtn");
const gpsDot = document.querySelector("#gpsDot");
const gpsStatusText = document.querySelector("#gpsStatusText");
const gpsAccuracyText = document.querySelector("#gpsAccuracyText");

if(floorplanWrap && floorplanImg){
  let store = loadStore();
  let floor = "0";
  let mapW = 1000, mapH = 1000; // grootte van de huidige plattegrond in kaart-eenheden (komt uit de SVG)
  let scale = 1, minScale = 1, maxScale = 4, tx = 0, ty = 0;
  let pointers = new Map();
  let pinchStartDist = 0, pinchStartScale = 1;
  let dragStart = null, moved = false;
  let gpsWatchId = null, lastFix = null;
  let manualStart = null; // { floor, x, y } — getikt "hier ben ik" (als er geen GPS is)
  let via = null;         // { lat, lng } van de trap waarlangs de route naar een andere verdieping gaat

  function loadStore(){
    try{ return JSON.parse(localStorage.getItem(STORE_KEY)) || {dest:null}; }
    catch{ return {dest:null}; }
  }
  function saveStore(){ try{ localStorage.setItem(STORE_KEY, JSON.stringify(store)); }catch{} }

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

  function focusOn(x, y){
    const r = floorplanWrap.getBoundingClientRect();
    scale = Math.min(maxScale, Math.max(minScale, 0.6));
    tx = r.width / 2 - x * scale;
    ty = r.height / 2 - y * scale;
    clampPan();
    applyTransform();
  }

  /* Bestemming kiezen: pin op het lokaal en de route ernaartoe. De kaart blijft op de verdieping
     waar je nu bent (daar begint de route); zonder startpunt springen we naar de bestemming. */
  window.showRoom = async (f, code) => {
    const room = (await floorIndex)[f]?.rooms.find(r => r.code === code);
    if(!room) return showToast(`${code} staat niet op de plattegrond.`);
    store.dest = { floor: String(f), code, name: room.name, x: room.x, y: room.y };
    saveStore();
    via = null;
    const haveStart = manualStart || lastFix;
    await setFloor(haveStart ? floor : f);
    await new Promise(requestAnimationFrame); // showView() past de kaart ook nog in; daarna pas inzoomen
    if(floor === store.dest.floor) focusOn(room.x, room.y);
  };

  floorTabs?.addEventListener("click", e => {
    const btn = e.target.closest("button[data-floor]");
    if(btn) setFloor(btn.dataset.floor);
  });

  function fitToContainer(){
    const wrapRect = floorplanWrap.getBoundingClientRect();
    if(wrapRect.width < 10 || wrapRect.height < 10) return;
    minScale = Math.min(wrapRect.width / mapW, wrapRect.height / mapH);
    scale = minScale;
    maxScale = Math.max(1.5, minScale * 4);
    tx = (wrapRect.width - mapW * scale) / 2;
    ty = (wrapRect.height - mapH * scale) / 2;
    applyTransform();
  }

  function applyTransform(){
    floorplanCanvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    // --k houdt lijndikte, labels en markers even groot op het scherm, ongeacht de zoom
    floorplanCanvas.style.setProperty("--k", 1 / scale);
    floorplanWrap.classList.toggle("far", scale < 0.45);
  }

  function clampPan(){
    const wrapRect = floorplanWrap.getBoundingClientRect();
    const iw = mapW * scale, ih = mapH * scale;
    const margin = 60;
    tx = Math.min(margin, Math.max(wrapRect.width - iw - margin, tx));
    ty = Math.min(margin, Math.max(wrapRect.height - ih - margin, ty));
  }

  function zoomAt(clientX, clientY, factor){
    const wrapRect = floorplanWrap.getBoundingClientRect();
    const px = clientX - wrapRect.left, py = clientY - wrapRect.top;
    const localX = (px - tx) / scale, localY = (py - ty) / scale;
    scale = Math.min(maxScale, Math.max(minScale, scale * factor));
    tx = px - localX * scale;
    ty = py - localY * scale;
    clampPan();
    applyTransform();
  }

  document.querySelector("#zoomIn")?.addEventListener("click", () => {
    const r = floorplanWrap.getBoundingClientRect();
    zoomAt(r.left + r.width/2, r.top + r.height/2, 1.4);
  });
  document.querySelector("#zoomOut")?.addEventListener("click", () => {
    const r = floorplanWrap.getBoundingClientRect();
    zoomAt(r.left + r.width/2, r.top + r.height/2, 1/1.4);
  });
  document.querySelector("#zoomReset")?.addEventListener("click", fitToContainer);

  floorplanWrap.addEventListener("wheel", e => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1/1.15);
  }, {passive:false});

  floorplanWrap.addEventListener("pointerdown", e => {
    floorplanWrap.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
    if(pointers.size === 1){
      dragStart = {x:e.clientX, y:e.clientY, tx, ty, t:Date.now()};
      moved = false;
      floorplanCanvas.classList.add("dragging");
    } else if(pointers.size === 2){
      const pts = [...pointers.values()];
      pinchStartDist = Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y) || 1;
      pinchStartScale = scale;
    }
  });

  floorplanWrap.addEventListener("pointermove", e => {
    if(!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
    if(pointers.size === 2){
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y) || 1;
      const midX = (pts[0].x+pts[1].x)/2, midY = (pts[0].y+pts[1].y)/2;
      const targetScale = Math.min(maxScale, Math.max(minScale, pinchStartScale * (dist/pinchStartDist)));
      const wrapRect = floorplanWrap.getBoundingClientRect();
      const px = midX - wrapRect.left, py = midY - wrapRect.top;
      const localX = (px - tx) / scale, localY = (py - ty) / scale;
      scale = targetScale;
      tx = px - localX * scale;
      ty = py - localY * scale;
      clampPan();
      applyTransform();
      moved = true;
    } else if(pointers.size === 1 && dragStart){
      const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
      if(Math.hypot(dx,dy) > 5) moved = true;
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
    if(pointers.size < 2){ pinchStartDist = 0; }
    if(pointers.size === 0){ dragStart = null; }
  }
  floorplanWrap.addEventListener("pointerup", endPointer);
  floorplanWrap.addEventListener("pointercancel", endPointer);

  function screenToImagePoint(clientX, clientY){
    const wrapRect = floorplanWrap.getBoundingClientRect();
    const px = clientX - wrapRect.left, py = clientY - wrapRect.top;
    return { x: (px - tx) / scale, y: (py - ty) / scale };
  }

  // tikken = "hier ben ik": startpunt van de route op deze verdieping
  function handleTap(clientX, clientY){
    manualStart = { floor, ...screenToImagePoint(clientX, clientY) };
    via = null;
    renderStart();
    updateRoute();
    mapHint.textContent = "Startpunt gezet. Tik ergens anders om het te verplaatsen.";
  }

  function place(el, pt){
    el.hidden = !pt;
    if(pt){ el.style.left = pt.x + "px"; el.style.top = pt.y + "px"; }
  }
  // de pin staat net boven het lokaalnummer, zodat dat leesbaar blijft
  const renderPin = () => {
    const d = store.dest;
    place(pinMarker, d && d.floor === floor ? { x: d.x, y: d.y - 16 } : null);
    floorplanImg.querySelectorAll(".mp-room.active").forEach(r => r.classList.remove("active"));
    if(d && d.floor === floor) floorplanImg.querySelector(`[data-code="${CSS.escape(d.code)}"]`)?.classList.add("active");
  };
  const renderStart = () => place(startMarker, manualStart?.floor === floor ? manualStart : null);

  /* ---- Live locatie (Geolocation API) ----
     De plattegronden zijn gegeorefereerd (kaarten/index.json → geo, zie tools/kaarten-bouwen.mjs):
     een lat/lng rekent direct om naar een punt op de kaart, dus kalibreren is niet nodig.
     GPS weet niet op welke verdieping je bent — die kies je zelf met de tabs. */
  const floorGeo = {}, floorNames = {};
  floorIndex.then(idx => {
    for(const [f, fl] of Object.entries(idx)){ floorGeo[f] = fl.geo; floorNames[f] = fl.label; }
    renderLiveMarker();
  }).catch(() => {});

  function projectLatLng(lat, lng, fl = floor){
    const g = floorGeo[fl];
    if(!g) return null;
    const [a, b, c, d, e, f] = g.m;
    return { x: a*lat + b*lng + c, y: d*lat + e*lng + f, pxPerMeter: g.pxPerMeter };
  }
  // omgekeerd: kaartpunt -> lat/lng (om bv. een trap van de ene naar de andere verdieping over te zetten)
  function toLatLng(x, y, fl = floor){
    const [a, b, c, d, e, f] = floorGeo[fl].m, det = a*e - b*d;
    return { lat: (e*(x - c) - b*(y - f)) / det, lng: (a*(y - f) - d*(x - c)) / det };
  }
  const onMap = p => p.x >= 0 && p.y >= 0 && p.x <= mapW && p.y <= mapH;

  /* Binnen is een losse GPS/wifi-meting grof (10-60 m). Daarom:
     1. middelen: recente metingen tellen zwaarder, nauwkeurige metingen veel zwaarder (gewicht 1/acc²);
     2. de stip altijd op een loopbare plek zetten (niet in een muur of buiten het gebouw);
     3. tijdens een route: valt de stip binnen de meetonzekerheid van de lijn, dan zetten we hem óp de lijn
        (zoals Google Maps). Dat maakt de meting niet echt nauwkeuriger, wel bruikbaarder. */
  const fixes = [];
  const FIX_WINDOW_MS = 12000, FIX_HALF_LIFE_MS = 5000;
  function addFix(c){
    const now = Date.now();
    fixes.push({ lat: c.latitude, lng: c.longitude, acc: Math.max(c.accuracy || 30, 3), t: now });
    while(fixes.length && now - fixes[0].t > FIX_WINDOW_MS) fixes.shift();
    let sw = 0, lat = 0, lng = 0;
    for(const f of fixes){
      const w = Math.pow(0.5, (now - f.t) / FIX_HALF_LIFE_MS) / (f.acc * f.acc);
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
    let p = gpsPoint();
    meMarker.hidden = accuracyMarker.hidden = !p;
    if(!p) return;
    if(routeLine){
      const { q, d } = closestOnLine(routeLine, p);
      if(q && d <= Math.max(lastFix.accuracy, 8) * p.pxPerMeter) p = { ...q, pxPerMeter: p.pxPerMeter };
    }
    meMarker.style.left = accuracyMarker.style.left = p.x + "px";
    meMarker.style.top = accuracyMarker.style.top = p.y + "px";
    const r = Math.max(8, lastFix.accuracy * p.pxPerMeter);
    accuracyMarker.style.width = accuracyMarker.style.height = (r*2) + "px";
  }

  function setGpsStatus(state, text, sub){
    gpsDot.classList.remove("on","error");
    if(state) gpsDot.classList.add(state);
    if(text) gpsStatusText.textContent = text;
    if(sub) gpsAccuracyText.textContent = sub;
  }

  // GeolocationPositionError.code: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
  const GEO_ERRORS = {
    1: "Geen toestemming. Sta locatie toe voor deze site in je browserinstellingen.",
    2: "Positie niet beschikbaar. Zet locatie (en wifi) aan op je telefoon.",
    3: "Het duurt lang om je positie te bepalen, we blijven zoeken…",
  };

  function stopWatch(){
    if(gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
    lastFix = null;
    fixes.length = 0;
    renderLiveMarker();
    setLocateUi(false);
  }

  // beide knoppen (de knop "Mijn locatie" rechtsboven en de grote knop in de locatiekaart) tonen de status
  function setLocateUi(on){
    document.querySelectorAll("[data-locate]").forEach(b => {
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      const label = b.querySelector(".locate-label");
      if(label) label.textContent = b === locateBtn ? (on ? "Locatie aan" : "Mijn locatie") : (on ? "Live locatie uitzetten" : "Live locatie aanzetten");
    });
  }

  function onPosition(pos){
    const first = !lastFix;
    lastFix = addFix(pos.coords);
    const p = projectLatLng(lastFix.lat, lastFix.lng);
    const acc = `± ${Math.round(lastFix.accuracy)} m (gemiddeld over ${fixes.length} meting${fixes.length === 1 ? "" : "en"}; laatste ± ${Math.round(lastFix.raw)} m)`;
    if(p && onMap(p)){
      setGpsStatus("on", "Live locatie actief", `${acc} · kies zelf je verdieping`);
      if(first) focusOn(p.x, p.y);
    } else if(p){
      const dist = Math.hypot(p.x - mapW/2, p.y - mapH/2) / p.pxPerMeter;
      setGpsStatus("on", "Je bent niet in het gebouw", `${acc} · ongeveer ${dist < 1000 ? Math.round(dist) + " m" : (dist/1000).toFixed(1) + " km"} van het Hoornbeeck`);
    }
    renderLiveMarker();
    if(!manualStart) updateRoute();
  }

  function onError(err){
    setGpsStatus("error", "Locatie niet beschikbaar", GEO_ERRORS[err.code] || err.message);
    if(err.code === 1) stopWatch(); // zonder toestemming heeft blijven kijken geen zin
  }

  document.addEventListener("click", e => {
    if(!e.target.closest("[data-locate]")) return;
    if(gpsWatchId !== null){
      stopWatch();
      setGpsStatus(null, "Live locatie uitgeschakeld", "Zet je live locatie aan om jezelf als blauwe stip op de kaart te zien.");
      return;
    }
    if(!("geolocation" in navigator)){
      setGpsStatus("error", "Locatie niet ondersteund", "Deze browser ondersteunt de Geolocation API niet.");
      return;
    }
    if(!window.isSecureContext){
      setGpsStatus("error", "Locatie werkt alleen via https", "Open de app via GitHub Pages (https), niet via http:// of een IP-adres.");
      return;
    }
    setGpsStatus(null, "Locatie zoeken…", "Even geduld, we bepalen je positie.");
    setLocateUi(true);
    manualStart = null; // live locatie gaat voor een getikt startpunt
    renderStart();
    gpsWatchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true, // GPS + wifi gebruiken i.p.v. alleen een snelle, grove schatting
      maximumAge: 0,            // altijd een verse positie
      timeout: 27000,
    });
  });

  /* ---- Route (zoals Google Maps) ----
     Start = getikt punt, anders je live locatie, anders (net van de trap af) de trap waar je vandaan komt.
     Bestemming op een andere verdieping: route naar de beste trap; trappen koppelen we tussen
     verdiepingen via hun lat/lng (ze staan recht boven elkaar; de nummers verschillen per verdieping). */
  const grids = {}, stairs = {}, restCache = new Map();
  let routeSeq = 0;

  const gridFor = f => grids[f] ??= Promise.all([loadFloorSvg(f), floorIndex]).then(([text, idx]) => {
    const [, w, h] = text.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    const walls = text.match(/class="mp-walls" d="([^"]*)"/)[1];
    const thin = (text.match(/class="mp-walls mp-thin" d="([^"]*)"/) || [, ""])[1];
    return gridReady[f] = Route.buildGrid(walls, thin, idx[f].doors || [], +w, +h, idx[f].geo.pxPerMeter, idx[f].openings || []);
  });
  const stairsOf = f => stairs[f] ??= loadFloorSvg(f).then(text =>
    [...text.matchAll(/class="mp-room trap" data-code="[^"]*" transform="translate\(([\d.]+),([\d.]+)\)"/g)]
      .map(m => toLatLng(+m[1], +m[2], f)));

  const floorLabel = f => floorNames[f] || `Verdieping ${f}`;
  const meters = (r, f) => r.length / floorGeo[f].pxPerMeter;
  // de tekening mist ergens een doorgang: de lijn stopt zo dichtbij als het kan (nooit door een muur)
  const partialText = (r, f, what = "je bestemming") =>
    `${walkText(meters(r, f))} tot zo dicht mogelijk bij ${what}. Het laatste stuk staat niet als doorgang in de bouwtekening; zoek daar de deur of volg de bordjes.`;
  const walkText = m => `${Math.round(m)} m · ± ${Math.max(1, Math.round(m / 1.3 / 60))} min lopen`;

  function currentStart(){
    if(manualStart?.floor === floor) return manualStart;
    const p = gpsPoint();
    if(p) return p;
    if(via && floor === store.dest?.floor) return projectLatLng(via.lat, via.lng); // net van de trap af
    return null;
  }

  function drawRoute(r){
    floorplanImg.querySelector(".mp-route")?.remove();
    routeLine = r ? r.points : null;
    renderLiveMarker();
    if(!r) return;
    const pts = r.points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "mp-route");
    g.innerHTML = `<polyline class="mp-route-casing" points="${pts}"/><polyline class="mp-route-line" points="${pts}"/>`;
    floorplanImg.querySelector(".mp-rooms")?.before(g); // onder de lokaalnummers, zodat die leesbaar blijven
  }

  function routeCard(title, meta, next){
    routeTitle.textContent = title;
    routeMeta.textContent = meta;
    routeNext.hidden = !next;
    if(next){ routeNext.textContent = next.label; routeNext.onclick = next.action; }
    routePick.textContent = store.dest ? "Andere bestemming" : "Kies bestemming";
    routeStop.hidden = !store.dest;
  }

  async function updateRoute(){
    const seq = ++routeSeq, dest = store.dest;
    const stale = () => seq !== routeSeq;
    if(!dest){ drawRoute(null); return routeCard("Waar wil je heen?", "Kies een lokaal om een route te krijgen."); }
    const title = `Naar ${dest.code}${dest.name ? " · " + dest.name : ""}`;
    await floorIndex;
    const start = currentStart();
    if(!start){
      drawRoute(null);
      return routeCard(title, `${floorLabel(dest.floor)}. Kies de verdieping waar je bent en tik op de kaart waar je staat, of tik rechtsboven op "Mijn locatie".`);
    }
    const here = await gridFor(floor);
    if(stale()) return;
    if(floor === dest.floor){
      const r = Route.find(here, start, dest);
      drawRoute(r);
      return routeCard(title, !r ? "Geen route gevonden vanaf dit punt." : r.partial ? partialText(r, floor) : walkText(meters(r, floor)));
    }
    // andere verdieping: probeer elke trap (van deze én de doelverdieping) en neem de kortste totale route
    const there = await gridFor(dest.floor);
    const candidates = [...await stairsOf(floor), ...await stairsOf(dest.floor)]
      .filter((s, i, all) => all.findIndex(o => Math.hypot(o.lat - s.lat, (o.lng - s.lng) * 0.62) < 3e-5) === i); // dubbele (<3 m) weg
    if(stale()) return;
    let best = null;
    for(const s of candidates){
      const key = `${dest.floor}|${dest.code}|${s.lat.toFixed(6)},${s.lng.toFixed(6)}`;
      if(!restCache.has(key)){
        const r2 = Route.find(there, projectLatLng(s.lat, s.lng, dest.floor), dest);
        restCache.set(key, r2 && { m: meters(r2, dest.floor), partial: r2.partial });
      }
      const rest = restCache.get(key);
      const r1 = rest && Route.find(here, start, projectLatLng(s.lat, s.lng));
      if(!r1) continue;
      // een route die helemaal klopt gaat altijd voor een route met een onbekend stuk
      const total = meters(r1, floor) + rest.m + (r1.partial || rest.partial ? 1e6 : 0);
      if(!best || total < best.total) best = { total, r1, rest, s };
    }
    if(stale()) return;
    if(!best){ drawRoute(null); return routeCard(title, "Geen trap gevonden naar die verdieping."); }
    via = best.s;
    drawRoute(best.r1);
    routeCard(title, best.r1.partial ? partialText(best.r1, floor, "de trap")
        : `Loop naar de trap (${walkText(meters(best.r1, floor))}) en ga naar ${floorLabel(dest.floor).toLowerCase()}. Daarna nog ${Math.round(best.rest.m)} m${best.rest.partial ? ", het laatste stuk staat niet op de kaart" : ""}.`,
      { label: `Ik ben op ${floorLabel(dest.floor).toLowerCase()} →`, action: () => { manualStart = null; setFloor(dest.floor); } });
  }

  routePick?.addEventListener("click", () => {
    showView("buildings");
    document.querySelector("#buildingSearch")?.focus();
  });
  routeStop?.addEventListener("click", () => {
    store.dest = null;
    via = null;
    saveStore();
    renderPin();
    updateRoute();
  });

  // alleen opnieuw passend maken als de breedte echt verandert: op telefoons vuurt "resize" ook
  // als de adresbalk in-/uitschuift tijdens scrollen, en dan zou je zoom steeds verspringen
  let lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if(window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    fitToContainer();
  });
  window.__fitFloorplan = () => { fitToContainer(); renderPin(); renderLiveMarker(); };
  setFloor("0");
}

document.querySelectorAll(".badge.unlocked").forEach(b => {
  b.addEventListener("click", () => showToast(`${b.querySelector("b").textContent} — badge al behaald!`));
});

let deferredPrompt;
const installBtn = document.querySelector("#installBtn");
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.hidden = false;
});
installBtn?.addEventListener("click", async () => {
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
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(console.warn));
}