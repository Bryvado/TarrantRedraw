// Wiring: data -> state -> map + panel, plus the toolbar, dialogs and the
// block-splitting flow.

import { loadAll, loadBlocks } from './data.js';
import { PlanState, planLib, prefs } from './state.js';
import { computeMetrics } from './metrics.js';
import { buildTopology } from './topology.js';
import { MapView, SHADE_MODES, setPartisanPalette } from './mapview.js';
import { Panel } from './panel.js';
import {
  PRECINCT, UNASSIGNED, NODATA, gradientCSS, ramp, PARTISAN_PALETTES, DEFAULT_PARTISAN,
} from './colors.js';
import {
  vtdCSV, blockCSV, dissolvedGeoJSON, flattenToVtd,
  sniffCSV, applyVtdImport, applyBlockImport, DRA_HEADERS,
} from './io.js';
import { $, el, fmtInt, fmtPct, fmtSigned, download } from './util.js';

const PLAN_LABELS = {
  map7: 'Map 7 — enacted 2025',
  rpack: 'R-pack — Republicans packed into one precinct',
  pre2025: 'Pre-2025 precincts',
};

let data, topo, state, mapView, panel;
let activePrecinct = 1;
let refMetrics = null;
let lastMetrics = null;
let hoverTarget = null;
let onlyUnassigned = false;
const BRUSH_PX = [2, 9, 18, 30, 46];     // slider 1..5 -> half-width in pixels

// ---------------------------------------------------------------- boot ----
boot().catch((err) => {
  console.error(err);
  $('#boot-msg').innerHTML =
    `<span class="err">Could not load data.<br>${String(err.message || err)}</span>`
    + '<br><br>Serve the folder over HTTP (for example <code>python3 -m http.server</code>); '
    + 'opening index.html straight from disk will not work, because the browser blocks fetch on file:// URLs.';
});

async function boot() {
  const bar = $('#boot-bar-fill'), msg = $('#boot-msg');
  data = await loadAll((frac, text) => {
    bar.style.width = `${Math.round(frac * 92)}%`;
    msg.textContent = text;
  });

  msg.textContent = 'Building topology…';
  await new Promise((r) => setTimeout(r, 0));
  topo = buildTopology(data.vtdGeo, data.idxOf);

  state = new PlanState(data);
  panel = new Panel($('#panel-body'), {
    onTolerance: (t) => { prefs.set('tolerance', t); refMetrics = null; recompute(true); },
  });
  panel.tolerance = prefs.get('tolerance', 0.05);
  panel.compare = prefs.get('compare', true);
  $('#cmp-map7').checked = panel.compare;

  msg.textContent = 'Starting map…';
  bar.style.width = '96%';
  mapView = new MapView('map', data, topo, state);
  await mapView.init();

  mapView.onPick = handlePick;
  mapView.onHover = handleHover;

  buildPrecinctList();
  wireToolbar();
  wireTools();
  renderLegend();

  // Restore the autosaved plan; with none, the plan starts blank.
  state.restore();
  await rehydrateSplits();

  state.on(onStateChange);
  buildPrecinctList();
  $('#plan-name').value = state.name;
  mapView.syncAllStates();
  mapView.refreshOutlines();
  recompute(true);
  updateUndoButtons();

  // Handle for the browser-side check suite and for debugging from the console.
  window.TarrantRedraw = {
    get data() { return data; }, get state() { return state; },
    get mapView() { return mapView; }, get panel() { return panel; },
    get metrics() { return lastMetrics; }, get refMetrics() { return refMetrics; },
    get topo() { return topo; },
    recompute, computeMetrics, vtdCSV, blockCSV, dissolvedGeoJSON,
    sniffCSV, applyVtdImport, applyBlockImport, flattenToVtd,
    setActive: (d) => setActive(d),
    doSplit, doUnsplit,
  };

  bar.style.width = '100%';
  $('#boot').classList.add('done');
  setStatus(`${data.n} VTDs loaded · ${fmtInt(data.countyPop)} people`, 'ok');
}

/** A restored plan may name split VTDs whose block geometry is not loaded yet. */
async function rehydrateSplits() {
  const idxs = state.splitIndices();
  if (!idxs.length) return;
  setStatus(`Loading blocks for ${idxs.length} split VTD${idxs.length > 1 ? 's' : ''}…`);
  for (const idx of idxs) {
    try {
      const gj = await loadBlocks(data.keys[idx]);
      mapView.addBlockFeatures(idx, gj.features);
    } catch (e) {
      state.blockOv.delete(idx);
      setStatus(`Could not load blocks for VTD ${data.keys[idx]}; the split was dropped.`, 'warn');
    }
  }
}

// ------------------------------------------------------------ recompute ----
let metricTimer = null, outlineTimer = null;

function scheduleRecompute() {
  if (metricTimer) return;
  metricTimer = requestAnimationFrame(() => { metricTimer = null; recompute(false); });
}
function scheduleOutlines() {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(() => mapView.refreshOutlines(), 130);
}

function recompute(force) {
  const blockProps = state.splitCount ? mapView.blockPropsIndex() : null;
  lastMetrics = computeMetrics(data, state.asn, {
    blockOv: state.splitCount ? state.blockOv : null,
    blockProps,
    tolerance: panel.tolerance,
  });
  if (!refMetrics || force) {
    refMetrics = computeMetrics(data, data.planCols.map7, { tolerance: panel.tolerance });
  }
  panel.render(lastMetrics, refMetrics);
  updatePrecinctPops(lastMetrics);
  updateMapNote(lastMetrics);
  applyAggShading();
}

