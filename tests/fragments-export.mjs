// Browser test for the DRA export rules and the Find problems tool.
//
// Export: one format, header GEOID20,District, assigned blocks only, District
// 1-4, never a 0 or a blank; the VTD CSV likewise drops unassigned VTDs.
// Find problems: pieces, fragments and islands, block adjacency in split VTDs,
// and Clean up fragments as one undoable step that respects locks.
//
// Serves the repository through Playwright's request routing, so no web
// server is needed:
//
//   node tests/fragments-export.mjs            # repository root by default
//   node tests/fragments-export.mjs <dir>      # or another checkout
//
// Needs Playwright with Chromium (a local or global install).

import { createRequire } from 'module';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs'; import path from 'path';
const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try { return req('playwright'); } catch (e) { /* fall back to a global install */ }
  const g = execSync('npm root -g').toString().trim();
  return createRequire(path.join(g, '/'))('playwright');
}
const { chromium } = loadPlaywright();
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.geojson':'application/json', '.csv':'text/csv' };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 200)); });
page.on('dialog', (d) => d.accept());
await page.route('http://app.local/**', (r) => {
  const u = new URL(r.request().url());
  const f = path.join(ROOT, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) return r.fulfill({ status: 404, body: 'nf' });
  r.fulfill({ status: 200, contentType: types[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
});
const boot = async () => {
  await page.waitForFunction(() => document.querySelector('#boot').classList.contains('done'), null, { timeout: 60000 });
  await page.waitForTimeout(300);
};
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const clickText = (t) => page.locator('button', { hasText: t }).first().click();
const download = async (clickFn) => {
  const [dl] = await Promise.all([page.waitForEvent('download'), clickFn()]);
  return fs.readFileSync(await dl.path(), 'utf8');
};
const parse = (text) => {
  const lines = text.trim().split('\n');
  return { head: lines[0], rows: lines.slice(1).map((l) => l.split(',')) };
};
const startMap7 = async () => {
  await page.click('#btn-start'); await clickText('Map 7'); await page.waitForTimeout(500);
};
const P = () => page.evaluate(() => {
  const T = window.TarrantRedraw, p = T.problems, k = T.data.keys;
  const desc = (x) => ({ d: x.d, pop: x.pop, vtds: x.vtds.map((i) => k[i]), blocks: x.blocks.length });
  return { fragments: p.fragments.map(desc), islands: p.islands.map(desc), pending: p.pending.length,
    unclean: p.unclean.map((i) => k[i]), badge: document.querySelector('#prob-badge').textContent };
});
const sameAsMap7 = () => page.evaluate(() => {
  const T = window.TarrantRedraw, m = T.data.planCols.map7;
  let diff = 0; for (let i = 0; i < T.data.n; i++) if (T.state.asn[i] !== m[i]) diff++;
  return diff === 0 && T.state.splitCount === 0 ? 0 : diff + T.state.splitCount;
});
const paintVtds = (keys, d) => page.evaluate(([keys, d]) => {
  const T = window.TarrantRedraw;
  T.setActive(d);
  T.mapView.onPick({ vtds: keys.map((k) => T.data.idxOf.get(k)), erase: d === 0 });
  T.mapView.onPick({ commit: true });
}, [keys, d]).then(() => page.waitForTimeout(250));

await page.goto('http://app.local/');
await page.evaluate(() => localStorage.clear());
await page.reload(); await boot();

// ================================================================ export ====
console.log('\n# DRA export: Map 7');
await startMap7();
await page.click('#btn-export-block'); await page.waitForTimeout(600);
const dlg = await page.locator('#modal').innerText();
check('no header or unassigned options in the dialog', (await page.locator('#modal select').count()) === 0);
check('no unassigned note when everything is assigned', !/unassigned in DRA too/.test(dlg));
let csv = parse(await download(() => clickText('Download block CSV')));
check('header is GEOID20,District', csv.head === 'GEOID20,District', csv.head);
check('31,925 rows plus header', csv.rows.length === 31925, String(csv.rows.length));
check('District values only 1-4', csv.rows.every((r) => /^[1-4]$/.test(r[1])), [...new Set(csv.rows.map((r) => r[1]))].join(' '));
check('GEOID20 is a 15-digit string, every row', csv.rows.every((r) => /^\d{15}$/.test(r[0])));
check('no duplicate blocks', new Set(csv.rows.map((r) => r[0])).size === csv.rows.length);
await page.keyboard.press('Escape');

await page.click('#btn-export-menu'); await page.waitForTimeout(200);
let vcsv = parse(await download(() => clickText('Download VTD CSV')));
check('VTD CSV: 782 rows, districts 1-4', vcsv.head === 'vtdkey,district' && vcsv.rows.length === 782
  && vcsv.rows.every((r) => /^[1-4]$/.test(r[1])), String(vcsv.rows.length));
await page.keyboard.press('Escape');

console.log('\n# DRA export: part of the map cleared');
// Erase 40 VTDs, and split one more VTD and erase half its blocks.
const erased = await page.evaluate(() => Array.from(window.TarrantRedraw.data.keys).filter((_, i) => i % 19 === 3).slice(0, 40));
await paintVtds(erased, 0);
await page.evaluate(() => window.TarrantRedraw.doSplit(window.TarrantRedraw.data.idxOf.get(8255)));
await page.waitForTimeout(900);
await page.evaluate(() => {
  const T = window.TarrantRedraw, i = T.data.idxOf.get(8255);
  const gs = [...T.state.blockOv.get(i).keys()];
  T.mapView.onPick({ blocks: gs.slice(0, 10).map((g) => [g, 8255]), erase: true });
  T.mapView.onPick({ commit: true });
});
const expected = await page.evaluate(async () => {
  const T = window.TarrantRedraw;
  const txt = await (await fetch('data/block_vtd.csv')).text();
  let assigned = 0, un = 0;
  for (const line of txt.trim().split('\n').slice(1)) {
    const [g, k] = line.split(',');
    const i = T.data.idxOf.get(Math.round(+k));
    const ov = T.state.blockOv.get(i);
    const d = ov ? ov.get(g) : T.state.asn[i];
    if (d >= 1 && d <= 4) assigned++; else un++;
  }
  return { assigned, un, vtds: Array.from(T.state.asn).filter((d) => d > 0).length - (T.state.asn[T.data.idxOf.get(8255)] > 0 ? 1 : 0) + 1 };
});
await page.click('#btn-export-block'); await page.waitForTimeout(900);
const note = await page.locator('#modal').innerText();
check('note counts the unassigned blocks', note.includes(`${expected.un.toLocaleString('en-US')} blocks unassigned; they will be unassigned in DRA too`), note.match(/[\d,]+ blocks? unassigned[^.]*/)?.[0]);
csv = parse(await download(() => clickText('Download block CSV')));
check('no 0 and no blank anywhere', csv.rows.every((r) => r.length === 2 && /^[1-4]$/.test(r[1])));
check('row count = assigned blocks', csv.rows.length === expected.assigned, `${csv.rows.length} vs ${expected.assigned}`);
check('rows + left out = 31,925', csv.rows.length + expected.un === 31925);
await page.locator('#modal button', { hasText: 'Find' }).click(); await page.waitForTimeout(300);
check('Find opens the Find problems tool', await page.locator('#problems').isVisible() && !(await page.locator('#modal-back').isVisible()));
await page.click('#btn-export-menu'); await page.waitForTimeout(200);
vcsv = parse(await download(() => clickText('Download VTD CSV')));
const assignedVtds = await page.evaluate(() => {
  const T = window.TarrantRedraw; let n = 0;
  for (let i = 0; i < T.data.n; i++) {
    const d = T.state.isSplit(i) ? T.state.majorityOf(i, T.mapView.blockPopMap(i)) : T.state.asn[i];
    if (d > 0) n++;
  }
  return n;
});
check('VTD CSV drops district 0', vcsv.rows.every((r) => /^[1-4]$/.test(r[1])) && vcsv.rows.length === assignedVtds, `${vcsv.rows.length} vs ${assignedVtds}`);
await page.keyboard.press('Escape');

// ========================================================= find problems ====
console.log('\n# Find problems: one VTD deep inside Pct 3 painted to Pct 1');
await startMap7();
check('Map 7 restored', (await sameAsMap7()) === 0);
let base = await P();
console.log(`      Map 7 itself: ${base.fragments.length} fragments, ${base.islands.length} islands`);
// A VTD whose neighbours, and their neighbours, are all Pct 3, small enough to pre-tick.
const deep = await page.evaluate(() => {
  const T = window.TarrantRedraw, D = T.data, a = D.planCols.map7;
  const nb = (i) => Array.from(D.nbr.subarray(D.nbrStart[i], D.nbrStart[i + 1]));
  for (let i = 0; i < D.n; i++) {
    if (a[i] !== 3 || D.num.pop[i] < 200 || D.num.pop[i] > 4000) continue;
    const ring2 = nb(i).flatMap((j) => [j, ...nb(j)]);
    if (ring2.every((j) => a[j] === 3)) return D.keys[i];
  }
  return null;
});
check('found a VTD deep inside Pct 3', deep != null, String(deep));
await paintVtds([deep], 1);
let pr = await P();
const newFrag = pr.fragments.filter((f) => f.d === 1 && f.vtds.length === 1 && f.vtds[0] === deep);
check('one new Pct 1 fragment, that VTD alone', pr.fragments.length === base.fragments.length + 1 && newFrag.length === 1);
check('badge updates live', +pr.badge === base.fragments.length + base.islands.length + 1, pr.badge);
if (await page.locator('#problems').isVisible()) await page.click('#btn-problems');
await page.click('#btn-problems'); await page.waitForTimeout(200);
check('rail button opens the panel', await page.locator('#problems').isVisible());
const listText = await page.locator('#problems').innerText();
check('panel lists main bodies and the fragment', /Main body/.test(listText) && /Fragment/.test(listText));
await page.locator('#problems .pr-row', { hasText: 'Fragment' }).filter({ hasText: '1 VTD' }).locator('.pr-zoom').first().click();
await page.waitForTimeout(700);
const hl = await page.evaluate(() => JSON.stringify(window.TarrantRedraw.mapView.map.getFilter('piece-hl')));
check('Zoom highlights the piece', hl.includes(String(deep)), hl);
const SHOTS = process.env.SHOTS;      // a directory: save screenshots of the tool there
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'find-problems.png') });
await clickText('Clean up fragments');
await page.waitForTimeout(200);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'clean-up.png') });
let rows = await page.evaluate(() => window.TarrantRedraw.cleanupRows.map((r) => ({
  vtds: r.piece.vtds.map((i) => window.TarrantRedraw.data.keys[i]), from: r.piece.d, to: r.to, ticked: r.ticked, reason: r.reason, pop: r.piece.pop })));
