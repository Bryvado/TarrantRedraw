// Fragments and unassigned islands: the connected pieces of each precinct.
//
// Units are whole VTDs, plus the blocks of any split VTD. VTD adjacency and
// shared border lengths come from data/vtd_adj.json (lengths in feet).
//
// Block adjacency is built from the block geometry by shared segments, the
// same idea topology.js uses for VTDs. The block layer does not share
// vertices with the VTD layer, so a block's neighbours across its VTD's edge
// are found in the neighbouring VTDs' block files. Before that is relied on it
// is checked: for every neighbour in vtd_adj.json the shared block border has
// to come out within 3% of the recorded VTD border, and no segment may belong
// to more than two blocks. A split VTD that fails the check is treated as one
// unit at its majority precinct, and its fragments are not offered for cleanup.

const FT_PER_M = 3.28084;
const LEN_TOLERANCE = 0.03;

// ---- block topology for one split VTD ---------------------------------------

const rings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).flat();

/** Segment length in feet: local equirectangular, ample at county scale. */
function segFeet(ax, ay, bx, by) {
  const lat = ((ay + by) / 2) * Math.PI / 180;
  return Math.hypot((bx - ax) * 111320 * Math.cos(lat), (by - ay) * 110574) * FT_PER_M;
}

/**
 * Block adjacency for split VTD `idx`: edges between its own blocks, and from
 * its blocks to the blocks of each neighbouring VTD. Fetches (cached) block
 * files for the VTD and its neighbours.
 */
export async function buildSplitTopology(data, idx, loadBlocks) {
  const nb = [];
  for (let k = data.nbrStart[idx]; k < data.nbrStart[idx + 1]; k++) nb.push(data.nbr[k]);
  const files = await Promise.all([idx, ...nb].map((i) => loadBlocks(data.keys[i])));

  const owners = new Map();          // segment key -> [{ v, g, len }]
  let overfull = 0;
  files.forEach((gj, fi) => {
    const v = fi === 0 ? idx : nb[fi - 1];
    for (const f of gj.features) {
      const g = f.properties.GEOID20;
      for (const r of rings(f.geometry)) {
        for (let j = 1; j < r.length; j++) {
          const a = r[j - 1], b = r[j];
          if (a[0] === b[0] && a[1] === b[1]) continue;
          const ka = a[0] + ',' + a[1], kb = b[0] + ',' + b[1];
          const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
          let o = owners.get(key);
          if (!o) { o = []; owners.set(key, o); }
          if (o.length === 2) overfull++;
          o.push({ v, g, len: segFeet(a[0], a[1], b[0], b[1]) });
        }
      }
    }
  });

  const internal = new Map();        // "g1|g2" (sorted) -> feet
  const external = new Map();        // "g|j|gj" -> feet
  const perNbr = new Map();          // j -> feet
  for (const o of owners.values()) {
    if (o.length !== 2) continue;
    const [p, q] = o;
    if (p.v === idx && q.v === idx) {
      if (p.g === q.g) continue;
      const k = p.g < q.g ? p.g + '|' + q.g : q.g + '|' + p.g;
      internal.set(k, (internal.get(k) || 0) + p.len);
    } else if (p.v === idx || q.v === idx) {
      const mine = p.v === idx ? p : q, other = p.v === idx ? q : p;
      const k = mine.g + '|' + other.v + '|' + other.g;
      external.set(k, (external.get(k) || 0) + mine.len);
      perNbr.set(other.v, (perNbr.get(other.v) || 0) + mine.len);
    }
  }

  // The check: every recorded neighbour found, with a matching border length.
  const problems = [];
  if (overfull) problems.push(`${overfull} segments shared by more than two blocks`);
  for (const j of nb) {
    const want = edgeLength(data, idx, j), got = perNbr.get(j) || 0;
    if (!(want > 0)) continue;
    if (Math.abs(got / want - 1) > LEN_TOLERANCE) {
      problems.push(`border with VTD ${data.keys[j]}: ${Math.round(got)} ft from blocks, ${Math.round(want)} ft recorded`);
    }
  }

  const pop = new Map();
  for (const f of files[0].features) pop.set(f.properties.GEOID20, f.properties.pop || 0);

  return {
    idx,
    ok: problems.length === 0,
    problems,
    pop,
    internal: [...internal].map(([k, len]) => { const [a, b] = k.split('|'); return [a, b, len]; }),
    external: [...external].map(([k, len]) => {
      const [g, j, gj] = k.split('|');
      return [g, Number(j), gj, len];
    }),
  };
}

let edgeIndex = null;
function edgeLength(data, a, b) {
  if (!edgeIndex || edgeIndex.data !== data) {
    const m = new Map();
    for (let e = 0; e < data.edgeCount; e++) {
      const x = data.edgeA[e], y = data.edgeB[e];
      m.set(x < y ? x * data.n + y : y * data.n + x, data.edgeLen[e]);
    }
    edgeIndex = { data, m };
  }
  return edgeIndex.m.get(a < b ? a * data.n + b : b * data.n + a) || 0;
}

// ---- the analysis ----------------------------------------------------------

/**
 * Connected pieces of every precinct, and every unassigned piece.
 *
 * @param topoOf  idx -> result of buildSplitTopology, or undefined if not loaded
 * @param blockPopOf idx -> Map<GEOID20, pop> for a split VTD's majority fallback
 * @returns {
 *   fragments: piece[],   precinct pieces other than each precinct's main body
 *   islands:   piece[],   unassigned pieces
 *   mains:     piece[],   each precinct's main body (index 1..4, may be null)
 *   pending:   number[],  split VTDs whose block topology is not loaded yet
 *   unclean:   number[],  split VTDs whose block topology failed the check
 * }
 * piece = { d, pop, vtds: number[], blocks: [vtdIdx, GEOID20][], whole: number[],
 *           border: number[5] (feet shared with each precinct, 0 = unassigned) }
 * `whole` lists split VTDs that had to be counted as one unit.
 */
