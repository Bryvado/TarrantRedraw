// Plan state: VTD assignments, block-level overrides, locks, undo/redo,
// localStorage autosave and named plans.
//
// A plan is a VTD-level assignment (0 = unassigned, 1..4 = precinct) plus, for
// any VTD the user has chosen to split, a complete map of that VTD's blocks to
// precincts. "Split" means an entry exists in `blockOv`.

const LS_CUR = 'tarrant-redraw/current';
const LS_PLANS = 'tarrant-redraw/plans';
const LS_PREFS = 'tarrant-redraw/prefs';
const MAX_UNDO = 300;

// v1 autosaves could hold the "Map 7 (copy)" plan the app used to load by
// itself on a first visit. From v2 a first visit starts blank.
const AUTOSAVE_VERSION = 2;
const OLD_DEFAULT_NAME = 'Map 7 (copy)';

export class PlanState {
  constructor(data) {
    this.data = data;
    this.n = data.n;
    this.asn = new Int8Array(this.n);
    this.blockOv = new Map();          // vtdIdx -> Map<GEOID20, 0..4>
    this.locks = [false, false, false, false];
    this.name = 'Untitled plan';
    this.undoStack = [];
    this.redoStack = [];
    this._tx = null;
    this._listeners = new Set();
    this._quiet = 0;
  }

  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  emit(detail = {}) {
    if (this._quiet) return;
    for (const fn of this._listeners) fn(detail);
  }

  // ---- queries ------------------------------------------------------------
  isLocked(d) { return d >= 1 && d <= 4 && this.locks[d - 1]; }
  isSplit(idx) { return this.blockOv.has(idx); }
  get splitCount() { return this.blockOv.size; }
  splitIndices() { return Array.from(this.blockOv.keys()); }

  /** Majority-population precinct of a split VTD (ties -> lowest precinct). */
  majorityOf(idx, blockPop) {
    const ov = this.blockOv.get(idx);
    if (!ov) return this.asn[idx];
    const tally = [0, 0, 0, 0, 0];
    for (const [g, d] of ov) tally[d] += blockPop ? (blockPop.get(g) || 0) : 1;
    let best = 0, bv = -1;
    for (let d = 1; d <= 4; d++) if (tally[d] > bv) { bv = tally[d]; best = d; }
    if (bv <= 0) {
      // No population anywhere: fall back to block count.
      const cnt = [0, 0, 0, 0, 0];
      for (const d of ov.values()) cnt[d]++;
      best = 0; bv = -1;
      for (let d = 1; d <= 4; d++) if (cnt[d] > bv) { bv = cnt[d]; best = d; }
      if (bv <= 0) best = 0;
    }
    return best;
  }

  // ---- transactions -------------------------------------------------------
  begin() { if (!this._tx) this._tx = { v: [], b: [], s: [], l: null }; return this._tx; }

  commit(label = '') {
    const tx = this._tx;
    this._tx = null;
    if (!tx || (!tx.v.length && !tx.b.length && !tx.s.length && !tx.l)) return false;
    tx.label = label;
    this.undoStack.push(tx);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit({ kind: 'edit', tx });
    this.autosave();
    return true;
  }

  abort() { this._tx = null; }

  // ---- edits --------------------------------------------------------------
  /**
   * Assign VTDs to a precinct. Skips units whose current precinct is locked,
   * and skips the target if it is locked. Returns the indices actually changed.
   */
  paint(indices, district) {
    if (this.isLocked(district)) return [];
    const tx = this.begin();
    const changed = [];
    for (const i of indices) {
      const prev = this.asn[i];
      if (prev === district) continue;
      if (this.isLocked(prev)) continue;
      // Painting over a split VTD at VTD level discards the split.
      if (this.blockOv.has(i)) {
        tx.s.push([i, this.blockOv.get(i), null]);
        this.blockOv.delete(i);
      }
      this.asn[i] = district;
      tx.v.push([i, prev, district]);
      changed.push(i);
    }
    return changed;
  }

  /** Assign individual blocks inside an already-split VTD. */
  paintBlocks(idx, geoids, district) {
    if (this.isLocked(district)) return [];
    const ov = this.blockOv.get(idx);
    if (!ov) return [];
    const tx = this.begin();
    const changed = [];
    for (const g of geoids) {
      const prev = ov.get(g) ?? 0;
      if (prev === district) continue;
      if (this.isLocked(prev)) continue;
      ov.set(g, district);
      tx.b.push([idx, g, prev, district]);
      changed.push(g);
    }
    return changed;
  }

