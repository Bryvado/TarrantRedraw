// Color ramps. Partisan shading defaults to red / blue; two alternatives are
// offered for readers who cannot separate those well or prefer not to use them.

export const PRECINCT = ['#1b9e77', '#e6ab02', '#7570b3', '#666666'];
export const UNASSIGNED = '#5a6068';
export const NODATA = '#43474d';

/**
 * Partisan level palettes, Republican end first, Democratic end last, centred
 * at 50%. All three are ColorBrewer diverging schemes rated colorblind-safe;
 * the alternatives are there because red against blue is still the hardest of
 * the three to tell apart with a colour-vision deficiency.
 */
export const PARTISAN_PALETTES = {
  redblue: {
    label: 'Red / blue',
    stops: ['#b2182b', '#ef8a62', '#fddbc7', '#f7f7f7', '#d1e5f0', '#67a9cf', '#2166ac'],
    rep: 'Red', dem: 'Blue',
  },
  brownteal: {
    label: 'Brown / teal',
    stops: ['#8c510a', '#bf812d', '#dfc27d', '#f5f5f5', '#80cdc1', '#35978f', '#01665e'],
    rep: 'Brown', dem: 'Teal',
  },
  orangepurple: {
    label: 'Orange / purple',
    stops: ['#b35806', '#f1a340', '#fee0b6', '#f7f7f7', '#d8daeb', '#998ec3', '#542788'],
    rep: 'Orange', dem: 'Purple',
  },
};
export const DEFAULT_PARTISAN = 'redblue';
/** Change over time: purple -> green, centered at 0. */
export const SHIFT = ['#762a83', '#9970ab', '#c2a5cf', '#f7f7f7', '#a6dba0', '#5aae61', '#1b7837'];
/** Demographic shares: single-hue sequential (blue-green, distinct from the precinct hues). */
export const SEQ = ['#f7fcfd', '#d5e8ef', '#a9d2e0', '#74b2cd', '#4a8fb5', '#2b6a95', '#143f6b'];

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

/** Sample a ramp at t in [0,1] and return a CSS rgb() string. */
export function ramp(stops, t) {
  if (!Number.isFinite(t)) return NODATA;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = t * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const a = hex(stops[i]), b = hex(stops[i + 1]);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${
    Math.round(a[1] + (b[1] - a[1]) * f)},${
    Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

/** CSS linear-gradient for a legend bar. */
export const gradientCSS = (stops) =>
  `linear-gradient(to right,${stops.join(',')})`;

/**
 * MapLibre `interpolate` colour expression over a numeric input, mapping
 * [lo,hi] across the ramp's stops. `input` is an expression.
 */
export function interpolateExpr(input, stops, lo, hi) {
  const out = ['interpolate', ['linear'], input];
  const n = stops.length - 1;
  for (let i = 0; i <= n; i++) out.push(lo + ((hi - lo) * i) / n, stops[i]);
  return out;
}
