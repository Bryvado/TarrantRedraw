// Browser test for splitting VTDs into blocks: right-click to split, block
// lines only on the active VTD, precinct outlines that follow block
// assignments (mixed-resolution dissolve, also in the GeoJSON export), and
// block shading from each block's own modelled values.
//
//   node tests/splits.mjs [repository root]

import fs from 'fs';
import { openApp } from './harness.mjs';

const { page, check, finish, clickText } = await openApp();

const T = (fn, arg) => page.evaluate(fn, arg);
const settle = (ms = 400) => page.waitForTimeout(ms);
const startMap7 = async () => { await page.click('#btn-start'); await clickText('Map 7'); await settle(500); };
const startBlank = async () => { await page.click('#btn-start'); await clickText('Blank'); await settle(300); };

/** Frame a VTD and return a page point well inside it (not over the unit card). */
async function pointIn(key) {
  const p = await T(async (key) => {
    const A = window.TarrantRedraw, m = A.mapView.map, i = A.data.idxOf.get(key);
    const f = A.data.vtdGeo.features[i];
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    const walk = (c) => { if (typeof c[0] === 'number') { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); } else c.forEach(walk); };
    walk(f.geometry.coordinates);
    m.fitBounds([[x0, y0], [x1, y1]], { padding: { top: 120, bottom: 120, left: 330, right: 120 }, duration: 0 });
    await new Promise((r) => { m.once('idle', r); setTimeout(r, 2500); });
    const a = m.project([x0, y1]), b = m.project([x1, y0]);
    const hits = [];
    for (let u = 1; u < 24; u++) for (let v = 1; v < 24; v++) {
      const pt = { x: a.x + ((b.x - a.x) * u) / 24, y: a.y + ((b.y - a.y) * v) / 24 };
      const top = m.queryRenderedFeatures([pt.x, pt.y], { layers: ['blocks-fill', 'vtd-fill'] })[0];
      if (top && top.properties.vtdkey === key) hits.push(pt);
    }
    if (!hits.length) return null;
    // The hit with the most hits around it: well inside the VTD.
    let best = hits[0], bs = -1;
    for (const h of hits) {
      const s = hits.filter((q) => Math.hypot(q.x - h.x, q.y - h.y) < Math.abs(b.x - a.x) / 6).length;
      if (s > bs) { bs = s; best = h; }
    }
    return best;
  }, key);
  const box = await page.locator('#map').boundingBox();
  return p && { x: box.x + p.x, y: box.y + p.y };
}
const isSplit = (key) => T((k) => window.TarrantRedraw.state.isSplit(window.TarrantRedraw.data.idxOf.get(k)), key);
const blockValues = (key) => T((k) => {
  const A = window.TarrantRedraw, ov = A.state.blockOv.get(A.data.idxOf.get(k));
  return ov ? [...new Set(ov.values())] : null;
}, key);
const asnOf = (key) => T((k) => window.TarrantRedraw.state.asn[window.TarrantRedraw.data.idxOf.get(k)], key);
const waitSplit = (key) => page.waitForFunction((k) => {
  const A = window.TarrantRedraw, i = A.data.idxOf.get(k);
  return A.state.isSplit(i) && A.mapView.blockFeatures.has(i);
}, key, { timeout: 15000 }).then(() => settle(300), () => {});
const cardText = async () => ((await page.locator('#unit-card').isVisible()) ? page.locator('#unit-card').innerText() : '');

// Big, assigned, ordinary VTDs to click on.
const pick = (pred) => T((src) => {
  const A = window.TarrantRedraw, D = A.data, a = D.planCols.map7;
  const f = new Function('i', 'D', 'a', `return (${src})(i, D, a);`);
  const out = [];
  for (let i = 0; i < D.n; i++) if (f(i, D, a)) out.push(D.keys[i]);
  return out;
}, pred.toString());

// ================================================================ 3 ====
console.log('\n# 3. Right-click splits a VTD');
await T(() => window.addEventListener('contextmenu', (e) => { window.__ctxPrevented = e.defaultPrevented; }));
const big = await pick((i, D, a) => D.num.pop[i] > 3000 && D.area[i] > 0);
await startBlank();
const kU = big[3];
let pt = await pointIn(kU);
await page.mouse.click(pt.x, pt.y, { button: 'right' });
await waitSplit(kU);
check('right-click splits an unassigned VTD', await isSplit(kU), String(kU));
check('… its blocks start unassigned', JSON.stringify(await blockValues(kU)) === '[0]', JSON.stringify(await blockValues(kU)));
check('browser context menu suppressed over the map', await T(() => window.__ctxPrevented === true));

