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
  return stitchPairs(segs.map((sg) => [segA[sg], segB[sg]]), (id) => [px[id], py[id]]);
}

/** Stitch [a, b] point-id pairs into polylines; `xy(id)` gives a point's coordinates. */
export function stitchPairs(pairs, xy) {
  const inc = new Map();             // point id -> pair indices
  pairs.forEach(([a, b], k) => {
    for (const p of [a, b]) {
      let arr = inc.get(p);
      if (!arr) { arr = []; inc.set(p, arr); }
      arr.push(k);
    }
  });
  const used = new Uint8Array(pairs.length);
  const paths = [];

  const walk = (startPt) => {
    const path = [startPt];
    let cur = startPt;
    for (;;) {
      const cands = inc.get(cur);
      let next = -1;
      if (cands) {
        for (const k of cands) {
          if (used[k]) continue;
          used[k] = 1;
          next = pairs[k][0] === cur ? pairs[k][1] : pairs[k][0];
          break;
        }
      }
      if (next < 0) break;
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
    for (;;) {
      const cands = inc.get(p);
      if (!cands || cands.every((k) => used[k])) break;
      const path = walk(p);
      if (path.length > 1) paths.push(path);
      else break;
    }
  }
  return paths.map((ids) => ids.map(xy));
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
  return pathsToPolygon(stitch(topo, boundarySegments(topo, indices)));
}

/** Closed boundary paths to a (Multi)Polygon, holes attached by containment. */
export function pathsToPolygon(paths) {
  let rings = paths.filter((r) => r.length >= 4);
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

// ---- mixed-resolution dissolve: VTDs plus the blocks of split VTDs ----------
//
// Inside a split VTD the precinct border runs along block segments that
// separate blocks in different precincts. On the split VTD's own perimeter the
// VTD segments are kept, and each takes the precinct of the block it touches,
// found by testing a point just inside the segment's midpoint against the
// VTD's blocks. Block geometry is unsimplified and the VTD layer is
// simplified, so their perimeters never share coordinates: segments are never
// cancelled across the two. Where a block border reaches the perimeter, its
// end is joined to the perimeter vertex where the segment precinct changes,
// so every outline closes with no gaps and no spurs.

const M_PER_DEG_LAT = 110574;
const metres = (ax, ay, bx, by) => {
  const c = Math.cos(((ay + by) / 2) * Math.PI / 180);
  return Math.hypot((bx - ax) * 111320 * c, (by - ay) * M_PER_DEG_LAT);
};
const polyRings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

/** Even-odd point in polygon over every ring of a Polygon or MultiPolygon. */
function inGeometry(pt, geom) {
  let inside = false;
  for (const poly of polyRings(geom)) for (const ring of poly) if (pointInRing(pt, ring)) inside = !inside;
  return inside;
}

function bboxOfGeom(geom) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polyRings(geom)) for (const ring of poly) for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/**
 * Static geometry of one split VTD, independent of how its blocks are
 * assigned: which block each VTD perimeter segment touches, and the block
 * segments shared by two of its blocks.
 */
export function splitGeometry(topo, idx, vtdGeom, blockFeatures) {
  const { px, py, segA, segB } = topo;
  const blocks = blockFeatures.map((f) => ({ g: f.properties.GEOID20, geom: f.geometry, bb: bboxOfGeom(f.geometry) }));
  const blockAt = (pt) => {
    for (const b of blocks) {
      if (pt[0] < b.bb[0] || pt[0] > b.bb[2] || pt[1] < b.bb[1] || pt[1] > b.bb[3]) continue;
      if (inGeometry(pt, b.geom)) return b.g;
    }
    return null;
  };

  const perimBlock = new Map();      // VTD segment id -> GEOID20
  let unresolved = 0;
  for (const sg of topo.vtdSegs[idx]) {
    const ax = px[segA[sg]], ay = py[segA[sg]], bx = px[segB[sg]], by = py[segB[sg]];
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const c = Math.cos(my * Math.PI / 180);
    // Unit normal in metres, then back to degrees.
    let nx = -(by - ay) * M_PER_DEG_LAT, ny = (bx - ax) * 111320 * c;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    const at = (d) => [mx + (nx * d) / (111320 * c), my + (ny * d) / M_PER_DEG_LAT];
    // Which side is inside: the simplified VTD outline decides.
    const sign = inGeometry(at(0.5), vtdGeom) ? 1 : -1;
    let g = null;
    for (const d of [1, 3, 8, 20, 50, 120]) {
      g = blockAt(at(sign * d));
      if (g) break;
    }
    if (!g) {
      // Nothing found inside: the nearest block centre will do.
      unresolved++;
      let best = Infinity;
      for (const b of blocks) {
        const dd = metres(mx, my, (b.bb[0] + b.bb[2]) / 2, (b.bb[1] + b.bb[3]) / 2);
        if (dd < best) { best = dd; g = b.g; }
      }
    }
    perimBlock.set(sg, g);
  }

  // Block segments shared by two of this VTD's blocks.
  const owner = new Map();           // "ax,ay|bx,by" -> [g, ...]
  const ends = new Map();
  for (const b of blocks) {
    for (const poly of polyRings(b.geom)) for (const ring of poly) {
      for (let j = 1; j < ring.length; j++) {
        const p = ring[j - 1], q = ring[j];
        if (p[0] === q[0] && p[1] === q[1]) continue;
        const kp = p[0] + ',' + p[1], kq = q[0] + ',' + q[1];
        const key = kp < kq ? kp + '|' + kq : kq + '|' + kp;
        let o = owner.get(key);
        if (!o) { o = []; owner.set(key, o); ends.set(key, kp < kq ? [p, q] : [q, p]); }
        o.push(b.g);
      }
    }
  }
  const inner = [];
  for (const [key, o] of owner) {
    if (o.length === 2 && o[0] !== o[1]) {
      const [p, q] = ends.get(key);
      inner.push([p[0], p[1], q[0], q[1], o[0], o[1]]);
    }
  }
  return { idx, perimBlock, inner, unresolved };
}

/**
 * Precinct boundaries at mixed resolution.
 *
 * @param asn     Int8Array: each VTD's precinct (ignored for split VTDs)
 * @param splits  Map<idx, { geo: splitGeometry(...), ov: Map<GEOID20, 0..4> }>
 * @returns { paths: [[x,y][]][] indexed by precinct 1..4, odd: number }
 *          `odd` counts vertices left with an odd degree (gaps or spurs); 0 when clean.
 */
export function mixedBoundary(topo, asn, splits) {
  const { px, py, segA, segB } = topo;
  const nTopo = px.length;
  const ext = [];                    // extra (block-layer) points: [x, y]
  const extId = new Map();
  const pid = (x, y) => {
    const k = x + ',' + y;
    let id = extId.get(k);
    if (id === undefined) { id = nTopo + ext.length; ext.push([x, y]); extId.set(k, id); }
    return id;
  };
  const xy = (id) => (id < nTopo ? [px[id], py[id]] : ext[id - nTopo]);
  const out = [null, [], [], [], []];
  let oddTotal = 0;
  const stats = [];

  for (let d = 1; d <= 4; d++) {
    const parity = new Map();        // VTD segment id -> 1
    const toggle = (sg) => { if (parity.has(sg)) parity.delete(sg); else parity.set(sg, 1); };
    for (let i = 0; i < asn.length; i++) {
      if (splits.has(i) || asn[i] !== d) continue;
      const segs = topo.vtdSegs[i];
      if (segs) for (let k = 0; k < segs.length; k++) toggle(segs[k]);
    }
    const extra = [];                // [idA, idB] pairs inside split VTDs

    for (const [sidx, { geo, ov }] of splits) {
      // Perimeter segments that take precinct d.
      const local = [];
      for (const [sg, g] of geo.perimBlock) {
        if ((ov.get(g) ?? 0) === d) { toggle(sg); local.push(sg); }
      }
      // Block borders inside the VTD with d on exactly one side.
      const inner = [];
      for (const [ax, ay, bx, by, g1, g2] of geo.inner) {
        const d1 = ov.get(g1) ?? 0, d2 = ov.get(g2) ?? 0;
        if ((d1 === d) !== (d2 === d)) inner.push([pid(ax, ay), pid(bx, by)]);
      }
      if (!local.length && !inner.length) continue;

      // Odd-degree ends of each set, then join them up.
      const oddOf = (pairs) => {
        const deg = new Map();
        for (const [a, b] of pairs) { deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1); }
        return [...deg].filter(([, n]) => n % 2).map(([p]) => p);
      };
      const V = oddOf(local.map((sg) => [segA[sg], segB[sg]]));
      const P = oddOf(inner);
      const dist = (a, b) => { const p = xy(a), q = xy(b); return metres(p[0], p[1], q[0], q[1]); };
      const pairUp = (A, B, maxM) => {
        const cand = [];
        for (const a of A) for (const b of B) if (a !== b) cand.push([dist(a, b), a, b]);
        cand.sort((x, y) => x[0] - y[0]);
        const usedA = new Set(), usedB = new Set(), joins = [];
        for (const [dd, a, b] of cand) {
          if (dd > maxM) break;
          if (usedA.has(a) || usedB.has(b) || usedA.has(b) || usedB.has(a)) continue;
          usedA.add(a); usedB.add(b); joins.push([a, b]);
        }
        return { joins, restA: A.filter((a) => !usedA.has(a) && !usedB.has(a)), restB: B.filter((b) => !usedB.has(b) && !usedA.has(b)) };
      };
      // A block border meets the perimeter where the perimeter precinct changes.
      const first = pairUp(P, V, 150);
      extra.push(...inner, ...first.joins);
      // Anything left over is paired up nearest first, whatever its kind (a
      // block that touches the perimeter too briefly to own a VTD segment, for
      // example). Each set has an even number of odd ends, so the leftovers
      // together do too and every end is joined.
      const before = extra.length - inner.length - first.joins.length;
      const rest = first.restA.concat(first.restB);
      extra.push(...pairUp(rest, rest, Infinity).joins);
      const localPairs = local.map((sg) => [segA[sg], segB[sg]]).concat(extra.slice(before));
      stats.push({ idx: sidx, d, P: P.length, V: V.length, matched: first.joins.length, localOdd: oddOf(localPairs).length });
    }

    const pairs = [...parity.keys()].map((sg) => [segA[sg], segB[sg]]).concat(extra);
    // Count odd vertices: gaps or spurs would show here.
    const deg = new Map();
    for (const [a, b] of pairs) { deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1); }
    for (const n of deg.values()) if (n % 2) oddTotal++;
    out[d] = pairs.length ? stitchPairs(pairs, xy) : [];
  }
  return { paths: out, odd: oddTotal, stats };
}