const mine = rows.find((r) => r.vtds.length === 1 && r.vtds[0] === deep);
check('proposes Pct 3, pre-ticked', mine && mine.to === 3 && mine.ticked && !mine.reason, JSON.stringify(mine));
check('pieces over 1% of ideal are not pre-ticked', rows.every((r) => !(r.ticked && r.pop >= 0.01 * 527660)));
const deltaText = await page.locator('.pb-delta').innerText();
check('population change shown before applying', /Change/.test(deltaText) && deltaText.includes('+'), deltaText.split('\n').slice(0, 3).join(' | '));
// Leave only our fragment ticked, so the result can be compared with Map 7.
await page.evaluate((deep) => {
  for (const r of window.TarrantRedraw.cleanupRows) {
    const only = r.piece.vtds.length === 1 && window.TarrantRedraw.data.keys[r.piece.vtds[0]] === deep;
    const cb = document.querySelectorAll('#problems .pr-row input[type=checkbox]')[window.TarrantRedraw.cleanupRows.indexOf(r)];
    if (cb && cb.checked !== only && !cb.disabled) { cb.checked = only; cb.dispatchEvent(new Event('change')); }
  }
}, deep);
const undoBefore = await page.evaluate(() => window.TarrantRedraw.state.undoStack.length);
await page.locator('#problems .pb-foot button.primary').click(); await page.waitForTimeout(500);
check('Apply restores Map 7 exactly', (await sameAsMap7()) === 0);
check('Apply is one undo step', (await page.evaluate(() => window.TarrantRedraw.state.undoStack.length)) === undoBefore + 1);
pr = await P();
check('fragment gone from the tool', pr.fragments.length === base.fragments.length, pr.badge);
await page.click('#btn-undo'); await page.waitForTimeout(400);
check('Undo puts it back', await page.evaluate((deep) => window.TarrantRedraw.state.asn[window.TarrantRedraw.data.idxOf.get(deep)] === 1, deep));
check('… and the fragment returns', (await P()).fragments.length === base.fragments.length + 1);
await page.click('#btn-redo'); await page.waitForTimeout(300);
check('Redo applies it again', (await sameAsMap7()) === 0);