await startMap7();
const kA = big[10];
pt = await pointIn(kA);
await page.mouse.click(pt.x, pt.y, { button: 'right' });
await waitSplit(kA);
const dA = await T((k) => window.TarrantRedraw.data.planCols.map7[window.TarrantRedraw.data.idxOf.get(k)], kA);
check('right-click splits an assigned VTD', await isSplit(kA));
check('… its blocks start in its precinct', JSON.stringify(await blockValues(kA)) === JSON.stringify([dA]), `${JSON.stringify(await blockValues(kA))} vs Pct ${dA}`);
check('card button names the outcome', new RegExp(`Undo split \\(whole VTD goes to Pct ${dA}\\)`).test(await cardText()));
await page.keyboard.press('Escape'); await settle(150);
check('card closed', !(await page.locator('#unit-card').isVisible()));
pt = await pointIn(kA);
const undoLen = await T(() => window.TarrantRedraw.state.undoStack.length);
await page.mouse.click(pt.x, pt.y, { button: 'right' }); await settle(300);
check('right-click on a split VTD opens its card', (await cardText()).startsWith(`VTD ${kA}`), (await cardText()).split('\n')[0]);
check('… and changes nothing', (await T(() => window.TarrantRedraw.state.undoStack.length)) === undoLen);

// A press that moves 3 px is still a click.
const kB = big[20];
pt = await pointIn(kB);
await page.mouse.move(pt.x, pt.y); await page.mouse.down({ button: 'right' });
await page.mouse.move(pt.x + 2, pt.y + 2, { steps: 2 }); await page.mouse.up({ button: 'right' });
await waitSplit(kB);
check('a right press that moves 3 px still splits', await isSplit(kB));

// A right-drag erases, as before, and does not split.
const kC = big[30];
pt = await pointIn(kC);
const dC = await asnOf(kC);
await page.mouse.move(pt.x, pt.y); await page.mouse.down({ button: 'right' });
await page.mouse.move(pt.x + 12, pt.y + 6, { steps: 6 }); await page.mouse.up({ button: 'right' }); await settle(300);
check('right-drag erases instead of splitting', (await asnOf(kC)) === 0 && !(await isSplit(kC)), `asn ${await asnOf(kC)} (was ${dC})`);
await page.click('#btn-undo'); await settle(200);
check('… and Undo restores it', (await asnOf(kC)) === dC);

// Left click and left drag paint exactly as before.
const kD = big[40];
pt = await pointIn(kD);
const dD = await asnOf(kD), target = dD === 2 ? 4 : 2;
await page.keyboard.press(String(target));
await page.mouse.click(pt.x, pt.y); await settle(300);
check('left click paints with the active precinct', (await asnOf(kD)) === target, `Pct ${await asnOf(kD)}`);
await page.click('#btn-undo'); await settle(200);
pt = await pointIn(kD);
await page.mouse.move(pt.x, pt.y); await page.mouse.down();
await page.mouse.move(pt.x + 10, pt.y, { steps: 4 }); await page.mouse.up(); await settle(300);
check('left drag paints', (await asnOf(kD)) === target);
check('… without splitting', !(await isSplit(kD)));
await page.click('#btn-undo'); await settle(200);
check('shortcut list has the right-click line', await (async () => {
  await page.keyboard.press('?'); await settle(150);
  const t = await page.locator('#modal').innerText();
  await page.keyboard.press('Escape');
  return /Right-click\s+Split a VTD into blocks/.test(t);
})());
check('rail hint says so', (await page.locator('.rail-hint').innerText()).includes('Right-click: split a VTD into blocks'));

// ================================================================ 4 ====
console.log('\n# 4. Finished splits melt into the precinct shapes');
const opac = await T(() => {
  const m = window.TarrantRedraw.mapView.map;
  const v = m.getPaintProperty('vtd-fill', 'fill-opacity');
  return { vtd: v[v.length - 1], block: m.getPaintProperty('blocks-fill', 'fill-opacity'), aa: m.getPaintProperty('blocks-fill', 'fill-antialias') };
});
check('block fill opacity = VTD fill opacity, no antialias seams', opac.vtd === opac.block && opac.aa === false, JSON.stringify(opac));
const lineKeys = () => T(() => window.TarrantRedraw.mapView.map.getFilter('blocks-line')[2][1]);
await page.keyboard.press('Escape');
await page.mouse.move(5, 300); await settle(200);
check('no block lines when no split VTD is selected or under the brush', (await lineKeys()).length === 0, JSON.stringify(await lineKeys()));
pt = await pointIn(kA);
await page.mouse.move(pt.x, pt.y); await settle(200);
check('block lines for the split VTD under the brush', JSON.stringify(await lineKeys()) === JSON.stringify([kA]), JSON.stringify(await lineKeys()));
await page.mouse.move(5, 300); await settle(150);
await T((k) => window.TarrantRedraw.select(window.TarrantRedraw.data.idxOf.get(k)), kA); await settle(150);
check('block lines for the selected split VTD', (await lineKeys()).includes(kA));
await page.keyboard.press('Escape'); await settle(150);
check('… gone again once deselected', (await lineKeys()).length === 0);

