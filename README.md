# Tarrant Redraw

A browser app for hand-drawing Tarrant County, Texas commissioner precincts (4 districts)
with live analytics, in the spirit of Dave's Redistricting but carrying 2026 election data.

Static site. No backend, no build step, no dependency on R.

---

## Run it locally

Any static server over HTTP works. From the repository root:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

It will **not** work by opening `index.html` from disk: browsers block `fetch` on
`file://` URLs, so the data never loads. The app says so if you try.

Alternatives, if you prefer:

```bash
npx --yes serve .
```

```bash
php -S localhost:8000
```

## Deploy to GitHub Pages

Everything is already relative-path, so the app runs unchanged under `/TarrantRedraw/`.
This is verified — the full check suite was run against a `/TarrantRedraw/` subpath as well
as the server root.

1. In the repository: **Settings → Pages**.
2. **Source: Deploy from a branch**.
3. **Branch: `master`**, folder **`/ (root)`**. Save.

The site appears at <https://bryvado.github.io/TarrantRedraw/> within a minute or two.

Two things to know:

- Pages serves the whole repository, so `data/blocks/` (782 files, 32 MB) is published too.
  That is wanted: the app fetches those files one at a time when a VTD is split.
- The repository is about 36 MB, comfortably inside the 1 GB Pages limit. No Action or
  workflow file is needed.

## How data refreshes arrive

`data/` and the two `.R` files at the root are **read-only from the app's side**. They are
generated in R on a separate machine and pushed from there. Nothing in the app writes to
them, and nothing in the build depends on R.

So: **pull before every push**, because refreshes land from the other machine.

The app adapts to a refresh on its own in one place: `data/plans.csv` is read by its header,
so any new reference-plan column (`pre2025`, say) shows up automatically in **Start from…**
with no code change. Everything else — field names, the VTD key, the block file layout — is
assumed to stay as documented below.

---

## What is in `data/`

| File | What it is |
|---|---|
| `vtd.geojson` | 782 VTDs, EPSG:4326, simplified. Population, VAP by group, partisan composites, city and community membership. |
| `vtd_adj.json` | Column-oriented adjacency: per-unit area and perimeter (EPSG:2276, feet), and each adjacent pair once with its shared border length. |
| `plans.csv` | Reference plans, one row per VTD: `vtdkey`, `map7`, `rpack`. |
| `map7.geojson` | Map 7 precinct polygons, for the outline overlay only. |
| `cities.geojson` | 42 features: cities plus unincorporated area. Overlay. |
| `communities.geojson` | 610 communities and neighborhoods. Overlay. |
| `block_vtd.csv` | All 31,925 Tarrant 2020 Census blocks: `GEOID20`, `vtdkey`, `pop`. |
| `blocks/<vtdkey>.geojson` | One file per VTD holding that VTD's blocks. Fetched one at a time, only when a VTD is split. |

Everything in the brief was checked against the data and matched. Nothing differed.

Two properties of the data the app leans on:

- **Geometry is simplified**, so area, perimeter and adjacency are never computed from it.
  They always come from `vtd_adj.json`.
- **The VTD layer is topologically clean**: every interior boundary segment appears in
  exactly two VTDs with identical coordinates (19,166 shared segments; the 252 singletons
  are the county boundary). Precinct outlines and the dissolved GeoJSON export are therefore
  produced by exact segment cancellation, with no polygon-clipping library.

### Nulls

86 VTDs have zero population and 80 have zero votes; `dshare`, `dshare_pre`, `share26` and
`shift26` are null there. They shade as no-data, stay paintable, and add zero to every total.
`city_name` is null in 27 VTDs and `comm_raw` in 472.

---

## Using it

**Drawing.** Pick a precinct in the left rail (or press `1`–`4`). Left-drag paints and
**right-drag erases**, with the brush, the box and the fill alike. `Space`+drag pans and
the wheel zooms. The lock next to each precinct stops it being painted over.

