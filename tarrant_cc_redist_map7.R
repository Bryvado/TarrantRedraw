# SCRIPT: tarrant_cc_redist_map7.R
# SMC ensemble of Tarrant County commissioner precincts (4) on TLC 2024 VTDs
# Reference plans: 2025 Map 7 (Tarrant7_clean.geojson), optional pre-2025 plan,
#   and "R-pack": an optimized plan packing Republicans into one precinct (section 4b)
# Partisanship baseline: time-decayed composite of 2020, 2022, 2024 and 2026 top-of-ticket races.
# 2026 commissioner results (CC_*) are plotted only and never enter the baseline.
# 2026 Senate + Governor votes are also kept on their own (ndv26/nrv26) to show what 2026 looks like on any plan.
# The neutral ensemble is sampled in independent, checkpointed batches (section 5) so the plan count can go
# into the millions without holding the plans in memory.

library(tidyverse)
library(sf)
library(tigris)
library(redist)
library(mapgl)
library(patchwork)

options(tigris_use_cache = TRUE)

# ---- Output handling ----
# The script runs as two stored blocks. Nothing is shown while a block runs: every table, printed line and
# plot is collected and released together at the end. If a step fails, everything collected so far is
# released first, then the failing step and the error are shown. This behaves the same pasted or source()d.
OUT <- list()
RUN_OK <- TRUE
flush_out <- function() {
  for (o in OUT) {
    if (!is.null(o$txt)) cat(o$txt, sep = "\n")
    if (!is.null(o$val)) print(o$val)
  }
  OUT <<- list()
  invisible()
}
run_stored <- function(block, final = FALSE) {
  if (!isTRUE(RUN_OK)) return(invisible())                   # an earlier block failed: do nothing, say nothing
  steps <- as.list(block)[-1]
  for (ex in steps) {
    tryCatch({
      txt <- capture.output(r <- withVisible(eval(ex, globalenv())))
      if (length(txt)) OUT[[length(OUT) + 1]] <<- list(txt = txt)
      if (r$visible && !is.null(r$value)) OUT[[length(OUT) + 1]] <<- list(val = r$value)
    }, error = function(e) {
      RUN_OK <<- FALSE
      flush_out()
      message("\nFAILED AT: ", paste(utils::head(deparse(ex), 3), collapse = "\n           "))
      stop(conditionMessage(e), call. = FALSE)
    })
  }
  if (final) flush_out()
  invisible()
}