// A VTD on the Pct 1 / Pct 3 line with plenty of blocks.
await startMap7();
const edge = await T(async () => {
  const A = window.TarrantRedraw, D = A.data, a = D.planCols.map7;
  const nb = (i) => Array.from(D.nbr.subarray(D.nbrStart[i], D.nbrStart[i + 1]));
  const cand = [];
  for (let i = 0; i < D.n; i++) {
    if (a[i] !== 1) continue;
    const n3 = nb(i).filter((j) => a[j] === 3);
    if (n3.length && nb(i).some((j) => a[j] === 1)) cand.push([i, n3[0]]);
  }
  for (const [i, j] of cand) {
    const r = await fetch(`data/blocks/${D.keys[i]}.geojson`);
    const gj = await r.json();
    if (gj.features.length >= 24) return { key: D.keys[i], toward: D.keys[j], n: gj.features.length };
  }
  return null;
});
check('found a Pct 1 VTD on the Pct 3 line', !!edge, JSON.stringify(edge));
await T((k) => window.TarrantRedraw.doSplit(window.TarrantRedraw.data.idxOf.get(k)), edge.key);
await waitSplit(edge.key);
// Give the half of its blocks nearer Pct 3 to Pct 3.
await T(({ key, toward }) => {
  const A = window.TarrantRedraw, D = A.data, i = D.idxOf.get(key), j = D.idxOf.get(toward);
  const cen = (g) => { let sx = 0, sy = 0, n = 0; const w = (c) => { if (typeof c[0] === 'number') { sx += c[0]; sy += c[1]; n++; } else c.forEach(w); }; w(g.coordinates); return [sx / n, sy / n]; };
  const ci = cen(D.vtdGeo.features[i].geometry), cj = cen(D.vtdGeo.features[j].geometry);
  const dir = [cj[0] - ci[0], cj[1] - ci[1]];
  const feats = A.mapView.blockFeatures.get(i).map((f) => { const c = cen(f.geometry); return [f.properties.GEOID20, (c[0] - ci[0]) * dir[0] + (c[1] - ci[1]) * dir[1]]; });
  feats.sort((p, q) => q[1] - p[1]);
  const half = feats.slice(0, Math.floor(feats.length / 2)).map(([g]) => [g, key]);
  A.setActive(3);
  A.mapView.onPick({ blocks: half }); A.mapView.onPick({ commit: true });
}, edge);
await settle(600);
const ol = await T((key) => {
  const A = window.TarrantRedraw, D = A.data, i = D.idxOf.get(key);
  const g = D.vtdGeo.features[i].geometry;
  const rings = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).flat();
  const inRing = ([x, y], r) => { let s = false; for (let a = 0, b = r.length - 1; a < r.length; b = a++) { if ((r[a][1] > y) !== (r[b][1] > y) && x < ((r[b][0] - r[a][0]) * (y - r[a][1])) / (r[b][1] - r[a][1]) + r[a][0]) s = !s; } return s; };
  const inside = (p) => rings.reduce((s, r) => (inRing(p, r) ? !s : s), false);
  const src = A.mapView.map.getSource('outline')._data;
  const out = {};
  for (const f of src.features) {
    const paths = f.geometry.coordinates;
    const segs = new Map();
    let dup = 0;
    for (const p of paths) for (let k = 1; k < p.length; k++) {
      const a = p[k - 1].join(), b = p[k].join(), key2 = a < b ? a + '|' + b : b + '|' + a;
      if (segs.has(key2)) dup++; segs.set(key2, 1);
    }
    const interior = paths.flat().filter(inside).map((p) => p.join());
    out[f.properties.d] = {
      paths: paths.length,
      closed: paths.every((p) => p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]),
      dup, interior,
    };
  }
  return { out, odd: A.mapView.lastOutlineOdd };
}, edge.key);
const o1 = ol.out[1], o3 = ol.out[3];
check('outline odd-degree vertices: 0 (no gaps, no spurs)', ol.odd === 0, String(ol.odd));
const st = await T((key) => window.TarrantRedraw.mapView.lastOutlineStats
  .filter((x) => x.idx === window.TarrantRedraw.data.idxOf.get(key)), edge.key);
