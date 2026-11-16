// Loads and normalises everything in data/. All paths are relative so the app
// works unchanged from a local static server and from /TarrantRedraw/ on Pages.

const NUM_FIELDS = [
  'pop', 'vap', 'vap_white', 'vap_black', 'vap_hisp',
  'ndv', 'nrv', 'ndv26', 'nrv26',
];

/** Shading fields that come straight off the VTD properties. */
export const SHADE_FIELDS = ['dshare', 'dshare_pre', 'share26', 'shift26'];

async function getJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
async function getText(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
}

export async function loadAll(onProgress = () => {}) {
  const step = (frac, msg) => onProgress(frac, msg);

  step(0.04, 'Loading VTD boundaries…');
  const vtdGeo = await getJSON('data/vtd.geojson');

  step(0.46, 'Loading adjacency…');
  const adjRaw = await getJSON('data/vtd_adj.json');

  step(0.58, 'Loading reference plans…');
  const plansText = await getText('data/plans.csv');

  step(0.66, 'Loading overlays…');
  const [map7Geo, citiesGeo, commGeo] = await Promise.all([
    getJSON('data/map7.geojson'),
    getJSON('data/cities.geojson'),
    getJSON('data/communities.geojson'),
  ]);

  step(0.9, 'Indexing…');

  // ---- VTD table, compact index 0..n-1 -------------------------------------
  const feats = vtdGeo.features;
  const n = feats.length;
  const keys = new Int32Array(n);
  const idxOf = new Map();
  const num = {};
  for (const f of NUM_FIELDS) num[f] = new Float64Array(n);
  const city = new Array(n);
  const comm = new Array(n);

  for (let i = 0; i < n; i++) {
    const p = feats[i].properties;
    const key = Math.round(Number(p.vtdkey));   // GeoJSON stores 7895.0
    keys[i] = key;
    idxOf.set(key, i);
    p.vtdkey = key;                              // normalise for promoteId

    for (const f of NUM_FIELDS) num[f][i] = Number(p[f]) || 0;

    city[i] = p.city_name == null || p.city_name === '' ? null : String(p.city_name);
    comm[i] = p.comm_raw == null || p.comm_raw === '' ? null : Math.round(Number(p.comm_raw));

    // Derived demographic shares, for shading. Null (absent) when VAP is zero.
    const vap = num.vap[i];
    if (vap > 0) {
      p.f_hisp = num.vap_hisp[i] / vap;
      p.f_black = num.vap_black[i] / vap;
      p.f_nonwhite = 1 - num.vap_white[i] / vap;
    }

    // Drop null-valued properties so MapLibre's ['has', …] is a clean no-data
    // test instead of feeding null into an interpolate.
    for (const f of SHADE_FIELDS) if (p[f] == null) delete p[f];
  }

  // ---- adjacency: CSR ------------------------------------------------------
  const area = new Float64Array(n);
  const perim = new Float64Array(n);
  {
    const uk = adjRaw.units.vtdkey, ua = adjRaw.units.area, up = adjRaw.units.perim;
    for (let i = 0; i < uk.length; i++) {
      const j = idxOf.get(Math.round(Number(uk[i])));
      if (j === undefined) continue;
      area[j] = Number(ua[i]) || 0;
      perim[j] = Number(up[i]) || 0;
    }
  }
  const ea = adjRaw.edges.a, eb = adjRaw.edges.b, elen = adjRaw.edges.len;
  const m = ea.length;
  const edgeA = new Int32Array(m), edgeB = new Int32Array(m), edgeLen = new Float64Array(m);
  const deg = new Int32Array(n);
  let mk = 0;
  for (let i = 0; i < m; i++) {
    const a = idxOf.get(Math.round(Number(ea[i])));
    const b = idxOf.get(Math.round(Number(eb[i])));
    if (a === undefined || b === undefined) continue;
    edgeA[mk] = a; edgeB[mk] = b; edgeLen[mk] = Number(elen[i]) || 0;
    deg[a]++; deg[b]++; mk++;
  }
  const nbrStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) nbrStart[i + 1] = nbrStart[i] + deg[i];
  const nbr = new Int32Array(nbrStart[n]);
  const fill = nbrStart.slice(0, n);
  for (let i = 0; i < mk; i++) {
    nbr[fill[edgeA[i]]++] = edgeB[i];
    nbr[fill[edgeB[i]]++] = edgeA[i];
  }

  // ---- reference plans ----------------------------------------------------
  const planCols = {};
  {
    const lines = plansText.trim().split(/\r?\n/);
    const head = lines[0].split(',').map((s) => s.trim());
    const kCol = head.indexOf('vtdkey');
    const cols = head.map((h, j) => (j === kCol || h === '' ? null : h));
    for (const h of cols) if (h) planCols[h] = new Int8Array(n);
    for (let li = 1; li < lines.length; li++) {
      const parts = lines[li].split(',');
      const i = idxOf.get(Math.round(Number(parts[kCol])));
      if (i === undefined) continue;
      for (let j = 0; j < cols.length; j++) {
        if (!cols[j]) continue;
        const v = Math.round(Number(parts[j]));
        planCols[cols[j]][i] = Number.isFinite(v) && v >= 1 && v <= 4 ? v : 0;
      }
    }
  }

  // ---- community id -> name ------------------------------------------------
  const commName = new Map();
  const commSources = new Set();
  for (const f of commGeo.features) {
    const p = f.properties;
    const id = Math.round(Number(p.comm_id));
    if (Number.isFinite(id)) commName.set(id, p.name ?? `Community ${id}`);
    if (p.source) commSources.add(String(p.source));
  }

  step(1, 'Ready');

  return {
    n, keys, idxOf, num, city, comm,
    area, perim, edgeA, edgeB, edgeLen, edgeCount: mk, nbr, nbrStart,
    vtdGeo, map7Geo, citiesGeo, commGeo,
    planCols, commName, commSources,
    countyPop: num.pop.reduce((a, b) => a + b, 0),
  };
}

