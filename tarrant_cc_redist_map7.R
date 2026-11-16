# SCRIPT: tarrant_cc_redist_map7.R
# SMC ensemble of Tarrant County commissioner precincts (4) on TLC 2024 VTDs
# Reference plans: 2025 Map 7 (Tarrant7_clean.geojson), optional pre-2025 plan,
#   and "R-pack": an optimized plan packing Republicans into one precinct (section 4b)
# Partisanship baseline: time-decayed composite of 2020, 2022, 2024 and 2026 top-of-ticket races.
# 2026 commissioner results (CC_*) are plotted only and never enter the baseline.
# 2026 Senate + Governor votes are also kept on their own (ndv26/nrv26) to show what 2026 looks like on any plan.

library(tidyverse)
library(sf)
library(tigris)
library(redist)
library(mapgl)

options(tigris_use_cache = TRUE)

DIR <- "~/TarrantRedistricting"                 # checkpoints + optional extras
SRC <- file.path(DIR, "sourceshapes")           # hand-supplied input layers
HALF_LIFE <- 4                                  # years; weight = 0.5^((2026 - year) / HALF_LIFE)
D_TGT     <- 0.57                               # R-pack: Democratic share the three unpacked precincts should clear

# ---- 0. Preflight ----
NEED <- c("Tarrant7_clean.geojson", "tarrant_precincts_2026.gpkg",
          "tarrant_cities.gpkg", "tarrant_communities.gpkg")
CKPT <- c("tarrant_vtd_tlc24pg.rds", "tarrant_cc_smc_splits.rds", "tx_cvap_2020_b.csv")

for (f in CKPT) {
  if (file.exists(file.path(DIR, f))) next
  hit <- list.files("~/tarrantmodel", pattern = paste0("^", f, "$"), full.names = TRUE, recursive = TRUE)
  if (length(hit)) {
    file.copy(hit[which.max(file.mtime(hit))], file.path(DIR, f))
    cat("copied", f, "\n")
  }
}
print(tibble(file = c(NEED, CKPT),
             folder = c(rep("sourceshapes", length(NEED)), rep("DIR", length(CKPT))),
             present = c(file.exists(file.path(SRC, NEED)), file.exists(file.path(DIR, CKPT)))))
stopifnot(all(file.exists(file.path(SRC, NEED))))

# ---- 1. TLC: 24PG VTD geometry, 2020 Census population, general returns ----
TLC <- "https://data.capitol.texas.gov/dataset"
URLS <- c(
  shp  = file.path(TLC, "4d8298d0-d176-4c19-b174-42837027b73e/resource/906f47e4-4e39-4156-b1bd-4969be0b2780/download/vtds_24pg.zip"),
  pop  = file.path(TLC, "4d8298d0-d176-4c19-b174-42837027b73e/resource/bf9b54a8-090c-41d0-8f00-e263fc1789c5/download/vtds_24pg_pop.zip"),
  elec = file.path(TLC, "35b16aee-0bb0-4866-b1ec-859f1f044241/resource/e1cd6332-6a7a-4c78-ad2a-852268f6c7a2/download/2024-general-vtds-election-data.zip")
)
grab <- function(url) {
  z <- tempfile(fileext = ".zip"); d <- tempfile()
  options(timeout = 1200)
  download.file(url, z, mode = "wb"); unzip(z, exdir = d); unlink(z)
  d
}
low <- function(x) rename_with(x, tolower)

f_map <- file.path(DIR, "tarrant_vtd_tlc24pg.rds")
if (file.exists(f_map)) {
  tar_sf <- readRDS(f_map)
} else {
  d   <- grab(URLS["shp"])
  shp <- st_read(list.files(d, "\\.shp$", full.names = TRUE, recursive = TRUE)[1], quiet = TRUE) |> low()
  if (!all(c("cnty", "vtdkey") %in% names(shp))) print(names(shp))
  stopifnot(all(c("cnty", "vtdkey") %in% names(shp)))
  shp <- shp |> filter(as.integer(cnty) == 439) |> select(vtdkey, any_of(c("vtd", "cntyvtd")))
  unlink(d, recursive = TRUE)
  
  d   <- grab(URLS["pop"])
  pop <- read_csv(list.files(d, "\\.(txt|csv)$", full.names = TRUE, recursive = TRUE)[1],
                  show_col_types = FALSE) |> low()
  need <- c("vtdkey", "total", "vap", "anglovap", "blackvap", "hispvap")
  if (!all(need %in% names(pop))) print(names(pop))
  stopifnot(all(need %in% names(pop)))
  pop <- pop |> transmute(vtdkey, pop = total, vap, vap_white = anglovap,
                          vap_black = blackvap, vap_hisp = hispvap)
  unlink(d, recursive = TRUE)
  
  d  <- grab(URLS["elec"])
  fs <- list.files(d, "General_Election_Returns", full.names = TRUE, recursive = TRUE)
  fs <- fs[str_extract(basename(fs), "\\d{4}") %in% c("2020", "2022", "2024")]
  if (length(fs) != 3) print(list.files(d, recursive = TRUE))
  stopifnot(length(fs) == 3)
  el <- map_dfr(fs, function(f) {
    x   <- read_csv(f, show_col_types = FALSE) |> low()
    key <- intersect(c("vtdkey", "vtdkeyvalue"), names(x))[1]
    stopifnot(!is.na(key), all(c("office", "party", "votes") %in% names(x)))
    x |>
      rename(vtdkey = all_of(key)) |>
      filter(vtdkey %in% shp$vtdkey, party %in% c("D", "R"),
             str_detect(office, "^(President|U\\.S\\. Sen|Governor)$")) |>
      mutate(contest = paste(str_extract(basename(f), "\\d{4}"),
                             str_remove_all(office, "[^A-Za-z]"), sep = "_")) |>
      group_by(vtdkey, contest, party) |>
      summarise(votes = sum(votes), .groups = "drop")
  })
  unlink(d, recursive = TRUE)
  print(unique(el$contest))
  stopifnot(n_distinct(el$contest) == 5)
  el <- el |>
    pivot_wider(names_from = c(party, contest), values_from = votes, values_fill = 0)
  
  tar_sf <- shp |> left_join(pop, by = "vtdkey") |> left_join(el, by = "vtdkey")
  cat("VTDs:", nrow(tar_sf), " no pop row:", sum(is.na(tar_sf$pop)), "\n")
  stopifnot(!anyNA(tar_sf$pop))
  tar_sf <- tar_sf |> mutate(across(matches("^[DR]_\\d{4}_"), \(v) replace_na(v, 0)))
  saveRDS(tar_sf, f_map)
}