check('every block border meets the VTD edge where the edge changes precinct', st.length > 0 && st.every((x) => x.P === x.V && x.matched === x.P && x.localOdd === 0),
  st.map((x) => `Pct ${x.d}: ${x.P} ends, ${x.V} switches, ${x.matched} joined`).join('; '));
check('Pct 1 and Pct 3 outlines are closed rings', o1.closed && o3.closed, `${o1.paths} / ${o3.paths} paths`);
check('no segment drawn twice', o1.dup === 0 && o3.dup === 0);
check('Pct 1 border runs through the split VTD', o1.interior.length > 2, `${o1.interior.length} vertices inside`);
const shared = o1.interior.filter((p) => o3.interior.includes(p)).length;
check('… along the same block edges as Pct 3’s', shared > 2 && shared / o1.interior.length > 0.8, `${shared} shared`);

await page.click('#btn-export-menu'); await settle(200);
const [dl] = await Promise.all([page.waitForEvent('download'), clickText('Download GeoJSON')]);
const gj = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
await page.keyboard.press('Escape');
const geoInside = await T(({ key, gj }) => {
  const A = window.TarrantRedraw, g = A.data.vtdGeo.features[A.data.idxOf.get(key)].geometry;
  const rings = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).flat();
  const inRing = ([x, y], r) => { let s = false; for (let a = 0, b = r.length - 1; a < r.length; b = a++) { if ((r[a][1] > y) !== (r[b][1] > y) && x < ((r[b][0] - r[a][0]) * (y - r[a][1])) / (r[b][1] - r[a][1]) + r[a][0]) s = !s; } return s; };
  const inside = (p) => rings.reduce((s, r) => (inRing(p, r) ? !s : s), false);
  const res = {};
  for (const f of gj.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    res[f.properties.PRECINCT] = {
      inside: polys.flat(2).filter(inside).length,
      closed: polys.every((pp) => pp.every((r) => r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1])),
      parts: polys.length,
    };
  }
  return res;
}, { key: edge.key, gj });
check('GeoJSON export: Pct 1 and Pct 3 polygons cut through the split VTD', geoInside[1].inside > 2 && geoInside[3].inside > 2, JSON.stringify(geoInside));
// Each precinct should export as many polygons as Find problems counts pieces.
const pieces = await T(() => {
  const p = window.TarrantRedraw.problems;
  return [1, 2, 3, 4].map((d) => (p.mains[d] ? 1 : 0) + p.fragments.filter((f) => f.d === d).length);
});
check('GeoJSON export: rings closed; polygons per precinct = pieces Find problems counts',
  [1, 2, 3, 4].every((d) => geoInside[d].closed && geoInside[d].parts === pieces[d - 1]),
  `parts ${[1, 2, 3, 4].map((d) => geoInside[d].parts).join('/')} vs pieces ${pieces.join('/')}`);

// Harder: neighbouring split VTDs with random block assignments, all four precincts.
const stress = await T(async () => {
  const A = window.TarrantRedraw, D = A.data;
  const nb = (i) => Array.from(D.nbr.subarray(D.nbrStart[i], D.nbrStart[i + 1]));
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const results = [];
  for (const startKey of [8255, 8102, 7950, 8400]) {
    const s0 = D.idxOf.get(startKey);
    if (s0 === undefined) continue;
    const group = [s0, ...nb(s0).slice(0, 3)];
    for (const i of group) if (!A.state.isSplit(i)) await A.doSplit(i, { frame: false });
    for (const i of group) {
      const ov = A.state.blockOv.get(i);
      const byD = [[], [], [], [], []];
      for (const g of ov.keys()) byD[Math.floor(rnd() * 5)].push(g);
      for (let d = 0; d <= 4; d++) {
        if (!byD[d].length) continue;
        A.setActive(d);
        A.mapView.onPick({ blocks: byD[d].map((g) => [g, D.keys[i]]), erase: d === 0 });
      }
      A.mapView.onPick({ commit: true });
    }
    A.mapView.refreshOutlines();
    results.push(A.mapView.lastOutlineOdd);
  }
  return results;
});
check('random block assignments in neighbouring split VTDs: outlines still close', stress.length === 4 && stress.every((n) => n === 0), JSON.stringify(stress));