| Key | Does |
|---|---|
| `1` `2` `3` `4` | Pick a precinct |
| `0` or `E` | Pick the eraser |
| `I` | Pick the precinct under the cursor |
| `B` / `M` / `F` / `S` / `H` | Brush / box select / fill region / select / pan |
| Click | Open the unit card for that VTD or block |
| `Ctrl`+click | The same, without painting |
| `A` | Show or hide the analytics under the map |
| `Esc` | Close the unit card |
| `Shift`+drag | Box select, whatever tool is active |
| `[` and `]` | Smaller / larger brush |
| `U` | Paint unassigned only, on or off |
| `L` | Lock or unlock the active precinct |
| `Ctrl+S` | Save the plan under its name |
| `Z` or `Ctrl+Z` | Undo |
| `R`, `Ctrl+Shift+Z` or `Ctrl+Y` | Redo |
| `?` | Show this list in the app |

**Fill region** gives the clicked VTD, and every VTD connected to it with the same
assignment, to the active precinct: one click assigns a leftover pocket, or hands a whole
contiguous piece of one precinct to another. **Paint unassigned only** protects everything
already drawn, so a new precinct can be brushed up against its neighbours without eating
them. `Ctrl+R` is deliberately left alone and still reloads the page.

A first visit starts blank: every VTD unassigned, plan named "Untitled plan". **Start from…**
loads Map 7 or any other reference plan. **Clear** unassigns every VTD, drops all block
splits and unlocks all four precincts in one step, so a cleared map can be painted straight
away; there is no confirmation, and Undo restores the plan, locks included, exactly.

**Shading** is one mode at a time: assigned precinct, Democratic share on the composite /
2026 / the 2020–24 baseline, the 2026 shift, and Hispanic, Black and nonwhite share of VAP.
Drawn precinct outlines stay on top in every mode. In the assigned-precinct view, unassigned units are
left clear so the basemap shows through until they are drawn.
**Precinct totals** (`T`) fills each drawn precinct with its own running total
on the current measure instead of shading unit by unit, so the colour moves as each VTD or
block is added. **Shade unassigned** keeps every unit that is not yet drawn shaded by its own
value on the current measure — on its own and under precinct totals alike — so the data you are
drawing against stays visible; turn it off to leave the undrawn ground clear. It is greyed out in
the assigned-precinct view, which has no per-unit measure to keep. It works for the composite, 2026 and the three VAP shares; the baseline and
the shift have no vote counts to total, so the option is greyed out there. Map 7, cities and communities are
separate toggles.

**Analytics** recompute on every change: population and deviation from ideal with a
user-set tolerance flag, Democratic share per precinct on the composite and on 2026 with
the count of Democratic-leaning precincts, VAP shares, cities and communities split listed
by name, and contiguity and Polsby-Popper from the adjacency file. The Map 7 numbers sit
under each value for comparison. The full tables sit in a dock under the map, which folds
away with `A`; the basics for each drawn precinct — population, deviation, partisan lean and
Hispanic / Black / nonwhite VAP — stay on its row in the precinct picker. The tool rail is
sized to fit a laptop screen without scrolling. Drag the edge between the rail and the map,
or between the map and the dock, to resize either; the sizes are remembered and a
double-click on the edge resets them. The map attribution stays folded behind its ⓘ button.

**The unit card.** Clicking a VTD or block opens a card in the corner of the map with its
numbers and its Split / Merge button. It follows clicks, not the pointer, so it holds still
while you reach for the button. A plain click with a paint tool paints the unit and opens
its card; the **Select** tool (`S`) and `Ctrl`+click open it without painting.

**Find problems** (under Tool) lists every precinct's connected pieces. The piece with the
most population is the main body; every other piece is a **fragment**. Unassigned pieces are
listed as **islands**. Each row gives the units, the population and a **Zoom** button that
frames and highlights the piece; the badge on the button counts fragments plus islands and
updates as you paint. Pieces come from VTD adjacency in `vtd_adj.json`. Inside split VTDs
they come from block adjacency built from the block geometry by shared segments. The block
layer does not share vertices with the VTD layer, so a block's neighbours across its VTD's
edge are found in the neighbouring VTDs' block files. That adjacency is checked before use:
every recorded VTD neighbour must be found, with the shared block border within 3% of the
recorded length (all 782 VTDs pass; the match is within 0.4%). A VTD that failed would be
counted whole at its majority precinct and not offered for cleanup.

