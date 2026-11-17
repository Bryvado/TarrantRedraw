// Analytics panel rendering. Each cell shows this plan's value, with the Map 7
// value beneath it in dim type when the comparison is switched on — that keeps
// the panel narrow enough to leave the map usable on a laptop.

import { el, fmtInt, fmtPct, fmtSigned, fmtNum } from './util.js';
import { PRECINCT, UNASSIGNED } from './colors.js';

const PNAME = ['Unassigned', 'Precinct 1', 'Precinct 2', 'Precinct 3', 'Precinct 4'];
const dot = (d) =>
  `<span class="pdot" style="background:${d === 0 ? UNASSIGNED : PRECINCT[d - 1]}"></span>`;

export class Panel {
  constructor(root, { onTolerance } = {}) {
    this.root = root;
    this.onTolerance = onTolerance || (() => {});
    this.tolerance = 0.05;
    this.compare = true;
  }

  render(mx, ref) {
    const cmp = this.compare && ref ? ref : null;
    this.root.innerHTML = '';
    this.root.append(
      this.population(mx, cmp),
      this.partisan(mx, cmp),
      this.demographics(mx, cmp),
      this.geometry(mx, cmp),
      this.splits(mx, cmp),
    );
    const tol = this.root.querySelector('#tol-input');
    if (tol) {
      tol.addEventListener('change', () => {
        const v = parseFloat(tol.value);
        if (Number.isFinite(v) && v >= 0 && v <= 100) {
          this.tolerance = v / 100;
          this.onTolerance(this.tolerance);
        }
      });
    }
  }

  /** value cell, with the comparison value beneath */
  cell(main, sub) {
    return cmpCell(main, this.compare ? sub : null);
  }

  // ---- population ---------------------------------------------------------
  population(mx, cmp) {
    const b = block('Population', `ideal ${fmtInt(mx.ideal)}`);
    const rows = [];
    for (let d = 1; d <= 4; d++) {
      const r = mx.rows[d], c = cmp && cmp.rows[d];
      rows.push(`<tr>
        <td>${dot(d)}Pct ${d}</td>
        <td>${this.cell(fmtInt(r.pop), c && fmtInt(c.pop))}</td>
        <td class="${r.overTol ? 'flag-bad' : ''}">${this.cell(
          fmtSigned(r.dev, 2), c && fmtSigned(c.dev, 2))}</td>
        <td>${this.cell(fmtInt(r.units), c && fmtInt(c.units))}</td>
      </tr>`);
    }
    const u = mx.rows[0];
    if (u.units > 0) {
      rows.push(`<tr class="unas"><td>${dot(0)}Unassigned</td>
        <td>${fmtInt(u.pop)}</td><td>—</td><td>${fmtInt(u.units)}</td></tr>`);
    }
    rows.push(`<tr class="tot"><td>County</td><td>${fmtInt(mx.total.pop)}</td>
      <td>range ${fmtInt(mx.popRange)}</td><td>${fmtInt(mx.rows.reduce((a, r) => a + r.units, 0))}</td></tr>`);

    b.append(table(['Precinct', 'Population', 'Deviation', 'VTDs'], rows));

    const over = [1, 2, 3, 4].filter((d) => mx.rows[d].overTol);
    b.append(el('div', { class: 'tolrow' }, [
      'Flag beyond ±',
      el('input', { id: 'tol-input', type: 'number', min: '0', max: '100', step: '0.5',
        value: (this.tolerance * 100).toFixed(1) }),
      '%',
      el('span', {
        class: over.length ? 'flag-bad' : 'good',
        text: over.length
          ? `${over.length} precinct${over.length > 1 ? 's' : ''} over (max ${fmtPct(mx.maxDev, 2)})`
          : `all within (max ${fmtPct(mx.maxDev, 2)})`,
      }),
    ]));
    return b;
  }

  // ---- partisan -----------------------------------------------------------
  partisan(mx, cmp) {
    const b = block('Partisan lean', '');
    const rows = [];
    for (let d = 1; d <= 4; d++) {
      const r = mx.rows[d], c = cmp && cmp.rows[d];
      rows.push(`<tr>
        <td>${dot(d)}Pct ${d}</td>
        <td class="${lean(r.dshare)}">${this.cell(fmtPct(r.dshare), c && fmtPct(c.dshare))}</td>
        <td class="${lean(r.share26)}">${this.cell(fmtPct(r.share26), c && fmtPct(c.share26))}</td>
      </tr>`);
    }
    rows.push(`<tr class="tot"><td>County</td>
      <td>${fmtPct(mx.total.dshare)}</td><td>${fmtPct(mx.total.share26)}</td></tr>`);
    b.append(table(['Precinct', 'Composite D', '2026 D'], rows));
    b.append(el('div', { class: 'tolrow wrap' }, [
      el('span', { html:
        `D-leaning: <strong>${mx.demComp}</strong> of 4 composite, ` +
        `<strong>${mx.dem26}</strong> of 4 on 2026` +
        (cmp ? ` <span class="cmp">(Map 7: ${cmp.demComp} / ${cmp.dem26})</span>` : '') }),
    ]));
    return b;
  }