/** Lazily fetch and cache one VTD's block features. */
const blockCache = new Map();
export async function loadBlocks(vtdkey) {
  if (blockCache.has(vtdkey)) return blockCache.get(vtdkey);
  const p = getJSON(`data/blocks/${vtdkey}.geojson`).then((gj) => {
    for (const f of gj.features) {
      const pr = f.properties;
      pr.GEOID20 = String(pr.GEOID20);
      pr.vtdkey = Math.round(Number(pr.vtdkey));
      for (const k of NUM_FIELDS) pr[k] = Number(pr[k]) || 0;
      if (pr.vap > 0) {
        pr.f_hisp = pr.vap_hisp / pr.vap;
        pr.f_black = pr.vap_black / pr.vap;
        pr.f_nonwhite = 1 - pr.vap_white / pr.vap;
      }
      const dr = pr.ndv + pr.nrv;
      if (dr > 0) pr.dshare = pr.ndv / dr;
      const dr26 = pr.ndv26 + pr.nrv26;
      if (dr26 > 0) pr.share26 = pr.ndv26 / dr26;
    }
    return gj;
  });
  blockCache.set(vtdkey, p);
  return p;
}
export const blocksLoaded = (vtdkey) => blockCache.has(vtdkey);

/** data/block_vtd.csv — all 31,925 blocks. Needed only for the block export. */
let blockVtdPromise = null;
export function loadBlockVtd() {
  if (!blockVtdPromise) {
    blockVtdPromise = getText('data/block_vtd.csv').then((text) => {
      const lines = text.trim().split(/\r?\n/);
      const head = lines[0].split(',').map((s) => s.trim());
      const gi = head.indexOf('GEOID20');
      const vi = head.indexOf('vtdkey');
      const pi = head.indexOf('pop');
      const geoid = new Array(lines.length - 1);
      const vtdkey = new Int32Array(lines.length - 1);
      const pop = new Float64Array(lines.length - 1);
      for (let i = 1; i < lines.length; i++) {
        const p = lines[i].split(',');
        geoid[i - 1] = p[gi].trim();
        vtdkey[i - 1] = Math.round(Number(p[vi]));
        pop[i - 1] = Number(p[pi]) || 0;
      }
      return { geoid, vtdkey, pop, count: geoid.length };
    });
  }
  return blockVtdPromise;
}
