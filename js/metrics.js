// Analytics. A full recompute walks 782 VTDs plus the adjacency graph, which is
// well under a millisecond, so every edit recomputes everything rather than
// trying to keep incremental accumulators in step.

import { share } from './util.js';

const ACC = ['pop', 'vap', 'vap_white', 'vap_black', 'vap_hisp', 'ndv', 'nrv', 'ndv26', 'nrv26'];

/**
 * @param data          loaded data bundle
 * @param asn           Int8Array(n), 0..4
 * @param blockOv       Map<vtdIdx, Map<GEOID20, 0..4>> or null
 * @param blockProps    Map<vtdIdx, Map<GEOID20, properties>> or null
 * @param tolerance     population deviation flag threshold, e.g. 0.05
 */
export function computeMetrics(data, asn, { blockOv = null, blockProps = null, tolerance = 0.05 } = {}) {
  const n = data.n;
  const num = data.num;
  const nSplit = blockOv ? blockOv.size : 0;

  // ---- per-precinct sums (index 0 = unassigned) ---------------------------
  const sums = {};
  for (const f of ACC) sums[f] = new Float64Array(5);
  const units = new Int32Array(5);

  // ---- split-aware effective VTD assignment, for geometry ----------------
  const eff = new Int8Array(n);
  eff.set(asn);

  for (let i = 0; i < n; i++) {
    const ov = nSplit ? blockOv.get(i) : undefined;
    if (ov) {
      const props = blockProps ? blockProps.get(i) : null;
      const tally = new Float64Array(5);
      for (const [g, d] of ov) {
        const p = props ? props.get(g) : null;
        if (p) for (const f of ACC) sums[f][d] += p[f] || 0;
        tally[d] += p ? (p.pop || 0) : 1;
      }
      // Geometry still works at VTD level: the split VTD goes to its
      // majority-population precinct.
      let best = 0, bv = -1;
      for (let d = 1; d <= 4; d++) if (tally[d] > bv) { bv = tally[d]; best = d; }
      if (bv <= 0) {
        const cnt = new Int32Array(5);
        for (const d of ov.values()) cnt[d]++;
        best = 0; bv = -1;
        for (let d = 1; d <= 4; d++) if (cnt[d] > bv) { bv = cnt[d]; best = d; }
        if (bv <= 0) best = 0;
      }
      eff[i] = best;
      units[best]++;
    } else {
      const d = asn[i];
      for (const f of ACC) sums[f][d] += num[f][i];
      units[d]++;
    }
  }

  // ---- derived per-precinct rows -----------------------------------------
  const ideal = data.countyPop / 4;
  const rows = [];
  for (let d = 0; d <= 4; d++) {
    const pop = sums.pop[d], vap = sums.vap[d];
    const dev = d === 0 ? null : (pop - ideal) / ideal;
    rows.push({
      d,
      units: units[d],
      pop,
      dev,
      overTol: d === 0 ? false : Math.abs(dev) > tolerance,
      vap,
      hisp: vap > 0 ? sums.vap_hisp[d] / vap : null,
      black: vap > 0 ? sums.vap_black[d] / vap : null,
      nonwhite: vap > 0 ? 1 - sums.vap_white[d] / vap : null,
      dshare: share(sums.ndv[d], sums.nrv[d]),
      share26: share(sums.ndv26[d], sums.nrv26[d]),
      ndv: sums.ndv[d], nrv: sums.nrv[d],
      ndv26: sums.ndv26[d], nrv26: sums.nrv26[d],
    });
  }

  // ---- county totals ------------------------------------------------------
  let tPop = 0, tVap = 0, tW = 0, tB = 0, tH = 0, tD = 0, tR = 0, tD26 = 0, tR26 = 0;
  for (let d = 0; d <= 4; d++) {
    tPop += sums.pop[d]; tVap += sums.vap[d]; tW += sums.vap_white[d];
    tB += sums.vap_black[d]; tH += sums.vap_hisp[d];
    tD += sums.ndv[d]; tR += sums.nrv[d]; tD26 += sums.ndv26[d]; tR26 += sums.nrv26[d];
  }
  const total = {
    pop: tPop, vap: tVap,
    hisp: tVap > 0 ? tH / tVap : null,
    black: tVap > 0 ? tB / tVap : null,
    nonwhite: tVap > 0 ? 1 - tW / tVap : null,
    dshare: share(tD, tR),
    share26: share(tD26, tR26),
    ideal,
  };

  // ---- Democratic-leaning precinct counts --------------------------------
  let demComp = 0, dem26 = 0;
  for (let d = 1; d <= 4; d++) {
    if (rows[d].dshare != null && rows[d].dshare > 0.5) demComp++;
    if (rows[d].share26 != null && rows[d].share26 > 0.5) dem26++;
  }

  // ---- contiguity and compactness ----------------------------------------
  const geom = geometry(data, eff);

  // ---- splits -------------------------------------------------------------
  const cities = splitTally(data, asn, blockOv, blockProps, (i) => data.city[i], (x) => x);
  const comms = splitTally(data, asn, blockOv, blockProps,
    (i) => data.comm[i], (id) => data.commName.get(id) || `Community ${id}`);

  const maxDev = Math.max(...[1, 2, 3, 4].map((d) => Math.abs(rows[d].dev)));

  return {
    rows, total, demComp, dem26, geom, cities, comms,
    nSplit, ideal, maxDev,
    popRange: Math.max(...[1, 2, 3, 4].map((d) => rows[d].pop))
            - Math.min(...[1, 2, 3, 4].map((d) => rows[d].pop)),
    approxGeom: nSplit > 0,
  };
}