// Shading modes that can be totalled for a drawn precinct, and the metrics
// field that holds the total. The baseline and the shift cannot: the data has
// no baseline vote counts to sum.
const AGG_FIELD = { dshare: 'dshare', share26: 'share26', hisp: 'hisp', black: 'black', nonwhite: 'nonwhite' };
let aggOn = false, aggKey = '';
let partisanPal = PARTISAN_PALETTES[DEFAULT_PARTISAN];

/**
 * "Shade by drawn precinct totals": colour each drawn precinct by its own
 * running total on the current measure, so the colour moves as units are added.
 */
function applyAggShading() {
  const mode = $('#shade-mode').value;
  const field = AGG_FIELD[mode];
  const box = $('#opt-agg');
  box.disabled = mode !== 'district' && !field;
  box.closest('label').title = box.disabled
    ? 'Not available for this measure: the data has no baseline vote counts to total by precinct.' : '';
  const active = aggOn && !!field && !!lastMetrics;
  let colors = null;
  if (active) {
    const m = SHADE_MODES[mode];
    colors = [null];
    for (let d = 1; d <= 4; d++) {
      const v = lastMetrics.rows[d][field];
      colors.push(v == null ? NODATA : ramp(m.ramp, (v - m.lo) / (m.hi - m.lo)));
    }
  }
  const key = `${mode}|${$('#partisan-palette').value}|${colors ? colors.join() + [1, 2, 3, 4].map((d) => lastMetrics.rows[d][field]).join() : ''}`;
  if (key === aggKey) return;
  aggKey = key;
  mapView.setAggColors(colors);
  renderLegend(colors);
}

const WHOLE_PLAN_EDITS = new Set(['clear', 'start', 'import']);

function onStateChange(detail) {
  if (detail.kind === 'reset') {
    mapView.syncAllStates();
    mapView.pushBlockSource();
    mapView.refreshOutlines();
    $('#plan-name').value = state.name;
    buildPrecinctList();
    recompute(false);
  } else if (detail.kind === 'edit' && WHOLE_PLAN_EDITS.has(detail.tx.label)) {
    // Clear, Start from… and Import replace the whole assignment in one step.
    mapView.syncAllStates();
    mapView.pushBlockSource();
    mapView.refreshOutlines();
    recompute(false);
  } else if (detail.kind === 'undo' || detail.kind === 'redo') {
    const t = detail.touched;
    for (const i of t.vtds) mapView.setVtdState(i, state.asn[i]);
    for (const i of t.splits) mapView.setVtdState(i, state.asn[i]);
    if (t.splits.length) mapView.pushBlockSource();
    for (const [i, g] of t.blocks) {
      const ov = state.blockOv.get(i);
      if (ov) mapView.map.setFeatureState({ source: 'blocks', id: g }, { d: ov.get(g) });
    }
    mapView.refreshOutlines();
    recompute(false);
  }
  updateUndoButtons();
}

// --------------------------------------------------------------- picking ----
function handlePick({ vtds, blocks, erase, commit, fill }) {
  if (commit) {
    if (state.commit('paint')) { scheduleRecompute(); scheduleOutlines(); }
    return;
  }
  const target = erase ? 0 : activePrecinct;
  if (target !== 0 && state.isLocked(target)) {
    setStatus(`Precinct ${target} is locked.`, 'warn');
    return;
  }

  if (fill !== undefined) { fillRegion(fill, target); return; }

  // "Paint unassigned only" protects everything already drawn. Erasing is exempt.
  if (onlyUnassigned && target !== 0) {
    if (vtds) vtds = vtds.filter((i) => state.asn[i] === 0);
    if (blocks) {
      blocks = blocks.filter(([g, key]) => {
        const ov = state.blockOv.get(data.idxOf.get(key));
        return ov && (ov.get(g) ?? 0) === 0;
      });
    }
  }

  if (vtds && vtds.length) {
    const changed = state.paint(vtds, target);
    for (const i of changed) mapView.setVtdState(i, target);
    if (changed.length) { scheduleRecompute(); scheduleOutlines(); }
  }

  if (blocks && blocks.length) {
    const byVtd = new Map();
    for (const [g, key] of blocks) {
      const idx = data.idxOf.get(key);
      if (idx === undefined || !state.isSplit(idx)) continue;
      let a = byVtd.get(idx);
      if (!a) { a = []; byVtd.set(idx, a); }
      a.push(g);
    }
    let any = false;
    for (const [idx, gs] of byVtd) {
      const changed = state.paintBlocks(idx, gs, target);
      for (const g of changed) {
        mapView.map.setFeatureState({ source: 'blocks', id: g }, { d: target });
      }
      if (changed.length) any = true;
    }
    if (any) { scheduleRecompute(); scheduleOutlines(); }
  }
}

/**
 * Flood fill: give the clicked VTD, and every VTD connected to it that shares
 * its current assignment, to the target. Filling an unassigned pocket is the
 * common use; filling a precinct recolours that whole contiguous piece.
 */