# ---- 1b. RDH block CVAP summed to VTDs (optional; CSV from RDH, free login) ----
RDH_CVAP <- file.path(DIR, "tx_cvap_2020_b.csv")
if (file.exists(RDH_CVAP) && !"cvap_tot" %in% names(tar_sf)) {
  cv <- read_csv(RDH_CVAP, col_types = cols(GEOID20 = "c"), show_col_types = FALSE) |>
    filter(str_starts(GEOID20, "48439")) |>
    select(GEOID20, matches("^CVAP_(TOT|HSP|BLK|WHT)\\d{2}$")) |>
    rename_with(\(n) tolower(str_remove(n, "\\d{2}$")), -GEOID20)
  stopifnot(all(c("cvap_tot", "cvap_hsp", "cvap_blk", "cvap_wht") %in% names(cv)))
  blk_cv <- blocks("TX", "Tarrant", year = 2020) |>
    st_drop_geometry() |>
    transmute(GEOID20, lon = as.numeric(INTPTLON20), lat = as.numeric(INTPTLAT20)) |>
    st_as_sf(coords = c("lon", "lat"), crs = 4269) |>
    st_transform(st_crs(tar_sf)) |>
    st_join(tar_sf["vtdkey"], join = st_within) |>
    st_drop_geometry()
  cat("Blocks with no VTD:", sum(is.na(blk_cv$vtdkey)), "\n")
  cv_vtd <- blk_cv |> inner_join(cv, by = "GEOID20") |>
    group_by(vtdkey) |> summarise(across(starts_with("cvap_"), sum))
  tar_sf <- tar_sf |> left_join(cv_vtd, by = "vtdkey") |>
    mutate(across(starts_with("cvap_"), \(v) replace_na(v, 0)))
  saveRDS(tar_sf, f_map)
}

# ---- 1c. 2026 Senate + Governor: county precincts -> VTDs through 2020 blocks ----
pc26 <- st_read(file.path(SRC, "tarrant_precincts_2026.gpkg"), quiet = TRUE)
V26  <- c("SEN_D", "SEN_R", "GOV_D", "GOV_R")
stopifnot(all(c("PCT", V26) %in% names(pc26)), !anyDuplicated(pc26$PCT))

f_x26 <- file.path(DIR, "tarrant_vtd_2026_votes.rds")
if (file.exists(f_x26)) {
  v26 <- readRDS(f_x26)
} else {
  v2276 <- tar_sf |> st_transform(2276) |> select(vtdkey)
  p26   <- pc26  |> st_transform(2276) |> select(PCT)
  blk <- blocks("TX", "Tarrant", year = 2020) |>
    st_drop_geometry() |>
    transmute(w = as.numeric(POP20), lon = as.numeric(INTPTLON20), lat = as.numeric(INTPTLAT20)) |>
    st_as_sf(coords = c("lon", "lat"), crs = 4269) |>
    st_transform(2276)
  blk$vtdkey <- v2276$vtdkey[st_nearest_feature(blk, v2276)]
  blk$PCT    <- p26$PCT[st_nearest_feature(blk, p26)]
  
  # share of each precinct's votes going to each VTD, by block population
  xw <- blk |> st_drop_geometry() |>
    count(PCT, vtdkey, wt = w, name = "w") |>
    group_by(PCT) |>
    mutate(share = if (sum(w) > 0) w / sum(w) else 1 / n()) |>
    ungroup() |> select(PCT, vtdkey, share)
  
  votes26 <- pc26 |> st_drop_geometry() |> select(PCT, all_of(V26)) |>
    mutate(across(all_of(V26), \(x) replace_na(as.numeric(x), 0)))
  
  # precincts containing no block point go whole to the nearest VTD
  orphan <- setdiff(votes26$PCT, xw$PCT)
  if (length(orphan)) {
    pts <- suppressWarnings(st_point_on_surface(p26[match(orphan, p26$PCT), ]))
    xw  <- bind_rows(xw, tibble(PCT = orphan, vtdkey = v2276$vtdkey[st_nearest_feature(pts, v2276)], share = 1))
  }
  cat("2026 precincts with no block point:", length(orphan), "\n")
  
  v26 <- xw |> inner_join(votes26, by = "PCT") |>
    group_by(vtdkey) |>
    summarise(across(all_of(V26), \(x) sum(x * share)), .groups = "drop")
  print(rbind(precincts = colSums(votes26[V26]), vtds = colSums(v26[V26])))
  stopifnot(isTRUE(all.equal(colSums(votes26[V26]), colSums(v26[V26]), tolerance = 1e-6)))
  saveRDS(v26, f_x26)
}

# drop-then-join so a re-run in the same session never creates .x/.y copies
tar_sf <- tar_sf |>
  select(-matches("_2026_")) |>
  left_join(v26 |> transmute(vtdkey,
                             D_2026_USSen = SEN_D, R_2026_USSen = SEN_R,
                             D_2026_Governor = GOV_D, R_2026_Governor = GOV_R),
            by = "vtdkey") |>
  mutate(across(matches("_2026_"), \(v) replace_na(v, 0)))

# ---- 1d. Time-decayed composite baseline ----
contest_long <- tar_sf |> st_drop_geometry() |>
  select(vtdkey, matches("^[DR]_\\d{4}_")) |>
  pivot_longer(-vtdkey, names_to = c("party", "year", "office"),
               names_pattern = "^([DR])_(\\d{4})_(.+)$", values_to = "votes") |>
  pivot_wider(names_from = party, values_from = votes, values_fill = 0) |>
  mutate(year = as.integer(year), tot = D + R,
         share = if_else(tot > 0, D / tot, NA_real_))
print(distinct(contest_long, year, office) |> arrange(year))
stopifnot(n_distinct(paste(contest_long$year, contest_long$office)) == 7)

# contests are averaged within a year first, so two-contest years don't count double
year_vtd <- contest_long |>
  group_by(vtdkey, year) |>
  summarise(share = if (all(is.na(share))) NA_real_ else mean(share, na.rm = TRUE),
            tot = mean(tot), .groups = "drop") |>
  mutate(w = 0.5^((2026 - year) / HALF_LIFE))
print(year_vtd |> distinct(year, w) |> mutate(pct_of_composite = round(100 * w / sum(w), 1)))

comp <- year_vtd |>
  group_by(vtdkey) |>
  summarise(dshare     = if (all(is.na(share))) NA_real_ else weighted.mean(share, w, na.rm = TRUE),
            turnout    = mean(tot),
            dshare_pre = if (all(is.na(share[year < 2026]))) NA_real_ else
              weighted.mean(share[year < 2026], w[year < 2026], na.rm = TRUE),
            share26    = share[year == 2026][1],
            tot26      = tot[year == 2026][1],
            .groups = "drop") |>
  mutate(ndv     = replace_na(dshare, 0.5) * turnout,
         nrv     = (1 - replace_na(dshare, 0.5)) * turnout,
         ndv26   = replace_na(share26, 0.5) * tot26,          # 2026 Senate + Governor, averaged
         nrv26   = (1 - replace_na(share26, 0.5)) * tot26,
         shift26 = share26 - dshare_pre)                      # 2026 minus the decayed 2020-24 baseline

# drop-then-join so a re-run in the same session never creates .x/.y copies
COMP_COLS <- setdiff(names(comp), "vtdkey")
tar_sf <- tar_sf |>
  select(-any_of(COMP_COLS)) |>
  left_join(comp, by = "vtdkey")
cty <- function(n, d) round(100 * sum(n, na.rm = TRUE) / sum(d, na.rm = TRUE), 1)
cat("County D share | composite:", cty(tar_sf$ndv, tar_sf$ndv + tar_sf$nrv),
    "| 2026 Senate+Governor:", cty(tar_sf$ndv26, tar_sf$ndv26 + tar_sf$nrv26),
    "| 2020-24 baseline:", cty(replace_na(tar_sf$dshare_pre, 0.5) * tar_sf$turnout, tar_sf$turnout), "\n")

