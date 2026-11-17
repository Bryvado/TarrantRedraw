// Browser test for plan persistence, split / merge undo, Clear and Save.
//
// Reproduces four bugs found on the live site (Nov 16) and checks they stay
// fixed: a loaded plan losing its splits on reload, undo/redo of split and
// merge leaving the block geometry behind, "Save a named copy" not
// autosaving, and Clear leaving precincts locked. Also covers the Save
// button, Ctrl+S, the Saved / Unsaved changes label and the load warning.
//
// Serves the repository through Playwright's request routing, so no web
// server is needed:
//
//   node tests/plan-persistence.mjs            # repository root by default
//   node tests/plan-persistence.mjs <dir>      # or another checkout
//
// Needs Playwright with Chromium (a local or global install).

import fs from 'fs';
import path from 'path';
import { openApp } from './harness.mjs';

const { page, boot, check, finish, clickText } = await openApp();

const KEY = 8255;
const S = () => page.evaluate((KEY) => {
  const T = window.TarrantRedraw, i = T.data.idxOf.get(KEY);
  const cur = JSON.parse(localStorage.getItem('tarrant-redraw/current') || 'null');
  const src = T.mapView.map.getSource('blocks')._data;
  const feats = (src && src.features) || [];
  return {
    split: T.state.isSplit(i), asn: T.state.asn[i], locks: T.state.locks.slice(), name: T.state.name,
    loaded: T.mapView.blockFeatures.has(i),
    drawn: feats.filter((f) => f.properties.vtdkey === KEY).length,
    savedSplit: !!(cur && cur.blockOv && cur.blockOv[KEY]),
    savedLocks: cur && cur.locks, savedName: cur && cur.name,
    saveState: document.querySelector('#save-state').textContent,
    card: document.querySelector('#unit-card').hidden ? null : document.querySelector('#unit-card').innerText,
  };
}, KEY);
const blockStates = () => page.evaluate((KEY) => {
  const T = window.TarrantRedraw, i = T.data.idxOf.get(KEY);
  const ov = T.state.blockOv.get(i); if (!ov) return null;
  let match = 0, n = 0;
  for (const [g, d] of ov) { n++; const fs = T.mapView.map.getFeatureState({ source: 'blocks', id: g }); if (fs.d === d) match++; }
  return { n, match, inPct3: [...ov.values()].filter((d) => d === 3).length };
}, KEY);


// ---------------- Bug 1: saved plan keeps its splits through Load + reload
console.log('\n# 1. Load a saved plan, then reload');
await page.click('#btn-start'); await clickText('Map 7'); await page.waitForTimeout(400);
await page.evaluate((KEY) => window.TarrantRedraw.doSplit(window.TarrantRedraw.data.idxOf.get(KEY)), KEY);
await page.waitForTimeout(800);
// Paint half the blocks to Pct 3 through the same path a brush stroke takes.
await page.evaluate((KEY) => {
  const T = window.TarrantRedraw, i = T.data.idxOf.get(KEY);
  const gs = [...T.state.blockOv.get(i).keys()];
  T.setActive(3);
  T.mapView.onPick({ blocks: gs.slice(0, Math.ceil(gs.length / 2)).map((g) => [g, KEY]) });
  T.mapView.onPick({ commit: true });
}, KEY);
await page.waitForTimeout(300);
await page.locator('.lockbtn').nth(1).click();                   // lock Pct 2 so locks round-trip too
await page.click('#btn-plans');
await page.locator('#modal input[type=text]').fill('A');
await clickText('Save a named copy'); await page.keyboard.press('Escape');
const beforeClear = await blockStates();
await page.click('#btn-clear'); await page.waitForTimeout(300);
await page.click('#btn-plans');
await page.locator('.m-row', { hasText: 'A' }).locator('button', { hasText: 'Load' }).click();
await page.waitForTimeout(300);
const warned = await page.locator('#modal').innerText();
check('Load warns about unsaved changes after Clear', /unsaved changes/i.test(warned) && /Save, then load/.test(warned));
if (await page.locator('#modal button', { hasText: 'Discard and load' }).count()) await clickText('Discard and load');
await page.waitForTimeout(1200);
let s = await S();
check('after Load: 8255 split, blocks drawn', s.split && s.drawn > 0, JSON.stringify({ split: s.split, drawn: s.drawn }));
check('after Load: autosave holds the split and the locks', s.savedSplit && JSON.stringify(s.savedLocks) === '[false,true,false,false]', JSON.stringify(s.savedLocks));
await page.reload(); await boot(); await page.waitForTimeout(800);
s = await S(); const afterReload = await blockStates();
check('after reload: 8255 still split, blocks drawn', s.split && s.drawn > 0, JSON.stringify({ split: s.split, drawn: s.drawn }));
check('after reload: same block assignment', afterReload && afterReload.inPct3 === beforeClear.inPct3 && afterReload.match === afterReload.n, JSON.stringify(afterReload));
check('after reload: Pct 2 still locked', JSON.stringify(s.locks) === '[false,true,false,false]', JSON.stringify(s.locks));
check('after reload: shows Saved', s.saveState === 'Saved', s.saveState);
await page.locator('.lockbtn').nth(1).click();                   // unlock for the next steps

