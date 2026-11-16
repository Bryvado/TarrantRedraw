// MapLibre view: VTD fill painted through feature-state, dissolved precinct
// outlines on top, optional overlays, and the paint interactions.

import {
  PRECINCT, UNASSIGNED, NODATA, PARTISAN_PALETTES, DEFAULT_PARTISAN, SHIFT, SEQ, interpolateExpr,
} from './colors.js';
import { dissolveLines } from './topology.js';
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

const districtColorExpr = () => [
  'match', ['to-string', ['feature-state', 'd']],
  '1', PRECINCT[0], '2', PRECINCT[1], '3', PRECINCT[2], '4', PRECINCT[3],
  UNASSIGNED,
];

function fillColorExpr(mode) {
  const m = SHADE_MODES[mode];
  if (!m || m.kind === 'cat') return districtColorExpr();
  return ['case', ['has', m.prop], interpolateExpr(['get', m.prop], m.ramp, m.lo, m.hi), NODATA];
}

export class MapView {
  constructor(container, data, topo, state) {
    this.data = data;
    this.topo = topo;
    this.state = state;
    this.shadeMode = 'district';
    this.dimUnder = false;
    this.ready = false;
    this.onPick = () => {};
    this.onHover = () => {};
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
        'Precincts drawn in Tarrant Redraw',
        'Population &amp; VAP: 2020 U.S. Census (P.L. 94-171)',
        'Election composites: Texas statewide contests 2020–2026',
        'Neighborhoods: SimpleMaps; Communities of interest: Districtr',
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
        'fill-color': fillColorExpr('district'),
        // A split VTD is hidden so its blocks show through.
        'fill-opacity': ['case', ['==', ['feature-state', 'split'], 1], 0, 0.72],
      },
    }, firstSymbol);

    m.addLayer({
      id: 'vtd-line', type: 'line', source: 'vtd',
      paint: {
        'line-color': '#1c1e22',
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 8.5, 0.12, 11, 0.3],
        'line-width': 0.5,
      },
    }, firstSymbol);

    m.addLayer({
      id: 'blocks-fill', type: 'fill', source: 'blocks',
      paint: { 'fill-color': districtColorExpr(), 'fill-opacity': 0.82 },
    }, firstSymbol);
    m.addLayer({
      id: 'blocks-line', type: 'line', source: 'blocks',
      paint: { 'line-color': '#f5f5f5', 'line-width': 0.4, 'line-opacity': 0.5 },
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

  // ---- shading ------------------------------------------------------------
  setShadeMode(mode) {
    this.shadeMode = mode;
    if (!this.ready) return;
    // With precinct totals on, every unit takes its drawn precinct's colour,
    // looked up through feature-state so a paint needs no data re-send.
    const agg = mode !== 'district' && this.aggColors
      ? ['match', ['to-string', ['feature-state', 'd']],
        '1', this.aggColors[1], '2', this.aggColors[2], '3', this.aggColors[3], '4', this.aggColors[4],
        UNASSIGNED]
      : null;
    this.map.setPaintProperty('vtd-fill', 'fill-color', agg || fillColorExpr(mode));
    const base = mode === 'district' ? 0.72 : (this.dimUnder ? 0.45 : 0.8);
    this.map.setPaintProperty('vtd-fill', 'fill-opacity',
      ['case', ['==', ['feature-state', 'split'], 1], 0, base]);
    // Blocks follow the same mode where the property exists on blocks.
    const bm = SHADE_MODES[mode];
    const blockExpr = (mode === 'district' || !bm.prop || bm.prop === 'dshare_pre' || bm.prop === 'shift26')
      ? districtColorExpr()
      : ['case', ['has', bm.prop], interpolateExpr(['get', bm.prop], bm.ramp, bm.lo, bm.hi), NODATA];
    this.map.setPaintProperty('blocks-fill', 'fill-color', agg || blockExpr);
  }

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
    const members = [[], [], [], [], []];
    for (let i = 0; i < this.data.n; i++) {
      // Split VTDs go to their majority precinct for the outline, matching how
      // the geometry metrics treat them.
      const d = this.state.isSplit(i) ? this.state.majorityOf(i, this.blockPopMap(i)) : this.state.asn[i];
      members[d].push(i);
    }
    const features = [];
    for (let d = 1; d <= 4; d++) {
      if (!members[d].length) continue;
      const geom = dissolveLines(this.topo, members[d]);
      if (geom) features.push({ type: 'Feature', properties: { d }, geometry: geom });
    }
    this.map.getSource('outline').setData({ type: 'FeatureCollection', features });
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
      if (f) features.push(...f);
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
    // Whether the drag in progress erases: fixed at mousedown, so a right-drag
    // keeps erasing for its whole length.
    let dragErase = false;
    const rubber = document.getElementById('box-rubber');
    const ring = document.getElementById('brush-ring');
    this.brushRadius = this.brushRadius || 2;

    const wantsPan = () => this.brushMode === 'pan' || this.spaceDown;

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

    m.on('mousedown', (e) => {
      if (wantsPan()) return;                             // let the map pan
      const oe = e.originalEvent;
      // Left button paints; right button (or Alt) erases.
      if (oe.button !== 0 && oe.button !== 2) return;
      dragErase = oe.button === 2 || oe.altKey;
      if (this.brushMode === 'fill' && !oe.shiftKey) {
        const top = m.queryRenderedFeatures(e.point, { layers: ['vtd-fill'] })[0];
        if (top) this.onPick({ fill: this.data.idxOf.get(top.properties.vtdkey), erase: dragErase });
        oe.preventDefault();
        return;
      }
      if (this.brushMode === 'box' || oe.shiftKey) {
        boxing = true; boxStart = e.point;
        m.dragPan.disable();
        rubber.hidden = false;
        rubber.style.left = `${e.point.x}px`; rubber.style.top = `${e.point.y}px`;
        rubber.style.width = '0px'; rubber.style.height = '0px';
        oe.preventDefault();
        return;
      }
      painting = true; lastPt = e.point;
      m.dragPan.disable();
      emitPick(pickAt(e.point), dragErase);
      oe.preventDefault();
    });

    m.on('mousemove', (e) => {
      moveRing(e.point);
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
        return;
      }
      this.hover(e.point);
    });

    const finish = (e) => {
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
      }
    };
    m.on('mouseup', finish);
    canvas.addEventListener('mouseleave', () => { finish(null); moveRing(null); });
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
    c.style.cursor = mode === 'pan' ? '' : mode === 'fill' ? 'cell' : 'crosshair';
    if (this._moveRing) this._moveRing(null);
  }

  /** Brush half-width in screen pixels. 2 is a single-unit point brush. */
  setBrushRadius(px) {
    this.brushRadius = px;
    if (this._moveRing) this._moveRing(null);
  }
}