  /** Start splitting a VTD: every block takes the VTD's current precinct. */
  split(idx, geoids) {
    if (this.blockOv.has(idx)) return false;
    const tx = this.begin();
    const d = this.asn[idx];
    const ov = new Map();
    for (const g of geoids) ov.set(g, d);
    this.blockOv.set(idx, ov);
    tx.s.push([idx, null, ov]);
    return true;
  }

  /** Collapse a split back to VTD level, at its majority precinct. */
  unsplit(idx, blockPop) {
    const ov = this.blockOv.get(idx);
    if (!ov) return false;
    const tx = this.begin();
    const maj = this.majorityOf(idx, blockPop);
    tx.s.push([idx, ov, null]);
    this.blockOv.delete(idx);
    if (this.asn[idx] !== maj) {
      tx.v.push([idx, this.asn[idx], maj]);
      this.asn[idx] = maj;
    }
    return true;
  }

  /** Replace the whole assignment (reference plan, import, load). */
  setAll(arr, { name, clearHistory = true, label = 'load', autosave = true } = {}) {
    const tx = this.begin();
    for (const [i, ov] of this.blockOv) tx.s.push([i, ov, null]);
    this.blockOv.clear();
    for (let i = 0; i < this.n; i++) {
      const d = arr[i] | 0;
      const prev = this.asn[i];
      if (prev !== d) { this.asn[i] = d; tx.v.push([i, prev, d]); }
    }
    if (name != null) this.name = name;
    if (clearHistory) {
      this._tx = null;
      this.undoStack.length = 0;
      this.redoStack.length = 0;
      this.emit({ kind: 'reset' });
      if (autosave) this.autosave();
      return true;
    }
    return this.commit(label);
  }

  /** Unassign everything, drop every split and unlock all four precincts: one undoable step. */
  clearAll() {
    if (this.locks.some(Boolean)) {
      const tx = this.begin();
      tx.l = [this.locks.slice(), [false, false, false, false]];
      this.locks = [false, false, false, false];
    }
    return this.setAll(new Int8Array(this.n), { clearHistory: false, label: 'clear' });
  }

  // ---- undo / redo --------------------------------------------------------
  _applyInverse(tx, forward) {
    const touched = { vtds: [], blocks: [], splits: [], locks: false };
    if (tx.l) { this.locks = (forward ? tx.l[1] : tx.l[0]).slice(); touched.locks = true; }
    const vlist = forward ? tx.v : [...tx.v].reverse();
    const blist = forward ? tx.b : [...tx.b].reverse();
    const slist = forward ? tx.s : [...tx.s].reverse();
    for (const [i, from, to] of slist) {
      const target = forward ? to : from;
      if (target) this.blockOv.set(i, target); else this.blockOv.delete(i);
      touched.splits.push(i);
    }
    for (const [i, prev, next] of vlist) {
      this.asn[i] = forward ? next : prev;
      touched.vtds.push(i);
    }
    for (const [i, g, prev, next] of blist) {
      const ov = this.blockOv.get(i);
      if (ov) ov.set(g, forward ? next : prev);
      touched.blocks.push([i, g]);
    }
    return touched;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const tx = this.undoStack.pop();
    if (!tx) return false;
    const touched = this._applyInverse(tx, false);
    this.redoStack.push(tx);
    this.emit({ kind: 'undo', touched });
    this.autosave();
    return true;
  }

  redo() {
    const tx = this.redoStack.pop();
    if (!tx) return false;
    const touched = this._applyInverse(tx, true);
    this.undoStack.push(tx);
    this.emit({ kind: 'redo', touched });
    this.autosave();
    return true;
  }

  // ---- serialisation ------------------------------------------------------
  toJSON() {
    const ov = {};
    for (const [i, m] of this.blockOv) {
      const o = {};
      for (const [g, d] of m) o[g] = d;
      ov[this.data.keys[i]] = o;
    }
    return {
      v: AUTOSAVE_VERSION,
      name: this.name,
      asn: Array.from(this.asn).join(''),       // 782 digits, 0..4
      locks: this.locks.slice(),
      blockOv: ov,
      saved: new Date().toISOString(),
    };
  }