  // ---- demographics -------------------------------------------------------
  demographics(mx, cmp) {
    const b = block('Voting-age population', '');
    const rows = [];
    for (let d = 1; d <= 4; d++) {
      const r = mx.rows[d], c = cmp && cmp.rows[d];
      rows.push(`<tr>
        <td>${dot(d)}Pct ${d}</td>
        <td>${this.cell(fmtPct(r.hisp), c && fmtPct(c.hisp))}</td>
        <td>${this.cell(fmtPct(r.black), c && fmtPct(c.black))}</td>
        <td>${this.cell(fmtPct(r.nonwhite), c && fmtPct(c.nonwhite))}</td>
      </tr>`);
    }
    rows.push(`<tr class="tot"><td>County</td>
      <td>${fmtPct(mx.total.hisp)}</td><td>${fmtPct(mx.total.black)}</td>
      <td>${fmtPct(mx.total.nonwhite)}</td></tr>`);
    b.append(table(['Precinct', 'Hispanic', 'Black', 'Nonwhite'], rows));
    return b;
  }

  // ---- geometry -----------------------------------------------------------
  geometry(mx, cmp) {
    const bad = mx.geom.slice(1).filter((g) => !g.contiguous && !g.empty);
    const b = block('Contiguity &amp; compactness', '');
    const rows = [];
    for (let d = 1; d <= 4; d++) {
      const g = mx.geom[d], c = cmp && cmp.geom[d];
      const label = g.empty ? 'empty'
        : g.contiguous ? 'contiguous'
          : `${g.components} pieces`;
      rows.push(`<tr>
        <td>${dot(d)}Pct ${d}</td>
        <td class="${g.empty ? '' : g.contiguous ? 'good' : 'flag-bad'}">${label}</td>
        <td>${this.cell(fmtNum(g.pp), c && fmtNum(c.pp))}</td>
      </tr>`);
    }
    b.append(table(['Precinct', 'Contiguity', 'Polsby-Popper'], rows));
    if (bad.length) {
      b.append(el('div', { class: 'approx', html:
        `⚠ Discontiguous: ${bad.map((g) => `Pct ${g.d} (${g.components} pieces, sizes ${g.sizes.join('/')})`).join('; ')}` }));
    }
    if (mx.approxGeom) {
      b.append(el('div', { class: 'approx', html:
        `⚠ Approximate: ${mx.nSplit} split VTD${mx.nSplit > 1 ? 's' : ''} counted at ` +
        'their majority-population precinct, because adjacency and area are VTD-level.' }));
    }
    return b;
  }

  // ---- splits -------------------------------------------------------------
  splits(mx, cmp) {
    const b = el('section', { class: 'pblock pblock-wide' });
    const head = (label, m, c) =>
      `${label} <span class="h3note"><b class="${m.splitCount ? 'flag' : 'good'}">${m.splitCount}</b> of ${m.total}`
      + `${c ? ` · Map 7: ${c.splitCount}` : ''}</span>`;
    const lists = el('div', { class: 'splitcols' }, [
      el('div', {}, [
        el('h3', { html: head('Cities split', mx.cities, cmp && cmp.cities) }),
        splitList(mx.cities.splits),
      ]),
      el('div', {}, [
        el('h3', { html: head('Communities split', mx.comms, cmp && cmp.comms) }),
        splitList(mx.comms.splits),
      ]),
    ]);
    b.append(lists);
    return b;
  }

  /** The standing caveats, shown from the dock's Notes button. */
  notesHTML(mx) {
    return [
      'Shares are computed from summed votes, never by averaging VTD shares.',
      'The 2026 measure is the mean of U.S. Senate and Governor. The 2026 county ' +
        'commissioner race was on the ballot in only two precincts, so it is not in the data.',
      'Per-precinct baseline (2020–24) share cannot be aggregated: the data carries ' +
        'the baseline only as a VTD share, with no baseline vote counts. It is available as a shading mode.',
      '86 VTDs have no population and 80 have no votes; they contribute zero to every total.',
      `${mx.comms.total} communities have VTDs assigned to them; the other neighborhoods in the ` +
        'overlay are not carried on any VTD, so they are not counted as split or whole.',
      mx.nSplit ? `${mx.nSplit} VTD${mx.nSplit > 1 ? 's' : ''} split to blocks. Block-level partisan ` +
        'figures are model estimates from race composition: a model fitted on VTDs, scaled so each ' +
        'VTD’s blocks add up exactly to its real votes. Blocks have no 2020–24 baseline, so a block’s ' +
        'shift is its 2026 estimate minus its VTD’s baseline.' : null,
    ].filter(Boolean).map((t) => `<p>${t}</p>`).join('');
  }
}

// ---- small builders -------------------------------------------------------
function block(title, note) {
  const b = el('section', { class: 'pblock' });
  b.append(el('h3', { html: `<span>${title}</span>${note ? `<span class="h3note">${note}</span>` : ''}` }));
  return b;
}

function table(head, rowHTML) {
  const t = el('table', { class: 'at' });
  t.innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`
    + `<tbody>${rowHTML.join('')}</tbody>`;
  return t;
}

const cmpCell = (main, sub) =>
  sub == null ? main : `${main}<div class="cmp">${sub}</div>`;

const lean = (s) => (s == null ? '' : s > 0.5 ? 'good' : '');

function splitList(items) {
  const d = el('div', { class: 'splitlist' });
  if (!items.length) { d.append(el('em', { text: 'None.' })); return d; }
  d.innerHTML = items.map((x) =>
    `<span class="sp"><span class="spn">${escapeHTML(String(x.name))}</span>
      <em>— Pct ${x.parts.join(', ')}${x.unassigned ? ' + unassigned' : ''}
      · ${fmtInt(x.pop)} pop</em></span>`).join('');
  return d;
}

const escapeHTML = (s) => s.replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
