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

const search = document.querySelector("#buildingSearch");
if(search){
  search.addEventListener("input", () => {
    const q = search.value.toLowerCase().trim();
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
fetch("kaarten/index.json").then(r => r.json()).then(floors => {
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  buildingList.innerHTML = Object.entries(floors)
    .sort(([a], [b]) => a - b)
    .flatMap(([f, fl]) => fl.rooms.map(r => `<button class="building-row" data-room="${r.code}" data-floor="${f}" data-search="${esc(`${r.code} ${r.code.replace(/\./g, "")} ${r.name} ${fl.label}`.toLowerCase())}"><span class="floor">${f === "0" ? "BG" : f}</span><div><b>${r.code}</b><small>${fl.label}${r.name ? " · " + esc(r.name) : ""}</small></div><i>›</i></button>`))
    .join("");
}).catch(() => { buildingList.innerHTML = `<p class="map-hint">Lokalenlijst kon niet geladen worden.</p>`; });

document.addEventListener("click", e => {
  const btn = e.target.closest("[data-room]");
  if(!btn) return;
  showView("route");
  window.showRoom?.(btn.dataset.floor, btn.dataset.room);
});

/* ---------------- Gebouwenroute: plattegrond uit de bouwtekeningen + live locatie ---------------- */
const STORE_KEY = "hgr_v3"; // v3: coördinaten van de echte plattegronden; v2-pins/kalibraties passen niet meer
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
const meMarker = document.querySelector("#meMarker");
const accuracyMarker = document.querySelector("#accuracyMarker");
const mapHint = document.querySelector("#mapHint");
const locateBtn = document.querySelector("#locateBtn");
const gpsDot = document.querySelector("#gpsDot");
const gpsStatusText = document.querySelector("#gpsStatusText");
const gpsAccuracyText = document.querySelector("#gpsAccuracyText");
const calibrateBtn = document.querySelector("#calibrateBtn");
const calibrateBox = document.querySelector("#calibrateBox");
const calibrateInstruction = document.querySelector("#calibrateInstruction");
const calibrateCapture = document.querySelector("#calibrateCapture");
const calibrateCancel = document.querySelector("#calibrateCancel");

if(floorplanWrap && floorplanImg){
  let store = loadStore();
  let floor = "0";
  let mapW = 1000, mapH = 1000; // grootte van de huidige plattegrond in kaart-eenheden (komt uit de SVG)
  let scale = 1, minScale = 1, maxScale = 4, tx = 0, ty = 0;
  let pointers = new Map();
  let pinchStartDist = 0, pinchStartScale = 1;
  let dragStart = null, moved = false;
  let gpsWatchId = null, lastFix = null;
  let calibrating = false, calibStep = 0, calibImgPts = [], calibGpsPts = [], calibTapPoint = null;

  function loadStore(){
    try{ return JSON.parse(localStorage.getItem(STORE_KEY)) || {pins:{}, calibration:{}}; }
    catch{ return {pins:{}, calibration:{}}; }
  }
  function saveStore(){ try{ localStorage.setItem(STORE_KEY, JSON.stringify(store)); }catch{} }

  async function setFloor(f){
    floor = String(f);
    const tab = floorTabs.querySelector(`button[data-floor="${floor}"]`);
    floorTabs.querySelectorAll("button").forEach(b => {
      b.classList.toggle("active", b === tab);
      b.setAttribute("aria-selected", b === tab ? "true" : "false");
    });
    if(calibrating) cancelCalibration();
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
    renderLiveMarker();
  }

  /* Spring naar een lokaal: juiste verdieping, pin op het lokaal, inzoomen. */
  window.showRoom = async (f, code) => {
    await setFloor(f);
    await new Promise(requestAnimationFrame); // showView() past de kaart ook nog in; daarna pas inzoomen
    const room = floorplanImg.querySelector(`[data-code="${CSS.escape(code)}"]`);
    if(!room) return showToast(`${code} staat niet op deze plattegrond.`);
    floorplanImg.querySelectorAll(".mp-room.active").forEach(r => r.classList.remove("active"));
    room.classList.add("active");
    const { e: x, f: y } = room.transform.baseVal.consolidate().matrix;
    store.pins[floor] = { x, y: y - 16 }; // net boven het lokaalnummer, zodat dat leesbaar blijft
    saveStore();
    renderPin();
    const r = floorplanWrap.getBoundingClientRect();
    scale = Math.min(maxScale, Math.max(minScale, 0.6));
    tx = r.width / 2 - x * scale;
    ty = r.height / 2 - y * scale;
    clampPan();
    applyTransform();
    mapHint.textContent = `${code} gemarkeerd met 📍.`;
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

  function handleTap(clientX, clientY){
    const pt = screenToImagePoint(clientX, clientY);
    if(calibrating){
      calibTapPoint = pt;
      calibrateInstruction.textContent = `Punt gemarkeerd. Sta nu fysiek op deze plek en tik op "Leg GPS vast".`;
      renderCalibMarker(pt);
      return;
    }
    store.pins[floor] = pt;
    saveStore();
    renderPin();
    mapHint.textContent = "Punt gemarkeerd op deze verdieping.";
  }

  function renderPin(){
    const pt = store.pins[floor];
    if(pt){
      pinMarker.hidden = false;
      pinMarker.style.left = pt.x + "px";
      pinMarker.style.top = pt.y + "px";
    } else {
      pinMarker.hidden = true;
    }
  }

  function renderCalibMarker(pt){
    pinMarker.hidden = false;
    pinMarker.style.left = pt.x + "px";
    pinMarker.style.top = pt.y + "px";
  }

  /* ---- Live locatie (GPS) ---- */
  function metersFromLatLng(lat, lng, lat0, lng0){
    const R = 111320;
    return {
      x: (lng - lng0) * R * Math.cos(lat0 * Math.PI/180),
      y: (lat0 - lat) * 110540 // noord = negatieve y, zodat het "boven" is
    };
  }

  function getCalibration(){ return store.calibration[floor]; }

  function computeTransform(calib){
    const [g1, g2] = calib.gpsPts;
    const [i1, i2] = calib.imgPts;
    const m1 = {x:0,y:0};
    const m2 = metersFromLatLng(g2.lat, g2.lng, g1.lat, g1.lng);
    const dMx = m2.x - m1.x, dMy = m2.y - m1.y;
    const dIx = i2.x - i1.x, dIy = i2.y - i1.y;
    const denom = dMx*dMx + dMy*dMy;
    if(denom < 1e-6) return null;
    // complex division dI / dM  => k = (dIx*dMx + dIy*dMy)/denom , (dIy*dMx - dIx*dMy)/denom
    const kre = (dIx*dMx + dIy*dMy) / denom;
    const kim = (dIy*dMx - dIx*dMy) / denom;
    return { origin: g1, i1, kre, kim, metersPerPixel: 1/Math.hypot(kre,kim) };
  }

  function projectLatLng(lat, lng, calib){
    const t = computeTransform(calib);
    if(!t) return null;
    const m = metersFromLatLng(lat, lng, t.origin.lat, t.origin.lng);
    // I = I1 + k * M  (complex multiply)
    const ix = t.i1.x + (t.kre*m.x - t.kim*m.y);
    const iy = t.i1.y + (t.kim*m.x + t.kre*m.y);
    return { x: ix, y: iy, pxPerMeter: Math.hypot(t.kre, t.kim) };
  }

  function renderLiveMarker(){
    const calib = getCalibration();
    if(!calib || !lastFix){
      meMarker.hidden = true;
      accuracyMarker.hidden = true;
      return;
    }
    const proj = projectLatLng(lastFix.lat, lastFix.lng, calib);
    if(!proj){ meMarker.hidden = true; accuracyMarker.hidden = true; return; }
    meMarker.hidden = false;
    meMarker.style.left = proj.x + "px";
    meMarker.style.top = proj.y + "px";
    const r = Math.max(8, lastFix.accuracy * proj.pxPerMeter);
    accuracyMarker.hidden = false;
    accuracyMarker.style.width = (r*2) + "px";
    accuracyMarker.style.height = (r*2) + "px";
    accuracyMarker.style.left = proj.x + "px";
    accuracyMarker.style.top = proj.y + "px";
  }

  function setGpsStatus(state, text, sub){
    gpsDot.classList.remove("on","error");
    if(state) gpsDot.classList.add(state);
    if(text) gpsStatusText.textContent = text;
    if(sub) gpsAccuracyText.textContent = sub;
  }

  locateBtn?.addEventListener("click", () => {
    if(gpsWatchId !== null){
      navigator.geolocation.clearWatch(gpsWatchId);
      gpsWatchId = null;
      lastFix = null;
      renderLiveMarker();
      setGpsStatus(null, "Live locatie uitgeschakeld", "Tik op ◉ hierboven om je live locatie op de kaart te tonen.");
      return;
    }
    if(!("geolocation" in navigator)){
      showToast("Geolocatie wordt niet ondersteund door dit toestel.");
      return;
    }
    setGpsStatus(null, "GPS zoeken…", "Even geduld, we bepalen je positie.");
    gpsWatchId = navigator.geolocation.watchPosition(pos => {
      lastFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy || 20 };
      const calib = getCalibration();
      if(calib){
        setGpsStatus("on", "Live locatie actief", `Nauwkeurigheid ≈ ${Math.round(lastFix.accuracy)} m`);
      } else {
        setGpsStatus("on", "GPS actief, geen kalibratie voor deze verdieping", "Kalibreer hieronder om jezelf op de kaart te zien.");
      }
      renderLiveMarker();
    }, err => {
      setGpsStatus("error", "Locatie niet beschikbaar", err.message || "Geef locatietoegang in je browserinstellingen.");
    }, { enableHighAccuracy:true, maximumAge:2000, timeout:15000 });
  });

  /* ---- Kalibratie (2 punten: plattegrond-pixel ↔ GPS) ---- */
  function startCalibration(){
    calibrating = true; calibStep = 1; calibImgPts = []; calibGpsPts = []; calibTapPoint = null;
    calibrateBox.hidden = false;
    calibrateBtn.textContent = "Kalibratie bezig — tik hieronder om te annuleren";
    calibrateInstruction.textContent = "Stap 1 van 2 — Ga fysiek naar een herkenbaar punt (bijv. de hoofdingang), tik dat punt aan op de plattegrond en druk daarna op \"Leg GPS vast\".";
    renderPin();
  }
  function cancelCalibration(){
    calibrating = false; calibStep = 0; calibTapPoint = null;
    calibrateBox.hidden = true;
    calibrateBtn.textContent = "Kalibreer GPS op deze verdieping";
    renderPin();
  }
  calibrateBtn?.addEventListener("click", () => {
    if(calibrating) cancelCalibration(); else startCalibration();
  });
  calibrateCancel?.addEventListener("click", cancelCalibration);

  calibrateCapture?.addEventListener("click", () => {
    if(!calibTapPoint){
      showToast("Tik eerst je huidige plek aan op de plattegrond.");
      return;
    }
    if(!("geolocation" in navigator)){
      showToast("Geolocatie wordt niet ondersteund door dit toestel.");
      return;
    }
    calibrateInstruction.textContent = "GPS wordt opgehaald…";
    navigator.geolocation.getCurrentPosition(pos => {
      calibImgPts.push({x:calibTapPoint.x, y:calibTapPoint.y});
      calibGpsPts.push({lat:pos.coords.latitude, lng:pos.coords.longitude});
      calibTapPoint = null;
      if(calibStep === 1){
        calibStep = 2;
        calibrateInstruction.textContent = "Stap 2 van 2 — Ga naar een ander punt, minstens een paar meter verderop, tik het aan op de kaart en leg opnieuw GPS vast.";
      } else {
        store.calibration[floor] = { imgPts: calibImgPts, gpsPts: calibGpsPts };
        saveStore();
        cancelCalibration();
        showToast("Kalibratie opgeslagen voor deze verdieping.");
        renderLiveMarker();
      }
    }, err => {
      showToast("Kon GPS niet ophalen: " + (err.message || "onbekende fout"));
    }, { enableHighAccuracy:true, timeout:15000 });
  });

  window.addEventListener("resize", () => fitToContainer());
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