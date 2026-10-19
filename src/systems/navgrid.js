/* =========================================================================
 * NAV GRID v2 — uniform grid + A* for GROUND and ROOF layers.
 *
 * - 0.8 m occupancy grid, colliders inflated by the agent radius.
 * - Layers: ground + one layer per roof height (union of level.roofZones
 *   rects with the same y). Ramps connect ground cells to roof cells through
 *   explicit portals detected by "walkable ground height ≈ roof height".
 * - Costs: cells next to a blocker are cheaper (cover), cells marked by
 *   recent player fire are more expensive (suppression), so routes bend
 *   away from the lane you are holding.
 * - Dynamic rebake: refreshRegion() re-rasterizes a small rectangle after a
 *   destructible cover is destroyed. Portals/roof layers are static.
 *
 * Deliberate limits: no clearance, no queueing, no jumping gaps; enemies
 * still resolve 2D collisions after path steering.
 * ========================================================================= */

const SQRT2 = Math.SQRT2;

export function createNavGrid(level, opts = {}) {
  const cell = opts.cell || 0.8;
  const radius = opts.radius || 0.32;
  const groundAt = opts.groundAt || ((x, z, y) => 0);
  const b = level.bounds;
  const pad = 1.5;
  const x0 = b.x0 + pad, x1 = b.x1 - pad;
  const z0 = b.z0 + pad, z1 = b.z1 - pad;
  const cols = Math.max(2, Math.ceil((x1 - x0) / cell) + 1);
  const rows = Math.max(2, Math.ceil((z1 - z0) / cell) + 1);
  const n = cols * rows;

  const cellOf = (x, z) => ({
    c: Math.max(0, Math.min(cols - 1, Math.round((x - x0) / cell))),
    r: Math.max(0, Math.min(rows - 1, Math.round((z - z0) / cell))),
  });
  const worldOf = (c, r) => ({ x: x0 + c * cell, z: z0 + r * cell });
  const idx = (c, r) => r * cols + c;

  /* --------------------------------------------------------------- layers */
  function makeLayer(id, height) {
    return {
      id, height,
      blocked: new Uint8Array(n),
      cost: new Float32Array(n).fill(1),
      cover: new Uint8Array(n),
      threat: height === 0 ? new Float32Array(n) : null,
    };
  }
  const layers = [makeLayer('ground', 0)];

  // group roof zones by height (market deck + catwalk + landing all sit at 3.2)
  const groupMap = new Map();
  for (const z of (level.roofZones || [])) {
    const h = Number.isFinite(z.y) ? z.y : 3.2;
    const key = Math.round(h * 20) / 20;
    if (!groupMap.has(key)) groupMap.set(key, { h, rects: [] });
    groupMap.get(key).rects.push(z);
  }
  for (const [, g] of groupMap) layers.push(makeLayer(`roof@${g.h.toFixed(2)}`, g.h));

  // rasterize the ground layer
  // cells hold lattice points: mark a cell only when its CENTER is inside the
  // inflated collider (floor/ceil here would over-mark by one cell per side)
  for (const c of level.colliders) {
    const ca = Math.max(0, Math.ceil((c.x0 - radius - x0) / cell));
    const cb = Math.min(cols - 1, Math.floor((c.x1 + radius - x0) / cell));
    const ra = Math.max(0, Math.ceil((c.z0 - radius - z0) / cell));
    const rb = Math.min(rows - 1, Math.floor((c.z1 + radius - z0) / cell));
    for (let r = ra; r <= rb; r++) {
      const row = r * cols;
      for (let k = ca; k <= cb; k++) layers[0].blocked[row + k] = 1;
    }
  }
  // hard walls at the grid border
  for (let c = 0; c < cols; c++) { layers[0].blocked[c] = 1; layers[0].blocked[(rows - 1) * cols + c] = 1; }
  for (let r = 0; r < rows; r++) { layers[0].blocked[r * cols] = 1; layers[0].blocked[r * cols + cols - 1] = 1; }
  markCover(0, cols - 1, 0, rows - 1);

  // roof layers: free only inside their rect union, plus a little skirt so
  // ramp-top cells can actually touch the deck
  for (let li = 1; li < layers.length; li++) {
    const L = layers[li];
    const rects = groupMap.get(Math.round(L.height * 20) / 20).rects;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const w = worldOf(c, r);
        let inside = false;
        for (const rect of rects) {
          if (w.x >= rect.x0 - 0.45 && w.x <= rect.x1 + 0.45 && w.z >= rect.z0 - 0.45 && w.z <= rect.z1 + 0.45) { inside = true; break; }
        }
        L.blocked[idx(c, r)] = inside ? 0 : 1;
      }
    }
  }

  /* -------------------------------------------------------------- portals */
  // `${layer}:${cellId}` -> [{ l, id }] step edges between layers
  const portals = new Map();
  const pkey = (l, id) => `${l}:${id}`;
  function addPortal(aL, aId, bL, bId) {
    const ka = pkey(aL, aId);
    if (!portals.has(ka)) portals.set(ka, []);
    portals.get(ka).push({ l: bL, id: bId });
    const kb = pkey(bL, bId);
    if (!portals.has(kb)) portals.set(kb, []);
    portals.get(kb).push({ l: aL, id: aId });
  }
  const rectsByLayer = new Map();
  for (const [key, g] of groupMap) rectsByLayer.set(layers.findIndex((l) => l.id === `roof@${g.h.toFixed(2)}`), g.rects);
  function insideRects(x, z, rects) {
    for (const rect of rects) {
      if (x > rect.x0 + 0.15 && x < rect.x1 - 0.15 && z > rect.z0 + 0.15 && z < rect.z1 - 0.15) return true;
    }
    return false;
  }
  for (let li = 1; li < layers.length; li++) {
    const L = layers[li];
    const rects = rectsByLayer.get(li) || [];
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        if (L.blocked[idx(c, r)]) continue;
        // only cells on the layer boundary matter for a ramp handoff
        if (!(L.blocked[idx(c - 1, r)] || L.blocked[idx(c + 1, r)] || L.blocked[idx(c, r - 1)] || L.blocked[idx(c, r + 1)])) continue;
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            const gc = c + dx, gr = r + dz;
            if (gc < 1 || gr < 1 || gc >= cols - 1 || gr >= rows - 1) continue;
            if (layers[0].blocked[idx(gc, gr)]) continue;
            const w = worldOf(gc, gr);
            // ground cells UNDER the deck return the deck height from
            // groundHeight(), which would open a fake portal through the
            // ceiling; only ramp cells just outside the deck may connect
            if (insideRects(w.x, w.z, rects)) continue;
            const h = groundAt(w.x, w.z, L.height - 0.05);
            if (h >= L.height - 0.6 && h <= L.height + 0.25) {
              addPortal(li, idx(c, r), 0, idx(gc, gr));
            }
          }
        }
      }
    }
  }

  // manual links for tight doorways the 0.8 m grid cannot express (e.g. the
  // 0.65 m deep apartment passage). Each link is a one-step handoff.
  for (const link of (opts.links || [])) {
    const a = closestFreeIn(0, link.ax, link.az);
    const b = closestFreeIn(0, link.bx, link.bz);
    if (a && b) addPortal(0, idx(a.c, a.r), 0, idx(b.c, b.r));
  }

  /* --------------------------------------------------------------- helpers */
  function markCover(ca, cb, ra, rb) {
    const L = layers[0];
    for (let r = ra; r <= rb; r++) {
      for (let c = ca; c <= cb; c++) {
        const i = idx(c, r);
        if (L.blocked[i]) { L.cover[i] = 0; L.cost[i] = 1; continue; }
        let near = 0;
        for (let dz = -1; dz <= 1 && !near; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const cc = c + dx, rr = r + dz;
            if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
            if (L.blocked[idx(cc, rr)]) { near = 1; break; }
          }
        }
        L.cover[i] = near;
        L.cost[i] = near ? 0.88 : 1;      // cover is cheaper to travel through
      }
    }
  }

  function freeIn(l, c, r) {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
    return !layers[l].blocked[idx(c, r)];
  }
  function closestFreeIn(l, x, z) {
    const { c, r } = cellOf(x, z);
    if (freeIn(l, c, r)) return { c, r };
    for (let ring = 1; ring <= 3; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          if (freeIn(l, c + dx, r + dz)) return { c: c + dx, r: r + dz };
        }
      }
    }
    return null;
  }
  function layerAt(x, z, y) {
    if (!(y > 1.0)) return 0;
    let best = 0, bestD = 1e9;
    const { c, r } = cellOf(x, z);
    for (let l = 1; l < layers.length; l++) {
      if (!freeIn(l, c, r)) continue;
      const d = Math.abs(layers[l].height - y);
      if (d < bestD && d < 1.2) { bestD = d; best = l; }
    }
    return best;
  }
  function lineWalkableLayer(ax, az, bx, bz, l = 0) {
    const d = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(d / 0.35));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const { c, r } = cellOf(ax + (bx - ax) * t, az + (bz - az) * t);
      if (!freeIn(l, c, r)) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------ A* */
  const total = layers.length * n;
  const gScore = new Float32Array(total);
  const fScore = new Float32Array(total);
  const cameFrom = new Int32Array(total);
  const closed = new Uint32Array(total);
  const openGen = new Uint32Array(total);
  let gen = 0;
  const heap = [];
  function heapPush(id) {
    heap.push(id);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (fScore[heap[p]] <= fScore[heap[i]]) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
      i = p;
    }
  }
  function heapPop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last !== undefined) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && fScore[heap[l]] < fScore[heap[m]]) m = l;
        if (r < heap.length && fScore[heap[r]] < fScore[heap[m]]) m = r;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
        i = m;
      }
    }
    return top;
  }
  const DIRS = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
  ];

  function findPath(sx, sz, a, b2, c, d, maxNodes) {
    let sy = 0, tx, tz, ty = 0;
    if (d === undefined) { tx = a; tz = b2; }
    else { sy = a; tx = b2; tz = c; ty = d; }
    const sl = layerAt(sx, sz, sy);
    const gl = layerAt(tx, tz, ty);
    const s = closestFreeIn(sl, sx, sz);
    const g = closestFreeIn(gl, tx, tz);
    if (!s || !g) return null;
    const goalCell = idx(g.c, g.r);
    const startId = sl * n + idx(s.c, s.r);
    const goalId = gl * n + goalCell;
    if (startId === goalId) {
      const w = worldOf(g.c, g.r);
      return [{ x: w.x, z: w.z, layer: gl }];
    }

    gen = (gen + 1) >>> 0 || 1;
    heap.length = 0;
    gScore[startId] = 0;
    fScore[startId] = 0;
    openGen[startId] = gen;
    closed[startId] = 0;
    cameFrom[startId] = -1;
    heapPush(startId);

    let expanded = 0;
    const limit = maxNodes || 14000;
    while (heap.length > 0 && expanded < limit) {
      const cur = heapPop();
      if (cur === goalId) return rebuild(cur);
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      expanded++;
      const l = (cur / n) | 0;
      const id = cur - l * n;
      const cc = id % cols, cr = (id / cols) | 0;
      const L = layers[l];

      // same-layer moves
      for (const [dc, dr, base] of DIRS) {
        const nc = cc + dc, nr = cr + dr;
        if (!freeIn(l, nc, nr)) continue;
        if (dc !== 0 && dr !== 0 && (!freeIn(l, cc + dc, cr) || !freeIn(l, cc, cr + dr))) continue;
        const nid = nr * cols + nc;
        const node = l * n + nid;
        if (closed[node] === gen) continue;
        const stepCost = base * (L.cost[nid] + (L.threat ? L.threat[nid] : 0));
        const tentative = gScore[cur] + stepCost;
        if (openGen[node] === gen && tentative >= gScore[node]) continue;
        openGen[node] = gen;
        gScore[node] = tentative;
        cameFrom[node] = cur;
        fScore[node] = tentative + Math.hypot(g.c - nc, g.r - nr) * cell + Math.abs(l - gl) * 2;
        heapPush(node);
      }

      // ramp handoffs
      const list = portals.get(pkey(l, id));
      if (list) {
        for (const p of list) {
          const node = p.l * n + p.id;
          if (closed[node] === gen) continue;
          const tentative = gScore[cur] + 2.2;
          if (openGen[node] === gen && tentative >= gScore[node]) continue;
          openGen[node] = gen;
          gScore[node] = tentative;
          cameFrom[node] = cur;
          const pc = p.id % cols, pr = (p.id / cols) | 0;
          fScore[node] = tentative + Math.hypot(g.c - pc, g.r - pr) * cell + Math.abs(p.l - gl) * 2;
          heapPush(node);
        }
      }
    }
    return null;

    function rebuild(endId) {
      const pts = [];
      let cur = endId;
      while (cur !== -1) {
        const l = (cur / n) | 0;
        const id = cur - l * n;
        const c = id % cols, r = (id / cols) | 0;
        const w = worldOf(c, r);
        pts.push({ x: w.x, z: w.z, layer: l });
        cur = cameFrom[cur];
      }
      pts.reverse();
      return smooth(pts);
    }
  }

  function smooth(pts) {
    if (pts.length <= 2) return pts.slice(1);
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = i + 1;
      while (j + 1 < pts.length && pts[j + 1].layer === pts[i].layer
             && lineWalkableLayer(pts[i].x, pts[i].z, pts[j + 1].x, pts[j + 1].z, pts[i].layer)) j++;
      out.push(pts[j]);
      i = j;
    }
    out.shift();
    return out;
  }

  /* -------------------------------------------------------- threat / rebake */
  let threatDirty = false;
  const threatCells = new Set();
  function markThreat(x, z, r = 2.4, amount = 1.6) {
    const L = layers[0];
    const ca = Math.max(0, Math.floor((x - r - x0) / cell));
    const cb = Math.min(cols - 1, Math.ceil((x + r - x0) / cell));
    const ra = Math.max(0, Math.floor((z - r - z0) / cell));
    const rb = Math.min(rows - 1, Math.ceil((z + r - z0) / cell));
    for (let rr = ra; rr <= rb; rr++) {
      for (let cc = ca; cc <= cb; cc++) {
        const w = worldOf(cc, rr);
        const d = Math.hypot(w.x - x, w.z - z);
        if (d > r) continue;
        const i = idx(cc, rr);
        L.threat[i] = Math.min(3.2, L.threat[i] + amount * (1 - d / r));
        threatCells.add(i);
      }
    }
    threatDirty = true;
  }

  function update(dt) {
    if (!threatDirty) return;
    const L = layers[0];
    const k = dt * 1.1;
    for (const i of threatCells) {
      L.threat[i] -= k;
      if (L.threat[i] <= 0) { L.threat[i] = 0; threatCells.delete(i); }
    }
    threatDirty = threatCells.size > 0;
  }

  /** re-rasterize a small rectangle (used when destructible cover breaks) */
  function refreshRegion(rx0, rx1, rz0, rz1) {
    const ec = 1;
    const ca = Math.max(1, Math.ceil((rx0 - radius - x0) / cell) - ec);
    const cb = Math.min(cols - 2, Math.floor((rx1 + radius - x0) / cell) + ec);
    const ra = Math.max(1, Math.ceil((rz0 - radius - z0) / cell) - ec);
    const rb = Math.min(rows - 2, Math.floor((rz1 + radius - z0) / cell) + ec);
    const L = layers[0];
    for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) L.blocked[idx(c, r)] = 0;
    for (const col of level.colliders) {
      const ac = Math.max(ca, Math.ceil((col.x0 - radius - x0) / cell));
      const bc = Math.min(cb, Math.floor((col.x1 + radius - x0) / cell));
      const ar = Math.max(ra, Math.ceil((col.z0 - radius - z0) / cell));
      const br = Math.min(rb, Math.floor((col.z1 + radius - z0) / cell));
      for (let r = ar; r <= br; r++) {
        const row = r * cols;
        for (let c = ac; c <= bc; c++) L.blocked[row + c] = 1;
      }
    }
    markCover(Math.max(0, ca - 1), Math.min(cols - 1, cb + 1), Math.max(0, ra - 1), Math.min(rows - 1, rb + 1));
  }

  let freeCells = 0;
  for (let i = 0; i < n; i++) if (!layers[0].blocked[i]) freeCells++;

  return {
    cell, radius, cols, rows, freeCells,
    layers: layers.map((l) => ({ id: l.id, height: l.height })),
    findPath,
    lineWalkable: (a, b, c, d) => lineWalkableLayer(a, b, c, d, 0),
    isWalkable: (x, z) => { const { c, r } = cellOf(x, z); return freeIn(0, c, r); },
    isWalkableOn: (x, z, l) => { const { c, r } = cellOf(x, z); return freeIn(l, c, r); },
    closestWalkable: (x, z) => { const f = closestFreeIn(0, x, z); return f ? worldOf(f.c, f.r) : null; },
    isWalkableAt: (x, z, y = 0) => { const l = layerAt(x, z, y); const { c, r } = cellOf(x, z); return freeIn(l, c, r); },
    closestWalkableOn: (x, z, y = 0) => {
      const l = layerAt(x, z, y);
      const f = closestFreeIn(l, x, z);
      return f ? { ...worldOf(f.c, f.r), layer: l, height: layers[l].height } : null;
    },
    layerAt, markThreat, update, refreshRegion,
    debugBlocked(x, z) {
      const { c, r } = cellOf(x, z);
      const id = idx(c, r);
      const half = cell / 2;
      const cx = x0 + c * cell, cz = z0 + r * cell;
      const hits = level.colliders.filter((k) => k.x1 + radius >= cx - half && k.x0 - radius <= cx + half
        && k.z1 + radius >= cz - half && k.z0 - radius <= cz + half);
      return { c, r, cellX: cx, cellZ: cz, blocked: !!layers[0].blocked[id], hits: hits.length,
        sample: hits.slice(0, 3).map((k) => [+k.x0.toFixed(1), +k.x1.toFixed(1), +k.z0.toFixed(1), +k.z1.toFixed(1)]) };
    },
    layerHeight: (l) => layers[l] ? layers[l].height : 0,
    get threatActive() { return threatDirty; },
  };
}
