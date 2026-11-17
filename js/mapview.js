// MapLibre view: VTD fill painted through feature-state, dissolved precinct
// outlines on top, optional overlays, and the paint interactions.

import {
  PRECINCT, NODATA, PARTISAN_PALETTES, DEFAULT_PARTISAN, SHIFT, SEQ, interpolateExpr,
} from './colors.js';
import { dissolveLines, mixedBoundary, splitGeometry } from './topology.js';
import { debounceFrame } from './util.js';

export const BASEMAP = 'https://tiles.openfreemap.org/styles/positron';

const EMPTY = { type: 'FeatureCollection', features: [] };

/** Shading modes: how each one colours the VTD fill. */
export const SHADE_MODES = {
  district: { label: 'Assigned precinct', kind: 'cat' },
  dshare: { label: 'Democratic share — composite', kind: 'div', prop: 'dshare', ramp: PARTISAN_PALETTES[DEFAULT_PARTISAN].stops, partisan: true, lo: 0.2, hi: 0.8, mid: 0.5 },
  share26: { label: 'Democratic share — 2026', kind: 'div', prop: 'share26', ramp: PARTISAN_PALETTES[DEFAULT_PARTISAN].stops, partisan: true, lo: 0.2, hi: 0.8, mid: 0.5 },
  dshare_pre: { label: 'Democratic share — 2020–24 baseline', kind: 'div', prop: 'dshare_pre', ramp: PARTISAN_PALETTES[DEFAULT_PARTISAN].stops, partisan: true, lo: 0.2, hi: 0.8, mid: 0.5 },
  shift26: { label: '2026 shift vs baseline', kind: 'div', prop: 'shift26', ramp: SHIFT, lo: -0.15, hi: 0.15, mid: 0 },
  hisp: { label: 'Hispanic share of VAP', kind: 'seq', prop: 'f_hisp', ramp: SEQ, lo: 0, hi: 0.9 },
  black: { label: 'Black share of VAP', kind: 'seq', prop: 'f_black', ramp: SEQ, lo: 0, hi: 0.9 },
  nonwhite: { label: 'Nonwhite share of VAP', kind: 'seq', prop: 'f_nonwhite', ramp: SEQ, lo: 0, hi: 1 },
};

/** Switch the palette used by the three Democratic-share modes. */
export function setPartisanPalette(name) {
  const pal = PARTISAN_PALETTES[name] || PARTISAN_PALETTES[DEFAULT_PARTISAN];
  for (const m of Object.values(SHADE_MODES)) if (m.partisan) m.ramp = pal.stops;
  return pal;
}

// Unassigned units can be left clear so the basemap shows through. A
// transparent colour, not zero opacity, keeps them clickable.
const CLEAR = 'rgba(0,0,0,0)';

/** The drawn precinct of a feature, as a string ('' when unassigned). */
const dState = () => ['to-string', ['feature-state', 'd']];

/**
 * `match` over the drawn precinct: one output per precinct 1..4, plus the
 * output for everything unassigned.
 */
const byDistrict = (outs, unassigned) => [
  'match', dState(),
  '1', outs[0], '2', outs[1], '3', outs[2], '4', outs[3],
  unassigned,
];

/** Per-unit shading for a measure mode, read off the unit's own properties. */
const measureExpr = (m) =>
  ['case', ['has', m.prop], interpolateExpr(['get', m.prop], m.ramp, m.lo, m.hi), NODATA];

/** Whether a mode's measure exists on the block features as well as on VTDs. */
// Every measure is on the blocks: their own votes and VAP, and for the
// baseline (which has no block figures) their VTD's value; see decorateBlocks.
const onBlocks = (m) => !!(m && m.prop);

const districtColorExpr = (unassigned = CLEAR) => byDistrict(PRECINCT, unassigned);

/**
 * Block shading values that are not in the block file. Blocks have no
 * baseline, so the 2020-24 view shows the VTD's baseline on each block, and
 * the shift is the block's own 2026 share minus that baseline.
 */
function decorateBlocks(vtdProps, features) {
  if (features._decorated) return;
  const base = vtdProps.dshare_pre;
  for (const f of features) {
    const p = f.properties;
    if (base != null) {
      p.dshare_pre = base;
      if (p.share26 != null) p.shift26 = p.share26 - base;
    }
  }
  features._decorated = true;
}