function fillRegion(start, target) {
  if (start === undefined) return;
  if (state.isSplit(start)) { setStatus('Fill works on whole VTDs; this one is split into blocks.', 'warn'); return; }
  const from = state.asn[start];
  if (from === target) return;
  if (state.isLocked(from)) { setStatus(`Precinct ${from} is locked.`, 'warn'); return; }
  const seen = new Uint8Array(data.n);
  const stack = [start], region = [];
  seen[start] = 1;
  while (stack.length) {
    const v = stack.pop();
    region.push(v);
    for (let k = data.nbrStart[v]; k < data.nbrStart[v + 1]; k++) {
      const w = data.nbr[k];
      if (!seen[w] && state.asn[w] === from && !state.isSplit(w)) { seen[w] = 1; stack.push(w); }
    }
  }
  const changed = state.paint(region, target);
  for (const i of changed) mapView.setVtdState(i, target);
  if (state.commit('paint')) {
    scheduleRecompute(); scheduleOutlines();
    setStatus(`Filled ${changed.length} VTD${changed.length === 1 ? '' : 's'} `
      + `${target ? `into Precinct ${target}` : 'back to unassigned'}. Z undoes it.`);
  }
}

function handleHover(feat) {
  if (!feat) { hoverTarget = null; return; }
  const isBlock = feat.layer.id === 'blocks-fill';
  hoverTarget = isBlock
    ? { kind: 'block', geoid: feat.properties.GEOID20, key: feat.properties.vtdkey, p: feat.properties }
    : { kind: 'vtd', key: feat.properties.vtdkey, idx: data.idxOf.get(feat.properties.vtdkey), p: feat.properties };
  renderUnitInfo();
}

function renderUnitInfo() {
  const box = $('#unit-info');
  if (!hoverTarget) { box.textContent = 'Hover or click a VTD.'; return; }
  const t = hoverTarget;
  const rows = [];
  const add = (k, v) => rows.push(`<tr><td>${k}</td><td>${v}</td></tr>`);

  if (t.kind === 'vtd') {
    const i = t.idx, p = t.p;
    const d = state.asn[i];
    box.innerHTML = `<div class="ui-head">VTD ${t.key}</div>`;
    add('Precinct', d === 0 ? 'unassigned' : `${d}`);
    add('City', p.city_name ?? '—');
    add('Community', data.comm[i] != null ? (data.commName.get(data.comm[i]) ?? data.comm[i]) : '—');
    add('Population', fmtInt(data.num.pop[i]));
    add('VAP', fmtInt(data.num.vap[i]));
    add('Hisp / Black VAP', `${fmtPct(p.f_hisp, 0)} / ${fmtPct(p.f_black, 0)}`);
    add('Nonwhite VAP', fmtPct(p.f_nonwhite, 0));
    add('D composite', p.dshare == null ? 'no votes' : fmtPct(p.dshare));
    add('D 2026', p.share26 == null ? 'no votes' : fmtPct(p.share26));
    add('D baseline 20–24', p.dshare_pre == null ? 'no votes' : fmtPct(p.dshare_pre));
    add('2026 shift', p.shift26 == null ? '—' : fmtSigned(p.shift26));
    box.insertAdjacentHTML('beforeend', `<table>${rows.join('')}</table>`);

    if (state.isSplit(i)) {
      const ov = state.blockOv.get(i);
      box.insertAdjacentHTML('beforeend',
        `<div class="legend-note">Split into ${ov.size} blocks.</div>`);
      box.append(el('button', { text: 'Merge back to one VTD', onclick: () => doUnsplit(i) }));
    } else {
      box.append(el('button', { text: 'Split this VTD into blocks', onclick: () => doSplit(i) }));
    }
  } else {
    const p = t.p;
    box.innerHTML = `<div class="ui-head">Block ${t.geoid}</div>`;
    const idx = data.idxOf.get(t.key);
    const ov = idx !== undefined ? state.blockOv.get(idx) : null;
    add('Precinct', ov ? (ov.get(t.geoid) || 'unassigned') : '—');
    add('In VTD', t.key);
    add('Population', fmtInt(p.pop));
    add('VAP', fmtInt(p.vap));
    add('Hisp / Black VAP', `${fmtPct(p.f_hisp, 0)} / ${fmtPct(p.f_black, 0)}`);
    add('D composite *', p.dshare == null ? 'no votes' : fmtPct(p.dshare));
    add('D 2026 *', p.share26 == null ? 'no votes' : fmtPct(p.share26));
    box.insertAdjacentHTML('beforeend', `<table>${rows.join('')}</table>`);
    box.insertAdjacentHTML('beforeend',
      '<div class="legend-note">* Block-level partisan figures are estimates: the VTD’s '
      + 'votes are spread across its blocks by voting-age population.</div>');
  }
}

// ------------------------------------------------------- precinct picker ----
function buildPrecinctList() {
  const host = $('#precinct-list');
  host.innerHTML = '';
  for (let d = 1; d <= 4; d++) {
    const btn = el('button', {
      class: 'pk' + (activePrecinct === d ? ' on' : ''),
      'data-d': d,
      onclick: (e) => { if (!e.target.closest('.lockbtn')) setActive(d); },
    }, [
      el('span', { class: 'swatch', style: `background:${PRECINCT[d - 1]}` }),
      el('span', { class: 'pk-name', text: `Precinct ${d}` }),
      el('span', { class: 'pk-pop', 'data-pop': d, text: '—' }),
      el('button', {
        class: 'lockbtn' + (state.locks[d - 1] ? ' locked' : ''),
        title: state.locks[d - 1] ? 'Locked — click to unlock' : 'Lock this precinct',
        text: state.locks[d - 1] ? '\u{1F512}' : '\u{1F513}',
        onclick: (e) => { e.stopPropagation(); toggleLock(d); },
      }),
    ]);
    host.append(btn);
  }
  const u = $('#btn-unassign');
  u.classList.toggle('on', activePrecinct === 0);
  if (lastMetrics) updatePrecinctPops(lastMetrics);
}

function setActive(d) {
  activePrecinct = d;
  for (const b of document.querySelectorAll('.pk')) {
    b.classList.toggle('on', Number(b.dataset.d) === d);
  }
  $('#btn-unassign').classList.toggle('on', d === 0);
}