# ---- 2. Reference plans, assigned by largest area overlap ----
assign_plan_area <- function(plan, col) {
  v <- tar_sf |> st_transform(2276) |> select(vtdkey)
  p <- plan  |> st_transform(2276) |> st_make_valid() |> select(all_of(col))
  ix <- suppressWarnings(st_intersection(v, p))
  ix$a <- as.numeric(st_area(ix))
  best <- ix |> st_drop_geometry() |>
    group_by(vtdkey) |> slice_max(a, n = 1, with_ties = FALSE) |> ungroup()
  as.integer(best[[col]][match(tar_sf$vtdkey, best$vtdkey)])
}

map7_sf <- st_read(file.path(SRC, "Tarrant7_clean.geojson"), quiet = TRUE)
tar_sf$cc_map7 <- assign_plan_area(map7_sf, "PRECINCT")
stopifnot(!anyNA(tar_sf$cc_map7), setequal(unique(tar_sf$cc_map7), 1:4))
print(tar_sf |> st_drop_geometry() |> group_by(cc_map7) |>
        summarise(vtds = n(), pop = sum(pop)))

f_pre <- file.path(DIR, "cc_pre2025.shp")   # optional pre-2025 plan, needs a PRECINCT column
tar_sf$cc_pre2025 <- if (file.exists(f_pre)) assign_plan_area(st_read(f_pre, quiet = TRUE), "PRECINCT") else NA_integer_
HAS_PRE <- !anyNA(tar_sf$cc_pre2025)

# ---- 2b. City and community labels per VTD (largest-overlap rule) ----
label_vtds <- function(layer, id_col, min_share = 0.5) {
  v <- tar_sf |> st_transform(2276) |> select(vtdkey)
  v$vtd_area <- as.numeric(st_area(v))
  ix <- suppressWarnings(st_intersection(v, st_make_valid(st_transform(layer[id_col], 2276))))
  ix$a <- as.numeric(st_area(ix))
  best <- ix |> st_drop_geometry() |>
    group_by(vtdkey, id = .data[[id_col]]) |>
    summarise(a = sum(a), vtd_area = first(vtd_area), .groups = "drop") |>
    group_by(vtdkey) |> slice_max(a, n = 1, with_ties = FALSE) |> ungroup() |>
    filter(a / vtd_area >= min_share)
  best$id[match(tar_sf$vtdkey, best$vtdkey)]
}
fill_unique <- function(id) {
  out <- as.integer(factor(id))
  na  <- is.na(out)
  out[na] <- max(c(out, 0L), na.rm = TRUE) + seq_len(sum(na))
  out
}

cities <- st_read(file.path(SRC, "tarrant_cities.gpkg"), quiet = TRUE) |> filter(type == "city")
comms  <- st_read(file.path(SRC, "tarrant_communities.gpkg"), quiet = TRUE)

tar_sf$city_name <- label_vtds(cities, "city")
tier <- cities$split_tier[match(tar_sf$city_name, cities$city)]
tar_sf$city_std  <- fill_unique(if_else(tier == "standard",  tar_sf$city_name, NA_character_))
tar_sf$city_irr  <- fill_unique(if_else(tier == "irregular", tar_sf$city_name, NA_character_))
tar_sf$city_fw   <- fill_unique(if_else(tier == "multi",     tar_sf$city_name, NA_character_))
tar_sf$city_all  <- fill_unique(tar_sf$city_name)
tar_sf$comm_raw  <- label_vtds(comms, "comm_id", min_share = 0.2)
tar_sf$comm      <- fill_unique(tar_sf$comm_raw)

# ---- 2c. 2026 commissioner results: PLOTTING ONLY ----
cc26 <- pc26 |> st_drop_geometry() |>
  filter(CC_PCT > 0) |>
  group_by(district = CC_PCT) |>
  summarise(d26 = sum(CC_D), r26 = sum(CC_R), .groups = "drop") |>
  mutate(dem26 = d26 / (d26 + r26))
print(cc26)
stopifnot(!any(grepl("^CC_", names(tar_sf))))   # commissioner results never enter the baseline

# ---- 3. redist_map: 4 districts, +/-5% ----
tar_sf$two_party <- tar_sf$ndv + tar_sf$nrv
map <- redist_map(tar_sf, ndists = 4, pop_tol = 0.05, total_pop = pop)

# ---- 4. SMC with split penalties by level (checkpointed) ----
cons <- redist_constr(map) |>
  add_constr_splits(strength = 1.0, admin = city_std) |>
  add_constr_multisplits(strength = 4.0, admin = city_std) |>
  add_constr_multisplits(strength = 1.5, admin = city_irr) |>
  add_constr_total_splits(strength = 0.3, admin = city_fw) |>
  add_constr_splits(strength = 0.3, admin = comm)

f_pl <- file.path(DIR, "tarrant_cc_smc_splits.rds")
if (file.exists(f_pl)) {
  plans <- readRDS(f_pl)
} else {
  set.seed(439)
  plans <- redist_smc(map, nsims = 100000, runs = 2, compactness = 1, constraints = cons)
  saveRDS(plans, f_pl)
}

# ---- 4b. Republican-pack ensemble and one optimized pack plan (checkpointed) ----
# The hinge penalty takes a square root of each precinct's shortfall below D_TGT, so the sampler
# prefers one deep shortfall (the packed R precinct) over several shallow ones.
cons_pack <- cons |>
  add_constr_grp_hinge(strength = 25, group_pop = ndv, total_pop = two_party, tgts_group = D_TGT)

f_pk <- file.path(DIR, "tarrant_cc_smc_rpack.rds")
if (file.exists(f_pk)) {
  plans_pack <- readRDS(f_pk)
} else {
  set.seed(439)
  plans_pack <- redist_smc(map, nsims = 20000, runs = 2, compactness = 1, constraints = cons_pack)
  saveRDS(plans_pack, f_pk)
}

pack_tab <- plans_pack |>
  mutate(dem = group_frac(map, ndv, two_party)) |>
  as_tibble() |>
  group_by(draw) |>
  summarise(dem_seats = sum(dem > 0.5), third = sort(dem)[2], packed = min(dem), .groups = "drop")
count(pack_tab, dem_seats)                      # Democratic-leaning precincts in the pack ensemble
summary(select(pack_tab, third, packed))        # third = weakest of the three D precincts; packed = the R precinct

# Start from the sampled pack plan with the strongest third D precinct, then push further with short bursts.
# Score: third-highest Democratic share, minus a small charge per split city.
f_sb <- file.path(DIR, "tarrant_cc_rpack_plan.rds")
if (file.exists(f_sb)) {
  cc_pack <- readRDS(f_sb)
} else {
  init  <- get_plans_matrix(plans_pack)[, which.max(pack_tab$third)]
  # redist's scorer_splits() crashes R on this map; count split cities in R instead
  city_id <- map$city_all
  s_split <- structure(function(plans) apply(as.matrix(plans), 2, \(a) sum(tapply(a, city_id, n_distinct) > 1)),
                       class = c("redist_scorer", "function"))
  score <- scorer_group_pct(map, ndv, two_party, k = 3) - 0.002 * s_split
  set.seed(439)
  sb <- redist_shortburst(map, score, init_plan = init, burst_size = 10, max_bursts = 400,
                          maximize = TRUE, verbose = FALSE)
  sb_m    <- get_plans_matrix(sb)
  cc_pack <- as.integer(sb_m[, ncol(sb_m)])
  saveRDS(cc_pack, f_sb)
}
stopifnot(length(cc_pack) == nrow(map), setequal(unique(cc_pack), 1:4))

