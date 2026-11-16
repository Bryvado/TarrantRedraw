// Import and export.
//
// DRA block assignment format, one format and no options: header
// "GEOID20,District", then one row per ASSIGNED block, GEOID20 as the 15-digit
// string and District an integer 1-4. That is what the geomander R package (the
// most widely used reader/writer of DRA exports) reads.
//
// Unassigned blocks are left out, never written as 0 or blank. DRA builds its
// districts from the labels it finds in the file, so a 0 turns into a fifth,
// ghost district; a block missing from the file is simply unassigned there.

import { loadBlockVtd, loadBlocks } from './data.js';
import { dissolvePolygon } from './topology.js';
import { parseCSV } from './util.js';

export const DRA_HEADER = 'GEOID20,District';

/** Effective VTD-level assignment, flattening any split to its majority precinct. */
export function flattenToVtd(state, blockPopByIdx) {
  const out = new Int8Array(state.n);
  out.set(state.asn);
  const flattened = [];
  for (const idx of state.splitIndices()) {
    const maj = state.majorityOf(idx, blockPopByIdx ? blockPopByIdx(idx) : null);
    out[idx] = maj;
    flattened.push(idx);
  }
  return { asn: out, flattened };
}

/**
 * vtdkey,district — one row per ASSIGNED VTD. Unassigned VTDs are left out, so
 * in R df$district[match(map$vtdkey, df$vtdkey)] gives NA for them.
 */
export function vtdCSV(data, asn) {
  const lines = ['vtdkey,district'];
  for (let i = 0; i < data.n; i++) if (asn[i] >= 1 && asn[i] <= 4) lines.push(`${data.keys[i]},${asn[i]}`);
  return lines.join('\n') + '\n';
}

/**
 * Block assignment CSV for DRA: one row for every assigned block in
 * data/block_vtd.csv. Blocks take their VTD's precinct, except in split VTDs
 * where the override wins. Unassigned blocks are counted, not written.
 */
export async function blockCSV(data, state) {
  const bv = await loadBlockVtd();

  // vtdkey -> override map, for split VTDs only.
  const ovByKey = new Map();
  for (const idx of state.splitIndices()) ovByKey.set(data.keys[idx], state.blockOv.get(idx));

  const out = [DRA_HEADER];
  let missing = 0;
  const byPrecinct = new Float64Array(5);
  const countByPrecinct = new Int32Array(5);

  for (let i = 0; i < bv.count; i++) {
    const key = bv.vtdkey[i];
    const idx = data.idxOf.get(key);
    let d;
    const ov = ovByKey.get(key);
    if (ov) {
      const v = ov.get(bv.geoid[i]);
      if (v === undefined) { missing++; d = idx === undefined ? 0 : state.asn[idx]; }
      else d = v;
    } else {
      d = idx === undefined ? 0 : state.asn[idx];
    }
    if (!(d >= 1 && d <= 4)) d = 0;
    byPrecinct[d] += bv.pop[i];
    countByPrecinct[d]++;
    if (d) out.push(`${bv.geoid[i]},${d}`);
  }

  return {
    text: out.join('\n') + '\n',
    rows: out.length - 1,
    total: bv.count,
    unassigned: countByPrecinct[0],
    missing,
    popByPrecinct: Array.from(byPrecinct),
    countByPrecinct: Array.from(countByPrecinct),
  };
}

/** Dissolved precinct polygons, EPSG:4326. */
export function dissolvedGeoJSON(data, topo, state, metrics, blockPopByIdx) {
  const { asn } = flattenToVtd(state, blockPopByIdx);
  const features = [];
  for (let d = 1; d <= 4; d++) {
    const idx = [];
    for (let i = 0; i < data.n; i++) if (asn[i] === d) idx.push(i);
    if (!idx.length) continue;
    const geom = dissolvePolygon(topo, idx);
    if (!geom) continue;
    const r = metrics.rows[d], g = metrics.geom[d];
    features.push({
      type: 'Feature',
      properties: {
        PRECINCT: d,
        plan: state.name,
        vtds: idx.length,
        pop: Math.round(r.pop),
        deviation: Number(r.dev.toFixed(6)),
        vap: Math.round(r.vap),
        hisp_vap_share: r.hisp == null ? null : Number(r.hisp.toFixed(4)),
        black_vap_share: r.black == null ? null : Number(r.black.toFixed(4)),
        nonwhite_vap_share: r.nonwhite == null ? null : Number(r.nonwhite.toFixed(4)),
        dshare: r.dshare == null ? null : Number(r.dshare.toFixed(4)),
        share26: r.share26 == null ? null : Number(r.share26.toFixed(4)),
        ndv: Number(r.ndv.toFixed(2)), nrv: Number(r.nrv.toFixed(2)),
        ndv26: Number(r.ndv26.toFixed(2)), nrv26: Number(r.nrv26.toFixed(2)),
        components: g.components,
        contiguous: g.contiguous,
        polsby_popper: g.pp == null ? null : Number(g.pp.toFixed(5)),
      },
      geometry: geom,
    });
  }
  return JSON.stringify({
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    name: 'tarrant_redraw_precincts',
    features,
  });
}

// ---- import ---------------------------------------------------------------

/**
 * Sniff and parse either assignment CSV. Returns
 *  { kind:'vtd'|'block', ... } or { error }.
 */