// ---------------- Bug 2: undo / redo of merge and split restore block shapes
console.log('\n# 2. Undo / redo of split and merge');
await page.evaluate((KEY) => window.TarrantRedraw.select(window.TarrantRedraw.data.idxOf.get(KEY)), KEY);
s = await S();
check('card button names the outcome', /Undo split \(whole VTD goes to Pct \d\)/.test(s.card || ''), (s.card || '').split('\n').pop());
await page.locator('#unit-card button', { hasText: 'Undo split' }).click(); await page.waitForTimeout(400);
s = await S();
check('after Undo split: whole, no blocks drawn', !s.split && s.drawn === 0, JSON.stringify({ split: s.split, drawn: s.drawn }));
await page.click('#btn-undo'); await page.waitForTimeout(800);
s = await S(); let bs = await blockStates();
check('Undo of the merge: split again, blocks drawn', s.split && s.loaded && s.drawn > 0, JSON.stringify({ split: s.split, drawn: s.drawn }));
check('Undo of the merge: block colours restored', bs && bs.match === bs.n && bs.inPct3 === beforeClear.inPct3, JSON.stringify(bs));
await page.click('#btn-redo'); await page.waitForTimeout(500);
s = await S();
check('Redo of the merge: whole, no stale blocks', !s.split && s.drawn === 0 && !s.loaded, JSON.stringify({ split: s.split, drawn: s.drawn, loaded: s.loaded }));
// Undo of a fresh split must remove its blocks.
await page.evaluate((KEY) => window.TarrantRedraw.doSplit(window.TarrantRedraw.data.idxOf.get(KEY)), KEY);
await page.waitForTimeout(700);
await page.click('#btn-undo'); await page.waitForTimeout(500);
s = await S();
check('Undo of a split: whole, no stale blocks', !s.split && s.drawn === 0, JSON.stringify({ split: s.split, drawn: s.drawn }));
await page.click('#btn-redo'); await page.waitForTimeout(700);
s = await S();
check('Redo of a split: blocks drawn again', s.split && s.drawn > 0, JSON.stringify({ split: s.split, drawn: s.drawn }));
// Rapid undo/redo must settle on the final state.
await page.evaluate(() => { const st = window.TarrantRedraw.state; st.undo(); st.redo(); st.undo(); });
await page.waitForTimeout(900);
s = await S();
check('Rapid undo/redo/undo settles whole with no blocks', !s.split && s.drawn === 0, JSON.stringify({ split: s.split, drawn: s.drawn }));

// ---------------- Bug 3: Save a named copy autosaves
console.log('\n# 3. Save a named copy');
await page.click('#btn-plans');
await page.locator('#modal input[type=text]').fill('B');
await clickText('Save a named copy'); await page.keyboard.press('Escape');
s = await S();
check('autosave name follows the named copy', s.savedName === 'B' && s.name === 'B', JSON.stringify({ name: s.name, saved: s.savedName }));
await page.reload(); await boot();
check('after reload: plan is still named B', (await page.inputValue('#plan-name')) === 'B');