refs <- "Map 7"
plans <- add_reference(plans, map$cc_map7, "Map 7")
if (HAS_PRE) { plans <- add_reference(plans, map$cc_pre2025, "pre-2025"); refs <- c(refs, "pre-2025") }
plans <- add_reference(plans, cc_pack, "R-pack"); refs <- c(refs, "R-pack")

# ---- 5. District metrics (composite baseline) ----
plans <- plans |>
  mutate(
    dev          = plan_parity(map),
    polsby       = comp_polsby(pl(), map),
    dem          = group_frac(map, ndv, ndv + nrv),
    sen26        = group_frac(map, ndv26, ndv26 + nrv26),
    hisp_vap     = group_frac(map, vap_hisp, vap),
    black_vap    = group_frac(map, vap_black, vap),
    nonwhite_vap = group_frac(map, vap - vap_white, vap),
    city_splits  = splits_admin(pl(), map, city_all),
    city_multi   = splits_multi(pl(), map, city_all),
    comm_splits  = splits_admin(pl(), map, comm)
  )
if ("cvap_tot" %in% names(map)) {
  plans <- plans |>
    mutate(hisp_cvap  = group_frac(map, cvap_hsp, cvap_tot),
           black_cvap = group_frac(map, cvap_blk, cvap_tot))
}
summary(plans)

d <- plans |>
  as_tibble() |>
  group_by(draw) |>
  mutate(rank = rank(dem, ties.method = "first")) |>
  ungroup()
ens  <- filter(d, !draw %in% refs)
refd <- filter(d, draw %in% refs)

# reference-plan precinct stats straight from the VTD table, so precinct numbers are the real ones
plan_stats <- function(assign) {
  tar_sf |> st_drop_geometry() |> mutate(district = as.integer(assign)) |>
    group_by(district) |>
    summarise(dem = sum(ndv) / sum(ndv + nrv), hisp_vap = sum(vap_hisp) / sum(vap),
              black_vap = sum(vap_black) / sum(vap), nonwhite_vap = sum(vap - vap_white) / sum(vap),
              pop = sum(pop),
              sen26   = sum(ndv26) / sum(ndv26 + nrv26),                               # 2026 Senate + Governor
              dem_pre = sum(replace_na(dshare_pre, 0.5) * turnout) / sum(turnout),     # 2020-24 baseline
              .groups = "drop") |>
    mutate(rank = rank(dem, ties.method = "first"), rank26 = rank(sen26, ties.method = "first"))
}
m7    <- plan_stats(tar_sf$cc_map7) |> left_join(mutate(cc26, district = as.integer(district)), by = "district")
m7_26 <- filter(m7, !is.na(dem26))
pre   <- if (HAS_PRE) plan_stats(tar_sf$cc_pre2025)
rp    <- plan_stats(cc_pack)
print(m7)
print(rp)

# R-pack vs Map 7 side by side: population, partisanship, compactness, splits
refd |> group_by(draw) |>
  summarise(dem_seats = sum(dem > 0.5), max_dev = max(dev), min_polsby = min(polsby),
            city_splits = first(city_splits), comm_splits = first(comm_splits)) |> print()

seats <- ens |> group_by(draw) |> summarise(dem_seats = sum(dem > 0.5), mm_seats = sum(nonwhite_vap > 0.5),
                                            seats26 = sum(sen26 > 0.5))
count(seats, dem_seats)
count(seats, mm_seats)
cat("Map 7: D-leaning", sum(m7$dem > 0.5), "| majority-nonwhite-VAP", sum(m7$nonwhite_vap > 0.5), "\n")

# ---- 6. Charts ----
ACC <- "#21908c"                                 # Map 7
PK  <- "#3b0f70"                                 # R-pack
pct <- scales::label_percent(accuracy = 1)
theme_cc <- theme_minimal(base_size = 11) +
  theme(panel.grid.minor = element_blank(), panel.grid.major.x = element_blank(),
        plot.title = element_text(face = "bold"), plot.title.position = "plot",
        plot.subtitle = element_text(colour = "grey30"), strip.text = element_text(face = "bold"))
q5 <- function(x) tibble(q05 = quantile(x, 0.05), q25 = quantile(x, 0.25), med = median(x),
                         q75 = quantile(x, 0.75), q95 = quantile(x, 0.95))
intervals <- list(
  geom_linerange(aes(rank, ymin = q05, ymax = q95), linewidth = 1.2, colour = "grey78"),
  geom_linerange(aes(rank, ymin = q25, ymax = q75), linewidth = 6, colour = "grey60"),
  geom_point(aes(rank, med), shape = 95, size = 9, colour = "grey15"))

# 6a. Partisanship by rank
band <- ens |> group_by(rank) |> summarise(q5(dem))
m7_seats   <- sum(m7$dem > 0.5)
mode_seats <- as.integer(names(which.max(table(seats$dem_seats))))
top_pctile <- mean(ens$dem[ens$rank == 4] < max(m7$dem))

p_rank <- ggplot(band) +
  geom_hline(yintercept = 0.5, linetype = 2, colour = "grey50") +
  annotate("text", x = 0.5, y = 0.5, label = "majority", vjust = -0.6, hjust = 0, size = 3, colour = "grey40") +
  intervals +
  geom_line(data = rp, aes(rank, dem), colour = PK, linewidth = 0.8, linetype = 2) +
  geom_point(data = rp, aes(rank, dem), colour = PK, shape = 15, size = 2.8) +
  geom_text(data = rp, aes(rank, dem, label = pct(dem)), nudge_x = 0.24, colour = PK, size = 3) +
  geom_line(data = m7, aes(rank, dem), colour = ACC, linewidth = 0.8) +
  geom_point(data = m7, aes(rank, dem), colour = ACC, size = 3) +
  geom_text(data = m7, aes(rank, dem, label = paste0("Pct ", district)),
            nudge_x = -0.24, colour = ACC, size = 3.3, fontface = "bold") +
  geom_segment(data = m7_26, aes(x = rank + 0.14, xend = rank + 0.14, y = dem, yend = dem26),
               arrow = arrow(length = unit(0.08, "in")), colour = "grey10") +
  geom_text(data = m7_26, aes(rank + 0.2, dem26, label = paste0("2026 result ", pct(dem26))),
            hjust = 0, size = 3, colour = "grey10") +
  scale_x_continuous(breaks = 1:4, limits = c(0.5, 4.9),
                     labels = c("Least\nDemocratic", "2nd", "3rd", "Most\nDemocratic")) +
  scale_y_continuous(labels = pct) +
  labs(x = "Precincts in each plan, ordered by Democratic share", y = "Two-party Democratic share",
       title = sprintf("Map 7 draws %d Democratic-leaning precinct%s; %s of sampled plans draw %d",
                       m7_seats, if_else(m7_seats == 1, "", "s"),
                       pct(mean(seats$dem_seats == mode_seats)), mode_seats),
       subtitle = sprintf(paste0("Grey: middle 50%% and 90%% of %s sampled plans, tick = median. Teal: Map 7. ",
                                 "Dashed purple: R-pack plan (%d D-leaning).\n",
                                 "Map 7's most Democratic precinct exceeds %s of sampled counterparts.\n",
                                 "Baseline: 2020-2026 composite, %d-year half-life. Arrows: 2026 commissioner results."),
                          format(n_distinct(ens$draw), big.mark = ","), sum(rp$dem > 0.5),
                          pct(top_pctile), HALF_LIFE)) +
  theme_cc