**Clean up fragments** proposes, for each fragment and island, the neighbouring precinct it
shares the longest border with. Pieces under a population threshold (default 1% of the
ideal) are ticked; larger ones are not, because moving them changes the plan materially.
The population change per precinct, with the deviation after, is shown before you apply.
**Apply** reassigns the ticked pieces in one undoable step. A piece is skipped, with the
reason shown, when its own precinct or the proposed one is locked.

**Plans** autosave to `localStorage` continuously, splits and locks included. **Save**
(`Ctrl+S`) keeps the plan under its name in **Plans…**, overwriting the earlier save; an
untitled plan asks for a name once. The label beside it reads *Saved* or *Unsaved changes*
against that saved copy. **Plans…** also keeps separate named copies, with load, duplicate
and delete. Loading replaces the plan you are drawing, so with unsaved changes it offers
*Save, then load* first.

### Colors

- Partisan level: **red → off-white → blue** by default, centered at 50%, blue the Democratic
  end. **Colors** under Shading switches to brown / teal or orange / purple, which are
  easier to tell apart with a color-vision deficiency. The choice is remembered per browser.
- Change over time: purple `#762a83` → green `#1b7837`, centered at 0.
- Demographic shares: one single-hue sequential ramp.
- Precincts 1–4: `#1b9e77`, `#e6ab02`, `#7570b3`, `#666666`.

---

## Block-level splitting

Block editing is an option, not the default. **Split into blocks** on a VTD's unit card
fetches `data/blocks/<vtdkey>.geojson` and lets you paint its blocks individually. **Undo
split** is on the same card, whether you clicked the split VTD or any one of its blocks. It
drops the block assignments and gives the whole VTD to the precinct holding most of its
population, and the button names that precinct (*whole VTD goes to Pct 3*). Undo and redo
bring the blocks back with their colours. A plan is stored as
a VTD-level assignment plus block-level overrides.

- When a VTD is split, the analytics use its blocks' numbers in place of the VTD's.
- Contiguity and Polsby-Popper stay VTD-level, with a split VTD counted at its
  majority-population precinct. The panel marks them approximate whenever any VTD is split.
- Painting a split VTD at VTD level discards the split.

**Block-level partisan numbers are estimates.** Each VTD's votes are spread across its
blocks by voting-age population. The UI says so everywhere they appear.

---

## Exports

| Export | Format |
|---|---|
| VTD assignment CSV | Header `vtdkey,district`, one row per **assigned** VTD, district 1–4. Unassigned VTDs are left out, so in R `df$district[match(map$vtdkey, df$vtdkey)]` gives `NA` for them. No comment lines. |
| Block assignment CSV | Always header `GEOID20,District`, then one row per **assigned** block: the 15-digit GEOID as a string and the precinct 1–4. No options. 31,925 rows when every block is assigned. One click from the toolbar. |
| Dissolved precinct GeoJSON | Precinct polygons with population, VAP shares, partisan shares, contiguity and Polsby-Popper as properties. EPSG:4326. |

Both CSV formats import back in. The format is detected from the identifier: a 15-digit id
is read as a 2020 Census block, a shorter one as a VTD key. A header row is optional and
both commas and pipes work as separators. A block file whose blocks disagree within a VTD
is re-imported **as a split**, fetching only that VTD's block geometry.

If a plan has split VTDs, the VTD-level CSV flattens each split to the precinct holding
most of its population, and the export dialog says which VTDs were flattened.

### On the Dave's Redistricting block format — please read

The brief asked for this to be verified before building the export. **It could not be
confirmed from the vendor.** What was found:

- DRA's documentation site (`dra2020.github.io/dra-docs/…`) returns **404** on every page.
  The DRA developers' "Importing Maps" post on Medium returns **403**. `davesredistricting.org`
  is JavaScript-rendered and served no readable text.