// ---------------- Bug 4: Clear unlocks, and undo puts the locks back
console.log('\n# 4. Clear and locks');
await page.locator('.lockbtn').nth(0).click(); await page.locator('.lockbtn').nth(3).click();
s = await S(); check('locked Pct 1 and 4', JSON.stringify(s.locks) === '[true,false,false,true]');
await page.click('#btn-clear'); await page.waitForTimeout(300);
s = await S();
check('Clear unlocks all four', JSON.stringify(s.locks) === '[false,false,false,false]', JSON.stringify(s.locks));
check('lock icons follow', (await page.locator('.lockbtn.locked').count()) === 0);
const painted = await page.evaluate(() => {
  const T = window.TarrantRedraw; T.setActive(1);
  T.mapView.onPick({ vtds: [0, 1, 2] }); T.mapView.onPick({ commit: true });
  return [0, 1, 2].every((i) => T.state.asn[i] === 1);
});
check('cleared map can be painted with Pct 1', painted);
await page.click('#btn-undo'); await page.waitForTimeout(200);   // the paint
await page.click('#btn-undo'); await page.waitForTimeout(400);   // the clear
s = await S();
check('Undo of Clear restores the locks', JSON.stringify(s.locks) === '[true,false,false,true]', JSON.stringify(s.locks));
check('lock icons follow the undo', (await page.locator('.lockbtn.locked').count()) === 2);
await page.click('#btn-redo'); await page.waitForTimeout(300);
s = await S(); check('Redo of Clear unlocks again', JSON.stringify(s.locks) === '[false,false,false,false]');

// ---------------- Save button / Ctrl+S / status
console.log('\n# Save button');
await page.click('#btn-start'); await clickText('Blank'); await page.waitForTimeout(300);
s = await S(); check('blank untitled plan shows no status', s.saveState === '', JSON.stringify(s.saveState));
await page.evaluate(() => { const T = window.TarrantRedraw; T.setActive(2); T.mapView.onPick({ vtds: [5] }); T.mapView.onPick({ commit: true }); });
s = await S(); check('an edit shows Unsaved changes', s.saveState === 'Unsaved changes', s.saveState);
await page.locator('#map').click({ position: { x: 5, y: 5 }, trial: true });
await page.keyboard.press('Control+s'); await page.waitForTimeout(200);
check('Ctrl+S on an untitled plan asks for a name', await page.locator('#modal', { hasText: 'Name this plan' }).isVisible());
await page.locator('#modal input[type=text]').fill('C'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
s = await S();
check('named and saved as C', s.name === 'C' && s.saveState === 'Saved' && s.savedName === 'C', JSON.stringify({ name: s.name, st: s.saveState }));
await page.evaluate(() => { const T = window.TarrantRedraw; T.mapView.onPick({ vtds: [6] }); T.mapView.onPick({ commit: true }); });
s = await S(); check('edit after save: Unsaved changes', s.saveState === 'Unsaved changes');
await page.click('#btn-save'); await page.waitForTimeout(200);
s = await S();
const cSaved = await page.evaluate(() => JSON.parse(localStorage.getItem('tarrant-redraw/plans')).C.asn[6]);
check('Save overwrites C without asking', s.saveState === 'Saved' && cSaved === '2' && !(await page.locator('#modal-back').isVisible()));
await page.click('#btn-undo'); await page.waitForTimeout(200);
s = await S(); check('undo past the save: Unsaved changes', s.saveState === 'Unsaved changes');
// Load with unsaved changes: Save, then load.
await page.click('#btn-plans');
await page.locator('.m-row', { hasText: /^A/ }).locator('button', { hasText: 'Load' }).click(); await page.waitForTimeout(200);
await clickText('Save, then load'); await page.waitForTimeout(1200);
s = await S();
const cNow = await page.evaluate(() => JSON.parse(localStorage.getItem('tarrant-redraw/plans')).C.asn[6]);
check('Save, then load: C saved first, then A loaded with its split', cNow === '0' && s.name === 'A' && s.split && s.drawn > 0, JSON.stringify({ cNow, name: s.name, split: s.split }));
// Load with no unsaved changes: no prompt.
await page.click('#btn-plans');
await page.locator('.m-row', { hasText: /^C/ }).locator('button', { hasText: 'Load' }).click(); await page.waitForTimeout(700);
s = await S(); check('clean plan loads straight away', s.name === 'C' && !(await page.locator('#modal-back').isVisible()));

await finish();