if (HAS_PRE) p_rank <- p_rank +
  geom_line(data = pre, aes(rank, dem), colour = "grey20", linewidth = 0.6, linetype = 3) +
  geom_point(data = pre, aes(rank, dem), colour = "grey20", shape = 1, size = 2.5) +
  labs(caption = "Dotted line with open circles: pre-2025 plan")
p_rank

# 6b. Democratic-leaning precincts per sampled plan
seats |> count(dem_seats) |> complete(dem_seats = 0:4, fill = list(n = 0)) |>
  mutate(p = n / sum(n), is_m7 = dem_seats == m7_seats) |>
  ggplot(aes(dem_seats, p, fill = is_m7)) +
  geom_col(width = 0.7) +
  geom_text(aes(label = if_else(p > 0, scales::label_percent(accuracy = 0.1)(p), "")), vjust = -0.5, size = 3.3) +
  scale_fill_manual(values = c(`TRUE` = ACC, `FALSE` = "grey70"), guide = "none") +
  scale_y_continuous(labels = pct, expand = expansion(mult = c(0, 0.12))) +
  labs(x = "Democratic-leaning precincts out of 4", y = "Share of sampled plans",
       title = "Democratic-leaning precincts per sampled plan",
       subtitle = "Teal bar: the count Map 7 draws on the same baseline") +
  theme_cc

# 6b2. Neutral ensemble vs R-pack ensemble: where the weakest D-leaning precinct lands
bind_rows(
  ens |> group_by(draw) |> summarise(third = sort(dem)[2], packed = min(dem)) |> mutate(set = "Neutral ensemble"),
  pack_tab |> select(draw, third, packed) |> mutate(set = "R-pack ensemble")
) |>
  pivot_longer(c(third, packed), names_to = "precinct", values_to = "dem") |>
  mutate(precinct = recode(precinct, third = "Third most Democratic precinct", packed = "Least Democratic precinct")) |>
  ggplot(aes(dem, fill = set)) +
  geom_density(alpha = 0.55, colour = NA) +
  geom_vline(xintercept = 0.5, linetype = 2, colour = "grey40") +
  geom_vline(data = tibble(precinct = c("Third most Democratic precinct", "Least Democratic precinct"),
                           dem = c(sort(rp$dem)[2], min(rp$dem))),
             aes(xintercept = dem), colour = PK, linewidth = 1) +
  facet_wrap(~precinct, scales = "free_y") +
  scale_fill_manual(values = c("Neutral ensemble" = "grey60", "R-pack ensemble" = "#8c6bb1"), name = NULL) +
  scale_x_continuous(labels = pct) +
  labs(x = "Two-party Democratic share", y = NULL,
       title = "Packing Republicans: how far the third Democratic precinct moves",
       subtitle = sprintf("Purple line: the optimized R-pack plan. Hinge target %s.", pct(D_TGT))) +
  theme_cc + theme(legend.position = "bottom", axis.text.y = element_blank())

# 6c. Minority voting-age share by rank: ensemble vs Map 7
VLAB <- c(nonwhite_vap = "All nonwhite VAP", hisp_vap = "Hispanic VAP", black_vap = "Black VAP")
rank_long <- function(x) x |>
  pivot_longer(all_of(names(VLAB)), names_to = "measure", values_to = "share") |>
  mutate(measure = factor(VLAB[measure], levels = VLAB)) |>
  group_by(across(any_of("draw")), measure) |>
  mutate(rank = rank(share, ties.method = "first")) |> ungroup()
band_v <- ens |> select(draw, all_of(names(VLAB))) |> rank_long() |>
  group_by(measure, rank) |> summarise(q5(share), .groups = "drop")
m7_v <- m7 |> select(district, all_of(names(VLAB))) |> rank_long()

ggplot(band_v) +
  geom_hline(yintercept = 0.5, linetype = 2, colour = "grey50") +
  intervals +
  geom_line(data = m7_v, aes(rank, share), colour = ACC, linewidth = 0.8) +
  geom_point(data = m7_v, aes(rank, share), colour = ACC, size = 2.5) +
  geom_text(data = m7_v, aes(rank, share, label = paste0("Pct ", district)),
            nudge_x = -0.3, colour = ACC, size = 2.9, fontface = "bold") +
  facet_wrap(~measure) +
  scale_x_continuous(breaks = 1:4, limits = c(0.4, 4.4), labels = c("Lowest", "2nd", "3rd", "Highest")) +
  scale_y_continuous(labels = pct) +
  labs(x = "Precincts in each plan, ordered by the group's share", y = "Share of voting-age population",
       title = sprintf("Majority-nonwhite precincts: Map 7 has %d; sampled plans most often have %s",
                       sum(m7$nonwhite_vap > 0.5), names(which.max(table(seats$mm_seats)))),
       subtitle = "Grey: middle 50% and 90% of sampled plans. Teal: Map 7. 2020 Census voting-age population.") +
  theme_cc

# 6d. Split counts: ensemble vs Map 7 (VTD-level counts)
SLAB <- c(city_splits = "Cities split", city_multi = "Cities split 3+ ways", comm_splits = "Communities split")
sp_long <- function(x) x |> distinct(draw, city_splits, city_multi, comm_splits) |>
  pivot_longer(-draw, names_to = "measure", values_to = "n") |>
  mutate(measure = factor(SLAB[measure], levels = SLAB))
ggplot(sp_long(ens), aes(n)) +
  geom_bar(fill = "grey70") +
  geom_vline(data = filter(sp_long(refd), draw == "Map 7"), aes(xintercept = n), colour = ACC, linewidth = 1.2) +
  facet_wrap(~measure, scales = "free") +
  labs(x = "Count per plan", y = "Sampled plans", title = "Splits per plan",
       subtitle = "Grey bars: sampled plans. Teal line: Map 7. Counted on VTDs, so small areas are undercounted.") +
  theme_cc

# 6e. What 2026 would have looked like on each plan (2026 Senate + Governor votes, re-aggregated)
band26 <- ens |> group_by(draw) |> mutate(rank26 = rank(sen26, ties.method = "first")) |>
  group_by(rank = rank26) |> summarise(q5(sen26))
ref26 <- bind_rows(mutate(m7, plan = "Map 7"), mutate(rp, plan = "R-pack plan")) |>
  mutate(lx = rank26 + if_else(plan == "Map 7", -0.27, 0.27), shift = sen26 - dem_pre,
         lab = paste0("Pct ", district))
count(seats, seats26)
ref26 |> select(plan, district, baseline_2020_24 = dem_pre, composite = dem, y2026 = sen26, shift) |> print()

ggplot(band26) +
  geom_hline(yintercept = 0.5, linetype = 2, colour = "grey50") +
  annotate("text", x = 0.5, y = 0.5, label = "majority", vjust = -0.6, hjust = 0, size = 3, colour = "grey40") +
  intervals +
  geom_line(data = ref26, aes(rank26, sen26, colour = plan, linetype = plan), linewidth = 0.8) +
  geom_point(data = ref26, aes(rank26, sen26, colour = plan, shape = plan), size = 2.8) +
  geom_text(data = ref26, aes(lx, sen26, label = pct(sen26), colour = plan), size = 3, show.legend = FALSE) +
  scale_colour_manual(values = c("Map 7" = ACC, "R-pack plan" = PK), name = NULL) +
  scale_linetype_manual(values = c("Map 7" = 1, "R-pack plan" = 2), name = NULL) +
  scale_shape_manual(values = c("Map 7" = 16, "R-pack plan" = 15), name = NULL) +
  scale_x_continuous(breaks = 1:4, limits = c(0.5, 4.5),
                     labels = c("Least\nDemocratic", "2nd", "3rd", "Most\nDemocratic")) +
  scale_y_continuous(labels = pct) +
  labs(x = "Precincts in each plan, ordered by 2026 Democratic share", y = "2026 two-party Democratic share",
       title = sprintf("On 2026 votes: Map 7 gives Democrats %d of 4 precincts, the R-pack plan %d, most sampled plans %s",
                       sum(m7$sen26 > 0.5), sum(rp$sen26 > 0.5), names(which.max(table(seats$seats26)))),
       subtitle = "Every plan's precincts re-added from 2026 Senate and Governor votes. Grey: middle 50% and 90% of sampled plans.") +
  theme_cc + theme(legend.position = "bottom")