function toggleLock(d) {
  state.locks[d - 1] = !state.locks[d - 1];
  state.autosave();
  buildPrecinctList();
  setStatus(`Precinct ${d} ${state.locks[d - 1] ? 'locked' : 'unlocked'}.`);
}

function updatePrecinctPops(mx) {
  for (let d = 1; d <= 4; d++) {
    const n = document.querySelector(`[data-pop="${d}"]`);
    if (n) {
      n.textContent = fmtInt(mx.rows[d].pop);
      n.className = 'pk-pop' + (mx.rows[d].overTol ? ' flag-bad' : '');
    }
  }
}

function updateMapNote(mx) {
  const bad = mx.geom.slice(1).filter((g) => !g.contiguous && !g.empty);
  const note = $('#map-note');
  const bits = [];
  if (bad.length) {
    bits.push(`⚠ Discontiguous: ${bad.map((g) => `Precinct ${g.d} is in ${g.components} pieces`).join('; ')}.`);
  }
  if (mx.rows[0].units) bits.push(`${fmtInt(mx.rows[0].units)} VTDs unassigned (${fmtInt(mx.rows[0].pop)} people).`);
  note.innerHTML = bits.join('<br>');
  note.classList.toggle('on', bits.length > 0);
}

// -------------------------------------------------------------- toolbar ----
function wireToolbar() {
  $('#btn-undo').onclick = () => state.undo();
  $('#btn-redo').onclick = () => state.redo();
  $('#btn-clear').onclick = () => {
    if (state.clearAll()) setStatus('Cleared every assignment. Undo restores it.');
    else setStatus('Nothing to clear.');
  };
  $('#plan-name').onchange = (e) => {
    state.name = e.target.value.trim() || 'Untitled plan';
    e.target.value = state.name;
    state.autosave();
  };
  $('#btn-plans').onclick = showPlansDialog;
  $('#btn-start').onclick = showStartDialog;
  $('#btn-export-block').onclick = () => exportBlocks();
  $('#btn-export-menu').onclick = showExportDialog;
  $('#btn-import').onclick = showImportDialog;
  $('#cmp-map7').onchange = (e) => {
    panel.compare = e.target.checked;
    prefs.set('compare', panel.compare);
    recompute(false);
  };

  window.addEventListener('keydown', (e) => {
    if (isTyping()) return;
    if (!$('#modal-back').hidden) { if (e.key === 'Escape') closeModal(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? state.redo() : state.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault(); state.redo();
    } else if (mod || e.altKey) {
      // Leave every other browser shortcut alone (Ctrl+R still reloads).
    } else if (/^[0-4]$/.test(e.key)) {
      setActive(Number(e.key));
    } else if (e.key === 'Escape') {
      closeModal();
    } else {
      const k = e.key.toLowerCase();
      if (k === 'z') state.undo();
      else if (k === 'r') state.redo();
      else if (k === 'e') setActive(0);
      else if (k === 'b') setBrushMode('click');
      else if (k === 'm') setBrushMode('box');
      else if (k === 'f') setBrushMode('fill');
      else if (k === 'h') setBrushMode('pan');
      else if (k === '[') stepBrushSize(-1);
      else if (k === ']') stepBrushSize(1);
      else if (k === 'u') { const c = $('#opt-only-unassigned'); c.checked = !c.checked; c.onchange(); }
      else if (k === 'l') { if (activePrecinct) toggleLock(activePrecinct); }
      else if (k === 'i') eyedropper();
      else if (k === 't') { const c = $('#opt-agg'); if (!c.disabled) { c.checked = !c.checked; c.onchange(); } }
      else if (k === '?' || k === '/') showKeysDialog();
    }
  });
}

/** True while the user is typing in a field, so single-key shortcuts stay out of the way. */
function isTyping() {
  const a = document.activeElement;
  if (!a) return false;
  if (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') return true;
  return a.tagName === 'INPUT' && /^(text|number|search|)$/.test(a.type || '');
}

function updateUndoButtons() {
  $('#btn-undo').disabled = !state.canUndo();
  $('#btn-redo').disabled = !state.canRedo();
}

function setStatus(text, cls = '') {
  const n = $('#status');
  n.textContent = text;
  n.className = 'tb-status ' + cls;
  clearTimeout(setStatus._t);
  if (text) setStatus._t = setTimeout(() => { n.textContent = ''; n.className = 'tb-status'; }, 7000);
}

// ---------------------------------------------------------------- tools ----
function wireTools() {
  $('#btn-unassign').onclick = () => setActive(0);

  for (const r of document.querySelectorAll('#brush-mode input')) {
    r.onchange = () => mapView.setBrushMode(r.value);
  }
  mapView.setBrushMode('click');

  const size = $('#brush-size');
  size.value = prefs.get('brushSize', 1);
  size.oninput = () => {
    mapView.setBrushRadius(BRUSH_PX[size.value - 1]);
    prefs.set('brushSize', Number(size.value));
  };
  size.oninput();

  const only = $('#opt-only-unassigned');
  only.onchange = () => {
    onlyUnassigned = only.checked;
    setStatus(onlyUnassigned ? 'Painting unassigned units only; drawn precincts are protected.'
      : 'Painting over any unlocked unit.');
  };
  $('#btn-keys').onclick = showKeysDialog;
  // Radios, checkboxes and the slider give focus back once used, so Space and
  // the single-key shortcuts keep working straight after a click.
  $('#tools').addEventListener('change', (e) => {
    if (e.target.matches('input[type=radio],input[type=checkbox],input[type=range]')) e.target.blur();
  });

  // Party colours: red / blue unless the user picked another palette.
  const pal = $('#partisan-palette');
  for (const [k, p] of Object.entries(PARTISAN_PALETTES)) {
    pal.append(el('option', { value: k }, [p.label + (k === DEFAULT_PARTISAN ? '' : ' (colorblind-friendly)')]));
  }
  pal.value = PARTISAN_PALETTES[prefs.get('partisanPalette')] ? prefs.get('partisanPalette') : DEFAULT_PARTISAN;
  partisanPal = setPartisanPalette(pal.value);
  pal.onchange = () => {
    partisanPal = setPartisanPalette(pal.value);
    prefs.set('partisanPalette', pal.value);
    mapView.setShadeMode($('#shade-mode').value);
    aggKey = '';
    renderLegend();
    applyAggShading();
    pal.blur();
  };

  const sel = $('#shade-mode');
  sel.value = prefs.get('shade', 'district');
  sel.onchange = () => {
    mapView.setShadeMode(sel.value);
    prefs.set('shade', sel.value);
    renderLegend();
    applyAggShading();
  };
  mapView.setShadeMode(sel.value);

  const agg = $('#opt-agg');
  agg.checked = aggOn = prefs.get('aggShade', false);
  agg.onchange = () => {
    aggOn = agg.checked;
    prefs.set('aggShade', aggOn);
    applyAggShading();
    if (aggOn && $('#shade-mode').value === 'district') {
      setStatus('Pick a partisan or demographic shading to see precinct totals.');
    }
  };

  $('#opt-opacity').onchange = (e) => mapView.setDimUnder(e.target.checked);

  const ov = [['#ov-map7', 'ov-map7'], ['#ov-cities', 'ov-cities'], ['#ov-comm', 'ov-comm']];
  for (const [sel2, layer] of ov) {
    const node = $(sel2);
    node.checked = prefs.get('ovl.' + layer, false);
    mapView.setOverlay(layer, node.checked);
    node.onchange = () => { mapView.setOverlay(layer, node.checked); prefs.set('ovl.' + layer, node.checked); };
  }
  const lab = $('#ov-labels');
  lab.checked = prefs.get('labels', true);
  mapView.setLabels(lab.checked);
  lab.onchange = () => { mapView.setLabels(lab.checked); prefs.set('labels', lab.checked); };
}

function setBrushMode(mode) {
  const r = document.querySelector(`#brush-mode input[value="${mode}"]`);
  if (!r) return;
  r.checked = true;
  mapView.setBrushMode(mode);
}

function stepBrushSize(delta) {
  const size = $('#brush-size');
  size.value = Math.max(1, Math.min(5, Number(size.value) + delta));
  size.oninput();
}

/** Make the precinct under the cursor the active one. */
function eyedropper() {
  const t = hoverTarget;
  if (!t) return;
  let d;
  if (t.kind === 'vtd') d = state.asn[t.idx];
  else { const ov = state.blockOv.get(data.idxOf.get(t.key)); d = ov ? (ov.get(t.geoid) ?? 0) : 0; }
  setActive(d);
  setStatus(d ? `Picked Precinct ${d}.` : 'Picked the eraser (unassigned).');
}

function showKeysDialog() {
  const rows = [
    ['Left-drag', 'Paint with the active precinct'],
    ['Right-drag, or Alt+drag', 'Erase (works with brush, box and fill)'],
    ['Shift+drag', 'Box select, whatever tool is active'],
    ['Space+drag', 'Pan the map; the wheel zooms'],
    ['1 2 3 4', 'Pick a precinct'],
    ['0 or E', 'Pick the eraser'],
    ['I', 'Pick the precinct under the cursor'],
    ['B / M / F / H', 'Brush / box select / fill region / pan'],
    ['[ and ]', 'Smaller / larger brush'],
    ['U', 'Paint unassigned only, on or off'],
    ['L', 'Lock or unlock the active precinct'],
    ['T', 'Shade by drawn precinct totals, on or off'],
    ['Z or Ctrl+Z', 'Undo'],
    ['R, Ctrl+Shift+Z or Ctrl+Y', 'Redo'],
    ['?', 'This list'],
  ];
  const t = el('table', { class: 'keys' });
  t.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  openModal('Shortcuts', [
    t,
    el('p', { style: 'margin-top:12px', class: 'tight', html:
      '<span class="cmp">Fill region gives the clicked VTD, and everything connected to it with the same '
      + 'assignment, to the active precinct. Ctrl+R is left alone, so it still reloads the page.</span>' }),
  ]);
}

function renderLegend(aggColors = mapView.aggColors) {
  const mode = $('#shade-mode').value;
  const m = SHADE_MODES[mode];
  const host = $('#legend');
  if (mode === 'district') {
    host.innerHTML = `<div class="legend-ends" style="display:grid;grid-template-columns:1fr 1fr;gap:4px 8px;color:var(--fg2);font-family:inherit;font-size:11px">
      ${[1, 2, 3, 4].map((d) =>
        `<span><span class="pdot" style="background:${PRECINCT[d - 1]}"></span>Pct ${d}</span>`).join('')}
      <span><span class="pdot" style="background:${UNASSIGNED}"></span>Unassigned</span>
    </div>`;
    return;
  }
  const pct = (x) => (mode === 'shift26' ? fmtSigned(x, 0) : fmtPct(x, 0));
  host.innerHTML = `
    <div class="legend-bar" style="background:${gradientCSS(m.ramp)}"></div>
    <div class="legend-ends"><span>${pct(m.lo)}</span>
      <span>${m.mid != null ? pct(m.mid) : ''}</span><span>${pct(m.hi)}</span></div>
    <div class="legend-note">
      <span class="pdot" style="background:${NODATA}"></span>
      no data (${mode.startsWith('f_') || m.prop.startsWith('f_') ? 'zero VAP' : 'zero votes'})
      ${m.partisan ? `<br>${partisanPal.dem} = Democratic, ${partisanPal.rep.toLowerCase()} = Republican.` : ''}
      ${mode === 'shift26' ? '<br>Green = shift toward Democrats, purple = toward Republicans.' : ''}
    </div>`;
  if (aggColors && AGG_FIELD[mode] && lastMetrics) {
    host.insertAdjacentHTML('beforeend', `<div class="agg-legend">
      <div class="legend-note">Each drawn precinct is filled with its own total. It updates as you paint.</div>
      ${[1, 2, 3, 4].map((d) => `<span><span class="pdot" style="background:${aggColors[d]}"></span>Pct ${d}
        <b>${fmtPct(lastMetrics.rows[d][AGG_FIELD[mode]])}</b></span>`).join('')}
    </div>`);
  }
}

// ------------------------------------------------------- block splitting ----
async function doSplit(idx) {
  const key = data.keys[idx];
  if (state.isSplit(idx)) return;
  const t0 = performance.now();
  setStatus(`Loading blocks for VTD ${key}…`);
  try {
    const gj = await loadBlocks(key);
    state.split(idx, gj.features.map((f) => f.properties.GEOID20));
    state.commit('split');
    mapView.addBlockFeatures(idx, gj.features);
    mapView.setVtdState(idx, state.asn[idx]);
    mapView.refreshOutlines();
    recompute(false);
    // Frame the VTD so its blocks are workable.
    const b = bboxOf(data.vtdGeo.features.find((f) => f.properties.vtdkey === key));
    if (b) mapView.map.fitBounds(b, { padding: 80, duration: 400, maxZoom: 15 });
    setStatus(`VTD ${key} split into ${gj.features.length} blocks in ${Math.round(performance.now() - t0)} ms.`, 'ok');
    renderUnitInfo();
  } catch (e) {
    setStatus(`Could not load blocks for VTD ${key}: ${e.message}`, 'warn');
  }
}

function doUnsplit(idx) {
  const pop = mapView.blockPopMap(idx);
  state.unsplit(idx, pop);
  state.commit('merge');
  mapView.removeBlockFeatures(idx);
  mapView.setVtdState(idx, state.asn[idx]);
  mapView.refreshOutlines();
  recompute(false);
  setStatus(`VTD ${data.keys[idx]} merged back to Precinct ${state.asn[idx] || 'unassigned'}.`);
  renderUnitInfo();
}

function bboxOf(feature) {
  if (!feature) return null;
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0];
      if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1];
    } else for (const k of c) walk(k);
  };
  walk(feature.geometry.coordinates);
  return [[x0, y0], [x1, y1]];
}