export function analyze(data, state, { topoOf, blockPopOf }) {
  const n = data.n;
  // Node table. A VTD node's id is its index; block nodes follow.
  const nodeVtd = [], nodeG = [], nodePop = [], nodeD = [];
  const blockNode = new Map();       // "idx|g" -> node id
  const asBlocks = new Uint8Array(n);
  const pending = [], unclean = [];

  for (let i = 0; i < n; i++) {
    nodeVtd.push(i); nodeG.push(null); nodePop.push(data.num.pop[i]); nodeD.push(state.asn[i]);
  }
  for (const i of state.splitIndices()) {
    const t = topoOf(i);
    const ov = state.blockOv.get(i);
    if (t && t.ok) {
      asBlocks[i] = 1;
      nodePop[i] = 0; nodeD[i] = -1;                 // the VTD node is retired
      for (const [g, d] of ov) {
        blockNode.set(i + '|' + g, nodeVtd.length);
        nodeVtd.push(i); nodeG.push(g); nodePop.push(t.pop.get(g) || 0); nodeD.push(d);
      }
    } else {
      (t ? unclean : pending).push(i);
      nodeD[i] = state.majorityOf(i, blockPopOf(i));
    }
  }

  const N = nodeVtd.length;
  const adj = Array.from({ length: N }, () => []);
  const link = (a, b, len) => {
    if (a === undefined || b === undefined || a === b) return;
    adj[a].push(b, len); adj[b].push(a, len);
  };

  for (let e = 0; e < data.edgeCount; e++) {
    const a = data.edgeA[e], b = data.edgeB[e];
    if (asBlocks[a] || asBlocks[b]) continue;       // replaced by block edges
    link(a, b, data.edgeLen[e]);
  }
  for (const i of state.splitIndices()) {
    if (!asBlocks[i]) continue;
    const t = topoOf(i);
    for (const [g1, g2, len] of t.internal) link(blockNode.get(i + '|' + g1), blockNode.get(i + '|' + g2), len);
    for (const [g, j, gj, len] of t.external) {
      if (asBlocks[j]) {
        if (j < i) continue;                         // the pair is added once, from the lower index
        link(blockNode.get(i + '|' + g), blockNode.get(j + '|' + gj), len);
      } else {
        link(blockNode.get(i + '|' + g), j, len);
      }
    }
  }

  // Components by precinct.
  const comp = new Int32Array(N).fill(-1);
  const pieces = [];
  for (let s = 0; s < N; s++) {
    if (comp[s] >= 0 || nodeD[s] < 0) continue;
    const d = nodeD[s], id = pieces.length;
    const piece = { d, pop: 0, vtds: [], blocks: [], whole: [], border: [0, 0, 0, 0, 0], nodes: [] };
    const stack = [s];
    comp[s] = id;
    while (stack.length) {
      const u = stack.pop();
      piece.nodes.push(u);
      piece.pop += nodePop[u];
      if (nodeG[u] === null) {
        piece.vtds.push(u);
        if (state.isSplit(u)) piece.whole.push(u);
      } else piece.blocks.push([nodeVtd[u], nodeG[u]]);
      const a = adj[u];
      for (let k = 0; k < a.length; k += 2) {
        const w = a[k];
        if (nodeD[w] === d) {
          if (comp[w] < 0) { comp[w] = id; stack.push(w); }
        } else if (nodeD[w] >= 0) {
          piece.border[nodeD[w]] += a[k + 1];
        }
      }
    }
    pieces.push(piece);
  }

  const mains = [null, null, null, null, null];
  for (const p of pieces) {
    if (p.d === 0) continue;
    const m = mains[p.d];
    if (!m || p.pop > m.pop || (p.pop === m.pop && p.nodes.length > m.nodes.length)) mains[p.d] = p;
  }
  const fragments = pieces.filter((p) => p.d > 0 && p !== mains[p.d]).sort((a, b) => a.d - b.d || b.pop - a.pop);
  const islands = pieces.filter((p) => p.d === 0).sort((a, b) => b.pop - a.pop);
  for (const p of pieces) delete p.nodes;
  return { fragments, islands, mains, pending, unclean };
}

/** Number of units in a piece, as text: "3 VTDs", "1 VTD, 12 blocks". */
export function unitText(p) {
  const v = p.vtds.length, b = p.blocks.length;
  const parts = [];
  if (v) parts.push(`${v} VTD${v === 1 ? '' : 's'}`);
  if (b) parts.push(`${b} block${b === 1 ? '' : 's'}`);
  return parts.join(', ') || '—';
}

/**
 * The cleanup proposal for a fragment or island: the neighbouring precinct it
 * shares the longest border with. Returns { to, reason } where `to` is 0 when
 * there is nothing to propose and `reason` says why it will be skipped.
 */
export function proposal(p, state) {
  let to = 0, best = 0;
  for (let d = 1; d <= 4; d++) {
    if (d !== p.d && p.border[d] > best) { best = p.border[d]; to = d; }
  }
  if (!to) return { to: 0, reason: 'no neighbouring precinct' };
  if (p.whole.length) return { to, reason: 'contains a split VTD whose block borders could not be checked' };
  if (p.d > 0 && state.isLocked(p.d)) return { to, reason: `Pct ${p.d} is locked` };
  if (state.isLocked(to)) return { to, reason: `Pct ${to} is locked` };
  return { to, reason: null };
}