# 6f. Shift to 2026 inside each precinct of Map 7 and the R-pack plan
ggplot(ref26, aes(y = fct_rev(lab))) +
  geom_vline(xintercept = 0.5, linetype = 2, colour = "grey50") +
  geom_segment(aes(x = dem_pre, xend = sen26, yend = fct_rev(lab)), colour = "grey20", linewidth = 0.8,
               arrow = arrow(length = unit(0.08, "in"))) +
  geom_point(aes(x = dem_pre), shape = 21, fill = "white", colour = "grey20", size = 2.6) +
  geom_text(aes(x = sen26, label = sprintf("%s (%+.1f)", pct(sen26), 100 * shift),
                hjust = if_else(shift >= 0, -0.12, 1.12)), size = 3) +
  geom_point(data = filter(ref26, !is.na(dem26)), aes(x = dem26), shape = 5, size = 3, stroke = 1.1, colour = ACC) +
  facet_wrap(~plan) +
  scale_x_continuous(labels = pct, expand = expansion(mult = c(0.06, 0.22))) +
  labs(x = "Two-party Democratic share", y = NULL,
       title = "How far each precinct moved in 2026",
       subtitle = paste0("Open circle: 2020-24 baseline. Arrowhead: 2026 Senate + Governor, with the change in points.\n",
                         "Teal diamond: the actual 2026 commissioner result (Map 7 Pct 2 and Pct 4 were on the ballot).")) +
  theme_cc + theme(panel.grid.major.y = element_blank(), panel.grid.major.x = element_line(colour = "grey90"))

# ---- 7. Static maps ----
DCOL <- c("1" = "#1b9e77", "2" = "#e6ab02", "3" = "#7570b3", "4" = "#666666")   # used by section 8
vtd   <- tar_sf |> st_transform(2276)
m7_ln <- map7_sf |> st_transform(2276) |> mutate(PRECINCT = as.integer(PRECINCT)) |>
  left_join(m7, by = c("PRECINCT" = "district"))

f_hw <- file.path(DIR, "tarrant_highways.rds")
if (file.exists(f_hw)) hw <- readRDS(f_hw) else {
  hw <- roads("TX", "Tarrant") |> filter(MTFCC == "S1100") |> st_transform(2276) |> select(FULLNAME)
  saveRDS(hw, f_hw)
}
theme_map <- theme_void(base_size = 11) +
  theme(plot.title = element_text(face = "bold"), plot.subtitle = element_text(colour = "grey30"),
        legend.position = "bottom", legend.key.width = unit(1.2, "cm"), strip.text = element_text(face = "bold"))
fill_dem <- scale_fill_gradient2(low = "#8c510a", mid = "#f5f5f5", high = "#01665e", midpoint = 0.5,
                                 limits = c(0.2, 0.8), oob = scales::squish, labels = pct,
                                 na.value = "grey85", name = "Composite Democratic share")
fill_dem_as <- function(name) scale_fill_gradient2(low = "#8c510a", mid = "#f5f5f5", high = "#01665e", midpoint = 0.5,
                                                   limits = c(0.2, 0.8), oob = scales::squish, labels = pct,
                                                   na.value = "grey85", name = name)
fill_26    <- fill_dem_as("2026 Senate + Governor Democratic share")
# change gets its own ramp (purple to green) so it never reads as a level of partisanship
fill_shift <- scale_fill_gradient2(low = "#762a83", mid = "#f7f7f7", high = "#1b7837", midpoint = 0,
                                   limits = c(-0.15, 0.15), oob = scales::squish,
                                   labels = \(x) sprintf("%+d", round(100 * x)), na.value = "grey85",
                                   name = "Points toward Democrats, 2020-24 baseline to 2026")
fill_seq <- function(name, lim = c(0, 1)) scale_fill_viridis_c(option = "mako", direction = -1, limits = lim,
                                                               oob = scales::squish, labels = pct,
                                                               na.value = "grey85", name = name)
lab_box <- function(data, ...) geom_sf_label(data = data, aes(...), size = 2.9, fontface = "bold",
                                             fill = "white", colour = "grey10")
m7_lines <- geom_sf(data = m7_ln, fill = NA, colour = "black", linewidth = 0.9)

# per-VTD value of its precinct's share, for every sampled plan (782 x n_plans)
pm    <- get_plans_matrix(subset_sampled(plans))
tot_v <- tar_sf$ndv + tar_sf$nrv
plan_share <- function(num, den) vapply(seq_len(ncol(pm)), function(j) {
  a <- pm[, j]; (rowsum(num, a) / rowsum(den, a))[as.character(a), 1]
}, numeric(nrow(pm)))
S_dem <- plan_share(tar_sf$ndv, tot_v)
S_nw  <- plan_share(tar_sf$vap - tar_sf$vap_white, tar_sf$vap)
vtd$freq_dem <- rowMeans(S_dem > 0.5)
vtd$freq_mm  <- rowMeans(S_nw > 0.5)
n_dem <- vapply(seq_len(ncol(pm)), \(j) n_distinct(pm[S_dem[, j] > 0.5, j]), integer(1))

# 7a/7b. Gallery, shaded by partisanship and then by nonwhite VAP
dissolve_plan <- function(assign, panel, prefix = FALSE) {
  vtd |> mutate(dist = factor(assign, levels = 1:4)) |>
    group_by(dist) |>
    summarise(dem = sum(ndv) / sum(ndv + nrv), nw = sum(vap - vap_white) / sum(vap),
              s26 = sum(ndv26) / sum(ndv26 + nrv26), .groups = "drop") |>
    mutate(panel = panel, tag = if (prefix) paste0("Pct ", dist, "\n") else "")
}
take <- function(ix, n) ix[sample.int(length(ix), min(n, length(ix)))]
set.seed(7)
pick <- c(take(which(n_dem == 2), 2), take(which(n_dem == 3), if (HAS_PRE) 1 else 2))
gal <- c(list(dissolve_plan(tar_sf$cc_map7, "Map 7 (2025)", TRUE)),
         list(dissolve_plan(cc_pack, sprintf("R-pack plan (%d D-leaning)", sum(rp$dem > 0.5)), TRUE)),
         if (HAS_PRE) list(dissolve_plan(tar_sf$cc_pre2025, "Pre-2025 plan", TRUE)),
         map2(pick, seq_along(pick), \(j, i) dissolve_plan(
           pm[, j], sprintf("Sampled plan %s (%d D-leaning)", LETTERS[i], n_dem[j]))))
gal <- do.call(rbind, gal)
gal$panel <- factor(gal$panel, levels = unique(gal$panel))