// --------------------------------------------------------------- dialogs ----
function openModal(title, bodyNodes, footNodes) {
  const back = $('#modal-back'), box = $('#modal');
  box.innerHTML = '';
  box.append(el('div', { class: 'm-head' }, [
    el('h2', { html: title }),
    el('button', { class: 'm-close', text: '×', onclick: closeModal }),
  ]));
  box.append(el('div', { class: 'm-body' }, bodyNodes));
  if (footNodes) box.append(el('div', { class: 'm-foot' }, footNodes));
  back.hidden = false;
  back.onclick = (e) => { if (e.target === back) closeModal(); };
}
function closeModal() { $('#modal-back').hidden = true; }

// ---- start from ----
function showStartDialog() {
  const options = [
    el('button', {
      style: 'width:100%;text-align:left;margin-bottom:6px',
      text: 'Blank — every VTD unassigned',
      onclick: () => { state.clearAll(); state.name = 'Untitled plan'; $('#plan-name').value = state.name; closeModal(); setStatus('Started from blank.'); },
    }),
  ];
  for (const col of Object.keys(data.planCols)) {
    options.push(el('button', {
      style: 'width:100%;text-align:left;margin-bottom:6px',
      text: PLAN_LABELS[col] || col,
      onclick: () => {
        state.setAll(data.planCols[col], { name: `${col} (copy)`, clearHistory: false, label: 'start' });
        closeModal();
        setStatus(`Started from ${col}.`, 'ok');
      },
    }));
  }
  openModal('Start from…', [
    el('p', { text: 'This replaces the current assignment. It can be undone.' }),
    ...options,
    el('p', { class: 'tight', style: 'margin-top:12px', html:
      '<span class="cmp">Reference plans come from <code>data/plans.csv</code>; any extra column '
      + 'added in a data refresh appears here automatically.</span>' }),
  ]);
}

