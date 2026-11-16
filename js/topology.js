// Exact precinct dissolve by segment cancellation.
//
// The VTD layer is topologically clean: every interior boundary segment appears
// in exactly two VTDs with identical coordinates (19,166 shared segments; the
// 252 singletons are the county boundary). So the dissolved boundary of a set
// of VTDs is simply the set of segments that appear an odd number of times
// across its members. No polygon-clipping library needed, and the result is
// exact rather than an approximation.
//
// Geometry here is only for drawing and for GeoJSON output. Area, perimeter and
// adjacency always come from data/vtd_adj.json, never from these coordinates.

export function buildTopology(vtdGeo, idxOf) {
  const ptId = new Map();            // "x,y" -> point id
  const px = [], py = [];
  const segId = new Map();           // "a,b" (a<b) -> segment id
  const segA = [], segB = [];
  const vtdSegs = new Array(vtdGeo.features.length);

  const pointOf = (c) => {
    const k = c[0] + ',' + c[1];
    let id = ptId.get(k);
    if (id === undefined) { id = px.length; px.push(c[0]); py.push(c[1]); ptId.set(k, id); }
    return id;
  };

  for (const f of vtdGeo.features) {
    const i = idxOf.get(f.properties.vtdkey);
    if (i === undefined) continue;
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    const segs = [];
    for (const poly of polys) {
      for (const ring of poly) {
        let prev = pointOf(ring[0]);
        for (let j = 1; j < ring.length; j++) {
          const cur = pointOf(ring[j]);
          if (cur === prev) continue;
          const a = prev < cur ? prev : cur;
          const b = prev < cur ? cur : prev;
          const k = a + ',' + b;
          let s = segId.get(k);
          if (s === undefined) { s = segA.length; segA.push(a); segB.push(b); segId.set(k, s); }
          segs.push(s);
          prev = cur;
        }
      }
    }
    vtdSegs[i] = Int32Array.from(segs);
  }

  return {
    px: Float64Array.from(px), py: Float64Array.from(py),
    segA: Int32Array.from(segA), segB: Int32Array.from(segB),
    segCount: segA.length, vtdSegs,
    _mark: new Int32Array(segA.length),
    _stamp: 0,
  };
}

/** Segment ids on the dissolved boundary of the given VTD indices. */
export function boundarySegments(topo, indices) {
  const parity = new Map();
  for (const i of indices) {
    const segs = topo.vtdSegs[i];
    if (!segs) continue;
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k];
      if (parity.has(s)) parity.delete(s); else parity.set(s, 1);
    }
  }
  return Array.from(parity.keys());
}

/**
 * Stitch segments into polylines, following each chain until it closes or runs
 * out. Returns arrays of [x,y] coordinate pairs.
 */
export function stitch(topo, segs) {
  const { px, py, segA, segB } = topo;
  const inc = new Map();             // point id -> segment ids
  for (const s of segs) {
    for (const p of [segA[s], segB[s]]) {
      let a = inc.get(p);
      if (!a) { a = []; inc.set(p, a); }
      a.push(s);
    }
  }
  const used = new Set();
  const paths = [];

  const walk = (startPt) => {
    const path = [startPt];
    let cur = startPt;
    for (;;) {
      const cands = inc.get(cur);
      if (!cands) break;
      let next = -1, viaSeg = -1;
      for (const s of cands) {
        if (used.has(s)) continue;
        viaSeg = s;
        next = segA[s] === cur ? segB[s] : segA[s];
        break;
      }
      if (viaSeg < 0) break;
      used.add(viaSeg);
      path.push(next);
      cur = next;
      if (cur === startPt) break;
    }
    return path;
  };

  // Open chains first (endpoints of odd degree), then closed rings.
  const starts = [];
  for (const [p, arr] of inc) if (arr.length % 2 === 1) starts.push(p);
  for (const p of starts.concat(Array.from(inc.keys()))) {
    while (true) {
      const cands = inc.get(p);
      if (!cands || cands.every((s) => used.has(s))) break;
      const path = walk(p);
      if (path.length > 1) paths.push(path);
      else break;
    }
  }

  return paths.map((ids) => ids.map((id) => [px[id], py[id]]));
}

const signedArea = (ring) => {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2;
};

const pointInRing = (pt, ring) => {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
};

/** Dissolved outline of a set of VTDs, as a MultiLineString geometry. */
export function dissolveLines(topo, indices) {
  const paths = stitch(topo, boundarySegments(topo, indices));
  return paths.length ? { type: 'MultiLineString', coordinates: paths } : null;
}

/**
 * Dissolved outline as a (Multi)Polygon. Rings are classified by containment
 * depth: even depth is an outer ring, odd is a hole, and each hole is attached
 * to the smallest ring that contains it.
 */
export function dissolvePolygon(topo, indices) {
  let rings = stitch(topo, boundarySegments(topo, indices))
    .filter((r) => r.length >= 4);
  // Close any ring the walk left open (shouldn't happen on clean topology).
  rings = rings.map((r) => {
    const a = r[0], b = r[r.length - 1];
    return (a[0] === b[0] && a[1] === b[1]) ? r : r.concat([[a[0], a[1]]]);
  });
  if (!rings.length) return null;

  const meta = rings.map((r) => ({ r, area: Math.abs(signedArea(r)) }));
  meta.sort((a, b) => b.area - a.area);

  const depth = meta.map((m, i) => {
    let d = 0;
    for (let j = 0; j < i; j++) if (pointInRing(m.r[0], meta[j].r)) d++;
    return d;
  });

  const polys = [];
  const outerIdx = [];
  meta.forEach((m, i) => {
    if (depth[i] % 2 === 0) {
      // Outer ring: counter-clockwise, per the GeoJSON right-hand rule.
      const r = signedArea(m.r) < 0 ? m.r.slice().reverse() : m.r;
      outerIdx.push(i);
      polys.push([r]);
    }
  });
  meta.forEach((m, i) => {
    if (depth[i] % 2 === 0) return;
    // Smallest containing outer ring wins.
    let host = -1, hostArea = Infinity;
    for (let k = 0; k < outerIdx.length; k++) {
      const oi = outerIdx[k];
      if (meta[oi].area < hostArea && pointInRing(m.r[0], meta[oi].r)) { host = k; hostArea = meta[oi].area; }
    }
    if (host < 0) return;
    const r = signedArea(m.r) > 0 ? m.r.slice().reverse() : m.r;
    polys[host].push(r);
  });

  if (!polys.length) return null;
  return polys.length === 1
    ? { type: 'Polygon', coordinates: polys[0] }
    : { type: 'MultiPolygon', coordinates: polys };
}