PART_A <- quote({
  
  DIR <- "~/TarrantRedistricting"                 # checkpoints + optional extras
  SRC <- file.path(DIR, "sourceshapes")           # hand-supplied input layers
  HALF_LIFE <- 4                                  # years; weight = 0.5^((2026 - year) / HALF_LIFE)
  D_TGT     <- 0.53                               # R-pack: Democratic share the three unpacked precincts should clear
  N_PER_RUN    <- 100000                           # plans per independent SMC run (one batch)
  N_RUNS       <- 20                              # batches; total sampled plans = N_PER_RUN * N_RUNS
  KEEP_PER_RUN <- 250                             # full plans kept from each batch for the gallery maps
  ENS_TAG      <- "v1"                            # change this whenever the map, tolerance or constraints change
  
  # ---- 0. Preflight ----
  NEED <- c("Tarrant7_clean.geojson", "tarrant_precincts_2026.gpkg",
            "tarrant_cities.gpkg", "tarrant_communities.gpkg")
  CKPT <- c("tarrant_vtd_tlc24pg.rds", "tx_cvap_2020_b.csv")
  
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
  
  # ---- 4. Split penalties by level ----
  cons <- redist_constr(map) |>
    add_constr_splits(strength = 0.75, admin = city_std) |>
    add_constr_multisplits(strength = 4.0, admin = city_std) |>
    add_constr_multisplits(strength = 1.5, admin = city_irr) |>
    add_constr_total_splits(strength = 0.3, admin = city_fw) |>
    add_constr_splits(strength = 0.3, admin = comm)
  
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
})
run_stored(PART_A)
# ==== END DATA BUILD ==== (tarrant_redraw_export.R runs the script down to this line)
PART_B <- quote({
  
  # ---- 5. Neutral ensemble in independent batches ----
  # Each batch is one independent SMC run of N_PER_RUN plans. It is reduced to precinct metrics, running
  # per-VTD and per-city counts and a small sample of whole plans, and then the plans are dropped, so memory
  # stays flat however many batches run. Every batch is checkpointed: an interrupted run resumes at the next one.
  BDIR <- file.path(DIR, sprintf("smc_batches_%s_%d", ENS_TAG, N_PER_RUN))
  dir.create(BDIR, showWarnings = FALSE)
  
  f_perim <- file.path(DIR, "tarrant_vtd_perims.rds")          # shared-border lengths, built once
  if (file.exists(f_perim)) perim_df <- readRDS(f_perim) else {
    perim_df <- redistmetrics::prep_perims(map, epsg = 2276)
    saveRDS(perim_df, f_perim)
  }
  
  has_city <- !is.na(tar_sf$city_name)
  cgrp     <- tar_sf$city_name[has_city]
  
  add_metrics <- function(p) {
    p |> mutate(
      dev          = plan_parity(map),
      polsby       = comp_polsby(pl(), map, perim_df = perim_df, epsg = 2276),
      dem          = group_frac(map, ndv, ndv + nrv),
      sen26        = group_frac(map, ndv26, ndv26 + nrv26),
      hisp_vap     = group_frac(map, vap_hisp, vap),
      black_vap    = group_frac(map, vap_black, vap),
      nonwhite_vap = group_frac(map, vap - vap_white, vap),
      city_splits  = splits_admin(pl(), map, city_all),
      city_multi   = splits_multi(pl(), map, city_all),
      comm_splits  = splits_admin(pl(), map, comm)
    )
  }
  
  # helpers for tables holding exactly 4 rows per plan, in plan order (no group_by over millions of plans)
  col4  <- function(x) colSums(matrix(x, nrow = 4))
  rank4 <- function(x) {                                       # same result as rank(ties.method = "first") within each plan
    m <- matrix(x, nrow = 4)
    r <- matrix(1L, 4, ncol(m))
    for (i in 1:4) for (j in setdiff(1:4, i))
      r[i, ] <- r[i, ] + (m[j, ] < m[i, ] | (m[j, ] == m[i, ] & j < i))
    as.vector(r)
  }
  
  run_batch <- function(b) {
    set.seed(439 + b)
    # silent drops the progress bar and banner; the low-efficiency warning is the same every batch, so mute it here
    p   <- withCallingHandlers(
      redist_smc(map, nsims = N_PER_RUN, runs = 1, compactness = 1, constraints = cons, silent = TRUE),
      warning = function(w) if (grepl("resampling efficiency", conditionMessage(w))) invokeRestart("muffleWarning"))
    pm  <- get_plans_matrix(p)
    n   <- ncol(pm)
    tab <- add_metrics(p) |> as_tibble() |> arrange(as.integer(draw), district)
    stopifnot(nrow(tab) == 4L * n, all(tab$district == rep(1:4, n)))
    rm(p)
    
    # each VTD's precinct value, looked up from the precinct table: row of tab = 4 * (plan - 1) + precinct
    lin <- pm + rep(4L * (seq_len(n) - 1L), each = nrow(pm))
    freq_dem <- rowSums(matrix((tab$dem > 0.5)[lin], nrow = nrow(pm)))
    freq_mm  <- rowSums(matrix((tab$nonwhite_vap > 0.5)[lin], nrow = nrow(pm)))
    rm(lin)
    
    # plans in which each city touches more than one precinct
    pc    <- pm[has_city, , drop = FALSE]
    touch <- Reduce(`+`, lapply(1:4, \(k) rowsum((pc == k) + 0L, cgrp) > 0))
    city_split <- rowSums(touch > 1)
    
    keep <- sort(sample.int(n, min(KEEP_PER_RUN, n)))
    one  <- seq(1, nrow(tab), by = 4)
    pol  <- matrix(tab$polsby, nrow = 4)
    list(
      n    = n,
      dist = tab |> transmute(district, dem, sen26, hisp_vap, black_vap, nonwhite_vap),
      plan = tibble(batch = b, dev = tab$dev[one], min_polsby = pmin(pol[1, ], pol[2, ], pol[3, ], pol[4, ]),
                    city_splits = tab$city_splits[one], city_multi = tab$city_multi[one],
                    comm_splits = tab$comm_splits[one]),
      freq_dem = freq_dem, freq_mm = freq_mm, city_split = city_split,
      keep = pm[, keep, drop = FALSE], keep_ix = keep
    )
  }
  
  bfile <- function(b) file.path(BDIR, sprintf("batch_%04d.rds", b))
  for (b in seq_len(N_RUNS)) {
    if (file.exists(bfile(b))) next
    t0 <- Sys.time()
    saveRDS(run_batch(b), bfile(b))
    invisible(gc())
    message(sprintf("batch %d of %d done in %.1f min", b, N_RUNS, as.numeric(difftime(Sys.time(), t0, units = "mins"))))
  }
  
  # assemble: precinct table (4 rows per plan), plan table (1 row per plan), counts, kept plans
  B <- lapply(seq_len(N_RUNS), \(b) readRDS(bfile(b)))
  ens     <- bind_rows(lapply(B, `[[`, "dist"))
  n_plans <- sum(vapply(B, `[[`, numeric(1), "n"))
  stopifnot(nrow(ens) == 4 * n_plans, all(ens$district == rep(1:4, n_plans)))
  ens$rank   <- rank4(ens$dem)
  ens$rank26 <- rank4(ens$sen26)
  
  seats <- bind_rows(lapply(B, `[[`, "plan")) |>
    mutate(dem_seats = col4(ens$dem > 0.5), mm_seats = col4(ens$nonwhite_vap > 0.5),
           seats26   = col4(ens$sen26 > 0.5),
           third     = ens$dem[ens$rank == 2],                  # weakest of the three most Democratic precincts
           packed    = ens$dem[ens$rank == 1])                  # least Democratic precinct
  
  vtd_freq_dem <- Reduce(`+`, lapply(B, `[[`, "freq_dem")) / n_plans
  vtd_freq_mm  <- Reduce(`+`, lapply(B, `[[`, "freq_mm"))  / n_plans
  city_split_n <- Reduce(`+`, lapply(B, `[[`, "city_split"))
  K     <- do.call(cbind, lapply(B, `[[`, "keep"))             # sample of whole plans for the gallery
  off   <- cumsum(c(0, head(vapply(B, `[[`, numeric(1), "n"), -1)))
  n_dem <- seats$dem_seats[unlist(map2(B, off, \(x, o) x$keep_ix + o))]
  rm(B); invisible(gc())
  cat("Sampled plans:", format(n_plans, big.mark = ",", scientific = FALSE), "in", N_RUNS, "independent runs\n")
  
  # Between-run agreement is the convergence check: these columns should barely move from batch to batch
  seats |> group_by(batch) |>
    summarise(d3_plus = mean(dem_seats >= 3), med_third = median(third), med_city_splits = median(city_splits)) |>
    summarise(across(-batch, list(min = min, max = max))) |> print(width = Inf)
  
  # ---- 5b. Reference plans: same metrics, computed once ----
  refs   <- c("Map 7", if (HAS_PRE) "pre-2025", "R-pack")
  ref_pl <- add_reference(plans_pack, map$cc_map7, "Map 7")
  if (HAS_PRE) ref_pl <- add_reference(ref_pl, map$cc_pre2025, "pre-2025")
  ref_pl <- add_reference(ref_pl, cc_pack, "R-pack") |> subset_ref() |> add_metrics()
  refd <- ref_pl |> as_tibble() |> mutate(draw = as.character(draw)) |>
    group_by(draw) |> mutate(rank = rank(dem, ties.method = "first")) |> ungroup()
  stopifnot(setequal(unique(refd$draw), refs))
  
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
  
  count(seats, dem_seats) |> mutate(share = n / sum(n))
  count(seats, mm_seats)  |> mutate(share = n / sum(n))
  seats |> summarise(across(c(dev, min_polsby, city_splits, comm_splits), median))
  cat("Map 7: D-leaning", sum(m7$dem > 0.5), "| majority-nonwhite-VAP", sum(m7$nonwhite_vap > 0.5), "\n")
  
  # ---- 6. Charts ----
  ACC <- "#21908c"                                 # Map 7
  PK  <- "#3b0f70"                                 # R-pack
  DEM <- "#2166ac"                                 # partisan metrics only
  REP <- "#b2182b"
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
  
  # Final results under any plot that shows a race: the total, then each district (or piece), for each race
  dist_bar <- function(yrs, plans, keep = rep(TRUE, nrow(tar_sf))) {
    keys <- tar_sf$vtdkey[keep]
    x <- imap_dfr(plans, \(a, nm) {
      cl <- contest_long |> filter(year %in% yrs, vtdkey %in% keys) |>
        mutate(dist = as.character(a[match(vtdkey, tar_sf$vtdkey)]))
      bind_rows(cl |> mutate(dist = "Total"), cl) |>
        group_by(plan = nm, year, office, dist) |>
        summarise(d = sum(D) / sum(D + R), .groups = "drop")
    }) |>
      arrange(year, office) |>
      mutate(race = fct_inorder(paste(year, recode(office, USSen = "Senate"))),
             plan = factor(plan, levels = names(plans)),
             tot  = dist == "Total",
             y    = factor(dist, levels = rev(c("Total", sort(setdiff(unique(dist), "Total"))))))
    ggplot(x, aes(y = y)) +
      geom_col(aes(x = 1, alpha = tot), fill = REP, width = 0.85) +
      geom_col(aes(x = d, alpha = tot), fill = DEM, width = 0.85) +
      geom_vline(xintercept = 0.5, colour = "white", linewidth = 0.4) +
      geom_text(aes(x = 0.03, label = sprintf("%s  D %.0f", if_else(tot, "Total", paste("Pct", dist)), 100 * d),
                    fontface = if_else(tot, "bold", "plain")), hjust = 0, colour = "white", size = 2.7) +
      geom_text(aes(x = 0.97, label = sprintf("R %.0f", 100 * (1 - d))), hjust = 1, colour = "white", size = 2.7) +
      scale_alpha_manual(values = c(`TRUE` = 1, `FALSE` = 0.8), guide = "none") +
      scale_x_continuous(expand = c(0, 0)) +
      (if (length(plans) > 1) facet_grid(race ~ plan) else facet_wrap(~race, nrow = 1)) +
      theme_void(base_size = 9) +
      theme(strip.text = element_text(face = "bold", size = 8, margin = margin(2, 2, 2, 2)),
            panel.spacing = unit(0.6, "lines"))
  }
  with_totals <- function(p, yrs, plans = list("Map 7" = tar_sf$cc_map7)) {
    rows <- if (length(plans) > 1) n_distinct(paste(contest_long$year, contest_long$office)[contest_long$year %in% yrs]) else 1
    p / dist_bar(yrs, plans) + plot_layout(heights = c(1, 0.32 * rows))
  }
  REF_PLANS <- list("Map 7" = tar_sf$cc_map7, "R-pack" = cc_pack)
  
  # 6a. Partisanship by rank
  band <- ens |> group_by(rank) |> summarise(q5(dem))
  m7_seats <- sum(m7$dem > 0.5)
  RANK_X <- scale_x_continuous(breaks = 1:4, limits = c(0.5, 4.9),
                               labels = c("Least D", "2nd", "3rd", "Most D"))
  
  p_rank <- ggplot(band) +
    geom_hline(yintercept = 0.5, linetype = 2, colour = "grey50") +
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
    geom_text(data = m7_26, aes(rank + 0.2, dem26, label = paste0("2026: ", pct(dem26))),
              hjust = 0, size = 3, colour = "grey10") +
    RANK_X + scale_y_continuous(labels = pct) +
    labs(x = NULL, y = "Dem. share",
         title = "Democratic share by precinct",
         subtitle = sprintf("Grey: %s sampled plans. Teal: Map 7. Purple: R-pack.", format(n_plans, big.mark = ",", scientific = FALSE))) +
    theme_cc
  if (HAS_PRE) p_rank <- p_rank +
    geom_line(data = pre, aes(rank, dem), colour = "grey20", linewidth = 0.6, linetype = 3) +
    geom_point(data = pre, aes(rank, dem), colour = "grey20", shape = 1, size = 2.5) +
    labs(caption = "Dotted: pre-2025")
  p_rank
  
  # 6b. Democratic-leaning precincts per sampled plan
  seats |> count(dem_seats) |> complete(dem_seats = 0:4, fill = list(n = 0)) |>
    mutate(p = n / sum(n), is_m7 = dem_seats == m7_seats,
           lab = paste0(if_else(p > 0, scales::label_percent(accuracy = 0.1)(p), ""), if_else(is_m7, "\nMap 7", ""))) |>
    ggplot(aes(dem_seats, p, fill = is_m7)) +
    geom_col(width = 0.7) +
    geom_text(aes(label = lab), vjust = -0.3, size = 3.3, lineheight = 0.9) +
    scale_fill_manual(values = c(`TRUE` = ACC, `FALSE` = "grey70"), guide = "none") +
    scale_y_continuous(labels = pct, expand = expansion(mult = c(0, 0.18))) +
    labs(x = "D-leaning precincts of 4", y = NULL, title = "D-leaning precincts per sampled plan") +
    theme_cc
  
  # 6b2. Neutral ensemble vs R-pack ensemble
  bind_rows(
    seats    |> select(third, packed) |> mutate(set = "Neutral"),
    pack_tab |> select(third, packed) |> mutate(set = "R-pack")
  ) |>
    pivot_longer(c(third, packed), names_to = "precinct", values_to = "dem") |>
    mutate(precinct = recode(precinct, third = "3rd most D precinct", packed = "Least D precinct")) |>
    ggplot(aes(dem, fill = set)) +
    geom_density(alpha = 0.55, colour = NA) +
    geom_vline(xintercept = 0.5, linetype = 2, colour = "grey40") +
    geom_vline(data = tibble(precinct = c("3rd most D precinct", "Least D precinct"),
                             dem = c(sort(rp$dem)[2], min(rp$dem))),
               aes(xintercept = dem), colour = PK, linewidth = 1) +
    facet_wrap(~precinct, scales = "free_y") +
    scale_fill_manual(values = c("Neutral" = "grey60", "R-pack" = "#8c6bb1"), name = NULL) +
    scale_x_continuous(labels = pct) +
    labs(x = "Dem. share", y = NULL, title = "Neutral vs. R-pack ensembles", subtitle = "Line: R-pack plan") +
    theme_cc + theme(legend.position = "bottom", axis.text.y = element_blank())
  
  # 6c. Minority voting-age share by rank
  VLAB <- c(nonwhite_vap = "Nonwhite VAP", hisp_vap = "Hispanic VAP", black_vap = "Black VAP")
  band_v <- map_dfr(names(VLAB), \(v) {
    tibble(measure = factor(VLAB[[v]], levels = VLAB), rank = rank4(ens[[v]]), share = ens[[v]]) |>
      group_by(measure, rank) |> summarise(q5(share), .groups = "drop")
  })
  m7_v <- m7 |> select(district, all_of(names(VLAB))) |>
    pivot_longer(-district, names_to = "measure", values_to = "share") |>
    mutate(measure = factor(VLAB[measure], levels = VLAB)) |>
    group_by(measure) |> mutate(rank = rank(share, ties.method = "first")) |> ungroup()
  
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
    labs(x = NULL, y = NULL, title = "Minority voting-age share by precinct",
         subtitle = "Grey: sampled plans. Teal: Map 7.") +
    theme_cc
  
  # 6d. Split counts
  SLAB <- c(city_splits = "Cities split", city_multi = "Cities split 3+ ways", comm_splits = "Communities split")
  sp_lab <- function(x) x |> mutate(measure = factor(SLAB[measure], levels = SLAB))
  sp_ens <- seats |> select(all_of(names(SLAB))) |>
    pivot_longer(everything(), names_to = "measure", values_to = "n") |>
    count(measure, n, name = "plans") |> sp_lab()
  sp_m7 <- refd |> filter(draw == "Map 7") |> distinct(across(all_of(names(SLAB)))) |>
    pivot_longer(everything(), names_to = "measure", values_to = "n") |> sp_lab()
  ggplot(sp_ens, aes(n, plans)) +
    geom_col(fill = "grey70") +
    geom_vline(data = sp_m7, aes(xintercept = n), colour = ACC, linewidth = 1.2) +
    facet_wrap(~measure, scales = "free") +
    scale_y_continuous(labels = scales::label_comma()) +
    labs(x = NULL, y = "Sampled plans", title = "Splits per plan", subtitle = "Line: Map 7") +
    theme_cc
  
  # 6e. 2026 votes on each plan
  band26 <- ens |> group_by(rank = rank26) |> summarise(q5(sen26))
  ref26 <- bind_rows(mutate(m7, plan = "Map 7"), mutate(rp, plan = "R-pack")) |>
    mutate(lx = rank26 + if_else(plan == "Map 7", -0.27, 0.27), shift = sen26 - dem_pre,
           lab = paste0("Pct ", district))
  count(seats, seats26) |> mutate(share = n / sum(n))
  ref26 |> select(plan, district, baseline_2020_24 = dem_pre, composite = dem, y2026 = sen26, shift) |> print()
  
  with_totals(
    ggplot(band26) +
      geom_hline(yintercept = 0.5, linetype = 2, colour = "grey50") +
      intervals +
      geom_line(data = ref26, aes(rank26, sen26, colour = plan, linetype = plan), linewidth = 0.8) +
      geom_point(data = ref26, aes(rank26, sen26, colour = plan, shape = plan), size = 2.8) +
      geom_text(data = ref26, aes(lx, sen26, label = pct(sen26), colour = plan), size = 3, show.legend = FALSE) +
      scale_colour_manual(values = c("Map 7" = ACC, "R-pack" = PK), name = NULL) +
      scale_linetype_manual(values = c("Map 7" = 1, "R-pack" = 2), name = NULL) +
      scale_shape_manual(values = c("Map 7" = 16, "R-pack" = 15), name = NULL) +
      scale_x_continuous(breaks = 1:4, limits = c(0.5, 4.5), labels = c("Least D", "2nd", "3rd", "Most D")) +
      scale_y_continuous(labels = pct) +
      labs(x = NULL, y = "2026 Dem. share", title = "2026 vote by precinct", subtitle = "Grey: sampled plans") +
      theme_cc + theme(legend.position = "top", legend.justification = "left"),
    2026, REF_PLANS)
  
  # 6f. Shift to 2026 inside each precinct of Map 7 and the R-pack plan
  with_totals(
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
      labs(x = "Dem. share", y = NULL, title = "2020-24 to 2026",
           subtitle = "Diamond: 2026 commissioner result") +
      theme_cc + theme(panel.grid.major.y = element_blank(), panel.grid.major.x = element_line(colour = "grey90")),
    2026, REF_PLANS)
  
  # ---- 7. Static maps ----
  DCOL <- c("1" = "#1b9e77", "2" = "#e6ab02", "3" = "#7570b3", "4" = "#666666")   # used by section 8
  vtd   <- tar_sf |> st_transform(2276)
  m7_ln <- map7_sf |> st_transform(2276) |> mutate(PRECINCT = as.integer(PRECINCT)) |>
    left_join(m7, by = c("PRECINCT" = "district"))
  rp_ln <- vtd |> mutate(PRECINCT = cc_pack) |> group_by(PRECINCT) |>
    summarise(.groups = "drop") |> left_join(rp, by = c("PRECINCT" = "district"))
  
  f_hw <- file.path(DIR, "tarrant_highways.rds")
  if (file.exists(f_hw)) hw <- readRDS(f_hw) else {
    hw <- roads("TX", "Tarrant") |> filter(MTFCC == "S1100") |> st_transform(2276) |> select(FULLNAME)
    saveRDS(hw, f_hw)
  }
  theme_map <- theme_void(base_size = 11) +
    theme(plot.title = element_text(face = "bold"), plot.subtitle = element_text(colour = "grey30"),
          legend.position = "bottom", legend.key.width = unit(1.2, "cm"), strip.text = element_text(face = "bold"))
  
  # Every scale takes its limits from the data it is drawing (2nd to 98th percentile), never from fixed numbers.
  # Partisan scales keep their midpoint (50%, or zero change) inside the range so white always means even.
  lim <- function(x, mid = NULL) range(c(quantile(x, c(0.02, 0.98), na.rm = TRUE), mid))
  fill_party <- function(x, name = "Dem. share") scale_fill_gradient2(
    low = REP, mid = "#f7f7f7", high = DEM, midpoint = 0.5, limits = lim(x, 0.5), oob = scales::squish,
    labels = pct, na.value = "grey85", name = name)
  fill_shift <- function(x, name = "Shift to D, pts") scale_fill_gradient2(
    low = REP, mid = "#f7f7f7", high = DEM, midpoint = 0, limits = lim(x, 0), oob = scales::squish,
    labels = \(v) sprintf("%+d", round(100 * v)), na.value = "grey85", name = name)
  fill_seq <- function(x, name) scale_fill_viridis_c(
    option = "mako", direction = -1, limits = lim(x), oob = scales::squish, labels = pct,
    na.value = "grey85", name = name)
  lab_box <- function(data, ...) geom_sf_label(data = data, aes(...), size = 2.9, fontface = "bold",
                                               fill = "white", colour = "grey10", lineheight = 0.9)
  m7_lines <- geom_sf(data = m7_ln, fill = NA, colour = "black", linewidth = 0.9)
  roads_ly <- geom_sf(data = hw, colour = "grey35", linewidth = 0.2)
  
  # 7a. Bivariate gallery: party x race by VTD, each plan's lines on top
  # Class breaks come from the VTDs: a third of VTDs fall in the middle party class, nonwhite share is cut at terciles.
  vtd$nw <- if_else(vtd$vap > 0, (vtd$vap - vtd$vap_white) / vtd$vap, NA_real_)
  pb <- 0.5 + c(-1, 1) * unname(quantile(abs(vtd$dshare - 0.5), 1 / 3, na.rm = TRUE))
  nb <- unname(quantile(vtd$nw, c(1 / 3, 2 / 3), na.rm = TRUE))
  vtd$biv <- if_else(is.na(vtd$dshare) | is.na(vtd$nw), NA_character_,
                     paste(findInterval(vtd$dshare, pb) + 1, findInterval(vtd$nw, nb) + 1, sep = "-"))
  BIV <- c("1-1" = "#f2c5bd", "2-1" = "#e8e8e8", "3-1" = "#bdd3ea",       # party class (R, even, D) - nonwhite class (low to high)
           "1-2" = "#d6756a", "2-2" = "#a9a9a9", "3-2" = "#5d9bcf",
           "1-3" = "#8f1d2c", "2-3" = "#5c5c5c", "3-3" = "#174a7e")
  biv_key <- expand_grid(p = 1:3, n = 1:3) |>
    ggplot(aes(p, n, fill = paste(p, n, sep = "-"))) +
    geom_tile() +
    scale_fill_manual(values = BIV, guide = "none") +
    scale_x_continuous(breaks = c(1.5, 2.5), labels = pct(pb), expand = c(0, 0)) +
    scale_y_continuous(breaks = c(1.5, 2.5), labels = pct(nb), expand = c(0, 0)) +
    labs(x = "Dem. share", y = "Nonwhite VAP") +
    coord_fixed() + theme_minimal(base_size = 8) + theme(panel.grid = element_blank())
  
  take <- function(ix, n) ix[sample.int(length(ix), min(n, length(ix)))]
  set.seed(7)
  pick <- c(take(which(n_dem == 2), 2), take(which(n_dem == 3), if (HAS_PRE) 1 else 2))
  gal_plans <- c(list("Map 7" = tar_sf$cc_map7, "R-pack" = cc_pack),
                 if (HAS_PRE) list("Pre-2025" = tar_sf$cc_pre2025),
                 setNames(lapply(pick, \(j) K[, j]), paste("Sampled", LETTERS[seq_along(pick)])))
  gal <- do.call(rbind, lapply(names(gal_plans), \(nm) {
    vtd |> mutate(dist = gal_plans[[nm]]) |> group_by(dist) |>
      summarise(dem = sum(ndv) / sum(ndv + nrv), nwv = sum(vap - vap_white) / sum(vap),
                s26 = sum(ndv26) / sum(ndv26 + nrv26), .groups = "drop") |>
      mutate(panel = factor(nm, levels = names(gal_plans)))
  }))
  gal_vtd <- do.call(rbind, lapply(names(gal_plans), \(nm)
                                   transmute(vtd, biv, panel = factor(nm, levels = names(gal_plans)))))
  
  (ggplot() +
      geom_sf(data = gal_vtd, aes(fill = biv), colour = NA) +
      geom_sf(data = gal, fill = NA, colour = "black", linewidth = 0.7) +
      lab_box(gal, label = sprintf("D %.0f\nNW %.0f", 100 * dem, 100 * nwv)) +
      scale_fill_manual(values = BIV, na.value = "grey90", guide = "none") +
      facet_wrap(~panel, ncol = 3) +
      labs(title = "Party and race under each plan") + theme_map) +
    biv_key + plot_layout(widths = c(7, 1))
  
  # 7b. 2026 votes on each plan
  with_totals(
    ggplot(gal) +
      geom_sf(aes(fill = s26), colour = "black", linewidth = 0.6) +
      lab_box(gal, label = pct(s26)) +
      fill_party(gal$s26, "2026 Dem. share") + facet_wrap(~panel, ncol = 3) +
      labs(title = "2026 vote on each plan") + theme_map,
    2026, gal_plans)
  
  # 7c. Composite baseline with Map 7 lines
  ggplot() +
    geom_sf(data = vtd, aes(fill = dshare), colour = NA) + roads_ly + m7_lines +
    lab_box(m7_ln, label = paste0("Pct ", PRECINCT, "\n", pct(dem))) +
    fill_party(vtd$dshare) +
    labs(title = "Map 7", subtitle = "2020-26 composite") + theme_map
  
  # 7c2. Composite baseline with R-pack lines
  ggplot() +
    geom_sf(data = vtd, aes(fill = dshare), colour = NA) + roads_ly +
    geom_sf(data = m7_ln, fill = NA, colour = "grey25", linewidth = 0.5, linetype = 2) +
    geom_sf(data = rp_ln, fill = NA, colour = "black", linewidth = 1) +
    lab_box(rp_ln, label = paste0("Pct ", PRECINCT, "\n", pct(dem))) +
    fill_party(vtd$dshare) +
    labs(title = "R-pack plan", subtitle = "Dashed: Map 7") + theme_map
  
  # 7d. How often each VTD lands in a Democratic-leaning precinct
  vtd$freq_dem <- vtd_freq_dem
  vtd$freq_mm  <- vtd_freq_mm
  ggplot() +
    geom_sf(data = vtd, aes(fill = freq_dem), colour = NA) + roads_ly + m7_lines +
    lab_box(m7_ln, label = paste0("Pct ", PRECINCT, "\n", pct(dem))) +
    fill_party(vtd$freq_dem, "Sampled plans") +
    labs(title = "How often a D-leaning precinct") + theme_map
  
  # 7e. Hispanic and Black voting-age share by VTD
  grp <- function(x, g, num) transmute(x, group = g, share = if_else(vap > 0, {{ num }} / vap, NA_real_))
  vtd_grp <- rbind(grp(vtd, "Hispanic VAP", vap_hisp), grp(vtd, "Black VAP", vap_black))
  m7_grp  <- rbind(transmute(m7_ln, group = "Hispanic VAP", lab = paste0("Pct ", PRECINCT, "\n", pct(hisp_vap))),
                   transmute(m7_ln, group = "Black VAP",    lab = paste0("Pct ", PRECINCT, "\n", pct(black_vap))))
  ggplot() +
    geom_sf(data = vtd_grp, aes(fill = share), colour = NA) + m7_lines +
    lab_box(m7_grp, label = lab) +
    facet_wrap(~group) + fill_seq(vtd_grp$share, "Share of VAP") +
    labs(title = "Map 7") + theme_map
  
  # 7f. How often each VTD lands in a majority-nonwhite precinct
  ggplot() +
    geom_sf(data = vtd, aes(fill = freq_mm), colour = NA) + roads_ly + m7_lines +
    lab_box(m7_ln, label = paste0("Pct ", PRECINCT, "\n", pct(nonwhite_vap))) +
    fill_seq(vtd$freq_mm, "Sampled plans") +
    labs(title = "How often a majority-nonwhite precinct") + theme_map
  
  # 7j. Election by election, one total bar per race under its year
  vtd_year <- vtd |> select(vtdkey) |> left_join(select(year_vtd, vtdkey, year, share), by = "vtdkey")
  with_totals(
    ggplot() +
      geom_sf(data = vtd_year, aes(fill = share), colour = NA) +
      geom_sf(data = m7_ln, fill = NA, colour = "black", linewidth = 0.5) +
      facet_wrap(~year, nrow = 1) + fill_party(vtd_year$share) +
      labs(title = "Tarrant County, 2020 to 2026") + theme_map,
    unique(year_vtd$year))
  
  # 7k. 2026 with Map 7 lines
  with_totals(
    ggplot() +
      geom_sf(data = vtd, aes(fill = share26), colour = NA) + roads_ly + m7_lines +
      lab_box(m7_ln, label = paste0("Pct ", PRECINCT, "\n", pct(sen26))) +
      fill_party(vtd$share26, "2026 Dem. share") +
      labs(title = "2026 on Map 7") + theme_map,
    2026)
  
  # 7l. Shift from the 2020-24 baseline to 2026, Map 7 lines
  with_totals(
    ggplot() +
      geom_sf(data = vtd, aes(fill = shift26), colour = NA) + roads_ly + m7_lines +
      lab_box(m7_ln, label = paste0("Pct ", PRECINCT, "\n", sprintf("%+.1f", 100 * (sen26 - dem_pre)))) +
      fill_shift(vtd$shift26) +
      labs(title = "2026 shift on Map 7", subtitle = "From 2020-24") + theme_map,
    c(2024, 2026))
  
  # 7m. The same shift under the R-pack plan's lines
  with_totals(
    ggplot() +
      geom_sf(data = vtd, aes(fill = shift26), colour = NA) + roads_ly +
      geom_sf(data = rp_ln, fill = NA, colour = "black", linewidth = 1) +
      lab_box(rp_ln, label = paste0("Pct ", PRECINCT, "\n", pct(sen26), " (", sprintf("%+.1f", 100 * (sen26 - dem_pre)), ")")) +
      fill_shift(vtd$shift26) +
      labs(title = "2026 on the R-pack plan", subtitle = "2026 share and shift from 2020-24") + theme_map,
    c(2024, 2026), list("R-pack" = cc_pack))
  
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
  
  # Inside each split city: VTDs on the party x race key, Map 7 pieces outlined, then the city's 2026 result
  # as a total and one bar per piece
  vtd$nwn <- vtd$vap - vtd$vap_white
  city_panel <- function(cty) {
    v <- filter(vtd, city_name == cty)
    pieces <- v |> group_by(piece = cc_map7) |>
      summarise(dem = sum(ndv) / sum(ndv + nrv), nw = sum(nwn) / sum(vap), .groups = "drop")
    mp <- ggplot() +
      geom_sf(data = v, aes(fill = biv), colour = "white", linewidth = 0.05) +
      geom_sf(data = pieces, fill = NA, colour = "black", linewidth = 0.9) +
      lab_box(pieces, label = sprintf("Pct %d\nD %.0f  NW %.0f", piece, 100 * dem, 100 * nw)) +
      scale_fill_manual(values = BIV, na.value = "grey90", guide = "none") +
      labs(title = cty) + theme_map
    mp / dist_bar(2026, setNames(list(tar_sf$cc_map7), cty), keep = tar_sf$city_name %in% cty) +
      plot_layout(heights = c(1, 0.32))
  }
  split_cities <- city_sp$city[which(city_sp$n_parts > 1)]
  # wrap_elements freezes each city's map-over-bars stack into one panel, so the row has exactly one slot per city
  wrap_plots(c(lapply(split_cities, \(cty) wrap_elements(full = city_panel(cty))), list(biv_key)),
             nrow = 1, ncol = length(split_cities) + 1, widths = c(rep(4, length(split_cities)), 1)) +
    plot_annotation(title = sprintf("Map 7 splits %d of %d cities", length(split_cities), nrow(city_sp)),
                    theme = theme(plot.title = element_text(face = "bold")))
  
  ggplot() +
    geom_sf(data = m7_ln, fill = "grey97", colour = NA) +
    geom_sf(data = comm_sp, aes(fill = n_parts > 1), colour = "white", linewidth = 0.1) +
    m7_lines +
    scale_fill_manual(values = c(`TRUE` = "#e08214", `FALSE` = "grey82"), labels = c(`TRUE` = "Split", `FALSE` = "Whole"),
                      name = NULL, na.value = "grey95") +
    labs(title = sprintf("Map 7 splits %d of %d mapped communities", sum(comm_sp$n_parts > 1, na.rm = TRUE), nrow(comm_sp))) +
    theme_map
  
  # 7i. Which cities sampled plans split, against Map 7 (VTD-level, cities with 2+ VTDs)
  city_freq <- tibble(city = names(city_split_n), freq = as.numeric(city_split_n) / n_plans) |>
    left_join(tibble(city = cgrp, p = tar_sf$cc_map7[has_city]) |> group_by(city) |>
                summarise(vtds = n(), m7_split = n_distinct(p) > 1), by = "city") |>
    filter(vtds >= 2)
  ggplot(city_freq, aes(freq, fct_reorder(city, freq), fill = m7_split)) +
    geom_col(width = 0.7) +
    scale_fill_manual(values = c(`TRUE` = ACC, `FALSE` = "grey70"),
                      labels = c(`TRUE` = "Split by Map 7", `FALSE` = "Whole in Map 7"), name = NULL) +
    scale_x_continuous(labels = pct, expand = expansion(mult = c(0, 0.05))) +
    labs(x = "Sampled plans splitting the city", y = NULL, title = "City splits") +
    theme_cc + theme(legend.position = "top", legend.justification = "left", panel.grid.major.y = element_blank(),
                     panel.grid.major.x = element_line(colour = "grey90"))
  
  # ---- 8. Interactive map: every plan with its precinct shares, toggleable boundaries and 2026 results ----
  ideal <- sum(tar_sf$pop) / 4
  plan_layer <- function(assign, nm) {
    st <- plan_stats(assign)
    vtd |> mutate(PRECINCT = as.integer(assign)) |> group_by(PRECINCT) |> summarise(.groups = "drop") |>
      left_join(st, by = c("PRECINCT" = "district")) |>
      mutate(dist  = as.character(PRECINCT),
             tip   = sprintf("%s Pct %s<br>Pop %s (%+.1f%%)<br>D %.1f%% composite | %.1f%% 2026<br>Nonwhite VAP %.1f%%",
                             nm, dist, format(pop, big.mark = ","), 100 * (pop / ideal - 1),
                             100 * dem, 100 * sen26, 100 * nonwhite_vap),
             lab   = sprintf("%s\nD %.0f | '26 %.0f", dist, 100 * dem, 100 * sen26)) |>
      st_transform(4326)
  }
  PL <- c(list("Map 7" = tar_sf$cc_map7, "R-pack" = cc_pack), if (HAS_PRE) list("Pre-2025" = tar_sf$cc_pre2025))
  LY <- imap(PL, plan_layer)
  LINE <- c("Map 7" = "#000000", "R-pack" = "#3b0f70", "Pre-2025" = "#7f7f7f")
  DASH <- list("Map 7" = c(1, 0), "R-pack" = c(2, 1), "Pre-2025" = c(1, 1))
  
  pc_ll <- pc26 |> st_transform(4326) |>
    mutate(sen_tip = sprintf("Pct %s<br>Senate D %s R %s<br>D %.1f%%", PCT, SEN_D, SEN_R, 100 * SEN_2P),
           cc_tip  = sprintf("Pct %s | Commissioner Pct %s<br>D %s R %s<br>D %.1f%%", PCT, CC_PCT, CC_D, CC_R, 100 * CC_2P))
  # red-white-blue around 50%, stretched to the spread of the layer's own values
  ramp <- function(col, x) {
    r <- max(abs(quantile(x - 0.5, c(0.02, 0.98), na.rm = TRUE)))
    interpolate(column = col, values = 0.5 + c(-r, 0, r), stops = c(REP, "#f7f7f7", DEM))
  }
  
  m <- maplibre(style = "https://tiles.openfreemap.org/styles/positron", bounds = LY[[1]]) |>
    add_fill_layer(id = "2026 Senate", source = pc_ll, fill_opacity = 0.7, tooltip = "sen_tip",
                   visibility = "none", fill_color = ramp("SEN_2P", pc_ll$SEN_2P)) |>
    add_fill_layer(id = "2026 Commissioner", source = filter(pc_ll, CC_PCT > 0), fill_opacity = 0.7, tooltip = "cc_tip",
                   visibility = "none", fill_color = ramp("CC_2P", pc_ll$CC_2P[pc_ll$CC_PCT > 0]))
  for (nm in names(LY)) {
    on <- if (nm == "R-pack") "visible" else "none"
    m <- m |>
      add_fill_layer(id = paste(nm, "precincts"), source = LY[[nm]], fill_opacity = 0.35, tooltip = "tip",
                     visibility = on, fill_color = match_expr("dist", values = names(DCOL), stops = unname(DCOL))) |>
      add_line_layer(id = paste(nm, "lines"), source = LY[[nm]], line_color = LINE[[nm]],
                     line_width = if (nm == "Map 7") 3 else 2, line_dasharray = DASH[[nm]],
                     visibility = if (nm %in% c("Map 7", "R-pack")) "visible" else "none") |>
      add_symbol_layer(id = paste(nm, "shares"), source = st_point_on_surface(LY[[nm]]),
                       text_field = get_column("lab"), text_size = 13, text_color = "#111111",
                       text_halo_color = "#ffffff", text_halo_width = 2, visibility = on)
  }
  m |>
    add_line_layer(id = "Cities", source = st_transform(cities, 4326), line_color = "#555555",
                   line_width = 0.8, visibility = "none") |>
    add_layers_control(collapsible = TRUE,
                       layers = c(as.vector(t(outer(names(LY), c("precincts", "shares", "lines"), paste))),
                                  "Cities", "2026 Senate", "2026 Commissioner"))
})
run_stored(PART_B, final = TRUE)