// ---- named plans ----
function showPlansDialog() {
  const list = el('div');
  const refresh = () => {
    list.innerHTML = '';
    const names = planLib.names();
    if (!names.length) {
      list.append(el('p', { class: 'tight', text: 'No saved plans yet.' }));
      return;
    }
    for (const name of names) {
      const p = planLib.get(name);
      const digits = (p.asn || '').split('');
      const assigned = digits.filter((c) => c !== '0').length;
      list.append(el('div', { class: 'm-row' }, [
        el('span', { class: 'mr-name', text: name }),
        el('span', { class: 'mr-meta', text:
          `${assigned}/${data.n} assigned${p.blockOv && Object.keys(p.blockOv).length
            ? ` · ${Object.keys(p.blockOv).length} split` : ''}` }),
        el('button', { text: 'Load', onclick: async () => {
          state.fromJSON(p);
          await rehydrateSplits();
          mapView.syncAllStates(); mapView.pushBlockSource(); mapView.refreshOutlines();
          recompute(false);
          closeModal(); setStatus(`Loaded “${name}”.`, 'ok');
        } }),
        el('button', { text: 'Duplicate', onclick: () => {
          const nn = planLib.uniqueName(name);
          planLib.save(nn, { ...p, name: nn });
          refresh(); setStatus(`Duplicated as “${nn}”.`);
        } }),
        el('button', { text: 'Delete', onclick: () => {
          if (!confirm(`Delete the saved plan “${name}”? This cannot be undone.`)) return;
          planLib.remove(name); refresh(); setStatus(`Deleted “${name}”.`);
        } }),
      ]));
    }
  };
  refresh();

  const nameInput = el('input', { type: 'text', value: state.name, spellcheck: 'false' });
  openModal('Saved plans', [
    el('p', { html: 'The plan you are drawing is autosaved continuously. Saving here keeps a '
      + 'separate named copy. Everything lives in this browser’s local storage only.' }),
    el('label', { class: 'fld' }, ['Save the current plan as', nameInput]),
    el('button', { text: 'Save a named copy', class: 'primary', onclick: () => {
      const n = nameInput.value.trim();
      if (!n) return;
      const existing = planLib.get(n);
      if (existing && !confirm(`Overwrite the saved plan “${n}”?`)) return;
      state.name = n;
      $('#plan-name').value = n;
      if (planLib.save(n, state.toJSON())) { refresh(); setStatus(`Saved “${n}”.`, 'ok'); }
      else setStatus('Could not save: local storage is full or unavailable.', 'warn');
    } }),
    el('h3', { style: 'margin:16px 0 4px;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--fg3)', text: 'Saved' }),
    list,
  ]);
}