export function sniffCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { error: 'The file is empty.' };

  let head = rows[0].map((s) => s.trim());
  let body = rows;
  const headerLooksLikeHeader = head.some((h) => /[a-z]/i.test(h));
  if (headerLooksLikeHeader) body = rows.slice(1);
  else head = [];

  if (!body.length) return { error: 'The file has a header but no rows.' };

  const lower = head.map((h) => h.toLowerCase());
  let idCol = 0, dCol = 1;
  if (head.length) {
    const find = (names) => lower.findIndex((h) => names.includes(h));
    const i1 = find(['vtdkey', 'geoid20', 'geoid', 'blockid', 'block', 'id', 'precinct_id']);
    const i2 = find(['district', 'precinct', 'pct', 'dist', 'assignment', 'value']);
    if (i1 >= 0) idCol = i1;
    if (i2 >= 0) dCol = i2;
    if (i1 < 0 && i2 < 0 && head.length >= 2) { idCol = 0; dCol = 1; }
  }
  if (body[0].length < 2) return { error: 'Expected at least two columns (id and district).' };

  // Decide by the length of the identifier: a 2020 block GEOID is 15 digits.
  const sample = body.slice(0, 50).map((r) => String(r[idCol]).trim()).filter(Boolean);
  const longIds = sample.filter((s) => s.replace(/\D/g, '').length >= 12).length;
  const kind = longIds > sample.length / 2 ? 'block' : 'vtd';

  const ids = new Array(body.length), dists = new Int8Array(body.length);
  let bad = 0, nOut = 0;
  for (const r of body) {
    const id = String(r[idCol] ?? '').trim();
    if (!id) continue;
    const dRaw = String(r[dCol] ?? '').trim();
    let d = Math.round(Number(dRaw));
    if (!Number.isFinite(d) || d < 0 || d > 4) {
      if (dRaw === '' || /^(na|null|none|unassigned|-1)$/i.test(dRaw)) d = 0;
      else { bad++; continue; }
    }
    ids[nOut] = id; dists[nOut] = d; nOut++;
  }
  ids.length = nOut;
  return { kind, ids, dists: dists.subarray(0, nOut), bad, headerSeen: head.length > 0, head };
}

/** Turn a parsed VTD CSV into an assignment array. */
export function applyVtdImport(data, parsed) {
  const asn = new Int8Array(data.n);
  let matched = 0, unknown = 0;
  const seen = new Uint8Array(data.n);
  for (let i = 0; i < parsed.ids.length; i++) {
    const key = Math.round(Number(parsed.ids[i]));
    const idx = data.idxOf.get(key);
    if (idx === undefined) { unknown++; continue; }
    asn[idx] = parsed.dists[i];
    if (!seen[idx]) { seen[idx] = 1; matched++; }
  }
  return { asn, matched, unknown, missing: data.n - matched };
}

/**
 * Turn a parsed block CSV into a VTD assignment plus, for any VTD whose blocks
 * disagree, a block-level split. Fetches block geometry only for those VTDs.
 */
export async function applyBlockImport(data, parsed) {
  const bv = await loadBlockVtd();
  const vtdOfBlock = new Map();
  for (let i = 0; i < bv.count; i++) vtdOfBlock.set(bv.geoid[i], bv.vtdkey[i]);
  const popOfBlock = new Map();
  for (let i = 0; i < bv.count; i++) popOfBlock.set(bv.geoid[i], bv.pop[i]);

  // Per VTD: the district of each of its listed blocks.
  const byVtd = new Map();
  let unknown = 0;
  for (let i = 0; i < parsed.ids.length; i++) {
    const g = parsed.ids[i].padStart(15, '0');
    const key = vtdOfBlock.get(g) ?? vtdOfBlock.get(parsed.ids[i]);
    if (key === undefined) { unknown++; continue; }
    let m = byVtd.get(key);
    if (!m) { m = new Map(); byVtd.set(key, m); }
    m.set(g, parsed.dists[i]);
  }

  const asn = new Int8Array(data.n);
  const splits = [];
  let matched = 0;
  for (const [key, m] of byVtd) {
    const idx = data.idxOf.get(key);
    if (idx === undefined) continue;
    matched++;
    const tally = new Float64Array(5);
    let distinct = new Set();
    for (const [g, d] of m) { tally[d] += popOfBlock.get(g) || 0; distinct.add(d); }
    let best = 0, bv2 = -1;
    for (let d = 0; d <= 4; d++) if (tally[d] > bv2) { bv2 = tally[d]; best = d; }
    if (bv2 <= 0) best = [...distinct][0] ?? 0;
    asn[idx] = best;
    if (distinct.size > 1) splits.push({ idx, key, overrides: m });
  }

  // Fill in overrides for every block of each split VTD, so the split is complete.
  const resolvedSplits = [];
  for (const s of splits) {
    const gj = await loadBlocks(s.key);
    const full = new Map();
    for (const f of gj.features) {
      const g = f.properties.GEOID20;
      full.set(g, s.overrides.get(g) ?? asn[s.idx]);
    }
    resolvedSplits.push({ idx: s.idx, key: s.key, overrides: full, features: gj.features });
  }

  return { asn, matched, unknown, splits: resolvedSplits, blocksSeen: parsed.ids.length, blocksTotal: bv.count };
}