// ================================================================ 5 ====
console.log('\n# 5. Block shading follows the shading menu');
const vals = await T((key) => {
  const A = window.TarrantRedraw, i = A.data.idxOf.get(key);
  const fs2 = A.mapView.blockFeatures.get(i);
  const sum = (k) => fs2.reduce((t, f) => t + (f.properties[k] || 0), 0);
  const ds = fs2.map((f) => f.properties.dshare).filter((v) => v != null);
  const vp = A.data.vtdGeo.features[i].properties;
  const shiftOk = fs2.every((f) => f.properties.share26 == null || Math.abs(f.properties.shift26 - (f.properties.share26 - vp.dshare_pre)) < 1e-12);
  return { ndv: sum('ndv'), vtdNdv: A.data.num.ndv[i], nrv26: sum('nrv26'), vtdNrv26: A.data.num.nrv26[i], min: Math.min(...ds), max: Math.max(...ds), shiftOk,
    shareOk: fs2.every((f) => f.properties.dshare == null || Math.abs(f.properties.dshare - f.properties.ndv / (f.properties.ndv + f.properties.nrv)) < 1e-12) };
}, edge.key);
check('block votes sum to the VTD’s real votes', Math.abs(vals.ndv - vals.vtdNdv) < 0.5 && Math.abs(vals.nrv26 - vals.vtdNrv26) < 0.5, `${vals.ndv.toFixed(1)} vs ${vals.vtdNdv}`);
check('block Dem shares differ within the VTD', vals.max - vals.min > 0.02, `${(vals.min * 100).toFixed(1)}%–${(vals.max * 100).toFixed(1)}%`);
check('block share = ndv / (ndv + nrv)', vals.shareOk);
check('block shift = its 2026 share − the VTD’s 2020–24 baseline', vals.shiftOk);

// Evaluate the block fill colour per mode for the two most different blocks.
const PROPS = { dshare: 'dshare', share26: 'share26', shift26: 'shift26', hisp: 'f_hisp', black: 'f_black', nonwhite: 'f_nonwhite' };
for (const [mode, prop] of Object.entries(PROPS)) {
  await page.selectOption('#shade-mode', mode); await settle(150);
  const r = await T(({ key, prop }) => {
    const A = window.TarrantRedraw, m = A.mapView.map, i = A.data.idxOf.get(key);
    const fs2 = A.mapView.blockFeatures.get(i).filter((f) => f.properties[prop] != null);
    fs2.sort((p, q) => p.properties[prop] - q.properties[prop]);
    const lo = fs2[0], hi = fs2[fs2.length - 1];
    const expr = JSON.stringify(m.getPaintProperty('blocks-fill', 'fill-color'));
    const layer = m.style.getLayer('blocks-fill');
    const col = (f) => {
      const c = layer.paint.get('fill-color').evaluate({ type: 3, properties: f.properties }, { d: A.state.blockOv.get(i).get(f.properties.GEOID20) });
      return [c.r, c.g, c.b].map((v) => Math.round(v * 255)).join(',');
    };
    return { usesProp: expr.includes(`["get","${prop}"]`), lo: lo.properties[prop], hi: hi.properties[prop], cLo: col(lo), cHi: col(hi) };
  }, { key: edge.key, prop });
  check(`${mode}: blocks shade from their own ${prop}`, r.usesProp && r.cLo !== r.cHi,
    `${(+r.lo).toFixed(3)} → ${r.cLo}  vs  ${(+r.hi).toFixed(3)} → ${r.cHi}`);
}
await page.selectOption('#shade-mode', 'district'); await settle(150);

const g0 = await T((key) => {
  const A = window.TarrantRedraw, i = A.data.idxOf.get(key);
  return A.mapView.blockFeatures.get(i).filter((f) => f.properties.pop > 0)[0].properties.GEOID20;
}, edge.key);
await T(({ key, g }) => {
  const A = window.TarrantRedraw, i = A.data.idxOf.get(key);
  const f = A.mapView.blockFeatures.get(i).find((ff) => ff.properties.GEOID20 === g);
  A.mapView.onSelect({ layer: { id: 'blocks-fill' }, properties: f.properties });
}, { key: edge.key, g: g0 });
await settle(200);
const ct = await cardText();
check('block card labels every partisan number "estimate"',
  /D composite \(estimate\)/.test(ct) && /D 2026 \(estimate\)/.test(ct) && /2026 shift \(estimate\)/.test(ct));
check('… with "model estimate from race composition" in the footnote', ct.includes('model estimate from race composition'));

await finish();