// ---- exports ----
function showExportDialog() {
  const { flattened } = flattenToVtd(state, (i) => mapView.blockPopMap(i));
  const warn = flattened.length
    ? el('p', { class: 'err', html:
      `⚠ This plan splits ${flattened.length} VTD${flattened.length > 1 ? 's' : ''} `
      + `(${flattened.map((i) => data.keys[i]).join(', ')}). The VTD-level CSV flattens each one to the `
      + 'precinct holding most of its population. Use the block CSV to keep the splits.' })
    : null;
  const unassigned = lastMetrics.rows[0].units;

  openModal('Export', [
    warn,
    unassigned ? el('p', { class: 'err', html:
      `⚠ ${unassigned} VTDs are unassigned; they are written as district <code>0</code>.` }) : null,

    el('h3', { style: 'margin:0 0 4px;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--fg3)', text: 'VTD assignment CSV' }),
    el('p', { class: 'tight', html: 'Header <code>vtdkey,district</code>, one row per VTD, '
      + `${data.n} rows. Plain enough to read straight into R as a reference plan.` }),
    el('button', { text: 'Download VTD CSV', onclick: () => {
      const { asn } = flattenToVtd(state, (i) => mapView.blockPopMap(i));
      download(`${slug(state.name)}_vtd.csv`, vtdCSV(data, asn));
      setStatus(`Exported ${data.n} VTD rows.`, 'ok');
    } }),

    el('h3', { style: 'margin:18px 0 4px;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--fg3)', text: 'Dissolved precinct GeoJSON' }),
    el('p', { class: 'tight', html: 'Precinct polygons with population, VAP shares, partisan shares, '
      + 'contiguity and Polsby-Popper as properties. EPSG:4326.' }),
    el('button', { text: 'Download GeoJSON', onclick: () => {
      const txt = dissolvedGeoJSON(data, topo, state, lastMetrics, (i) => mapView.blockPopMap(i));
      download(`${slug(state.name)}_precincts.geojson`, txt, 'application/geo+json');
      setStatus('Exported dissolved precinct GeoJSON.', 'ok');
    } }),

    el('h3', { style: 'margin:18px 0 4px;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--fg3)', text: 'Block assignment CSV' }),
    el('p', { class: 'tight', html: 'Also on the toolbar. See the block export dialog for the header options.' }),
    el('button', { text: 'Block CSV for DRA…', onclick: () => exportBlocks() }),
  ]);
}