console.log('\n# Unassigned island and locks');
await paintVtds([deep], 0);
pr = await P();
check('erased VTD is an unassigned island', pr.islands.length === base.islands.length + 1 && pr.islands.some((f) => f.vtds[0] === deep));
await page.evaluate(() => window.TarrantRedraw.openCleanup()); await page.waitForTimeout(200);
rows = await page.evaluate(() => window.TarrantRedraw.cleanupRows.map((r) => ({ vtds: r.piece.vtds.map((i) => window.TarrantRedraw.data.keys[i]), from: r.piece.d, to: r.to, reason: r.reason })));
check('island proposed for Pct 3', rows.some((r) => r.from === 0 && r.vtds[0] === deep && r.to === 3 && !r.reason));
await page.locator('.lockbtn').nth(2).click(); await page.waitForTimeout(300);
rows = await page.evaluate(() => window.TarrantRedraw.cleanupRows.map((r) => ({ vtds: r.piece.vtds.map((i) => window.TarrantRedraw.data.keys[i]), to: r.to, reason: r.reason, ticked: r.ticked })));
const lockedRow = rows.find((r) => r.vtds[0] === deep);
check('with Pct 3 locked the island is skipped and says why', lockedRow && lockedRow.reason === 'Pct 3 is locked' && !lockedRow.ticked, JSON.stringify(lockedRow));
check('… shown in the list', /Skipped: Pct 3 is locked/.test(await page.locator('#problems').innerText()));
await page.locator('.lockbtn').nth(2).click(); await page.waitForTimeout(200);
await paintVtds([deep], 3);
check('back to Map 7', (await sameAsMap7()) === 0);

