// Wiring: data -> state -> map + panel, plus the toolbar, dialogs and the
// block-splitting flow.

import { loadAll, loadBlocks } from './data.js';
import { PlanState, planLib, prefs } from './state.js';
import { computeMetrics } from './metrics.js';
import { buildTopology } from './topology.js';
import { analyze, buildSplitTopology, proposal, unitText } from './fragments.js';
import { MapView, SHADE_MODES, setPartisanPalette } from './mapview.js';
import { Panel } from './panel.js';
import {
  PRECINCT, NODATA, gradientCSS, ramp, PARTISAN_PALETTES, DEFAULT_PARTISAN,
} from './colors.js';
import {
  vtdCSV, blockCSV, dissolvedGeoJSON, flattenToVtd,
  sniffCSV, applyVtdImport, applyBlockImport, DRA_HEADER,
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
let hoverTarget = null;          // unit under the cursor, for the eyedropper
let selected = null;             // unit the user clicked, shown in the map card
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
  mapView.onSelect = handleSelect;
  mapView.onSplitClick = handleSplitClick;

  buildPrecinctList();
  wireToolbar();
  wireTools();
  renderLegend();

  // Restore the autosaved plan; with none, the plan starts blank.
  state.restore();
  await rehydrateSplits();
  state.autosave();

  state.on(onStateChange);
  buildPrecinctList();
  $('#plan-name').value = state.name;
  mapView.syncAllStates();
  mapView.refreshOutlines();
  recompute(true);
  updateUndoButtons();
  updateSaveState();

  // Handle for the browser-side check suite and for debugging from the console.
  window.TarrantRedraw = {
    get data() { return data; }, get state() { return state; },
    get mapView() { return mapView; }, get panel() { return panel; },
    get metrics() { return lastMetrics; }, get refMetrics() { return refMetrics; },
    get topo() { return topo; },
    recompute, computeMetrics, vtdCSV, blockCSV, dissolvedGeoJSON,
    sniffCSV, applyVtdImport, applyBlockImport, flattenToVtd,
    setActive: (d) => setActive(d),
    doSplit, doUnsplit, loadSavedPlan, saveCurrentPlan,
    get problems() { return problems; }, openProblems, openCleanup, applyCleanup,
    get cleanupRows() { return cleanupRows; },
    get blockFeatureCount() { return mapView.blockFeatures.size; },
    select: (idx) => selectVtd(idx), get selected() { return selected; },
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
    if (mapView.blockFeatures.has(idx)) continue;
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
  renderUnitInfo();
  refreshProblems();
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
  const un = $('#opt-unassigned');
  un.disabled = mode === 'district';
  un.closest('label').title = un.disabled
    ? 'Only for a partisan or demographic measure: the precinct view has no per-unit shading to keep.'
    : 'Keep each unassigned unit shaded by its own value on this measure.';
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

const WHOLE_PLAN_EDITS = new Set(['clear', 'start', 'import', 'cleanup']);

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
    // Clear also unlocks every precinct.
    buildPrecinctList();
    mapView.syncAllStates();
    mapView.pushBlockSource();
    mapView.refreshOutlines();
    recompute(false);
  } else if (detail.kind === 'undo' || detail.kind === 'redo') {
    const t = detail.touched;
    for (const i of t.vtds) mapView.setVtdState(i, state.asn[i]);
    for (const [i, g] of t.blocks) {
      const ov = state.blockOv.get(i);
      if (ov) mapView.map.setFeatureState({ source: 'blocks', id: g }, { d: ov.get(g) });
    }
    if (t.locks) buildPrecinctList();
    if (t.splits.length) {
      // A split or merge undone or redone changes which VTDs are drawn as
      // blocks, so the block geometry has to follow, not just the state.
      syncSplitGeometry(t.splits);
    } else {
      mapView.refreshOutlines();
      recompute(false);
    }
  }
  updateUndoButtons();
  updateSaveState();
}

/**
 * Bring the block layer in line with `state.blockOv` for the given VTDs:
 * fetch and add the blocks of each one that is now split (the fetch is
 * cached), drop the blocks of each one that no longer is, then repaint.
 */