gallery <- function(var, scale, title, sub) {
  ggplot(gal) +
    geom_sf(aes(fill = .data[[var]]), colour = "black", linewidth = 0.6) +
    geom_sf(data = hw, colour = "grey40", linewidth = 0.15) +
    lab_box(gal, label = paste0(tag, pct(.data[[var]]))) +
    scale + facet_wrap(~panel, ncol = 3) + labs(title = title, subtitle = sub) + theme_map
}
gallery("dem", fill_dem, "Map 7 beside plans drawn by the sampler: partisanship",
        "Each precinct shaded and labelled by its composite two-party Democratic share")
gallery("nw", fill_seq("Nonwhite share of voting-age population", c(0.2, 0.8)),
        "Map 7 beside plans drawn by the sampler: nonwhite voting-age share",
        "Each precinct shaded and labelled by the nonwhite share of its 2020 voting-age population")
gallery("s26", fill_26, "What 2026 would have looked like on each plan",
        "Each precinct shaded and labelled by its 2026 Senate + Governor two-party Democratic share")

# 7c. Composite baseline by VTD with Map 7 lines
ggplot() +
  geom_sf(data = vtd, aes(fill = dshare), colour = NA) +
  geom_sf(data = hw, colour = "grey35", linewidth = 0.2) + m7_lines +
  lab_box(m7_ln, label = paste0("Pct ", PRECINCT, "\n", pct(dem))) +
  fill_dem +
  labs(title = "Where Map 7's lines fall on the partisan baseline",
       subtitle = sprintf("VTDs shaded by the 2020-2026 composite (%d-year half-life); black lines: Map 7", HALF_LIFE)) +
  theme_map

# 7c2. Composite baseline with R-pack lines (Map 7 dashed for comparison)
rp_ln <- vtd |> mutate(PRECINCT = cc_pack) |> group_by(PRECINCT) |>
  summarise(.groups = "drop") |> left_join(rp, by = c("PRECINCT" = "district"))
ggplot() +
  geom_sf(data = vtd, aes(fill = dshare), colour = NA) +
  geom_sf(data = hw, colour = "grey35", linewidth = 0.2) +
  geom_sf(data = m7_ln, fill = NA, colour = "grey25", linewidth = 0.5, linetype = 2) +
  geom_sf(data = rp_ln, fill = NA, colour = "black", linewidth = 1) +
  lab_box(rp_ln, label = paste0("Pct ", PRECINCT, "\n", pct(dem))) +
  fill_dem +
  labs(title = sprintf("R-pack plan: %d Democratic-leaning precincts, Republicans packed at %s",
                       sum(rp$dem > 0.5), pct(min(rp$dem))),
       subtitle = "Solid black lines and labels: R-pack precincts. Dashed grey: Map 7. VTDs shaded by the composite.") +
  theme_map

# 7d. How often each VTD lands in a Democratic-leaning precinct
ggplot() +
  geom_sf(data = vtd, aes(fill = freq_dem), colour = NA) +
  geom_sf(data = hw, colour = "grey50", linewidth = 0.2) + m7_lines +
  lab_box(m7_ln, label = paste0("Pct ", PRECINCT, "\n", pct(dem))) +
  fill_seq("Share of sampled plans placing the VTD\nin a Democratic-leaning precinct") +
  labs(title = "Where sampled plans put Democratic-leaning precincts",
       subtitle = "Black lines and labels: Map 7 precincts with their composite Democratic share") +
  theme_map

# 7e. Hispanic and Black voting-age share by VTD, with Map 7 lines
grp <- function(x, g, num) transmute(x, group = g, share = if_else(vap > 0, {{ num }} / vap, NA_real_))
vtd_grp <- rbind(grp(vtd, "Hispanic VAP", vap_hisp), grp(vtd, "Black VAP", vap_black))
m7_grp  <- rbind(transmute(m7_ln, group = "Hispanic VAP", lab = paste0("Pct ", PRECINCT, "\n", pct(hisp_vap))),
                 transmute(m7_ln, group = "Black VAP",    lab = paste0("Pct ", PRECINCT, "\n", pct(black_vap))))
ggplot() +
  geom_sf(data = vtd_grp, aes(fill = share), colour = NA) +
  geom_sf(data = hw, colour = "grey50", linewidth = 0.2) + m7_lines +
  lab_box(m7_grp, label = lab) +
  facet_wrap(~group) + fill_seq("Share of voting-age population", c(0, 0.8)) +
  labs(title = "Where Map 7's lines fall on Hispanic and Black population",
       subtitle = "VTDs shaded by 2020 Census voting-age share; labels: each Map 7 precinct's share") +
  theme_map

# 7f. How often each VTD lands in a majority-nonwhite precinct
ggplot() +
  geom_sf(data = vtd, aes(fill = freq_mm), colour = NA) +
  geom_sf(data = hw, colour = "grey50", linewidth = 0.2) + m7_lines +
  lab_box(m7_ln, label = paste0("Pct ", PRECINCT, "\n", pct(nonwhite_vap))) +
  fill_seq("Share of sampled plans placing the VTD\nin a majority-nonwhite-VAP precinct") +
  labs(title = "Where sampled plans put majority-nonwhite precincts",
       subtitle = "Black lines and labels: Map 7 precincts with their nonwhite voting-age share") +
  theme_map

# 7j. Partisan shading election by election, with Map 7 lines
vtd_year <- vtd |> select(vtdkey) |> left_join(select(year_vtd, vtdkey, year, share), by = "vtdkey")
ggplot() +
  geom_sf(data = vtd_year, aes(fill = share), colour = NA) +
  geom_sf(data = m7_ln, fill = NA, colour = "black", linewidth = 0.5) +
  facet_wrap(~year, nrow = 1) +
  fill_dem_as("Two-party Democratic share, top-of-ticket races") +
  labs(title = "Tarrant County's partisan map, 2020 to 2026",
       subtitle = "VTDs shaded by each year's top-of-ticket average; black lines: Map 7") +
  theme_map

# 7k. 2026 on its own, with what each Map 7 precinct would have voted
ggplot() +
  geom_sf(data = vtd, aes(fill = share26), colour = NA) +
  geom_sf(data = hw, colour = "grey35", linewidth = 0.2) + m7_lines +
  lab_box(m7_ln, label = paste0("Pct ", PRECINCT, "\n", pct(sen26))) +
  fill_26 +
  labs(title = sprintf("2026 on Map 7's lines: Democrats carry %d of 4 precincts", sum(m7$sen26 > 0.5)),
       subtitle = "VTDs shaded by 2026 Senate + Governor share; labels: each Map 7 precinct's 2026 share") +
  theme_map

# 7l. Where the county moved between the 2020-24 baseline and 2026
ggplot() +
  geom_sf(data = vtd, aes(fill = shift26), colour = NA) +
  geom_sf(data = hw, colour = "grey35", linewidth = 0.2) + m7_lines +
  lab_box(m7_ln, label = paste0("Pct ", PRECINCT, "\n", sprintf("%+.1f", 100 * (sen26 - dem_pre)))) +
  fill_shift +
  labs(title = "The 2026 shift, VTD by VTD",
       subtitle = "Green: moved toward Democrats; purple: toward Republicans. Labels: each Map 7 precinct's change in points.") +
  theme_map