/** Connected components and Polsby-Popper, per precinct, from vtd_adj.json. */
export function geometry(data, eff) {
  const n = data.n;
  const { nbr, nbrStart, area, perim, edgeA, edgeB, edgeLen, edgeCount } = data;

  const internal = new Float64Array(5);
  for (let e = 0; e < edgeCount; e++) {
    const a = eff[edgeA[e]];
    if (a !== 0 && a === eff[edgeB[e]]) internal[a] += edgeLen[e];
  }

  const A = new Float64Array(5), P = new Float64Array(5);
  for (let i = 0; i < n; i++) {
    const d = eff[i];
    A[d] += area[i]; P[d] += perim[i];
  }

  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const out = [];
  for (let d = 0; d <= 4; d++) {
    const comps = [];
    for (let s = 0; s < n; s++) {
      if (seen[s] || eff[s] !== d) continue;
      let sp = 0, size = 0;
      stack[sp++] = s; seen[s] = 1;
      while (sp > 0) {
        const v = stack[--sp]; size++;
        for (let k = nbrStart[v]; k < nbrStart[v + 1]; k++) {
          const w = nbr[k];
          if (!seen[w] && eff[w] === d) { seen[w] = 1; stack[sp++] = w; }
        }
      }
      comps.push(size);
    }
    comps.sort((a, b) => b - a);
    const per = P[d] - 2 * internal[d];
    out.push({
      d,
      components: comps.length,
      sizes: comps,
      contiguous: comps.length <= 1,
      empty: comps.length === 0,
      area: A[d],
      perim: per,
      pp: d !== 0 && A[d] > 0 && per > 0 ? (4 * Math.PI * A[d]) / (per * per) : null,
    });
  }
  return out;
}

/** Whole-county connectivity check, for the data sanity report. */
export function countyComponents(data) {
  const all = new Int8Array(data.n).fill(1);
  return geometry(data, all)[1].components;
}

/**
 * Tally a named grouping (city or community) across precincts, counting a group
 * as split when its units land in more than one precinct. Membership comes from
 * the VTD attribute; where a VTD is split its blocks are counted individually.
 */
function splitTally(data, asn, blockOv, blockProps, keyOf, nameOf) {
  const hits = new Map();   // key -> { pop: Float64Array(5), units: Int32Array(5) }
  const get = (k) => {
    let h = hits.get(k);
    if (!h) { h = { pop: new Float64Array(5), units: new Int32Array(5) }; hits.set(k, h); }
    return h;
  };

  for (let i = 0; i < data.n; i++) {
    const k = keyOf(i);
    if (k == null) continue;
    const h = get(k);
    const ov = blockOv ? blockOv.get(i) : undefined;
    if (ov) {
      const props = blockProps ? blockProps.get(i) : null;
      for (const [g, d] of ov) {
        const p = props ? props.get(g) : null;
        h.pop[d] += p ? (p.pop || 0) : 0;
        h.units[d]++;
      }
    } else {
      const d = asn[i];
      h.pop[d] += data.num.pop[i];
      h.units[d]++;
    }
  }

  const list = [];
  let splitCount = 0;
  for (const [k, h] of hits) {
    const parts = [];
    for (let d = 1; d <= 4; d++) if (h.units[d] > 0) parts.push(d);
    const unassigned = h.units[0] > 0;
    const isSplit = parts.length > 1;
    if (isSplit) splitCount++;
    list.push({
      key: k,
      name: nameOf(k),
      parts,
      unassigned,
      split: isSplit,
      pop: h.pop.reduce((a, b) => a + b, 0),
      byPrecinct: Array.from(h.pop),
    });
  }
  list.sort((a, b) => b.pop - a.pop || String(a.name).localeCompare(String(b.name)));
  return { total: hits.size, splitCount, list, splits: list.filter((x) => x.split) };
}