- The best available evidence is the [`geomander`](https://rdrr.io/cran/geomander/src/R/dra.R)
  R package, the most widely used reader and writer of DRA exports. Its reader **requires
  the columns `GEOID20` and `District`**, reads both as character (so leading zeros survive),
  expects a header row, and accepts `.csv` only — `json not currently supported`. Its writer
  emits `tibble(GEOID20 = shp$GEOID20, District = dist)`.
- Separately, a DRA developer post (not reachable directly, seen only via search) describes
  a block assignment file as one block id and one district per line, and says a `|` is
  accepted as well as a comma.

So the export writes `GEOID20,District` with a header, comma separated, with the 15-digit
GEOID unchanged. There is one format and no options.

**Unassigned blocks are left out of the file**, never written as `0` or blank. DRA builds
its districts from the labels it finds in the file, so a `0` became a fifth, ghost
district on import. A block missing from the file is simply unassigned in DRA. When any
blocks are unassigned the export still runs, and the dialog says how many, with a **Find**
link to the Find problems tool.

**What is still unverified:** whether DRA requires every block in the state rather than one
county. A fully drawn plan covers all 31,925 Tarrant blocks.

The reliable way to settle it: draw any map in DRA, export it, and look at the header of
the file it produces. Its own export is the best template for a re-import. If it differs
from `GEOID20,District`, say so and the header takes one line to change in
`js/io.js` (`DRA_HEADER`).

---

## Verification

Every check in the brief was run and passes. Two suites:

**In Node, directly against `data/`** — the analytics and dissolve code imported and run
outside the browser.

**In a real browser (headless Chromium, Playwright)** — the app driven through its own UI
and its public handle, against both `http://localhost:8000/` and a `/TarrantRedraw/`
subpath, to match GitHub Pages.

| Check | Result |
|---|---|
| 1. Map 7 populations | 528,827 / 524,327 / 529,825 / 527,661 — exact |
| 2. Map 7 Democratic shares, composite | 73.6% / 51.3% / 43.6% / 47.9% — exact |
| 2. Map 7 Democratic shares, 2026 | 78.5% / 57.6% / 48.8% / 55.1% — exact |
| 2. County | 2,110,640 people, 52.4% composite, 58.5% on 2026 — exact |
| 2. R-pack populations | 545,087 / 540,240 / 518,489 / 506,824 — exact |
| 2. R-pack composite shares | 40.8% / 57.9% / 57.8% / 58.1% — exact |
| 2. Contiguity | both plans, all four precincts contiguous |
| 2. Adjacency graph | one connected component, 2,065 edges |
| 3. VTD CSV round trip | 782 rows, re-import reproduces every number exactly |
| 3. Block CSV | 31,925 rows; block populations summed by precinct equal check 1 |
| 4. Brush across 782 VTDs | see note below |
| 4. Split a VTD | 133 blocks in ~0.4 s |
| 5. Discontiguous precinct | flagged in the panel and on the map |
| 6. Local server and Pages subpath | both pass the whole suite, no console errors |

**On check 4, one honest caveat.** The app's own paint handler costs **0.31–0.44 ms per
mouse move** (measured over 360 synthetic moves painting 487 VTDs), and assigning,
recoloring and re-dissolving all 782 VTDs at once takes **4–7 ms**. Those are the numbers
the app controls, and they are comfortable.

What could not be measured here is the frame rate on real hardware. This container has no
GPU — WebGL runs on SwiftShader, where a single map frame costs about **180–200 ms**, which
swamps everything else and makes a drag feel slow *in the container*. On a laptop with a
GPU a frame is roughly 5–15 ms, so painting should feel immediate, but that is inference
from the frame cost, not something verified on real hardware. Worth a quick look on an
actual laptop before calling check 4 closed.

### Re-running the checks

```bash
python3 -m http.server 8731
```

The two suites live outside the repository (they were written as scratch verification, not
shipped). The app exposes `window.TarrantRedraw` — `state`, `data`, `metrics`, `mapView`
and the import/export functions — so the checks can be re-driven from the browser console
or any Playwright script.

---

## How it is built

No framework. ES modules, plain DOM, MapLibre GL JS 4.7.1 from unpkg. The basemap is
OpenFreeMap positron only.

| File | Role |
|---|---|
| `js/data.js` | Loads and normalises `data/`. Builds typed-array tables and a CSR adjacency graph. Lazily fetches block files. |
| `js/state.js` | Plan state: assignments, block overrides, locks, undo/redo, `localStorage` autosave, named plans. |
| `js/metrics.js` | All analytics. A full recompute is well under a millisecond, so every edit recomputes everything rather than keeping incremental accumulators in step. |
| `js/topology.js` | Exact precinct dissolve by segment cancellation; ring stitching with hole classification for the GeoJSON export. |
| `js/mapview.js` | MapLibre setup, layers, shading expressions, paint interactions. |
| `js/panel.js` | Analytics panel. |
| `js/io.js` | Import and export. |
| `js/colors.js` | The color ramps. |
| `js/app.js` | Wiring, toolbar, dialogs, the splitting flow. |

Painting recolors through `feature-state` with `vtdkey` as the feature id (`promoteId`), so
no source data is re-sent on a paint.

**Shares are always computed from summed votes** — `sum ndv / (sum ndv + sum nrv)` — never
by averaging VTD shares.

---

## Known limits

- **No per-precinct 2020–24 baseline share.** The data carries the baseline only as a VTD
  share (`dshare_pre`), with no baseline vote counts, so it cannot be aggregated to a
  precinct. It is available as a shading mode but not as an analytics column. If a precinct
  column is wanted, the export would need `ndv_pre` and `nrv_pre`.
- **The 2026 county commissioner race is not in the data** and cannot be re-aggregated to
  other plans — it was on the ballot in only two of the four precincts. The 2026 measure
  everywhere is the mean of U.S. Senate and Governor.
- **Community splits cover mapped communities only.** 310 of 782 VTDs carry a community, so
  138 communities have VTDs; the rest of the 610-feature overlay is not carried on any VTD
  and is not counted. The panel says so.
- **Contiguity and Polsby-Popper are VTD-level**, by design, and marked approximate when any
  VTD is split.
- Plans live in this browser's `localStorage` only. There are no accounts and no sync.

## Attribution

The map attribution control credits OpenFreeMap and OpenMapTiles, OpenStreetMap, the 2020
Census for population and VAP, the Texas statewide contests behind the composites, and both
community sources: **SimpleMaps** (607 neighborhoods) and **Districtr** (3 communities of
interest).

> **Open question for Bryson, before publishing.** The neighborhood layer is understood to
> be ODbL. The exact credit line ODbL requires has not been confirmed — the current wording
> is a placeholder. Please confirm what SimpleMaps requires and the line will be updated in
> `js/mapview.js` (`customAttribution`).

## Not in scope

No sampler, optimizer or auto-draw in the browser. No racial targets. No accounts or
multi-user editing. No changes to the R code.

## Tests

`tests/plan-persistence.mjs` drives the app in headless Chromium through Playwright, with no
web server: it saves, clears, loads and reloads a plan with a split VTD and a locked precinct;
undoes and redoes splits and merges and checks the block geometry and colours; checks that
Clear unlocks and that undo restores the locks; and exercises Save, `Ctrl+S` and the load
warning.

`tests/fragments-export.mjs` checks the export rules (Map 7 gives 31,925 rows plus the
header, values only 1–4; with part of the map cleared there is no `0` anywhere and the row
count equals the assigned blocks) and the Find problems tool: a VTD deep inside Pct 3
painted to Pct 1 shows as one fragment, Clean up proposes Pct 3 and restores Map 7 exactly,
and Undo puts it back. It also covers islands, locks and a one-block fragment in a split VTD.

```bash
node tests/plan-persistence.mjs
node tests/fragments-export.mjs
```

Set `SHOTS=<dir>` on the second to save screenshots of the tool.