  /**
   * Replace the plan with a serialised one. It does not autosave: the caller
   * does that once the load is complete (block geometry fetched, splits that
   * failed to load dropped), so localStorage never holds a half-loaded plan.
   */
  fromJSON(obj, { clearHistory = true } = {}) {
    if (!obj || typeof obj.asn !== 'string') return false;
    const arr = new Int8Array(this.n);
    const s = obj.asn;
    for (let i = 0; i < Math.min(this.n, s.length); i++) {
      const d = s.charCodeAt(i) - 48;
      arr[i] = d >= 0 && d <= 4 ? d : 0;
    }
    this._quiet++;
    this.setAll(arr, { name: obj.name ?? this.name, clearHistory: true, autosave: false });
    this._quiet--;
    this.locks = Array.isArray(obj.locks) ? obj.locks.map(Boolean).slice(0, 4) : [false, false, false, false];
    while (this.locks.length < 4) this.locks.push(false);
    this.blockOv.clear();
    for (const [k, o] of Object.entries(obj.blockOv || {})) {
      const i = this.data.idxOf.get(Math.round(Number(k)));
      if (i === undefined) continue;
      const m = new Map();
      for (const [g, d] of Object.entries(o)) m.set(String(g), d | 0);
      if (m.size) this.blockOv.set(i, m);
    }
    if (clearHistory) { this.undoStack.length = 0; this.redoStack.length = 0; }
    this.emit({ kind: 'reset' });
    return true;
  }

  /** The plan's content, without the timestamp: equal strings mean equal plans. */
  signature(json = this.toJSON()) {
    const { saved, v, ...rest } = json;
    const ov = rest.blockOv || {};
    const sortedOv = {};
    for (const k of Object.keys(ov).sort()) {
      const o = ov[k], so = {};
      for (const g of Object.keys(o).sort()) so[g] = o[g];
      sortedOv[k] = so;
    }
    return JSON.stringify([rest.name, rest.asn, (rest.locks || []).map(Boolean), sortedOv]);
  }

  // ---- localStorage -------------------------------------------------------
  autosave() {
    try { localStorage.setItem(LS_CUR, JSON.stringify(this.toJSON())); }
    catch (e) { /* quota or private mode: autosave is best-effort */ }
  }
  restore() {
    try {
      const raw = localStorage.getItem(LS_CUR);
      if (!raw) return false;
      const obj = JSON.parse(raw);
      if ((obj.v ?? 1) < AUTOSAVE_VERSION && this._isOldDefault(obj)) {
        // The plan the old version auto-loaded, never renamed or edited:
        // open blank once. Anything the user named or changed is kept.
        localStorage.removeItem(LS_CUR);
        return false;
      }
      // The caller autosaves once the splits are rehydrated, which also
      // rewrites the plan at the current version.
      return this.fromJSON(obj);
    } catch (e) { return false; }
  }

  /** True only for an untouched auto-loaded Map 7: same name, same assignment, no splits. */
  _isOldDefault(obj) {
    if (obj.name !== OLD_DEFAULT_NAME) return false;
    if (obj.blockOv && Object.keys(obj.blockOv).length) return false;
    const m7 = this.data.planCols.map7;
    if (!m7 || typeof obj.asn !== 'string') return false;
    return obj.asn === Array.from(m7).join('');
  }
}

// ---- named plan library ---------------------------------------------------
export const planLib = {
  all() {
    try { return JSON.parse(localStorage.getItem(LS_PLANS) || '{}'); }
    catch (e) { return {}; }
  },
  write(obj) {
    try { localStorage.setItem(LS_PLANS, JSON.stringify(obj)); return true; }
    catch (e) { return false; }
  },
  save(name, planJSON) {
    const all = this.all();
    all[name] = { ...planJSON, name };
    return this.write(all);
  },
  get(name) { return this.all()[name] || null; },
  remove(name) { const all = this.all(); delete all[name]; return this.write(all); },
  names() { return Object.keys(this.all()).sort((a, b) => a.localeCompare(b)); },
  /** "Name", "Name 2", "Name 3", … */
  uniqueName(base) {
    const all = this.all();
    if (!all[base]) return base;
    for (let i = 2; i < 500; i++) if (!all[`${base} ${i}`]) return `${base} ${i}`;
    return `${base} ${Date.now()}`;
  },
};

export const prefs = {
  all() {
    try { return JSON.parse(localStorage.getItem(LS_PREFS) || '{}'); }
    catch (e) { return {}; }
  },
  get(k, dflt) { const v = this.all()[k]; return v === undefined ? dflt : v; },
  set(k, v) {
    const a = this.all(); a[k] = v;
    try { localStorage.setItem(LS_PREFS, JSON.stringify(a)); } catch (e) {}
  },
};