async function exportBlocks() {
  const hdr = prefs.get('draHeader', 'GEOID20,District');
  const sel = el('select', {}, Object.keys(DRA_HEADERS).map((k) =>
    el('option', { value: k, selected: k === hdr }, [k])));
  const unassignedSel = el('select', {}, [
    el('option', { value: '0', selected: prefs.get('draUnassigned', '0') === '0' }, ['0']),
    el('option', { value: '', selected: prefs.get('draUnassigned', '0') === '' }, ['(blank)']),
  ]);
  const out = el('div');

  const run = async () => {
    out.innerHTML = 'Building…';
    prefs.set('draHeader', sel.value);
    prefs.set('draUnassigned', unassignedSel.value);
    try {
      const res = await blockCSV(data, state, { header: sel.value, unassigned: unassignedSel.value });
      download(`${slug(state.name)}_blocks.csv`, res.text);
      out.innerHTML =
        `<p class="tight">Exported <strong>${fmtInt(res.rows)}</strong> block rows.</p>`
        + '<pre>' + [1, 2, 3, 4].map((d) =>
          `Precinct ${d}  ${fmtInt(res.countByPrecinct[d]).padStart(7)} blocks  ${fmtInt(res.popByPrecinct[d]).padStart(10)} people`).join('\n')
        + (res.countByPrecinct[0]
          ? `\nUnassigned ${fmtInt(res.countByPrecinct[0]).padStart(6)} blocks  ${fmtInt(res.popByPrecinct[0]).padStart(10)} people` : '')
        + `\n${''.padEnd(46, '─')}\nTotal      ${fmtInt(res.rows).padStart(7)} blocks  ${fmtInt(res.popByPrecinct.reduce((a, b) => a + b, 0)).padStart(10)} people</pre>`;
      setStatus(`Exported ${fmtInt(res.rows)} block rows.`, 'ok');
    } catch (e) {
      out.innerHTML = `<p class="err">${e.message}</p>`;
    }
  };

  openModal('Block assignment CSV for Dave’s Redistricting', [
    el('p', { html: 'One row for every one of the 31,925 Tarrant County 2020 Census blocks. Each block '
      + 'takes its VTD’s precinct; blocks in a split VTD take their own assignment.' }),
    el('p', { class: 'tight', html:
      '<strong>On the format:</strong> DRA’s own documentation site is offline, so this could not be '
      + 'confirmed from the vendor. The header below is what the <code>geomander</code> R package — the '
      + 'most widely used reader and writer of DRA exports — requires: columns <code>GEOID20</code> and '
      + '<code>District</code>, read as text, with a header row, comma separated. The 15-digit GEOID is '
      + 'written unchanged. Other headers are offered in case DRA wants a different one.' }),
    el('label', { class: 'fld' }, ['Header', sel]),
    el('label', { class: 'fld' }, ['Write unassigned blocks as', unassignedSel]),
    el('button', { class: 'primary', text: 'Download block CSV', onclick: run }),
    out,
  ]);
}

const slug = (s) => (s || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'plan';

// ---- import ----
function showImportDialog() {
  const out = el('div');
  const input = el('input', { type: 'file', accept: '.csv,.txt', style: 'display:none' });
  const drop = el('div', { class: 'drop', html:
    'Drop an assignment CSV here, or click to choose a file.<br>'
    + '<span class="cmp">Either format: <code>vtdkey,district</code> or <code>GEOID20,District</code>.</span>' });

  drop.onclick = () => input.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('hot'); };
  drop.ondragleave = () => drop.classList.remove('hot');
  drop.ondrop = (e) => {
    e.preventDefault(); drop.classList.remove('hot');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  };
  input.onchange = () => { if (input.files[0]) handleFile(input.files[0]); };

  async function handleFile(file) {
    out.innerHTML = 'Reading…';
    const text = await file.text();
    const parsed = sniffCSV(text);
    if (parsed.error) { out.innerHTML = `<p class="err">${parsed.error}</p>`; return; }

    if (parsed.kind === 'vtd') {
      const r = applyVtdImport(data, parsed);
      out.innerHTML = `<p class="tight">Read as a <strong>VTD assignment</strong> file: `
        + `${fmtInt(r.matched)} of ${data.n} VTDs matched`
        + (r.unknown ? `, ${fmtInt(r.unknown)} unknown keys skipped` : '')
        + (r.missing ? `, ${fmtInt(r.missing)} VTDs not listed (left unassigned)` : '')
        + (parsed.bad ? `, ${fmtInt(parsed.bad)} rows with an unusable district value skipped` : '')
        + '.</p>';
      out.append(el('button', { class: 'primary', text: 'Apply this plan', onclick: () => {
        state.setAll(r.asn, { name: file.name.replace(/\.[^.]+$/, ''), clearHistory: false, label: 'import' });
        mapView.syncAllStates(); mapView.pushBlockSource(); mapView.refreshOutlines();
        recompute(false); closeModal();
        setStatus(`Imported ${fmtInt(r.matched)} VTD assignments.`, 'ok');
      } }));
    } else {
      out.innerHTML = 'Read as a block assignment file. Matching blocks to VTDs…';
      const r = await applyBlockImport(data, parsed);
      out.innerHTML = `<p class="tight">Read as a <strong>block assignment</strong> file: `
        + `${fmtInt(r.blocksSeen)} rows, ${fmtInt(r.matched)} VTDs covered`
        + (r.unknown ? `, ${fmtInt(r.unknown)} block ids not in this county skipped` : '')
        + `. ${r.splits.length
          ? `<strong>${r.splits.length} VTD${r.splits.length > 1 ? 's are' : ' is'} split</strong> `
            + `(${r.splits.map((s) => s.key).join(', ')}) and will be kept as block-level splits.`
          : 'No VTD is split.'}</p>`;
      out.append(el('button', { class: 'primary', text: 'Apply this plan', onclick: () => {
        state.setAll(r.asn, { name: file.name.replace(/\.[^.]+$/, ''), clearHistory: false, label: 'import' });
        for (const s of r.splits) {
          state.blockOv.set(s.idx, s.overrides);
          mapView.addBlockFeatures(s.idx, s.features);
        }
        state.autosave();
        mapView.syncAllStates(); mapView.pushBlockSource(); mapView.refreshOutlines();
        recompute(false); closeModal();
        setStatus(`Imported ${fmtInt(r.blocksSeen)} block assignments.`, 'ok');
      } }));
    }
  }

  openModal('Import an assignment CSV', [
    el('p', { html: 'The format is detected from the identifier: a 15-digit id is read as a 2020 '
      + 'Census block, a shorter one as a VTD key. A header row is optional, and both commas and '
      + 'pipes work as separators.' }),
    drop, input, out,
  ]);
}