export class MapView {
  constructor(container, data, topo, state) {
    this.data = data;
    this.topo = topo;
    this.state = state;
    this.shadeMode = 'district';
    this.dimUnder = false;
    this.shadeUnassigned = true;
    this.ready = false;
    this.onPick = () => {};
    this.onHover = () => {};
    this.onSelect = () => {};
    this.onSplitClick = () => {};
    this.blockFeatures = new Map();   // vtdIdx -> features array

    this.map = new maplibregl.Map({
      container,
      style: BASEMAP,
      center: [-97.29, 32.77],
      zoom: 9.1,
      maxZoom: 16,
      minZoom: 7,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchZoomRotate: false,
      fadeDuration: 0,
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'imperial' }), 'bottom-right');
    this.map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: [
        'Tarrant Redraw',
        '2020 Census (P.L. 94-171)',
        'Texas statewide contests 2020–26',
        'SimpleMaps',
        'Districtr',
      ],
    }), 'bottom-right');
  }

  async init() {
    await new Promise((res) => this.map.on('load', res));
    const m = this.map;

    // Insert our layers beneath the basemap's first label layer.
    this.labelLayers = m.getStyle().layers.filter((l) => l.type === 'symbol').map((l) => l.id);
    const firstSymbol = this.labelLayers[0];

    m.addSource('vtd', {
      type: 'geojson', data: this.data.vtdGeo, promoteId: 'vtdkey', generateId: false,
    });
    m.addSource('outline', { type: 'geojson', data: EMPTY });
    m.addSource('map7', { type: 'geojson', data: this.data.map7Geo });
    m.addSource('cities', { type: 'geojson', data: this.data.citiesGeo });
    m.addSource('comm', { type: 'geojson', data: this.data.commGeo });
    m.addSource('blocks', { type: 'geojson', data: EMPTY, promoteId: 'GEOID20' });

    m.addLayer({
      id: 'vtd-fill', type: 'fill', source: 'vtd',
      paint: {
        'fill-color': districtColorExpr(),
        // A split VTD is hidden so its blocks show through.
        'fill-opacity': ['case', ['==', ['feature-state', 'split'], 1], 0, 0.72],
      },
    }, firstSymbol);

    m.addLayer({
      id: 'vtd-line', type: 'line', source: 'vtd',
      paint: {
        'line-color': '#1c1e22',
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 8.5, 0.28, 11, 0.45],
        'line-width': 0.5,
      },
    }, firstSymbol);

    m.addLayer({
      id: 'blocks-fill', type: 'fill', source: 'blocks',
      // Same opacity as the VTD fill (set with the shading mode), and no
      // antialiasing, which would draw hairline seams between blocks: a
      // finished split reads exactly like the VTD fill around it.
      paint: { 'fill-color': districtColorExpr(), 'fill-opacity': 0.72, 'fill-antialias': false },
    }, firstSymbol);
    // Block lines only for the VTD that is selected or under the brush.
    m.addLayer({
      id: 'blocks-line', type: 'line', source: 'blocks',
      filter: ['in', ['get', 'vtdkey'], ['literal', []]],
      paint: { 'line-color': '#1c1e22', 'line-width': 0.5, 'line-opacity': 0.55 },
    }, firstSymbol);

    // Overlays, hidden until toggled.
    m.addLayer({
      id: 'ov-comm', type: 'line', source: 'comm',
      layout: { visibility: 'none' },
      paint: { 'line-color': '#5b3a8e', 'line-width': 0.8, 'line-opacity': 0.8, 'line-dasharray': [3, 2] },
    }, firstSymbol);
    m.addLayer({
      id: 'ov-cities', type: 'line', source: 'cities',
      layout: { visibility: 'none' },
      paint: { 'line-color': '#1b4f72', 'line-width': 1.3, 'line-opacity': 0.9 },
    }, firstSymbol);
    m.addLayer({
      id: 'ov-map7', type: 'line', source: 'map7',
      layout: { visibility: 'none', 'line-join': 'round' },
      paint: { 'line-color': '#2b2b2b', 'line-width': 2, 'line-opacity': 0.85, 'line-dasharray': [4, 2.5] },
    }, firstSymbol);

    // Drawn precinct outlines: always on top of everything, labels included.
    m.addLayer({
      id: 'draw-outline-halo', type: 'line', source: 'outline',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 4.4, 'line-opacity': 0.55 },
    });
    m.addLayer({
      id: 'draw-outline', type: 'line', source: 'outline',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['match', ['to-string', ['get', 'd']],
          '1', PRECINCT[0], '2', PRECINCT[1], '3', PRECINCT[2], '4', PRECINCT[3], '#000000'],
        'line-width': 2.3,
      },
    });

    // The clicked unit: a VTD ring, or a block ring inside a split VTD.
    m.addLayer({
      id: 'vtd-selected-halo', type: 'line', source: 'vtd',
      filter: ['==', ['id'], -1],
      paint: { 'line-color': '#101113', 'line-width': 5, 'line-opacity': 0.75 },
    });
    m.addLayer({
      id: 'vtd-selected', type: 'line', source: 'vtd',
      filter: ['==', ['id'], -1],
      paint: { 'line-color': '#ffe066', 'line-width': 2.6 },
    });
    m.addLayer({
      id: 'block-selected', type: 'line', source: 'blocks',
      filter: ['==', ['get', 'GEOID20'], ''],
      paint: { 'line-color': '#ffe066', 'line-width': 2.4 },
    });

    // A piece picked in the Find problems tool.
    const NONE = ['literal', []];
    m.addLayer({
      id: 'piece-hl-fill', type: 'fill', source: 'vtd',
      filter: ['in', ['id'], NONE],
      paint: { 'fill-color': '#ff3b8d', 'fill-opacity': 0.28 },
    });
    m.addLayer({
      id: 'piece-hl', type: 'line', source: 'vtd',
      filter: ['in', ['id'], NONE],
      paint: { 'line-color': '#ff3b8d', 'line-width': 2.6 },
    });
    m.addLayer({
      id: 'piece-hl-block-fill', type: 'fill', source: 'blocks',
      filter: ['in', ['get', 'GEOID20'], NONE],
      paint: { 'fill-color': '#ff3b8d', 'fill-opacity': 0.32 },
    });
    m.addLayer({
      id: 'piece-hl-block', type: 'line', source: 'blocks',
      filter: ['in', ['get', 'GEOID20'], NONE],
      paint: { 'line-color': '#ff3b8d', 'line-width': 2.2 },
    });

    // Hover ring.
    m.addLayer({
      id: 'vtd-hover', type: 'line', source: 'vtd',
      filter: ['==', ['id'], -1],
      paint: { 'line-color': '#f5f5f5', 'line-width': 1.8 },
    });

    // Frame the county. The unique-point table from the topology is already a
    // flat coordinate list, so this is cheap.
    const { px, py } = this.topo;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < px.length; i++) {
      if (px[i] < x0) x0 = px[i]; if (px[i] > x1) x1 = px[i];
      if (py[i] < y0) y0 = py[i]; if (py[i] > y1) y1 = py[i];
    }
    this.countyBounds = [[x0, y0], [x1, y1]];
    m.fitBounds(this.countyBounds, { padding: 24, duration: 0 });
    m.setMaxBounds([[x0 - 1.2, y0 - 1.0], [x1 + 1.2, y1 + 1.0]]);

    // The map shares its column with the analytics dock, which can be folded.
    new ResizeObserver(debounceFrame(() => m.resize())).observe(m.getContainer());

    // MapLibre opens the compact attribution on load; keep it folded behind
    // its (i) button so it does not sit on the map.
    const attrib = m.getContainer().querySelector('.maplibregl-ctrl-attrib');
    if (attrib) { attrib.classList.remove('maplibregl-compact-show'); attrib.removeAttribute('open'); }

    this.ready = true;
    this.syncAllStates();
    this.refreshOutlines();
    this.installInteractions();
  }

  // ---- feature state ------------------------------------------------------
  setVtdState(idx, district) {
    this.map.setFeatureState(
      { source: 'vtd', id: this.data.keys[idx] },
      { d: district, split: this.state.isSplit(idx) ? 1 : 0 },
    );
  }

  syncAllStates() {
    if (!this.ready) return;
    const { keys } = this.data;
    const m = this.map;
    m.removeFeatureState({ source: 'vtd' });
    for (let i = 0; i < this.data.n; i++) {
      m.setFeatureState({ source: 'vtd', id: keys[i] },
        { d: this.state.asn[i], split: this.state.isSplit(i) ? 1 : 0 });
    }
    this.syncBlockStates();
  }

  syncBlockStates() {
    if (!this.ready) return;
    const m = this.map;
    for (const [idx, ov] of this.state.blockOv) {
      if (!this.blockFeatures.has(idx)) continue;
      for (const [g, d] of ov) m.setFeatureState({ source: 'blocks', id: g }, { d });
    }
  }

  /** Ring the selected unit. `vtdKey` alone rings a VTD; with `geoid`, the block too. */
  setSelected(vtdKey, geoid) {
    if (!this.ready) return;
    this.selectedVtdKey = vtdKey ?? null;
    this.updateBlockLines();
    const v = ['==', ['id'], vtdKey ?? -1];
    this.map.setFilter('vtd-selected-halo', v);
    this.map.setFilter('vtd-selected', v);
    this.map.setFilter('block-selected', ['==', ['get', 'GEOID20'], geoid ?? '']);
  }

  /** Show block lines for the selected VTD and the one under the brush, if split. */
  updateBlockLines() {
    if (!this.ready) return;
    const keys = [this.selectedVtdKey, this.brushVtdKey].filter((k) => k != null);
    const sig = keys.join(',');
    if (sig === this._lineSig) return;
    this._lineSig = sig;
    this.map.setFilter('blocks-line', ['in', ['get', 'vtdkey'], ['literal', keys]]);
  }

  setBrushVtd(feat) {
    const k = feat ? feat.properties.vtdkey : null;
    const idx = k == null ? undefined : this.data.idxOf.get(k);
    this.brushVtdKey = idx !== undefined && this.state.isSplit(idx) ? k : null;
    this.updateBlockLines();
  }

  /** Highlight a piece: VTD keys and block GEOIDs. Pass nothing to clear. */
  setPieceHighlight(vtdKeys = [], geoids = []) {
    if (!this.ready) return;
    const v = ['in', ['id'], ['literal', vtdKeys]];
    const b = ['in', ['get', 'GEOID20'], ['literal', geoids]];
    this.map.setFilter('piece-hl-fill', v);
    this.map.setFilter('piece-hl', v);
    this.map.setFilter('piece-hl-block-fill', b);
    this.map.setFilter('piece-hl-block', b);
  }

  // ---- shading ------------------------------------------------------------
  setShadeMode(mode) {
    this.shadeMode = mode;
    if (!this.ready) return;
    const m = SHADE_MODES[mode];
    const cat = !m || m.kind === 'cat';
    // Unassigned units keep their own shading on the current measure unless
    // the user turns that off, and are always clear in the precinct view,
    // where there is no per-unit measure to show.
    const keep = this.shadeUnassigned && !cat;
    const unVtd = keep ? measureExpr(m) : CLEAR;
    const unBlock = keep && onBlocks(m) ? measureExpr(m) : CLEAR;
    // With precinct totals on, every assigned unit takes its drawn precinct's
    // colour, looked up through feature-state so a paint needs no data re-send.
    const agg = !cat && this.aggColors ? this.aggColors.slice(1, 5) : null;

    const vtdExpr = agg ? byDistrict(agg, unVtd)
      : cat ? districtColorExpr(unVtd)
        : (keep ? measureExpr(m) : byDistrict(Array(4).fill(measureExpr(m)), CLEAR));
    this.map.setPaintProperty('vtd-fill', 'fill-color', vtdExpr);
    const base = cat ? 0.72 : (this.dimUnder ? 0.45 : 0.8);
    this.map.setPaintProperty('vtd-fill', 'fill-opacity',
      ['case', ['==', ['feature-state', 'split'], 1], 0, base]);
    this.map.setPaintProperty('blocks-fill', 'fill-opacity', base);

    // Blocks follow the same mode where the property exists on blocks.
    const blockUnit = onBlocks(m) ? measureExpr(m) : null;
    const blockExpr = agg ? byDistrict(agg, unBlock)
      : !blockUnit ? districtColorExpr(unBlock)
        : (keep ? blockUnit : byDistrict(Array(4).fill(blockUnit), CLEAR));
    this.map.setPaintProperty('blocks-fill', 'fill-color', blockExpr);
  }

  /** Keep per-unit measure shading under unassigned units, or leave them clear. */
  setShadeUnassigned(on) { this.shadeUnassigned = on; this.setShadeMode(this.shadeMode); }

  /** Colours for precincts 1..4 (index 0 unused), or null for per-unit shading. */
  setAggColors(colors) { this.aggColors = colors; this.setShadeMode(this.shadeMode); }

  setDimUnder(on) { this.dimUnder = on; this.setShadeMode(this.shadeMode); }

  setOverlay(id, on) {
    if (!this.ready) return;
    this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  setLabels(on) {
    if (!this.ready) return;
    for (const id of this.labelLayers) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
  }

  // ---- dissolved outlines -------------------------------------------------
  refreshOutlines() {
    if (!this.ready) return;
    const features = [];
    const splits = this.splitGeometries();
    if (!splits.size) {
      const members = [[], [], [], [], []];
      for (let i = 0; i < this.data.n; i++) members[this.state.asn[i]].push(i);
      for (let d = 1; d <= 4; d++) {
        if (!members[d].length) continue;
        const geom = dissolveLines(this.topo, members[d]);
        if (geom) features.push({ type: 'Feature', properties: { d }, geometry: geom });
      }
    } else {
      // Borders through split VTDs follow the block assignment.
      const { paths, odd, stats } = mixedBoundary(this.topo, this.state.asn, splits);
      this.lastOutlineOdd = odd;
      this.lastOutlineStats = stats;
      for (let d = 1; d <= 4; d++) {
        if (paths[d].length) features.push({ type: 'Feature', properties: { d }, geometry: { type: 'MultiLineString', coordinates: paths[d] } });
      }
    }
    this.map.getSource('outline').setData({ type: 'FeatureCollection', features });
  }

  /**
   * Split VTDs with their block geometry loaded, as mixedBoundary wants them.
   * The static geometry is cached per block file.
   */
  splitGeometries() {
    const out = new Map();
    this._splitGeo = this._splitGeo || new WeakMap();
    for (const idx of this.state.splitIndices()) {
      const feats = this.blockFeatures.get(idx);
      if (!feats) continue;
      let geo = this._splitGeo.get(feats);
      if (!geo) {
        geo = splitGeometry(this.topo, idx, this.data.vtdGeo.features[idx].geometry, feats);
        this._splitGeo.set(feats, geo);
      }
      out.set(idx, { geo, ov: this.state.blockOv.get(idx) });
    }
    return out;
  }

  blockPopMap(idx) {
    const feats = this.blockFeatures.get(idx);
    if (!feats) return null;
    const m = new Map();
    for (const f of feats) m.set(f.properties.GEOID20, f.properties.pop || 0);
    return m;
  }

  /** Map<vtdIdx, Map<GEOID20, properties>> for the metrics pass. */
  blockPropsIndex() {
    const out = new Map();
    for (const [idx, feats] of this.blockFeatures) {
      const m = new Map();
      for (const f of feats) m.set(f.properties.GEOID20, f.properties);
      out.set(idx, m);
    }
    return out;
  }

  addBlockFeatures(idx, features) {
    this.blockFeatures.set(idx, features);
    this.pushBlockSource();
  }
  removeBlockFeatures(idx) {
    this.blockFeatures.delete(idx);
    this.pushBlockSource();
  }
  pushBlockSource() {
    if (!this.ready) return;
    const features = [];
    for (const idx of this.state.splitIndices()) {
      const f = this.blockFeatures.get(idx);
      if (f) { decorateBlocks(this.data.vtdGeo.features[idx].properties, f); features.push(...f); }
    }
    this.map.getSource('blocks').setData({ type: 'FeatureCollection', features });
    this.syncBlockStates();
  }

  // ---- interactions -------------------------------------------------------
  installInteractions() {
    const m = this.map;
    const canvas = m.getCanvasContainer();
    this.brushMode = 'click';
    this.spaceDown = false;

    let painting = false, boxing = false, boxStart = null, lastPt = null;
    // A press that never moved is a click: it also selects the unit under it.
    let downPt = null, moved = false;
    // Whether the drag in progress erases: fixed when it starts, so a right-drag
    // keeps erasing for its whole length.
    let dragErase = false;
    // A right press is held back until it moves: released in place it is a
    // right-click (split); moved more than RIGHT_SLOP px it is a right-drag,
    // which erases as before.
    const RIGHT_SLOP = 4;
    let rightDown = null;
    const rubber = document.getElementById('box-rubber');
    const ring = document.getElementById('brush-ring');
    this.brushRadius = this.brushRadius || 2;

    const wantsPan = () => this.brushMode === 'pan' || this.brushMode === 'select' || this.spaceDown;

    const topAt = (pt) => m.queryRenderedFeatures(pt, {
      layers: this.blockFeatures.size ? ['blocks-fill', 'vtd-fill'] : ['vtd-fill'],
    })[0] || null;

    const moveRing = (pt) => {
      const show = pt && this.brushMode === 'click' && !this.spaceDown && this.brushRadius > 2;
      ring.hidden = !show;
      if (!show) return;
      const r = this.brushRadius;
      ring.style.left = `${pt.x - r}px`; ring.style.top = `${pt.y - r}px`;
      ring.style.width = `${2 * r}px`; ring.style.height = `${2 * r}px`;
    };
    this._moveRing = moveRing;

    const pickAt = (pt) => {
      const r = this.brushRadius;
      const feats = m.queryRenderedFeatures(
        [[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]],
        { layers: this.blockFeatures.size ? ['blocks-fill', 'vtd-fill'] : ['vtd-fill'] },
      );
      return feats;
    };

    const emitPick = (feats, erase) => {
      if (!feats.length) return;
      const blocks = [], vtds = [];
      for (const f of feats) {
        if (f.layer.id === 'blocks-fill') blocks.push([f.properties.GEOID20, f.properties.vtdkey]);
        else vtds.push(f.properties.vtdkey);
      }
      // A split VTD is painted through its blocks, never wholesale by brush.
      const vtdIdx = vtds
        .map((k) => this.data.idxOf.get(k))
        .filter((i) => i !== undefined && !this.state.isSplit(i));
      this.onPick({ vtds: vtdIdx, blocks, erase });
    };

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Select and Pan never paint, and Ctrl/⌘+click selects from any tool.
    m.on('click', (e) => {
      const oe = e.originalEvent;
      if (this.brushMode === 'select' || ((oe.ctrlKey || oe.metaKey) && oe.button === 0)
        || (this.brushMode === 'pan' && !this.spaceDown)) {
        this.onSelect(topAt(e.point));
      }
    });

    const startPress = (e, oe) => {
      if (this.brushMode === 'fill' && !oe.shiftKey) {
        const top = m.queryRenderedFeatures(e.point, { layers: ['vtd-fill'] })[0];
        if (top) this.onPick({ fill: this.data.idxOf.get(top.properties.vtdkey), erase: dragErase });
        return;
      }
      if (this.brushMode === 'box' || oe.shiftKey) {
        boxing = true; boxStart = e.point;
        m.dragPan.disable();
        rubber.hidden = false;
        rubber.style.left = `${e.point.x}px`; rubber.style.top = `${e.point.y}px`;
        rubber.style.width = '0px'; rubber.style.height = '0px';
        return;
      }
      painting = true; lastPt = e.point; downPt = e.point; moved = false;
      m.dragPan.disable();
      emitPick(pickAt(e.point), dragErase);
    };

    m.on('mousedown', (e) => {
      const oe = e.originalEvent;
      if (oe.button === 2) {
        // Right button, in every tool: decided on move or release.
        rightDown = { point: e.point, shift: oe.shiftKey };
        oe.preventDefault();
        return;
      }
      if (wantsPan()) return;                             // let the map pan
      if ((oe.ctrlKey || oe.metaKey) && oe.button === 0) return;   // select, handled on click
      // Left button paints; Alt+left erases.
      if (oe.button !== 0) return;
      dragErase = oe.altKey;
      startPress(e, oe);
      oe.preventDefault();
    });

    m.on('mousemove', (e) => {
      moveRing(e.point);
      if (rightDown) {
        const d = Math.hypot(e.point.x - rightDown.point.x, e.point.y - rightDown.point.y);
        if (d <= RIGHT_SLOP) return;
        // A right-drag: erase from where the press began, in the paint tools.
        const from = rightDown;
        rightDown = null;
        if (!wantsPan() && this.brushMode !== 'fill') {
          dragErase = true;
          startPress({ point: from.point }, { shiftKey: from.shift });
        }
      }
      if (boxing) {
        const x0 = Math.min(boxStart.x, e.point.x), y0 = Math.min(boxStart.y, e.point.y);
        rubber.style.left = `${x0}px`; rubber.style.top = `${y0}px`;
        rubber.style.width = `${Math.abs(e.point.x - boxStart.x)}px`;
        rubber.style.height = `${Math.abs(e.point.y - boxStart.y)}px`;
        return;
      }
      if (painting) {
        // Step along the path so a fast drag does not skip units.
        const dx = e.point.x - lastPt.x, dy = e.point.y - lastPt.y;
        const dist = Math.hypot(dx, dy);
        if (Math.hypot(e.point.x - downPt.x, e.point.y - downPt.y) > 3) moved = true;
        const steps = Math.max(1, Math.min(40, Math.ceil(dist / 6)));
        const seen = new Set();
        const acc = [];
        for (let s = 1; s <= steps; s++) {
          const pt = { x: lastPt.x + (dx * s) / steps, y: lastPt.y + (dy * s) / steps };
          for (const f of pickAt(pt)) {
            const key = f.layer.id + ':' + (f.properties.GEOID20 ?? f.properties.vtdkey);
            if (seen.has(key)) continue;
            seen.add(key); acc.push(f);
          }
        }
        lastPt = e.point;
        emitPick(acc, dragErase);
        this.setBrushVtd(topAt(e.point));
        return;
      }
      this.hover(e.point);
    });

    const finish = (e) => {
      if (rightDown) {
        // Pressed and released in place: a right-click splits.
        const at = rightDown.point;
        rightDown = null;
        if (e) this.onSplitClick(topAt(at));
        return;
      }
      if (boxing) {
        boxing = false; rubber.hidden = true;
        m.dragPan.enable();
        const a = boxStart, b = e ? e.point : boxStart;
        if (Math.abs(a.x - b.x) > 2 && Math.abs(a.y - b.y) > 2) {
          const feats = m.queryRenderedFeatures([[Math.min(a.x, b.x), Math.min(a.y, b.y)],
            [Math.max(a.x, b.x), Math.max(a.y, b.y)]],
          { layers: this.blockFeatures.size ? ['blocks-fill', 'vtd-fill'] : ['vtd-fill'] });
          emitPick(feats, dragErase);
        }
        this.onPick({ commit: true });
        return;
      }
      if (painting) {
        painting = false;
        m.dragPan.enable();
        this.onPick({ commit: true });
        if (!moved && !dragErase && downPt) this.onSelect(topAt(downPt));
      }
    };
    m.on('mouseup', finish);
    canvas.addEventListener('mouseleave', () => { finish(null); moveRing(null); this.setBrushVtd(null); });
    window.addEventListener('blur', () => finish(null));

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && !/^(TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !(document.activeElement.tagName === 'INPUT' && /^(text|number)$/.test(document.activeElement.type))) {
        this.spaceDown = true; canvas.style.cursor = 'grab'; e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { this.spaceDown = false; canvas.style.cursor = ''; }
    });
  }

  hover(pt) {
    const feats = this.map.queryRenderedFeatures(pt, {
      layers: this.blockFeatures.size ? ['blocks-fill', 'vtd-fill'] : ['vtd-fill'],
    });
    const top = feats[0];
    this.setBrushVtd(top || null);
    if (!top) {
      this.map.setFilter('vtd-hover', ['==', ['id'], -1]);
      this.onHover(null);
      return;
    }
    if (top.layer.id === 'vtd-fill') {
      this.map.setFilter('vtd-hover', ['==', ['id'], top.properties.vtdkey]);
    } else {
      this.map.setFilter('vtd-hover', ['==', ['id'], -1]);
    }
    this.onHover(top);
  }

  setBrushMode(mode) {
    this.brushMode = mode;
    const c = this.map.getCanvasContainer();
    c.style.cursor = mode === 'pan' ? '' : mode === 'select' ? 'pointer' : mode === 'fill' ? 'cell' : 'crosshair';
    if (this._moveRing) this._moveRing(null);
  }

  /** Brush half-width in screen pixels. 2 is a single-unit point brush. */
  setBrushRadius(px) {
    this.brushRadius = px;
    if (this._moveRing) this._moveRing(null);
  }
}