let splitSyncSeq = 0;
async function syncSplitGeometry(indices) {
  const seq = ++splitSyncSeq;
  const want = [...new Set(indices)];
  for (const i of want) {
    if (state.isSplit(i) && !mapView.blockFeatures.has(i)) {
      try {
        const gj = await loadBlocks(data.keys[i]);
        // A later undo may have merged it again while the blocks loaded.
        if (state.isSplit(i)) mapView.blockFeatures.set(i, gj.features);
      } catch (e) {
        setStatus(`Could not load blocks for VTD ${data.keys[i]}.`, 'warn');
      }
    }
  }
  if (seq !== splitSyncSeq) return;          // a newer undo/redo will finish the job
  for (const i of want) {
    if (!state.isSplit(i)) mapView.blockFeatures.delete(i);
    mapView.setVtdState(i, state.asn[i]);
  }
  mapView.pushBlockSource();                 // re-sends the geometry and every block's colour
  mapView.refreshOutlines();
  recompute(false);
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

function targetOf(feat) {
  if (!feat) return null;
  return feat.layer.id === 'blocks-fill'
    ? { kind: 'block', geoid: feat.properties.GEOID20, key: feat.properties.vtdkey, p: feat.properties }
    : { kind: 'vtd', key: feat.properties.vtdkey, idx: data.idxOf.get(feat.properties.vtdkey), p: feat.properties };
}

// Hovering only feeds the eyedropper. The unit card follows clicks, so it
// holds still while the pointer travels to its buttons.
function handleHover(feat) { hoverTarget = targetOf(feat); }

/**
 * Right-click: split the VTD under the pointer into blocks. A VTD that is
 * already split (or one of its blocks) opens its unit card instead.
 */
function handleSplitClick(feat) {
  const t = targetOf(feat);
  if (!t) return;
  const idx = t.kind === 'vtd' ? t.idx : data.idxOf.get(t.key);
  if (idx === undefined) return;
  if (state.isSplit(idx)) { selectVtd(idx); return; }
  doSplit(idx, { frame: false });
}

function handleSelect(feat) {
  selected = targetOf(feat);
  renderUnitInfo();
}

let vtdPropsByKey = null;
function vtdProps(key) {
  if (!vtdPropsByKey) {
    vtdPropsByKey = new Map(data.vtdGeo.features.map((f) => [f.properties.vtdkey, f.properties]));
  }
  return vtdPropsByKey.get(key);
}

function selectVtd(idx) {
  const key = data.keys[idx];
  selected = { kind: 'vtd', key, idx, p: vtdProps(key) };
  renderUnitInfo();
}

/** "Undo split", naming the precinct the whole VTD will take: its majority by population. */
function undoSplitButton(idx) {
  const d = state.majorityOf(idx, mapView.blockPopMap(idx));
  return el('button', {
    text: `Undo split (whole VTD goes to ${d ? `Pct ${d}` : 'unassigned'})`,
    title: 'Drops the block assignments; the VTD takes the precinct holding most of its population.',
    onclick: () => doUnsplit(idx),
  });
}

function clearSelection() { selected = null; renderUnitInfo(); }

function renderUnitInfo() {
  const box = $('#unit-card');
  // A selected block whose VTD is no longer split (merge, undo, a repaint)
  // falls back to the VTD it belongs to.
  if (selected && selected.kind === 'block') {
    const idx = data.idxOf.get(selected.key);
    if (idx === undefined || !state.isSplit(idx)) {
      selected = idx === undefined ? null : { kind: 'vtd', key: selected.key, idx, p: vtdProps(selected.key) };
    }
  }
  const t = selected;
  mapView.setSelected(t ? t.key : null, t && t.kind === 'block' ? t.geoid : null);
  box.hidden = !t;
  if (!t) { box.innerHTML = ''; return; }

  const rows = [];
  const add = (k, v) => rows.push(`<tr><td>${k}</td><td>${v}</td></tr>`);
  const head = (title) => {
    box.innerHTML = '';
    box.append(el('div', { class: 'uc-head' }, [
      el('span', { text: title }),
      el('button', { class: 'm-close', text: '×', title: 'Close (Esc)', onclick: clearSelection }),
    ]));
  };
  const pname = (d) => (d ? `<span class="pdot" style="background:${PRECINCT[d - 1]}"></span>${d}` : 'unassigned');

  if (t.kind === 'vtd') {
    const i = t.idx, p = t.p;
    const split = state.isSplit(i);
    head(`VTD ${t.key}`);
    add('Precinct', split ? `split · mostly ${pname(state.majorityOf(i, mapView.blockPopMap(i)))}` : pname(state.asn[i]));
    add('City', p.city_name ?? '—');
    add('Community', data.comm[i] != null ? (data.commName.get(data.comm[i]) ?? data.comm[i]) : '—');
    add('Population / VAP', `${fmtInt(data.num.pop[i])} / ${fmtInt(data.num.vap[i])}`);
    add('Hisp / Black / Nonwhite', `${fmtPct(p.f_hisp, 0)} / ${fmtPct(p.f_black, 0)} / ${fmtPct(p.f_nonwhite, 0)}`);
    add('D composite / 2026', `${p.dshare == null ? '—' : fmtPct(p.dshare)} / ${p.share26 == null ? '—' : fmtPct(p.share26)}`);
    add('D 2020–24 / shift', `${p.dshare_pre == null ? '—' : fmtPct(p.dshare_pre)} / ${p.shift26 == null ? '—' : fmtSigned(p.shift26)}`);
    box.insertAdjacentHTML('beforeend', `<table>${rows.join('')}</table>`);
    if (split) {
      box.append(el('div', { class: 'uc-note', text: `Split into ${state.blockOv.get(i).size} blocks. Paint them one by one.` }));
      box.append(undoSplitButton(i));
    } else {
      box.append(el('button', { text: 'Split into blocks', onclick: () => doSplit(i) }));
    }
  } else {
    const p = t.p;
    const idx = data.idxOf.get(t.key);
    const ov = state.blockOv.get(idx);
    head(`Block ${t.geoid}`);
    add('Precinct', pname(ov.get(t.geoid) || 0));
    add('In VTD', `${t.key} · ${ov.size} blocks`);
    add('Population / VAP', `${fmtInt(p.pop)} / ${fmtInt(p.vap)}`);
    add('Hisp / Black', `${fmtPct(p.f_hisp, 0)} / ${fmtPct(p.f_black, 0)}`);
    add('D composite (estimate) *', p.dshare == null ? '—' : fmtPct(p.dshare));
    add('D 2026 (estimate) *', p.share26 == null ? '—' : fmtPct(p.share26));
    add('2026 shift (estimate) *', p.shift26 == null ? '—' : fmtSigned(p.shift26));
    box.insertAdjacentHTML('beforeend', `<table>${rows.join('')}</table>`);
    box.insertAdjacentHTML('beforeend', '<div class="uc-note">* model estimate from race composition, '
      + 'scaled so the VTD’s blocks add up to its real votes. The shift is against the VTD’s 2020–24 baseline, '
      + 'since blocks have none.</div>');
    box.append(undoSplitButton(idx));
    box.append(el('button', { class: 'linkbtn', text: 'Show the whole VTD', onclick: () => selectVtd(idx) }));
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
      el('span', { class: 'pk-stats', 'data-stats': d }),
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
  updateSaveState();
  refreshProblems();                 // locks decide which cleanups can run
  setStatus(`Precinct ${d} ${state.locks[d - 1] ? 'locked' : 'unlocked'}.`);
}

/** The basics for each drawn precinct, on its picker row. */
function updatePrecinctPops(mx) {
  const pc = (x) => (x == null ? '—' : Math.round(x * 100));
  for (let d = 1; d <= 4; d++) {
    const r = mx.rows[d];
    const n = document.querySelector(`[data-pop="${d}"]`);
    if (n) n.textContent = fmtInt(r.pop);
    const st = document.querySelector(`[data-stats="${d}"]`);
    if (!st) continue;
    if (!r.units) { st.innerHTML = '<span class="dim">empty</span>'; continue; }
    const lean = r.dshare == null ? '—'
      : `${r.dshare >= 0.5 ? 'D' : 'R'}+${(Math.abs(r.dshare - 0.5) * 200).toFixed(1)}`;
    st.innerHTML =
      `<span class="${r.overTol ? 'flag-bad' : ''}" title="Deviation from the ideal population">${fmtSigned(r.dev, 1)}</span>`
      + `<span title="Composite lean: ${fmtPct(r.dshare)} Democratic · 2026: ${fmtPct(r.share26)}">${lean}</span>`
      + `<span title="Hispanic / Black / nonwhite share of voting-age population">H${pc(r.hisp)} B${pc(r.black)} NW${pc(r.nonwhite)}</span>`;
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
    if (state.clearAll()) setStatus('Cleared every assignment and unlocked all precincts. Undo restores it.');
    else setStatus('Nothing to clear.');
  };
  $('#plan-name').onchange = (e) => {
    state.name = e.target.value.trim() || 'Untitled plan';
    e.target.value = state.name;
    state.autosave();
    updateSaveState();
  };
  $('#btn-save').onclick = () => saveCurrentPlan();
  $('#btn-plans').onclick = showPlansDialog;
  $('#btn-start').onclick = showStartDialog;
  $('#btn-export-block').onclick = () => exportBlocks();
  $('#btn-export-menu').onclick = showExportDialog;
  $('#btn-import').onclick = showImportDialog;
  $('#btn-notes').onclick = () => openModal('Notes', [el('div', { html: panel.notesHTML(lastMetrics) })]);
  const setDock = (open) => {
    $('#dock').classList.toggle('closed', !open);
    $('#dock-caret').textContent = open ? '▾' : '▸';
    prefs.set('dockOpen', open);
  };
  setDock(prefs.get('dockOpen', true));
  $('#dock-toggle').onclick = (e) => { setDock($('#dock').classList.contains('closed')); e.currentTarget.blur(); };
  wireResizers();
  $('#cmp-map7').onchange = (e) => {
    panel.compare = e.target.checked;
    prefs.set('compare', panel.compare);
    recompute(false);
  };

  window.addEventListener('keydown', (e) => {
    // Ctrl/⌘+S saves from anywhere, the plan-name field included, and never
    // opens the browser's own save dialog.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if ($('#modal-back').hidden) {
        if (document.activeElement === $('#plan-name')) $('#plan-name').blur();
        saveCurrentPlan();
      }
      return;
    }
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
      clearSelection();
    } else {
      const k = e.key.toLowerCase();
      if (k === 'z') state.undo();
      else if (k === 'r') state.redo();
      else if (k === 'e') setActive(0);
      else if (k === 'b') setBrushMode('click');
      else if (k === 'm') setBrushMode('box');
      else if (k === 'f') setBrushMode('fill');
      else if (k === 'h') setBrushMode('pan');
      else if (k === 's') setBrushMode('select');
      else if (k === 'a') $('#dock-toggle').click();
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

/**
 * Drag handles: the tool rail's width and the analytics dock's height. Both
 * are remembered; a double-click puts the default back.
 */
function wireResizers() {
  const root = document.documentElement, dock = $('#dock');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const setTools = (w) => {
    if (w == null) root.style.removeProperty('--tools-w');
    else root.style.setProperty('--tools-w', `${w}px`);
    prefs.set('toolsW', w);
  };
  const setDockH = (h) => {
    dock.classList.toggle('sized', h != null);
    if (h == null) dock.style.removeProperty('--dock-h');
    else dock.style.setProperty('--dock-h', `${h}px`);
    prefs.set('dockH', h);
  };
  const drag = (handle, onMove, onReset) => {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('drag');
      document.body.classList.add('resizing');
      const move = (ev) => onMove(ev);
      const up = () => {
        handle.classList.remove('drag');
        document.body.classList.remove('resizing');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
      e.preventDefault();
    });
    handle.addEventListener('dblclick', onReset);
  };

  drag($('#rz-tools'),
    (e) => setTools(clamp(Math.round(e.clientX), 190, Math.min(460, innerWidth * 0.4))),
    () => setTools(null));
  drag($('#rz-dock'),
    (e) => {
      const head = dock.querySelector('.dock-head').offsetHeight;
      const bottom = dock.getBoundingClientRect().bottom;
      setDockH(clamp(Math.round(bottom - e.clientY - head - 2), 48, Math.round(innerHeight * 0.7)));
    },
    () => setDockH(null));

  const w = prefs.get('toolsW', null), h = prefs.get('dockH', null);
  if (Number.isFinite(w)) setTools(w);
  if (Number.isFinite(h)) setDockH(h);
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
  $('#btn-problems').onclick = () => ($('#problems').hidden ? openProblems() : closeProblems());

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
    pal.append(el('option', { value: k }, [p.label]));
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

  const unas = $('#opt-unassigned');
  unas.checked = prefs.get('shadeUnassigned', true);
  mapView.setShadeUnassigned(unas.checked);
  unas.onchange = () => {
    mapView.setShadeUnassigned(unas.checked);
    prefs.set('shadeUnassigned', unas.checked);
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
    ['Right-click', 'Split a VTD into blocks (on a split VTD: open its card)'],
    ['Right-drag, or Alt+drag', 'Erase (works with brush and box; Alt+click with fill)'],
    ['Shift+drag', 'Box select, whatever tool is active'],
    ['Space+drag', 'Pan the map; the wheel zooms'],
    ['1 2 3 4', 'Pick a precinct'],
    ['0 or E', 'Pick the eraser'],
    ['I', 'Pick the precinct under the cursor'],
    ['Click', 'Show that unit’s numbers, with Split / Undo split, in the card on the map'],
    ['Ctrl+S', 'Save the plan under its name'],
    ['Ctrl+click, or the Select tool', 'The same, without painting'],
    ['B / M / F / S / H', 'Brush / box / fill region / select / pan'],
    ['A', 'Show or hide the analytics under the map'],
    ['Esc', 'Close the unit card'],
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
  // The precinct colours are already on the picker above; no legend needed.
  if (mode === 'district') { host.innerHTML = ''; return; }
  const pct = (x) => (mode === 'shift26' ? fmtSigned(x, 0) : fmtPct(x, 0));
  // The party letter on each end replaces a sentence of explanation.
  const party = m.partisan || mode === 'shift26';
  host.innerHTML = `
    <div class="legend-bar" style="background:${gradientCSS(m.ramp)}"></div>
    <div class="legend-ends"><span>${party ? 'R ' : ''}${pct(m.lo)}</span>
      <span>${m.mid != null ? pct(m.mid) : ''}</span><span>${pct(m.hi)}${party ? ' D' : ''}</span></div>`;
}

// ------------------------------------------------------- find problems ----
// Connected pieces of each precinct, from fragments.js. The analysis is cheap
// and runs after every recompute; block adjacency for split VTDs is built once
// per VTD in the background and cached.
let problems = null;
let problemsView = 'list';          // 'list' | 'cleanup'
let cleanupThreshold = 0.01;        // share of the ideal population
let cleanupTicks = new Map();       // piece key -> ticked, overrides the threshold
let cleanupRows = [];
const splitTopo = new Map();        // idx -> topology, or a pending promise

function topoOf(i) { const t = splitTopo.get(i); return t && !(t instanceof Promise) ? t : undefined; }

function ensureSplitTopologies() {
  for (const i of state.splitIndices()) {
    if (splitTopo.has(i)) continue;
    const p = buildSplitTopology(data, i, loadBlocks).then((t) => {
      splitTopo.set(i, t);
      if (!t.ok) console.warn(`Block borders for VTD ${data.keys[i]} failed the check:`, t.problems);
      refreshProblems();
    }, (e) => {
      splitTopo.set(i, { idx: i, ok: false, problems: [String(e.message || e)] });
      refreshProblems();
    });
    splitTopo.set(i, p);
  }
}

const pieceKey = (p) => `${p.d}:${p.vtds[0] ?? ''}:${p.blocks[0] ? p.blocks[0].join('/') : ''}`;

function refreshProblems() {
  if (!state || !mapView) return;
  ensureSplitTopologies();
  problems = analyze(data, state, { topoOf, blockPopOf: (i) => mapView.blockPopMap(i) });
  const count = problems.fragments.length + problems.islands.length;
  const badge = $('#prob-badge');
  badge.textContent = String(count);
  badge.classList.toggle('zero', count === 0);
  $('#btn-problems').title = count
    ? `${problems.fragments.length} fragment${problems.fragments.length === 1 ? '' : 's'}, `
      + `${problems.islands.length} unassigned island${problems.islands.length === 1 ? '' : 's'}`
    : 'Every precinct is in one piece and nothing is unassigned';
  if (!$('#problems').hidden) renderProblems();
}

function openProblems() {
  problemsView = 'list';
  $('#problems').hidden = false;
  $('#btn-problems').classList.add('on');
  refreshProblems();
}
function closeProblems() {
  $('#problems').hidden = true;
  $('#btn-problems').classList.remove('on');
  mapView.setPieceHighlight();
}
function openCleanup() {
  problemsView = 'cleanup';
  cleanupTicks = new Map();
  $('#problems').hidden = false;
  $('#btn-problems').classList.add('on');
  refreshProblems();
}

function zoomToPiece(p) {
  const keys = p.vtds.map((i) => data.keys[i]);
  const geoids = p.blocks.map(([, g]) => g);
  mapView.setPieceHighlight(keys, geoids);
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const grow = (f) => {
    const b = bboxOf(f);
    if (!b) return;
    x0 = Math.min(x0, b[0][0]); y0 = Math.min(y0, b[0][1]);
    x1 = Math.max(x1, b[1][0]); y1 = Math.max(y1, b[1][1]);
  };
  for (const i of p.vtds) grow(data.vtdGeo.features[i]);
  for (const [i, g] of p.blocks) {
    const f = (mapView.blockFeatures.get(i) || []).find((ff) => ff.properties.GEOID20 === g);
    grow(f);
  }
  if (x0 <= x1) mapView.map.fitBounds([[x0, y0], [x1, y1]], { padding: 90, duration: 450, maxZoom: 14.5 });
}

const pdot = (d) => (d
  ? `<span class="pdot" style="background:${PRECINCT[d - 1]}"></span>`
  : '<span class="pdot pdot-none"></span>');

function pieceRow(p, label, extra = []) {
  const row = el('div', { class: 'pr-row' }, [
    ...extra,
    el('span', { class: 'pr-name', html: label }),
    el('span', { class: 'pr-units', text: unitText(p) }),
    el('span', { class: 'pr-pop', text: fmtInt(p.pop) }),
    el('button', { class: 'pr-zoom', text: 'Zoom', title: 'Frame and highlight this piece', onclick: () => zoomToPiece(p) }),
  ]);
  return row;
}

function renderProblems() {
  const box = $('#problems');
  box.innerHTML = '';
  const head = (title, back) => box.append(el('div', { class: 'pb-head' }, [
    back ? el('button', { class: 'linkbtn', text: '‹ Back', onclick: () => { problemsView = 'list'; renderProblems(); } }) : null,
    el('span', { class: 'pb-title', text: title }),
    el('button', { class: 'm-close', text: '×', title: 'Close', onclick: closeProblems }),
  ]));
  const p = problems;
  const notes = [];
  if (p.pending.length) notes.push(`Checking block borders for ${p.pending.length} split VTD${p.pending.length === 1 ? '' : 's'}…`);
  if (p.unclean.length) {
    notes.push(`Block borders for VTD ${p.unclean.map((i) => data.keys[i]).join(', ')} did not line up with the `
      + 'VTD adjacency, so each counts as one unit at its majority precinct and is not offered for cleanup.');
  }

  if (problemsView === 'cleanup') { renderCleanup(box, head, notes); return; }

  head('Find problems');
  for (const n of notes) box.append(el('div', { class: 'pb-note', text: n }));
  const count = p.fragments.length + p.islands.length;
  box.append(el('div', { class: 'pb-sum', html: count
    ? `<b>${p.fragments.length}</b> fragment${p.fragments.length === 1 ? '' : 's'} · `
      + `<b>${p.islands.length}</b> unassigned island${p.islands.length === 1 ? '' : 's'}`
    : '<span class="good">Every precinct is in one piece and nothing is unassigned.</span>' }));

  const list = el('div', { class: 'pb-list' });
  for (let d = 1; d <= 4; d++) {
    const main = p.mains[d];
    const frags = p.fragments.filter((f) => f.d === d);
    list.append(el('div', { class: 'pb-sec', html:
      `${pdot(d)}Precinct ${d} <span class="dim">${main ? `${1 + frags.length} piece${frags.length ? 's' : ''}` : 'empty'}</span>` }));
    if (main) list.append(pieceRow(main, 'Main body'));
    frags.forEach((f, k) => list.append(pieceRow(f, `<span class="flag-bad">Fragment ${k + 1}</span>`)));
  }
  if (p.islands.length) {
    list.append(el('div', { class: 'pb-sec', html: `${pdot(0)}Unassigned <span class="dim">${p.islands.length} island${p.islands.length === 1 ? '' : 's'}</span>` }));
    p.islands.forEach((f, k) => list.append(pieceRow(f, `Island ${k + 1}`)));
  }
  box.append(list);
  box.append(el('div', { class: 'pb-foot' }, [
    el('button', { class: 'primary', text: 'Clean up fragments…', disabled: !count,
      onclick: () => { problemsView = 'cleanup'; cleanupTicks = new Map(); renderProblems(); } }),
  ]));
}

function renderCleanup(box, head, notes) {
  head('Clean up fragments', true);
  for (const n of notes) box.append(el('div', { class: 'pb-note', text: n }));
  const ideal = lastMetrics.ideal;
  const pieces = [...problems.fragments, ...problems.islands];

  cleanupRows = pieces.map((piece) => {
    const prop = proposal(piece, state);
    const key = pieceKey(piece);
    const auto = piece.pop < cleanupThreshold * ideal;
    const ticked = !prop.reason && (cleanupTicks.has(key) ? cleanupTicks.get(key) : auto);
    return { piece, key, to: prop.to, reason: prop.reason, ticked };
  });

  const thr = el('input', { type: 'number', min: '0', max: '100', step: '0.5', value: String(+(cleanupThreshold * 100).toFixed(2)) });
  thr.addEventListener('change', () => {
    const v = parseFloat(thr.value);
    if (Number.isFinite(v) && v >= 0) { cleanupThreshold = v / 100; cleanupTicks = new Map(); renderProblems(); }
  });
  box.append(el('div', { class: 'pb-thr' }, [
    'Tick pieces under ', thr, ` % of the ideal population (${fmtInt(cleanupThreshold * ideal)} people). `,
    el('span', { class: 'dim', text: 'Larger ones change the plan materially.' }),
  ]));

  const list = el('div', { class: 'pb-list' });
  if (!cleanupRows.length) list.append(el('div', { class: 'pb-note', text: 'Nothing to clean up.' }));
  for (const r of cleanupRows) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = r.ticked;
    cb.disabled = !!r.reason;
    cb.onchange = () => { cleanupTicks.set(r.key, cb.checked); r.ticked = cb.checked; renderDelta(); updateApply(); };
    const from = r.piece.d ? `Pct ${r.piece.d}` : 'Unassigned';
    const label = r.to
      ? `${pdot(r.piece.d)}${from} → ${pdot(r.to)}Pct ${r.to}`
      : `${pdot(r.piece.d)}${from}`;
    const row = pieceRow(r.piece, label, [cb]);
    if (r.reason) row.append(el('div', { class: 'pr-skip', text: `Skipped: ${r.reason}` }));
    list.append(row);
  }
  box.append(list);

  const delta = el('div', { class: 'pb-delta' });
  const renderDelta = () => {
    const ch = [0, 0, 0, 0, 0];
    for (const r of cleanupRows) if (r.ticked) { ch[r.piece.d] -= r.piece.pop; ch[r.to] += r.piece.pop; }
    const rows = [1, 2, 3, 4].map((d) => {
      const now = lastMetrics.rows[d].pop, after = now + ch[d];
      const dev = (after - ideal) / ideal;
      return `<tr><td>${pdot(d)}Pct ${d}</td><td>${fmtInt(now)}</td>`
        + `<td class="${ch[d] ? (ch[d] > 0 ? 'up' : 'down') : 'dim'}">${ch[d] ? (ch[d] > 0 ? '+' : '−') + fmtInt(Math.abs(ch[d])) : '—'}</td>`
        + `<td>${fmtInt(after)}</td><td class="${Math.abs(dev) > panel.tolerance ? 'flag-bad' : ''}">${fmtSigned(dev, 2)}</td></tr>`;
    });
    if (ch[0]) {
      rows.push(`<tr class="dim"><td>${pdot(0)}Unassigned</td><td>${fmtInt(lastMetrics.rows[0].pop)}</td>`
        + `<td>−${fmtInt(-ch[0])}</td><td>${fmtInt(lastMetrics.rows[0].pop + ch[0])}</td><td></td></tr>`);
    }
    delta.innerHTML = '<table class="at"><thead><tr><th>Population</th><th>Now</th><th>Change</th><th>After</th><th>Deviation</th></tr></thead>'
      + `<tbody>${rows.join('')}</tbody></table>`;
  };
  renderDelta();
  box.append(delta);

  const apply = el('button', { class: 'primary', onclick: () => applyCleanup() });
  const updateApply = () => {
    const k = cleanupRows.filter((r) => r.ticked).length;
    apply.textContent = `Apply ${k} change${k === 1 ? '' : 's'}`;
    apply.disabled = !k;
  };
  updateApply();
  box.append(el('div', { class: 'pb-foot' }, [
    el('span', { class: 'dim', text: 'One step; Undo reverses it.' }),
    apply,
  ]));
}

/** Reassign every ticked piece to its proposed precinct, as one undoable step. */
function applyCleanup() {
  const rows = cleanupRows.filter((r) => r.ticked && r.to && !r.reason);
  if (!rows.length) return false;
  let moved = 0, people = 0;
  const blocked = [];
  for (const r of rows) {
    const p = r.piece;
    let n = state.paint(p.vtds, r.to).length;
    const byVtd = new Map();
    for (const [i, g] of p.blocks) { if (!byVtd.has(i)) byVtd.set(i, []); byVtd.get(i).push(g); }
    for (const [i, gs] of byVtd) n += state.paintBlocks(i, gs, r.to).length;
    if (n) { moved++; people += p.pop; } else blocked.push(r);
  }
  const skipped = cleanupRows.filter((r) => r.reason);
  problemsView = 'list';             // the commit re-renders the panel
  mapView.setPieceHighlight();
  if (!state.commit('cleanup')) { setStatus('Nothing changed: every ticked piece is locked.', 'warn'); return false; }
  const bits = [`Moved ${moved} piece${moved === 1 ? '' : 's'} (${fmtInt(people)} people). Z undoes it.`];
  if (skipped.length) {
    bits.push(`Skipped ${skipped.length}: ${[...new Set(skipped.map((r) => r.reason))].join('; ')}.`);
  }
  setStatus(bits.join(' '), skipped.length ? 'warn' : 'ok');
  return true;
}

// ------------------------------------------------------- block splitting ----
async function doSplit(idx, { frame = true } = {}) {
  const key = data.keys[idx];
  if (state.isSplit(idx)) return;
  setStatus(`Loading blocks for VTD ${key}…`);
  try {
    const gj = await loadBlocks(key);
    state.split(idx, gj.features.map((f) => f.properties.GEOID20));
    state.commit('split');
    mapView.addBlockFeatures(idx, gj.features);
    mapView.setVtdState(idx, state.asn[idx]);
    mapView.refreshOutlines();
    recompute(false);
    // Frame the VTD so its blocks are workable: always from the card's button,
    // and from a right-click only when the VTD is too small on screen to paint.
    const b = bboxOf(data.vtdGeo.features[idx]);
    if (b) {
      const p0 = mapView.map.project(b[0]), p1 = mapView.map.project(b[1]);
      const small = Math.min(Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y)) < 140;
      if (frame || small) mapView.map.fitBounds(b, { padding: 80, duration: 400, maxZoom: 15 });
    }
    setStatus(`VTD ${key} split into ${gj.features.length} blocks. Paint them one at a time; Undo split puts it back.`, 'ok');
    selectVtd(idx);
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
  setStatus(`VTD ${data.keys[idx]} merged back ${state.asn[idx] ? `into Precinct ${state.asn[idx]}` : 'to unassigned'}.`);
  selectVtd(idx);
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
  if (modalCloseHook) { const fn = modalCloseHook; modalCloseHook = null; fn(); }
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
let modalCloseHook = null;
function onModalClose(fn) { modalCloseHook = fn; }
function closeModal() {
  $('#modal-back').hidden = true;
  const fn = modalCloseHook; modalCloseHook = null;
  if (fn) fn();
}

// ---- start from ----
function showStartDialog() {
  const options = [
    el('button', {
      style: 'width:100%;text-align:left;margin-bottom:6px',
      text: 'Blank — every VTD unassigned',
      onclick: () => { state.clearAll(); state.name = UNTITLED; $('#plan-name').value = state.name; state.autosave(); updateSaveState(); closeModal(); setStatus('Started from blank.'); },
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

// ---- save / load ----
const UNTITLED = 'Untitled plan';

/** Unsaved: the plan differs from the saved copy under its name, or has none. */
function hasUnsavedChanges() {
  const saved = planLib.get(state.name);
  if (saved) return state.signature(saved) !== state.signature();
  // An untitled, empty, unlocked plan has nothing worth keeping.
  return state.asn.some((d) => d !== 0) || state.splitCount > 0 || state.locks.some(Boolean)
    || state.name !== UNTITLED;
}

function updateSaveState() {
  const n = $('#save-state');
  if (!n || !state) return;
  const dirty = hasUnsavedChanges();
  const saved = !!planLib.get(state.name);
  n.textContent = dirty ? 'Unsaved changes' : saved ? 'Saved' : '';
  n.className = 'save-state' + (dirty ? ' dirty' : '');
  n.title = dirty
    ? (saved ? `Differs from the saved plan “${state.name}”. Ctrl+S saves.` : 'Not saved under a name yet. Ctrl+S saves.')
    : '';
}

/**
 * Save under the plan's name, overwriting that saved plan. An untitled plan
 * asks for a name first. Resolves true once saved.
 */
function saveCurrentPlan() {
  return new Promise((resolve) => {
    const write = (name) => {
      state.name = name;
      $('#plan-name').value = name;
      state.autosave();
      const ok = planLib.save(name, state.toJSON());
      updateSaveState();
      if (ok) setStatus(`Saved “${name}”.`, 'ok');
      else setStatus('Could not save: local storage is full or unavailable.', 'warn');
      return ok;
    };
    if (state.name && state.name !== UNTITLED) { resolve(write(state.name)); return; }

    const input = el('input', { type: 'text', value: '', spellcheck: 'false', placeholder: 'Plan name' });
    const err = el('p', { class: 'err tight' });
    let done = false;
    const go = () => {
      const n = input.value.trim();
      if (!n || n === UNTITLED) { err.textContent = 'Give the plan a name.'; input.focus(); return; }
      if (planLib.get(n) && !confirm(`Overwrite the saved plan “${n}”?`)) return;
      done = true;
      closeModal();
      resolve(write(n));
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    openModal('Save plan', [
      el('label', { class: 'fld' }, ['Name this plan', input]),
      err,
    ], [
      el('button', { text: 'Cancel', onclick: () => { closeModal(); } }),
      el('button', { class: 'primary', text: 'Save', onclick: go }),
    ]);
    onModalClose(() => { if (!done) resolve(false); });
    input.focus();
  });
}

/** Loading replaces the plan you are drawing: offer to save it first. */
function confirmLoad(name) {
  if (!hasUnsavedChanges()) {
    loadSavedPlan(name);
    return;
  }
  const cur = state.name || UNTITLED;
  openModal(`Load “${escapeHTML(name)}”?`, [
    el('p', { html: `Loading replaces the plan you are drawing, <strong>${escapeHTML(cur)}</strong>, `
      + 'which has unsaved changes. Undo cannot bring it back after a load.' }),
  ], [
    el('button', { text: 'Cancel', onclick: closeModal }),
    el('button', { text: 'Discard and load', onclick: () => { closeModal(); loadSavedPlan(name); } }),
    el('button', { class: 'primary', text: 'Save, then load', onclick: async () => {
      closeModal();
      if (await saveCurrentPlan()) loadSavedPlan(name);
    } }),
  ]);
}

/** The one path that loads a saved plan: state, block geometry, map, then one autosave. */
async function loadSavedPlan(name) {
  const p = planLib.get(name);
  if (!p) { setStatus(`No saved plan “${name}”.`, 'warn'); return false; }
  closeModal();
  selected = null;
  state.fromJSON(p);
  await rehydrateSplits();
  state.autosave();
  mapView.syncAllStates(); mapView.pushBlockSource(); mapView.refreshOutlines();
  buildPrecinctList();
  recompute(false);
  updateUndoButtons();
  updateSaveState();
  setStatus(`Loaded “${name}”.`, 'ok');
  return true;
}

const escapeHTML = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
        el('button', { text: 'Load', onclick: () => confirmLoad(name) }),
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
      state.autosave();
      if (planLib.save(n, state.toJSON())) { refresh(); setStatus(`Saved “${n}”.`, 'ok'); }
      else setStatus('Could not save: local storage is full or unavailable.', 'warn');
      updateSaveState();
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
  const h3 = (text, top) => el('h3', { style: `margin:${top}px 0 4px;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--fg3)`, text });

  openModal('Export', [
    warn,

    h3('VTD assignment CSV', 0),
    el('p', { class: 'tight', html: 'Header <code>vtdkey,district</code>, one row per assigned VTD, '
      + 'district 1–4. Unassigned VTDs are left out, so in R '
      + '<code>df$district[match(map$vtdkey, df$vtdkey)]</code> gives <code>NA</code> for them.' }),
    el('div', { class: 'exp-row' }, [
      el('button', { text: 'Download VTD CSV', onclick: () => {
        const { asn } = flattenToVtd(state, (i) => mapView.blockPopMap(i));
        const rows = asn.reduce((k, d) => k + (d >= 1 && d <= 4 ? 1 : 0), 0);
        download(`${slug(state.name)}_vtd.csv`, vtdCSV(data, asn));
        setStatus(`Exported ${fmtInt(rows)} VTD rows.`, 'ok');
      } }),
      unassigned ? unassignedNote(`${fmtInt(unassigned)} VTD${unassigned === 1 ? '' : 's'} unassigned; `
        + 'they are left out of the file') : null,
    ]),

    h3('Dissolved precinct GeoJSON', 18),
    el('p', { class: 'tight', html: 'Precinct polygons with population, VAP shares, partisan shares, '
      + 'contiguity and Polsby-Popper as properties. EPSG:4326.' }),
    el('button', { text: 'Download GeoJSON', onclick: () => {
      const txt = dissolvedGeoJSON(data, topo, state, lastMetrics, (i) => mapView.blockPopMap(i),
        () => mapView.splitGeometries());
      download(`${slug(state.name)}_precincts.geojson`, txt, 'application/geo+json');
      setStatus('Exported dissolved precinct GeoJSON.', 'ok');
    } }),

    h3('Block assignment CSV', 18),
    el('p', { class: 'tight', text: 'Also on the toolbar.' }),
    el('button', { text: 'Block CSV for DRA…', onclick: () => exportBlocks() }),
  ]);
}

/** "N … unassigned; …", with a Find link that opens the Find problems tool. */
function unassignedNote(text) {
  return el('span', { class: 'exp-note' }, [
    `${text}. `,
    el('button', { class: 'linkbtn inline', text: 'Find', onclick: () => { closeModal(); openProblems(); } }),
  ]);
}

async function exportBlocks() {
  const out = el('div');
  const note = el('div', { class: 'exp-row' });
  const btn = el('button', { class: 'primary', text: 'Download block CSV' });
  note.append(btn);

  const run = async () => {
    out.innerHTML = 'Building…';
    try {
      const res = await blockCSV(data, state);
      download(`${slug(state.name)}_blocks.csv`, res.text);
      const total = res.popByPrecinct.slice(1).reduce((a, b) => a + b, 0);
      out.innerHTML =
        `<p class="tight">Exported <strong>${fmtInt(res.rows)}</strong> block rows`
        + `${res.unassigned ? ` (${fmtInt(res.unassigned)} unassigned blocks left out)` : ''}.</p>`
        + '<pre>' + [1, 2, 3, 4].map((d) =>
          `Precinct ${d}  ${fmtInt(res.countByPrecinct[d]).padStart(7)} blocks  ${fmtInt(res.popByPrecinct[d]).padStart(10)} people`).join('\n')
        + `\n${''.padEnd(46, '─')}\nIn file    ${fmtInt(res.rows).padStart(7)} blocks  ${fmtInt(total).padStart(10)} people`
        + (res.unassigned
          ? `\nLeft out   ${fmtInt(res.unassigned).padStart(7)} blocks  ${fmtInt(res.popByPrecinct[0]).padStart(10)} people` : '')
        + '</pre>';
      setStatus(`Exported ${fmtInt(res.rows)} block rows.`, 'ok');
    } catch (e) {
      out.innerHTML = `<p class="err">${e.message}</p>`;
    }
  };
  btn.onclick = run;

  openModal('Block assignment CSV for Dave’s Redistricting', [
    el('p', { html: `Header <code>${DRA_HEADER}</code>, then one row per assigned 2020 Census block: `
      + 'the 15-digit <code>GEOID20</code> and the precinct, 1–4. Each block takes its VTD’s precinct; '
      + 'blocks in a split VTD take their own assignment.' }),
    el('p', { class: 'tight', html:
      'Unassigned blocks are left out of the file, not written as <code>0</code>: DRA builds its '
      + 'districts from the labels it finds, so a <code>0</code> would become a fifth district. A block '
      + 'missing from the file is unassigned in DRA.' }),
    note,
    out,
  ]);

  // Count what will be left out before the user clicks.
  try {
    const pre = await blockCSV(data, state);
    if (pre.unassigned && note.isConnected) {
      note.append(unassignedNote(`${fmtInt(pre.unassigned)} block${pre.unassigned === 1 ? '' : 's'} unassigned; `
        + 'they will be unassigned in DRA too'));
    }
  } catch (e) { /* the download reports it */ }
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
