/* Routeplanner: kortste looproute over de plattegrond.
   De muren worden een raster van 25 cm-cellen (deuropeningen vrijgemaakt, buiten het gebouw verboden),
   daarop zoekt A* de route. Cellen vlak naast een muur kosten meer, zodat de lijn netjes midden
   door de gang loopt. Werkt in de browser en in Node (voor tests). */
const Route = (() => {
  const CELL_M = 0.25;
  const WALL_COST = [0, 4, 1.5, 0.5]; // extra kosten op 1, 2, 3 cellen van een muur

  // walls: SVG-pad van de muren (dikke lijnen); thin: dunne lijnen (glas, kozijnen, dorpels);
  // doors: [cx, cy, ax, ay, bx, by] per deur (scharnier + uiteinden van de deurboog, uit kaarten/index.json);
  // openings: [x, y, r] handmatige doorgangen waar de tekening geen deurboog heeft
  function buildGrid(walls, thin, doors, mapW, mapH, pxPerMeter, openings = []){
    const cell = CELL_M * pxPerMeter;
    const w = Math.ceil(mapW / cell) + 1, h = Math.ceil(mapH / cell) + 1;
    const raster = (...paths) => {
      const r = new Uint8Array(w * h);
      const set = (x, y) => {
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
        if(cx >= 0 && cy >= 0 && cx < w && cy < h) r[cy * w + cx] = 1;
      };
      const line = (a, b) => {
        const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (cell * 0.5)) || 1;
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
    };

    // Buiten = alles wat je vanaf de rand bereikt zonder een lijn te kruisen. Hier tellen de dunne lijnen
    // (ramen) wél mee, anders lekt het via de ramen naar binnen. Buiten mag de route nooit komen.
    const shell = raster(walls, thin);
    const outside = new Uint8Array(w * h), stack = [0];
    outside[0] = 1;
    while(stack.length){
      const i = stack.pop(), x = i % w;
      for(const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]){
        if(j >= 0 && j < w * h && !outside[j] && !shell[j]){ outside[j] = 1; stack.push(j); }
      }
    }
    let free = 0, out = 0;
    for(let i = 0; i < w * h; i++) if(!shell[i]){ free++; if(outside[i]) out++; }
    if(out > free * 0.9) outside.fill(0); // gevel lekt ergens: dan maar zonder buitengrens

    // Deuren: in de tekening ligt er vaak nog een dorpel of deurblad dwars over de opening, en de boog
    // zelf is ook een lijn. Daarom maken we het hele draaivlak van de deur (de kwartcirkel) vrij.
    const blocked = raster(walls);
    for(const [cx, cy, ax, ay, bx, by] of doors){
      const ua = [ax - cx, ay - cy], ub = [bx - cx, by - cy], r = Math.hypot(ua[0], ua[1]), R = r + cell;
      const turn = ua[0] * ub[1] - ua[1] * ub[0], m = cell * r * 0.5;
      for(let y = cy - R; y <= cy + R; y += cell / 2) for(let x = cx - R; x <= cx + R; x += cell / 2){
        const v = [x - cx, y - cy];
        if(Math.hypot(v[0], v[1]) > R) continue;
        // binnen de kwartsector tussen de twee stralen (met een halve cel marge)
        const inA = ua[0] * v[1] - ua[1] * v[0], inB = v[0] * ub[1] - v[1] * ub[0];
        if(turn > 0 ? (inA >= -m && inB >= -m) : (inA <= m && inB <= m)){
          const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
          if(gx >= 0 && gy >= 0 && gx < w && gy < h) blocked[gy * w + gx] = 0;
        }
      }
    }

    for(const [ox, oy, r] of openings){
      for(let y = Math.floor((oy - r) / cell); y <= (oy + r) / cell; y++) for(let x = Math.floor((ox - r) / cell); x <= (ox + r) / cell; x++){
        if(x >= 0 && y >= 0 && x < w && y < h && Math.hypot((x + 0.5) * cell - ox, (y + 0.5) * cell - oy) <= r){
          blocked[y * w + x] = 0;
          outside[y * w + x] = 0;
        }
      }
    }

    // afstand tot de dichtstbijzijnde muur (in cellen, max 4)
    const dist = new Uint8Array(w * h).fill(4);
    let front = [];
    for(let i = 0; i < w * h; i++) if(blocked[i]){ dist[i] = 0; front.push(i); }
    for(let r = 1; r < 4 && front.length; r++){
      const next = [];
      for(const i of front) for(const j of [i - 1, i + 1, i - w, i + w]){
        if(j >= 0 && j < w * h && dist[j] > r){ dist[j] = r; next.push(j); }
      }
      front = next;
    }
    return { w, h, cell, blocked, dist, outside };
  }

  // dichtstbijzijnde cel binnen het gebouw die niet in een muurholte zit (minstens 2 cellen van een muur)
  function snap(g, p){
    const cx = Math.floor(p.x / g.cell), cy = Math.floor(p.y / g.cell);
    for(let r = 0; r <= 24; r++){
      let best = -1, bd = Infinity;
      for(let dy = -r; dy <= r; dy++) for(let dx = -r; dx <= r; dx++){
        if(Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if(x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
        const i = y * g.w + x;
        if(g.dist[i] >= 2 && !g.outside[i] && dx * dx + dy * dy < bd){ bd = dx * dx + dy * dy; best = i; }
      }
      if(best >= 0) return best;
    }
    return -1;
  }

  function astar(g, s, t){
    const { w, blocked, dist, outside } = g, N = w * g.h;
    const gs = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const tx = t % w, ty = (t - tx) / w;
    const hfn = i => { const x = i % w, y = (i - x) / w, dx = Math.abs(x - tx), dy = Math.abs(y - ty); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    // binaire heap met [f, index]
    const heap = [];
    const push = (f, i) => { heap.push([f, i]); let k = heap.length - 1; while(k){ const p = (k - 1) >> 1; if(heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = () => { const top = heap[0], end = heap.pop(); if(heap.length){ heap[0] = end; let k = 0; for(;;){ const l = 2 * k + 1, r = l + 1; let m = k; if(l < heap.length && heap[l][0] < heap[m][0]) m = l; if(r < heap.length && heap[r][0] < heap[m][0]) m = r; if(m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
    const STEPS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
    gs[s] = 0; push(hfn(s), s);
    while(heap.length){
      const [, i] = pop();
      if(i === t) break;
      if(closed[i]) continue;
      closed[i] = 1;
      const x = i % w, y = (i - x) / w;
      for(const [dx, dy, c] of STEPS){
        const nx = x + dx, ny = y + dy, j = ny * w + nx;
        if(nx < 0 || ny < 0 || nx >= w || ny >= g.h || closed[j] || outside[j]) continue;
        // nooit door een muur, ook niet diagonaal tussen twee muurcellen door (zo'n schuine muur is als
        // trapje van cellen getekend); langs één muurhoek mag wel, anders sluiten smalle doorgangen
        if(blocked[j] || (dx && dy && blocked[y * w + nx] && blocked[ny * w + x])) continue;
        const ng = gs[i] + c * (1 + WALL_COST[Math.min(dist[j], 3)]);
        if(ng < gs[j]){ gs[j] = ng; from[j] = i; push(ng + hfn(j), j); }
      }
    }
    // Doel niet bereikbaar (de tekening mist een opening): ga naar de bereikbare plek die er het dichtst bij ligt.
    let end = t, partial = false;
    if(from[t] < 0 && s !== t){
      partial = true;
      let bd = Infinity;
      for(let i = 0; i < N; i++) if(closed[i]){
        const x = i % w, y = (i - x) / w, d = (x - tx) ** 2 + (y - ty) ** 2;
        if(d < bd){ bd = d; end = i; }
      }
    }
    const cells = [end];
    while(cells[cells.length - 1] !== s) cells.push(from[cells[cells.length - 1]]);
    cells.reverse();
    cells.partial = partial;
    return cells;
  }

  // vrij zicht tussen twee cellen, zonder langs muren te schuren (afstand >= 2)
  function clear(g, a, b){
    const ax = a % g.w, ay = (a - ax) / g.w, bx = b % g.w, by = (b - bx) / g.w;
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
    for(let k = 1; k < n; k++){
      const i = Math.round(ay + (by - ay) * k / n) * g.w + Math.round(ax + (bx - ax) * k / n);
      if(g.dist[i] < 2 || g.outside[i]) return false;
    }
    return true;
  }

  // Route van punt naar punt (kaart-eenheden): { points, length, partial }, of null als je nergens heen kunt.
  // partial = de bestemming is volgens de tekening niet bereikbaar; de route stopt dan zo dichtbij als het kan.
  function find(g, from, to){
    const s = snap(g, from), t = snap(g, to);
    if(s < 0 || t < 0) return null;
    const cells = astar(g, s, t);
    if(!cells) return null;
    const keep = [cells[0]];
    for(let k = 1; k < cells.length; k++){
      if(k === cells.length - 1 || !clear(g, keep[keep.length - 1], cells[k + 1])) keep.push(cells[k]);
    }
    const pt = i => { const x = i % g.w; return { x: (x + 0.5) * g.cell, y: ((i - x) / g.w + 0.5) * g.cell }; };
    const cellAt = p => Math.floor(p.y / g.cell) * g.w + Math.floor(p.x / g.cell);
    // het exacte begin-/eindpunt alleen aanplakken als daar geen muur tussen zit
    const sees = (p, i) => { const c = cellAt(p); return c === i || (!g.blocked[c] && clearLine(g, c, i)); };
    const points = keep.map(pt);
    if(sees(from, cells[0])) points.unshift(from);
    if(!cells.partial && sees(to, cells[cells.length - 1])) points.push(to);
    let length = 0;
    for(let k = 1; k < points.length; k++) length += Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y);
    return { points, length, partial: !!cells.partial };
  }

  // rechte lijn zonder muurcellen (strenger dan clear(): alleen muren, niet de afstand)
  function clearLine(g, a, b){
    const ax = a % g.w, ay = (a - ax) / g.w, bx = b % g.w, by = (b - bx) / g.w;
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
    for(let k = 1; k < n; k++) if(g.blocked[Math.round(ay + (by - ay) * k / n) * g.w + Math.round(ax + (bx - ax) * k / n)]) return false;
    return true;
  }

  // dichtstbijzijnde loopbare plek (binnen, niet in een muur); null als er binnen ±6 m niets is
  function nearest(g, p){
    const i = snap(g, p);
    if(i < 0) return null;
    const x = i % g.w;
    return { x: (x + 0.5) * g.cell, y: ((i - x) / g.w + 0.5) * g.cell };
  }

  return { buildGrid, find, nearest };
})();
if(typeof module !== "undefined") module.exports = Route;