console.log('\n# Split VTD: a block fragment');
// A split VTD inside Pct 3 with one block painted to Pct 1.
const splitKey = await page.evaluate(() => {
  const T = window.TarrantRedraw, D = T.data, a = D.planCols.map7;
  const nb = (i) => Array.from(D.nbr.subarray(D.nbrStart[i], D.nbrStart[i + 1]));
  for (let i = 0; i < D.n; i++) if (a[i] === 3 && D.num.pop[i] > 500 && nb(i).every((j) => a[j] === 3) && D.keys[i] !== 8255) return D.keys[i];
});
await page.evaluate((k) => window.TarrantRedraw.doSplit(window.TarrantRedraw.data.idxOf.get(k)), splitKey);
await page.waitForFunction(() => window.TarrantRedraw.problems && window.TarrantRedraw.problems.pending.length === 0, null, { timeout: 30000 });
pr = await P();
check('block borders of the split VTD pass the check', pr.unclean.length === 0, JSON.stringify(pr.unclean));
check('splitting alone adds no fragment', pr.fragments.length === base.fragments.length, pr.badge);
const target = await page.evaluate((k) => {
  // A block with population, not on the VTD's edge: all its block neighbours are in this VTD.
  const T = window.TarrantRedraw, i = T.data.idxOf.get(k);
  const feats = T.mapView.blockFeatures.get(i);
  return feats.filter((f) => f.properties.pop > 0).map((f) => f.properties.GEOID20)[0];
}, splitKey);
await page.evaluate(([k, g]) => {
  const T = window.TarrantRedraw; T.setActive(1);
  T.mapView.onPick({ blocks: [[g, k]] }); T.mapView.onPick({ commit: true });
}, [splitKey, target]);
await page.waitForTimeout(250);
pr = await P();
const bf = pr.fragments.find((f) => f.d === 1 && f.blocks === 1 && f.vtds.length === 0);
check('one block is a Pct 1 fragment', !!bf && pr.fragments.length === base.fragments.length + 1, JSON.stringify(bf));
await page.evaluate(() => window.TarrantRedraw.openCleanup()); await page.waitForTimeout(200);
rows = await page.evaluate(() => window.TarrantRedraw.cleanupRows.map((r) => ({ blocks: r.piece.blocks.length, vtds: r.piece.vtds.length, from: r.piece.d, to: r.to, reason: r.reason })));
check('block fragment proposed for Pct 3', rows.some((r) => r.blocks === 1 && r.vtds === 0 && r.from === 1 && r.to === 3 && !r.reason), JSON.stringify(rows.filter((r) => r.blocks)));
await page.evaluate(() => {
  const T = window.TarrantRedraw;
  T.cleanupRows.forEach((r) => { r.ticked = r.piece.blocks.length === 1 && r.piece.vtds.length === 0; });
  T.applyCleanup();
});
await page.waitForTimeout(400);
check('block goes back to Pct 3', await page.evaluate(([k, g]) => {
  const T = window.TarrantRedraw; return T.state.blockOv.get(T.data.idxOf.get(k)).get(g) === 3;
}, [splitKey, target]));

console.log(`\n${pass} passed, ${fail} failed`);
console.log(errs.join('\n') || 'no page errors');
await b.close();
process.exit(fail ? 1 : 0);