# 7m. The same shift under the R-pack plan's lines
ggplot() +
  geom_sf(data = vtd, aes(fill = shift26), colour = NA) +
  geom_sf(data = hw, colour = "grey35", linewidth = 0.2) +
  geom_sf(data = rp_ln, fill = NA, colour = "black", linewidth = 1) +
  lab_box(rp_ln, label = paste0("Pct ", PRECINCT, "\n", pct(sen26), " (", sprintf("%+.1f", 100 * (sen26 - dem_pre)), ")")) +
  fill_shift +
  labs(title = sprintf("2026 on the R-pack plan: Democrats carry %d of 4 precincts", sum(rp$sen26 > 0.5)),
       subtitle = "Labels: each R-pack precinct's 2026 share and its change from the 2020-24 baseline") +
  theme_map

# 7g/7h. Which cities and communities Map 7 splits (true geometry, 5% minimum piece)
SPLIT_MIN <- 0.05
split_geo <- function(layer, id_col) {
  ix <- suppressWarnings(st_intersection(st_make_valid(st_transform(layer[id_col], 2276)), m7_ln["PRECINCT"]))
  ix$a <- as.numeric(st_area(ix))
  ix |> st_drop_geometry() |>
    group_by(id = .data[[id_col]], PRECINCT) |> summarise(a = sum(a), .groups = "drop_last") |>
    mutate(sh = a / sum(a)) |>
    summarise(n_parts = sum(sh >= SPLIT_MIN), minor_share = 1 - max(sh),
              precincts = paste(sort(PRECINCT[sh >= SPLIT_MIN]), collapse = ", "), .groups = "drop")
}
# tarrant_cities.gpkg already has an n_parts column (polygon pieces); drop clashes before joining
SPLIT_COLS <- c("n_parts", "minor_share", "precincts")
city_sp <- cities |> select(-any_of(SPLIT_COLS)) |> st_transform(2276) |>
  left_join(split_geo(cities, "city"), by = c("city" = "id"))
comm_sp <- comms  |> select(-any_of(SPLIT_COLS)) |> st_transform(2276) |>
  left_join(split_geo(comms, "comm_id"), by = c("comm_id" = "id"))

city_sp |> st_drop_geometry() |> filter(n_parts > 1) |>
  select(city, split_tier, n_parts, precincts, minor_share) |> arrange(desc(minor_share)) |> print()
comm_sp |> st_drop_geometry() |> filter(n_parts > 1) |>
  select(name, city, n_parts, precincts, minor_share) |> arrange(desc(minor_share)) |> print()

ggplot() +
  geom_sf(data = m7_ln, fill = "grey97", colour = NA) +
  geom_sf(data = city_sp, aes(fill = factor(n_parts)), colour = "white", linewidth = 0.2) +
  m7_lines +
  geom_sf_text(data = suppressWarnings(st_point_on_surface(filter(city_sp, n_parts > 1))),
               aes(label = city), size = 2.8, fontface = "bold", check_overlap = TRUE) +
  scale_fill_manual(values = c("1" = "grey85", "2" = "#7fcdbb", "3" = "#2c7fb8", "4" = "#253494"),
                    name = "Map 7 precincts the city falls in", na.value = "grey95") +
  labs(title = sprintf("Map 7 splits %d of %d cities", sum(city_sp$n_parts > 1, na.rm = TRUE), nrow(city_sp)),
       subtitle = sprintf("A piece counts when it holds at least %s of the city's area; split cities are named", pct(SPLIT_MIN))) +
  theme_map

ggplot() +
  geom_sf(data = m7_ln, fill = "grey97", colour = NA) +
  geom_sf(data = comm_sp, aes(fill = n_parts > 1), colour = "white", linewidth = 0.1) +
  m7_lines +
  scale_fill_manual(values = c(`TRUE` = ACC, `FALSE` = "grey82"), labels = c(`TRUE` = "Split", `FALSE` = "Whole"),
                    name = NULL, na.value = "grey95") +
  labs(title = sprintf("Map 7 splits %d of %d mapped communities", sum(comm_sp$n_parts > 1, na.rm = TRUE), nrow(comm_sp)),
       subtitle = "Mapped neighborhoods cover about 23% of the county; names are in the printed table") +
  theme_map

# 7i. Which cities sampled plans split, against Map 7 (VTD-level, cities with 2+ VTDs)
has_city <- !is.na(tar_sf$city_name)
cgrp     <- tar_sf$city_name[has_city]
touch    <- Reduce(`+`, lapply(1:4, \(k) rowsum((pm[has_city, ] == k) + 0L, cgrp) > 0))
city_freq <- tibble(city = rownames(touch), freq = rowMeans(touch > 1)) |>
  left_join(tibble(city = cgrp, p = tar_sf$cc_map7[has_city]) |> group_by(city) |>
              summarise(vtds = n(), m7_split = n_distinct(p) > 1), by = "city") |>
  filter(vtds >= 2)
ggplot(city_freq, aes(freq, fct_reorder(city, freq), fill = m7_split)) +
  geom_col(width = 0.7) +
  scale_fill_manual(values = c(`TRUE` = ACC, `FALSE` = "grey70"),
                    labels = c(`TRUE` = "Split by Map 7", `FALSE` = "Whole in Map 7"), name = NULL) +
  scale_x_continuous(labels = pct, expand = expansion(mult = c(0, 0.05))) +
  labs(x = "Share of sampled plans that split the city", y = NULL,
       title = "How often sampled plans split each city") +
  theme_cc + theme(legend.position = "bottom", panel.grid.major.y = element_blank(),
                   panel.grid.major.x = element_line(colour = "grey90"))
# ---- 8. Interactive map: R-pack plan, Map 7 outline, 2026 Senate and commissioner results ----
show <- rp_ln |>
  mutate(dist = as.character(PRECINCT),
         label = paste0("R-pack precinct ", dist, " | pop ", format(pop, big.mark = ","),
                        " | D ", round(100 * dem, 1), "%")) |>
  st_transform(4326)

pc_ll <- pc26 |> st_transform(4326) |>
  mutate(sen_tip = paste0("Precinct ", PCT, " | Senate D ", SEN_D, " R ", SEN_R,
                          " | D 2P ", round(100 * SEN_2P, 1), "%"),
         cc_tip  = paste0("Precinct ", PCT, " | Commissioner Pct ", CC_PCT,
                          " | D ", CC_D, " R ", CC_R, " | D 2P ", round(100 * CC_2P, 1), "%"))
ramp <- function(col) interpolate(column = col, values = c(0.3, 0.5, 0.7),
                                  stops = c("#440154", "#21908c", "#fde725"))

maplibre(style = "https://tiles.openfreemap.org/styles/positron", bounds = show) |>
  add_fill_layer(id = "rpack", source = show, fill_opacity = 0.40, tooltip = "label",
                 fill_color = match_expr("dist", values = names(DCOL), stops = unname(DCOL))) |>
  add_fill_layer(id = "sen26", source = pc_ll, fill_opacity = 0.65, tooltip = "sen_tip",
                 visibility = "none", fill_color = ramp("SEN_2P")) |>
  add_fill_layer(id = "cc26", source = filter(pc_ll, CC_PCT > 0), fill_opacity = 0.65, tooltip = "cc_tip",
                 visibility = "none", fill_color = ramp("CC_2P")) |>
  add_line_layer(id = "rpack_line", source = show, line_color = "#222222", line_width = 1.5) |>
  add_line_layer(id = "map7_line", source = st_transform(map7_sf, 4326),
                 line_color = "#000000", line_width = 3, line_dasharray = c(2, 1)) |>
  add_layers_control(layers = c("rpack", "sen26", "cc26"))