/* Routeplanner: kortste looproute over de plattegrond.
   De muren worden een raster van 25 cm-cellen (deuropeningen vrijgemaakt, buiten het gebouw verboden),
   daarop zoekt A* de route. Cellen vlak naast een muur of de buitenrand kosten meer, zodat de lijn netjes midden
   door de gang loopt. Werkt in de browser en in Node (voor tests).

   Een raster is { w, h, cell, blocked, dist, outside }: één byte per cel, celnummer i = y * w + x.
     blocked  1 = muur
     outside  1 = buiten het gebouw (of de lucht in het midden): hier mag de route nooit komen
     dist     afstand in cellen tot de dichtstbijzijnde muur of buitenrand (max 4)
     shut     1 = deurvlak van een wc-hokje of technische ruimte: de route gebruikt zo'n deur alleen als hij daar begint of
              eindigt, nooit om er dwars doorheen te lopen (de hokjes zouden anders een sluiproute tussen twee gangen zijn) */
const Route = (() => {
  const CELL_M = 0.25;
  // Een deur binnen SEAL_M van een wc- of technisch-ruimtelabel hoort bij die ruimte (zie g.shut); zo'n deur is alleen
  // toegankelijk binnen ENDPOINT_M van het begin of eind van de route.
  const SEAL_M = 2.5, ENDPOINT_M = 3.5;
  const WALL_COST = [0, 4, 1.5, 0.5]; // extra kosten op 0, 1, 2, 3+ cellen van een muur of de buitenrand

  /* ---------------- hulpjes ---------------- */
  const inGrid = (g, x, y) => x >= 0 && y >= 0 && x < g.w && y < g.h;
  const col = (g, i) => i % g.w;
  const row = (g, i) => Math.floor(i / g.w);
  const cellCenter = (g, i) => ({ x: (col(g, i) + 0.5) * g.cell, y: (row(g, i) + 0.5) * g.cell });
  // de buurcellen links, rechts, boven en onder (alleen die binnen het raster liggen)
  function around(g, i){
    const x = col(g, i), n = [];
    if(x > 0) n.push(i - 1);
    if(x < g.w - 1) n.push(i + 1);
    if(i >= g.w) n.push(i - g.w);
    if(i < g.w * (g.h - 1)) n.push(i + g.w);
    return n;
  }

  /* ---------------- raster bouwen ---------------- */

  // SVG-paden (M, L, C, Z) -> raster waarin elke cel die een lijn raakt 1 is
  function rasterize(g, paths){
    const r = new Uint8Array(g.w * g.h);
    const set = (x, y) => {
      const cx = Math.floor(x / g.cell), cy = Math.floor(y / g.cell);
      if(inGrid(g, cx, cy)) r[cy * g.w + cx] = 1;
    };
    const line = (a, b) => {
      const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (g.cell * 0.5)) || 1;
      for(let k = 0; k <= n; k++) set(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n);
    };
    const bez = (p0, p1, p2, p3, t) => [0, 1].map(k => (1-t)**3*p0[k] + 3*(1-t)**2*t*p1[k] + 3*(1-t)*t*t*p2[k] + t**3*p3[k]);
    for(const d of paths){
      const t = d.match(/[MLCZ]|-?[\d.]+/g) || [];
      let last = null, start = null;
      for(let i = 0; i < t.length;){
        const c = t[i++], n = () => +t[i++];
        if(c === "M"){ last = start = [n(), n()]; }
        else if(c === "L"){ const p = [n(), n()]; line(last, p); last = p; }
        else if(c === "C"){
          const p1 = [n(), n()], p2 = [n(), n()], p3 = [n(), n()];
          for(let k = 0; k < 8; k++) line(bez(last, p1, p2, p3, k / 8), bez(last, p1, p2, p3, (k + 1) / 8));
          last = p3;
        }
        else if(c === "Z"){ line(last, start); last = start; }
      }
    }
    return r;
  }

  // Buiten = alles wat je vanaf de rand van de kaart (of vanaf een luchtpunt) bereikt zonder een lijn te kruisen.
  // shell = muren + dunne lijnen: de ramen tellen wél mee, anders lekt het via de ramen naar binnen.
  // airSeeds: punten in buitenruimte die door maatlijnen (dunne lijnen) is afgesloten, zoals de leegte tussen de vleugels.
  function floodOutside(g, shell, airSeeds){
    const outside = new Uint8Array(g.w * g.h), stack = [0];
    outside[0] = 1;
    for(const [sx, sy] of airSeeds){
      const i = Math.floor(sy / g.cell) * g.w + Math.floor(sx / g.cell);
      if(i >= 0 && i < g.w * g.h && !shell[i] && !outside[i]){ outside[i] = 1; stack.push(i); }
    }
    while(stack.length){
      for(const j of around(g, stack.pop())){
        if(!outside[j] && !shell[j]){ outside[j] = 1; stack.push(j); }
      }
    }
    let free = 0, out = 0;
    for(let i = 0; i < g.w * g.h; i++) if(!shell[i]){ free++; if(outside[i]) out++; }
    if(out > free * 0.9) outside.fill(0); // gevel lekt ergens: dan maar zonder buitengrens
    return outside;
  }

  // Deuren: in de tekening ligt er vaak nog een dorpel of deurblad dwars over de opening, en de boog zelf is ook een lijn.
  // Daarom maken we het hele draaivlak van de deur (de kwartcirkel) vrij. doors: [cx, cy, ax, ay, bx, by] per deur
  // (scharnier + uiteinden van de deurboog, uit kaarten/index.json).
  function openDoors(g, blocked, doors, shut, closedLabels){
    const sealR = SEAL_M / CELL_M * g.cell;
    for(const [cx, cy, ax, ay, bx, by] of doors){
      const seal = closedLabels.some(p => Math.hypot(p.x - cx, p.y - cy) <= sealR);
      const ua = [ax - cx, ay - cy], ub = [bx - cx, by - cy], r = Math.hypot(ua[0], ua[1]), R = r + g.cell;
      const turn = ua[0] * ub[1] - ua[1] * ub[0], m = g.cell * r * 0.5;
      for(let y = cy - R; y <= cy + R; y += g.cell / 2) for(let x = cx - R; x <= cx + R; x += g.cell / 2){
        const v = [x - cx, y - cy];
        if(Math.hypot(v[0], v[1]) > R) continue;
        // binnen de kwartsector tussen de twee stralen (met een halve cel marge)
        const inA = ua[0] * v[1] - ua[1] * v[0], inB = v[0] * ub[1] - v[1] * ub[0];
        if(turn > 0 ? (inA >= -m && inB >= -m) : (inA <= m && inB <= m)){
          const gx = Math.floor(x / g.cell), gy = Math.floor(y / g.cell);
          if(inGrid(g, gx, gy)){
            blocked[gy * g.w + gx] = 0;
            if(seal) shut[gy * g.w + gx] = 1;
          }
        }
      }
    }
  }

  // openings: [x, y, r] handmatige doorgangen waar de tekening geen deurboog heeft (ook door de gevel heen)
  function openOpenings(g, blocked, outside, openings){
    for(const [ox, oy, r] of openings){
      for(let y = Math.floor((oy - r) / g.cell); y <= (oy + r) / g.cell; y++) for(let x = Math.floor((ox - r) / g.cell); x <= (ox + r) / g.cell; x++){
        if(inGrid(g, x, y) && Math.hypot((x + 0.5) * g.cell - ox, (y + 0.5) * g.cell - oy) <= r){
          blocked[y * g.w + x] = 0;
          outside[y * g.w + x] = 0;
        }
      }
    }
  }

  // Labels uit de kaart-svg: closed = wc's en technische ruimtes (code met .F.): hier loop je nooit doorheen.
  // open = al het andere (gang, trap, lift, lokalen): de verdiepingen zijn deels open ruimtes, dus die blijven doorloopbaar.
  function labels(svgText){
    const out = { closed: [], open: [] };
    for(const m of svgText.matchAll(/class="mp-room (\w+)" data-code="([^"]*)" transform="translate\(([\d.]+),([\d.]+)\)"/g)){
      (m[1] === "sanitair" || (m[1] === "lokaal" && m[2].includes(".F.")) ? out.closed : out.open).push({ x: +m[3], y: +m[4] });
    }
    return out;
  }

  // afstand (in cellen, max 4) tot de dichtstbijzijnde cel waarvoor isEdge(i) geldt
  function edgeDist(g, isEdge){
    const d = new Uint8Array(g.w * g.h).fill(4);
    let front = [];
    for(let i = 0; i < g.w * g.h; i++) if(isEdge(i)){ d[i] = 0; front.push(i); }
    for(let r = 1; r < 4 && front.length; r++){
      const next = [];
      for(const i of front) for(const j of around(g, i)) if(d[j] > r){ d[j] = r; next.push(j); }
      front = next;
    }
    return d;
  }

  // walls: SVG-pad van de muren (dikke lijnen); thin: dunne lijnen (glas, kozijnen, dorpels)
  function buildGrid(walls, thin, doors, mapW, mapH, pxPerMeter, openings = [], airSeeds = [], roomLabels = { closed: [], open: [] }){
    const cell = CELL_M * pxPerMeter;
    const g = { w: Math.ceil(mapW / cell) + 1, h: Math.ceil(mapH / cell) + 1, cell };
    const outside = floodOutside(g, rasterize(g, [walls, thin]), airSeeds);
    const blocked = rasterize(g, [walls]);
    const shut = new Uint8Array(g.w * g.h);
    openDoors(g, blocked, doors, shut, roomLabels.closed);
    openOpenings(g, blocked, outside, openings);

    // Reepjes tussen de gevel (dunne lijn) en een muur zijn geen loopruimte maar buitenlucht: de lijn liep daar langs de
    // buitenkant van het gebouw. Cellen vlak bij een muur (dist < 2) én vlak bij buiten (binnen 3 cellen) tellen daarom als buiten.
    const wallDist = edgeDist(g, i => blocked[i]), outsideDist = edgeDist(g, i => outside[i]);
    for(let i = 0; i < g.w * g.h; i++) if(!blocked[i] && !outside[i] && wallDist[i] < 2 && outsideDist[i] < 4) outside[i] = 1;

    // De rand van het gebouw (gevel, de lucht in het midden) telt voor de afstand ook als muur. Anders hield de lijn wel
    // afstand tot muren maar schuurde hij langs de gevel, en liep hij in smalle gangen over de rand van de lucht.
    return { ...g, blocked, dist: edgeDist(g, i => blocked[i] || outside[i]), outside, shut };
  }

  /* ---------------- route zoeken ---------------- */

  // dichtstbijzijnde cel binnen het gebouw die niet in een muurholte zit (minstens 2 cellen van een muur)
  function snap(g, p){
    const cx = Math.floor(p.x / g.cell), cy = Math.floor(p.y / g.cell), start = cy * g.w + cx;
    // Staat het punt in een open cel (bv. in een lokaal), zoek dan eerst binnen dezelfde ruimte (vloeien rond muren,
    // niet erdoor). Anders sprong het punt naar de gang aan de andere kant van de muur en liep de route verkeerd.
    if(inGrid(g, cx, cy) && !g.blocked[start] && !g.outside[start]){
      const seen = new Set([start]);
      let ring = [start];
      for(let step = 0; step <= 40 && ring.length; step++){
        const ok = ring.filter(i => g.dist[i] >= 2);
        if(ok.length) return closestTo(g, ok, cx, cy);
        const next = [];
        for(const i of ring) for(const j of around(g, i)){
          if(!seen.has(j) && !g.blocked[j] && !g.outside[j]){ seen.add(j); next.push(j); }
        }
        ring = next;
      }
    }
    // anders: de dichtstbijzijnde geschikte cel, ring na ring naar buiten (tot 6 m)
    for(let r = 0; r <= 24; r++){
      const ok = [];
      for(let dy = -r; dy <= r; dy++) for(let dx = -r; dx <= r; dx++){
        if(Math.max(Math.abs(dx), Math.abs(dy)) !== r || !inGrid(g, cx + dx, cy + dy)) continue;
        const i = (cy + dy) * g.w + cx + dx;
        if(g.dist[i] >= 2 && !g.outside[i]) ok.push(i);
      }
      if(ok.length) return closestTo(g, ok, cx, cy);
    }
    return -1;
  }
  // de cel uit de lijst die het dichtst bij (cx, cy) ligt (bij gelijkspel de eerste)
  function closestTo(g, cells, cx, cy){
    let best = cells[0], bd = Infinity;
    for(const i of cells){
      const d = (col(g, i) - cx) ** 2 + (row(g, i) - cy) ** 2;
      if(d < bd){ bd = d; best = i; }
    }
    return best;
  }

  // binaire min-heap van [prioriteit, celnummer]
  function minHeap(){
    const heap = [];
    const swap = (a, b) => { [heap[a], heap[b]] = [heap[b], heap[a]]; };
    return {
      get size(){ return heap.length; },
      push(f, i){
        heap.push([f, i]);
        for(let k = heap.length - 1, p; k && heap[p = (k - 1) >> 1][0] > heap[k][0]; k = p) swap(p, k);
      },
      pop(){
        const top = heap[0], end = heap.pop();
        if(heap.length){
          heap[0] = end;
          for(let k = 0;;){
            const l = 2 * k + 1, r = l + 1;
            let m = k;
            if(l < heap.length && heap[l][0] < heap[m][0]) m = l;
            if(r < heap.length && heap[r][0] < heap[m][0]) m = r;
            if(m === k) break;
            swap(m, k); k = m;
          }
        }
        return top;
      },
    };
  }

  const STEPS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];

  // A* van cel s naar cel t; geeft de cellen van de route (met .partial als t niet bereikbaar was)
  function astar(g, s, t, barred){
    const { w, blocked, dist, outside } = g, N = w * g.h;
    const cost = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const tx = col(g, t), ty = row(g, t);
    const estimate = i => { const dx = Math.abs(col(g, i) - tx), dy = Math.abs(row(g, i) - ty); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    const open = minHeap();
    cost[s] = 0; open.push(estimate(s), s);
    while(open.size){
      const [, i] = open.pop();
      if(i === t) break;
      if(closed[i]) continue;
      closed[i] = 1;
      const x = col(g, i), y = row(g, i);
      for(const [dx, dy, c] of STEPS){
        const nx = x + dx, ny = y + dy, j = ny * w + nx;
        if(!inGrid(g, nx, ny) || closed[j] || outside[j] || barred(j)) continue;
        // nooit door een muur, ook niet diagonaal tussen twee muurcellen door (zo'n schuine muur is als
        // trapje van cellen getekend); langs één muurhoek mag wel, anders sluiten smalle doorgangen
        if(blocked[j] || (dx && dy && blocked[y * w + nx] && blocked[ny * w + x])) continue;
        const ng = cost[i] + c * (1 + WALL_COST[Math.min(dist[j], 3)]);
        if(ng < cost[j]){ cost[j] = ng; from[j] = i; open.push(ng + estimate(j), j); }
      }
    }
    // Doel niet bereikbaar (de tekening mist een opening): ga naar de bereikbare plek die er het dichtst bij ligt.
    let end = t, partial = false;
    if(from[t] < 0 && s !== t){
      partial = true;
      let bd = Infinity;
      for(let i = 0; i < N; i++) if(closed[i]){
        const d = (col(g, i) - tx) ** 2 + (row(g, i) - ty) ** 2;
        if(d < bd){ bd = d; end = i; }
      }
    }
    const cells = [end];
    while(cells[cells.length - 1] !== s) cells.push(from[cells[cells.length - 1]]);
    cells.reverse();
    cells.partial = partial;
    return cells;
  }

  // rechte lijn tussen twee cellen waarop bad(i) nergens waar is
  function lineFree(g, a, b, bad){
    const ax = col(g, a), ay = row(g, a), bx = col(g, b), by = row(g, b);
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
    for(let k = 1; k < n; k++) if(bad(Math.round(ay + (by - ay) * k / n) * g.w + Math.round(ax + (bx - ax) * k / n))) return false;
    return true;
  }
  // vrij zicht zonder langs muren te schuren (afstand >= 2) of buiten te komen
  const clear = (g, a, b, barred) => lineFree(g, a, b, i => g.dist[i] < 2 || g.outside[i] || barred(i));
  // alleen muren tellen, niet de afstand
  const clearLine = (g, a, b) => lineFree(g, a, b, i => g.blocked[i]);

  // Route van punt naar punt (kaart-eenheden): { points, length, partial }, of null als je nergens heen kunt.
  // partial = de bestemming is volgens de tekening niet bereikbaar; de route stopt dan zo dichtbij als het kan.
  function find(g, from, to){
    const s = snap(g, from), t = snap(g, to);
    if(s < 0 || t < 0) return null;
    // een wc/technische ruimte is alleen toegankelijk vlak bij het begin of eind van de route
    const near = c => { const cx = col(g, c), cy = row(g, c), r = ENDPOINT_M / CELL_M; return i => (col(g, i) - cx) ** 2 + (row(g, i) - cy) ** 2 <= r * r; };
    const nearS = near(s), nearT = near(t);
    const barred = i => g.shut[i] === 1 && !nearS(i) && !nearT(i);
    const cells = astar(g, s, t, barred);
    // onnodige tussenpunten weglaten: houd een cel alleen als je vanaf de vorige bewaarde cel niet rechtdoor kunt
    const keep = [cells[0]];
    for(let k = 1; k < cells.length; k++){
      if(k === cells.length - 1 || !clear(g, keep[keep.length - 1], cells[k + 1], barred)) keep.push(cells[k]);
    }
    const cellAt = p => Math.floor(p.y / g.cell) * g.w + Math.floor(p.x / g.cell);
    // het exacte begin-/eindpunt alleen aanplakken als daar geen muur tussen zit en het niet buiten (in de lucht) ligt
    const sees = (p, i) => { const c = cellAt(p); return c === i || (!g.blocked[c] && !g.outside[c] && clearLine(g, c, i)); };
    const points = keep.map(i => cellCenter(g, i));
    if(sees(from, cells[0])) points.unshift(from);
    if(!cells.partial && sees(to, cells[cells.length - 1])) points.push(to);
    let length = 0;
    for(let k = 1; k < points.length; k++) length += Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y);
    return { points, length, partial: !!cells.partial };
  }

  // dichtstbijzijnde loopbare plek (binnen, niet in een muur); null als er binnen ±6 m niets is
  function nearest(g, p){
    const i = snap(g, p);
    return i < 0 ? null : cellCenter(g, i);
  }

  return { buildGrid, find, nearest, labels };
})();
if(typeof module !== "undefined") module.exports = Route;
