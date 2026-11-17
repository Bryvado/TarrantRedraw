# SCRIPT: tarrant_cc_redist_map7.R
# SMC ensemble of Tarrant County commissioner precincts (4) on TLC 2024 VTDs
# Reference plans (PLANS, section 4d): 2025 Map 7, "R-pack" (Republicans packed into one precinct, 4b),
#   "Swing" (one R precinct, one flippable, two packed D, 4c) and an optional pre-2025 plan.
#   Every chart and map shows all of them together; nothing is drawn for Map 7 alone.
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
  items <- OUT
  OUT <<- list()                         # empty first, so a failed draw can never leave old output queued
  for (o in items) {
    if (!is.null(o$txt)) cat(o$txt, sep = "\n")
    if (!is.null(o$val)) tryCatch(print(o$val), error = function(e)
      message("\nCOULD NOT DRAW: ", utils::head(deparse(o$step), 1), "\n  ", conditionMessage(e), "\n"))
  }
  invisible()
}
run_stored <- function(block, final = FALSE) {
  if (!isTRUE(RUN_OK)) return(invisible())                   # an earlier block failed: do nothing, say nothing
  steps <- as.list(block)[-1]
  for (ex in steps) {
    tryCatch({
      txt <- capture.output(r <- withVisible(eval(ex, globalenv())))
      if (length(txt)) OUT[[length(OUT) + 1]] <<- list(txt = txt)
      if (r$visible && !is.null(r$value)) OUT[[length(OUT) + 1]] <<- list(val = r$value, step = ex)
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
  D_TGT     <- 0.55                               # R-pack: Democratic share the three unpacked precincts should clear
  N_PER_RUN    <- 100000                          # plans per independent SMC run (one batch)
  N_RUNS       <- 20                              # batches; total sampled plans = N_PER_RUN * N_RUNS
  KEEP_PER_RUN <- 250                             # full plans kept from each batch for the gallery maps
  USE_CITY_SPLITS <- FALSE                        # FALSE: city lines play no part in drawing any plan
  USE_COI_SPLITS  <- FALSE                        # FALSE: communities of interest play no part in drawing any plan
  # Every checkpoint below is named for these two switches, so turning one off draws fresh plans
  # and switching back reuses the earlier ones. Both TRUE keeps the original file names.
  SPLIT_TAG    <- paste0(if (!USE_CITY_SPLITS) "_nocity", if (!USE_COI_SPLITS) "_nocoi")
  ENS_TAG      <- paste0("v1", SPLIT_TAG)         # change "v1" whenever the map, tolerance or constraint strengths change
  PACK_STARTS  <- 5                               # short-burst runs, each from a different start
  PACK_BURSTS  <- 1500                            # bursts per run
  PACK_SPLITW  <- 0.002                           # charge per split city; 0 gives the pure partisan ceiling
  SW_RBAND     <- c(0.38, 0.42)                   # swing plan: D share allowed in the Republican precinct (58-62% R)
  SW_SWING     <- 0.495                           # swing plan: composite D share of the flippable precinct
  SW_FLOOR     <- 0.62                            # swing plan: both packed D precincts at or above this
  
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
  cons <- redist_constr(map)
  if (USE_CITY_SPLITS) cons <- cons |>
    add_constr_splits(strength = 0.75, admin = city_std) |>
    add_constr_multisplits(strength = 4.0, admin = city_std) |>
    add_constr_multisplits(strength = 1.5, admin = city_irr) |>
    add_constr_total_splits(strength = 0.3, admin = city_fw)
  if (USE_COI_SPLITS) cons <- cons |> add_constr_splits(strength = 0.3, admin = comm)
  SPLIT_W <- PACK_SPLITW * USE_CITY_SPLITS        # short-burst charge per split city (0 when city splits are off)
  cat("Split rules | cities:", USE_CITY_SPLITS, "| communities:", USE_COI_SPLITS, "| checkpoint tag:", ENS_TAG, "\n")
  
  # ---- 4b. Republican-pack ensemble and one optimized pack plan (checkpointed) ----
  # The hinge penalty takes a square root of each precinct's shortfall below D_TGT, so the sampler
  # prefers one deep shortfall (the packed R precinct) over several shallow ones.
  cons_pack <- cons |>
    add_constr_grp_hinge(strength = 25, group_pop = ndv, total_pop = two_party, tgts_group = D_TGT)
  
  f_pk <- file.path(DIR, paste0("tarrant_cc_smc_rpack", SPLIT_TAG, ".rds"))
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
  f_sb <- file.path(DIR, paste0("tarrant_cc_rpack_plan", SPLIT_TAG, ".rds"))
  if (file.exists(f_sb)) {
    cc_pack <- readRDS(f_sb)
  } else {
    pm_pk <- get_plans_matrix(plans_pack)
    # redist's scorer_splits() crashes R on this map; count split cities in R instead
    city_id <- map$city_all
    s_split <- structure(function(plans) apply(as.matrix(plans), 2, \(a) sum(tapply(a, city_id, n_distinct) > 1)),
                         class = c("redist_scorer", "function"))
    score     <- scorer_group_pct(map, ndv, two_party, k = 3) - SPLIT_W * s_split
    third_of  <- function(a) sort(tapply(map$ndv, a, sum) / tapply(map$two_party, a, sum))[2]
    last_plan <- function(sb) { m <- get_plans_matrix(sb); as.integer(m[, ncol(m)]) }
    starts    <- order(pack_tab$third, decreasing = TRUE)[seq_len(PACK_STARTS)]
    set.seed(439)
    cand <- lapply(starts, function(j) last_plan(
      redist_shortburst(map, score, init_plan = pm_pk[, j], burst_size = 10, max_bursts = PACK_BURSTS,
                        maximize = TRUE, verbose = FALSE)))
    res <- sapply(cand, third_of)
    message("Third D precinct by start: ", paste(sprintf("%.1f%%", 100 * res), collapse = ", "))
    cc_pack <- cand[[which.max(res)]]
    
    # refine with merge-split only: whole-border redraws keep shapes clean (single-VTD flips grew tendrils)
    ref1 <- last_plan(redist_shortburst(map, score, init_plan = cc_pack, burst_size = 10, max_bursts = PACK_BURSTS,
                                        reversible = FALSE, fixed_k = 1, compactness = 1, verbose = FALSE))
    if (third_of(ref1) > third_of(cc_pack)) cc_pack <- ref1
    message(sprintf("After refinement: third D precinct %.1f%% (ceiling 60.7%%)", 100 * third_of(cc_pack)))
    saveRDS(cc_pack, f_sb)
  }
  stopifnot(length(cc_pack) == nrow(map), setequal(unique(cc_pack), 1:4))
  
  # ---- 4c. Swing plan: one capped R precinct, one flippable precinct, two packed D precincts (checkpointed) ----
  f_sw <- file.path(DIR, paste0("tarrant_cc_swing_plan", SPLIT_TAG, ".rds"))
  if (file.exists(f_sw)) {
    cc_swing <- readRDS(f_sw)
  } else {
    sw_pen <- function(a) {                                           # 0 when every target is met
      d <- sort(tapply(map$ndv, a, sum) / tapply(map$two_party, a, sum))
      12 * (max(0, SW_RBAND[1] - d[1]) + max(0, d[1] - SW_RBAND[2])) + 10 * abs(d[2] - SW_SWING) + 6 * max(0, SW_FLOOR - d[3])
    }
    city_id  <- map$city_all
    sw_score <- structure(function(plans) apply(as.matrix(plans), 2, \(a)
                                                -sw_pen(a) - SPLIT_W * sum(tapply(a, city_id, n_distinct) > 1)),
                          class = c("redist_scorer", "function"))
    pm_pk  <- get_plans_matrix(plans_pack)
    starts <- cbind(map$cc_map7, pm_pk[, order(apply(pm_pk, 2, sw_pen))[seq_len(PACK_STARTS - 1)]])
    set.seed(439)
    cand <- lapply(seq_len(ncol(starts)), function(j) {
      sb   <- redist_shortburst(map, sw_score, init_plan = starts[, j], burst_size = 10, max_bursts = PACK_BURSTS,
                                maximize = TRUE, verbose = FALSE)
      sb_m <- get_plans_matrix(sb)
      as.integer(sb_m[, ncol(sb_m)])
    })
    pen <- sapply(cand, sw_pen)
    message("Swing plan penalty by start (0 = all targets met): ", paste(round(pen, 3), collapse = ", "))
    cc_swing <- cand[[which.min(pen)]]
    saveRDS(cc_swing, f_sw)
  }
  print(sort(round(tapply(map$ndv, cc_swing, sum) / tapply(map$two_party, cc_swing, sum), 3)))
  stopifnot(length(cc_swing) == nrow(map), setequal(unique(cc_swing), 1:4))
  
  # ---- 4d. The plans every script compares (tarrant_cc_planscore.R and tarrant_redraw_export.R read these) ----
  PLANS <- c(list("Map 7" = tar_sf$cc_map7, "R-pack" = cc_pack, "Swing" = cc_swing),
             if (HAS_PRE) list("Pre-2025" = tar_sf$cc_pre2025))
  PCOL  <- c("Map 7" = "#21908c", "R-pack" = "#3b0f70", "Swing" = "#e08214", "Pre-2025" = "#7f7f7f")[names(PLANS)]
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
  
  # ---- 5b. Every plan measured the same way ----
  ref_pl <- plans_pack
  for (nm in names(PLANS)) ref_pl <- add_reference(ref_pl, PLANS[[nm]], nm)
  ref_pl <- ref_pl |> subset_ref() |> add_metrics()
  refd <- ref_pl |> as_tibble() |> mutate(plan = factor(as.character(draw), levels = names(PLANS)))
  stopifnot(!anyNA(refd$plan))
  
  # precinct stats straight from the VTD table, so precinct numbers are the real ones
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
  OFFX <- setNames(seq(-0.27, 0.27, length.out = length(PLANS)), names(PLANS))   # side-by-side offset per plan
  pst <- imap_dfr(PLANS, \(a, nm) plan_stats(a) |> mutate(plan = nm)) |>
    left_join(cc26 |> transmute(plan = "Map 7", district = as.integer(district), dem26), by = c("plan", "district")) |>
    mutate(rx = rank + unname(OFFX[plan]), rx26 = rank26 + unname(OFFX[plan]), shift = sen26 - dem_pre,
           plan = factor(plan, levels = names(PLANS)))
  print(pst |> select(plan, district, pop, dem, sen26, dem_pre, hisp_vap, black_vap, nonwhite_vap), n = Inf)
  
  plan_sum <- refd |> group_by(plan) |>
    summarise(dem_seats = sum(dem > 0.5), seats26 = sum(sen26 > 0.5), mm_seats = sum(nonwhite_vap > 0.5),
              max_dev = max(dev), min_polsby = min(polsby), city_splits = first(city_splits),
              city_multi = first(city_multi), comm_splits = first(comm_splits))
  print(plan_sum)
  
  count(seats, dem_seats) |> mutate(share = n / sum(n))
  count(seats, seats26)   |> mutate(share = n / sum(n))
  seats |> summarise(across(c(dev, min_polsby, city_splits, comm_splits), median))
  
  # ---- 6. Charts: sampled plans in grey, every reference plan in its own colour ----
  DEM <- "#2166ac"                                 # partisan metrics only
  REP <- "#b2182b"
  COLS <- scale_colour_manual(values = PCOL, name = NULL)
  pct <- scales::label_percent(accuracy = 1)
  theme_cc <- theme_minimal(base_size = 11) +
    theme(panel.grid.minor = element_blank(), panel.grid.major.x = element_blank(),
          plot.title = element_text(face = "bold"), plot.title.position = "plot",
          plot.subtitle = element_text(colour = "grey30"), strip.text = element_text(face = "bold"),
          legend.position = "top", legend.justification = "left")
  q5 <- function(x) tibble(q05 = quantile(x, 0.05), q25 = quantile(x, 0.25), med = median(x),
                           q75 = quantile(x, 0.75), q95 = quantile(x, 0.95))
  intervals <- list(
    geom_linerange(aes(rank, ymin = q05, ymax = q95), linewidth = 1.2, colour = "grey78"),
    geom_linerange(aes(rank, ymin = q25, ymax = q75), linewidth = 6, colour = "grey60"),
    geom_point(aes(rank, med), shape = 95, size = 9, colour = "grey15"))
  plan_marks <- function(d, x, y) list(
    geom_line(data = d, aes(.data[[x]], .data[[y]], colour = plan), linewidth = 0.8),
    geom_point(data = d, aes(.data[[x]], .data[[y]], colour = plan), size = 2.6),
    geom_text(data = d, aes(.data[[x]], .data[[y]], label = pct(.data[[y]]), colour = plan),
              vjust = -1, size = 2.7, show.legend = FALSE))
  
  # Results under any plot that shows a race: the total, then each precinct, for each plan and race
  dist_bar <- function(yrs, plans = PLANS, keep = rep(TRUE, nrow(tar_sf))) {
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
      (if (length(plans) > 1) facet_grid(plan ~ race) else facet_wrap(~race, nrow = 1)) +
      theme_void(base_size = 9) +
      theme(strip.text = element_text(face = "bold", size = 8, margin = margin(2, 2, 2, 2)),
            panel.spacing = unit(0.6, "lines"))
  }
  with_totals <- function(p, yrs, plans = PLANS) p / dist_bar(yrs, plans) + plot_layout(heights = c(1, 0.3 * length(plans)))
  
  # 6a. Democratic share by precinct rank
  RANK_X <- scale_x_continuous(breaks = 1:4, limits = c(0.5, 4.5), labels = c("Least D", "2nd", "3rd", "Most D"))
  ggplot(ens |> group_by(rank) |> summarise(q5(dem))) +
    geom_hline(yintercept = 0.5, linetype = 2, colour = "grey50") +
    intervals + plan_marks(pst, "rx", "dem") + COLS + RANK_X + scale_y_continuous(labels = pct) +
    labs(x = NULL, y = "Dem. share", title = "Democratic share by precinct",
         subtitle = sprintf("Grey: %s sampled plans", format(n_plans, big.mark = ",", scientific = FALSE))) +
    theme_cc
  
  # 6b. Democratic-leaning precincts per sampled plan, with each reference plan marked on its bar
  seat_lab <- plan_sum |> group_by(dem_seats) |> summarise(who = paste(plan, collapse = "\n"))
  seats |> count(dem_seats) |> complete(dem_seats = 0:4, fill = list(n = 0)) |>
    mutate(p = n / sum(n)) |> left_join(seat_lab, by = "dem_seats") |>
    mutate(lab = paste0(if_else(p > 0, scales::label_percent(accuracy = 0.1)(p), ""),
                        if_else(is.na(who), "", paste0("\n", who)))) |>
    ggplot(aes(dem_seats, p, fill = !is.na(who))) +
    geom_col(width = 0.7) +
    geom_text(aes(label = lab), vjust = -0.2, size = 3.1, lineheight = 0.9) +
    scale_fill_manual(values = c(`TRUE` = "grey45", `FALSE` = "grey75"), guide = "none") +
    scale_y_continuous(labels = pct, expand = expansion(mult = c(0, 0.3))) +
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
    geom_vline(data = pst |> filter(rank %in% 1:2) |>
                 mutate(precinct = if_else(rank == 2, "3rd most D precinct", "Least D precinct")),
               aes(xintercept = dem, colour = plan), linewidth = 1) +
    facet_wrap(~precinct, scales = "free_y") +
    scale_fill_manual(values = c("Neutral" = "grey60", "R-pack" = "#8c6bb1"), name = NULL) + COLS +
    scale_x_continuous(labels = pct) +
    labs(x = "Dem. share", y = NULL, title = "Neutral vs. R-pack ensembles", subtitle = "Lines: reference plans") +
    theme_cc + theme(axis.text.y = element_blank())
  
  # 6c. Minority voting-age share by rank
  VLAB <- c(nonwhite_vap = "Nonwhite VAP", hisp_vap = "Hispanic VAP", black_vap = "Black VAP")
  band_v <- map_dfr(names(VLAB), \(v) {
    tibble(measure = factor(VLAB[[v]], levels = VLAB), rank = rank4(ens[[v]]), share = ens[[v]]) |>
      group_by(measure, rank) |> summarise(q5(share), .groups = "drop")
  })
  pst_v <- pst |> select(plan, district, all_of(names(VLAB))) |>
    pivot_longer(all_of(names(VLAB)), names_to = "measure", values_to = "share") |>
    mutate(measure = factor(VLAB[measure], levels = VLAB)) |>
    group_by(plan, measure) |>
    mutate(rx = rank(share, ties.method = "first") + unname(OFFX[as.character(plan)])) |> ungroup()
  ggplot(band_v) +
    geom_hline(yintercept = 0.5, linetype = 2, colour = "grey50") +
    intervals + plan_marks(pst_v, "rx", "share") + COLS +
    facet_wrap(~measure) +
    scale_x_continuous(breaks = 1:4, limits = c(0.5, 4.5), labels = c("Lowest", "2nd", "3rd", "Highest")) +
    scale_y_continuous(labels = pct) +
    labs(x = NULL, y = NULL, title = "Minority voting-age share by precinct", subtitle = "Grey: sampled plans") +
    theme_cc
  
  # 6d. Split counts
  SLAB <- c(city_splits = "Cities split", city_multi = "Cities split 3+ ways", comm_splits = "Communities split")
  sp_lab <- function(x) x |> mutate(measure = factor(SLAB[measure], levels = SLAB))
  sp_ens <- seats |> select(all_of(names(SLAB))) |>
    pivot_longer(everything(), names_to = "measure", values_to = "n") |>
    count(measure, n, name = "plans") |> sp_lab()
  sp_ref <- plan_sum |> select(plan, all_of(names(SLAB))) |>
    pivot_longer(-plan, names_to = "measure", values_to = "n") |> sp_lab()
  ggplot(sp_ens, aes(n, plans)) +
    geom_col(fill = "grey75") +
    geom_vline(data = sp_ref, aes(xintercept = n, colour = plan), linewidth = 1.1) + COLS +
    facet_wrap(~measure, scales = "free") +
    scale_y_continuous(labels = scales::label_comma()) +
    labs(x = NULL, y = "Sampled plans", title = "Splits per plan") +
    theme_cc
  
  # 6e. 2026 votes on each plan
  with_totals(
    ggplot(ens |> group_by(rank = rank26) |> summarise(q5(sen26))) +
      geom_hline(yintercept = 0.5, linetype = 2, colour = "grey50") +
      intervals + plan_marks(pst, "rx26", "sen26") + COLS + RANK_X + scale_y_continuous(labels = pct) +
      labs(x = NULL, y = "2026 Dem. share", title = "2026 vote by precinct", subtitle = "Grey: sampled plans") +
      theme_cc,
    2026)
  
  # 6f. Shift to 2026 inside each precinct of every plan
  ggplot(pst, aes(y = fct_rev(paste("Pct", district)))) +
    geom_vline(xintercept = 0.5, linetype = 2, colour = "grey50") +
    geom_segment(aes(x = dem_pre, xend = sen26, yend = fct_rev(paste("Pct", district))), colour = "grey20",
                 linewidth = 0.8, arrow = arrow(length = unit(0.08, "in"))) +
    geom_point(aes(x = dem_pre), shape = 21, fill = "white", colour = "grey20", size = 2.6) +
    geom_text(aes(x = sen26, label = sprintf("%s (%+.1f)", pct(sen26), 100 * shift)), hjust = -0.12, size = 3) +
    geom_point(data = filter(pst, !is.na(dem26)), aes(x = dem26), shape = 5, size = 3, stroke = 1.1, colour = "grey20") +
    facet_wrap(~plan) +
    scale_x_continuous(labels = pct, expand = expansion(mult = c(0.06, 0.3))) +
    labs(x = "Dem. share", y = NULL, title = "2020-24 to 2026", subtitle = "Diamond: 2026 commissioner result") +
    theme_cc + theme(panel.grid.major.y = element_blank(), panel.grid.major.x = element_line(colour = "grey90"))
  
  # ---- 7. Static maps: one panel per plan, same shading, same scale ----
  DCOL <- c("1" = "#1b9e77", "2" = "#e6ab02", "3" = "#7570b3", "4" = "#666666")   # used by section 8
  vtd  <- tar_sf |> st_transform(2276)
  vtd$freq_dem <- vtd_freq_dem
  vtd$freq_mm  <- vtd_freq_mm
  vtd$nw   <- if_else(vtd$vap > 0, (vtd$vap - vtd$vap_white) / vtd$vap, NA_real_)
  vtd$h_sh <- if_else(vtd$vap > 0, vtd$vap_hisp / vtd$vap, NA_real_)
  vtd$b_sh <- if_else(vtd$vap > 0, vtd$vap_black / vtd$vap, NA_real_)
  
  plan_ln <- do.call(rbind, lapply(names(PLANS), \(nm)
                                   vtd |> mutate(district = as.integer(PLANS[[nm]])) |> group_by(district) |> summarise(.groups = "drop") |>
                                     mutate(plan = nm))) |>
    left_join(mutate(pst, plan = as.character(plan)), by = c("plan", "district")) |>
    mutate(plan = factor(plan, levels = names(PLANS)),
           l_dem   = paste0("Pct ", district, "\n", pct(dem)),
           l_26    = paste0("Pct ", district, "\n", pct(sen26)),
           l_shift = paste0("Pct ", district, "\n", sprintf("%+.1f", 100 * shift)),
           l_nw    = paste0("Pct ", district, "\n", pct(nonwhite_vap)),
           l_hisp  = paste0("Pct ", district, "\n", pct(hisp_vap)),
           l_black = paste0("Pct ", district, "\n", pct(black_vap)))
  
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
  
  # VTDs shaded by one column, repeated once per plan with that plan's lines and precinct labels
  plan_map <- function(fill, scale, lab, title, subtitle = NULL) {
    base <- do.call(rbind, lapply(names(PLANS), \(nm)
                                  transmute(vtd, v = .data[[fill]], plan = factor(nm, levels = names(PLANS)))))
    ggplot() +
      geom_sf(data = base, aes(fill = v), colour = NA) +
      geom_sf(data = hw, colour = "grey35", linewidth = 0.15) +
      geom_sf(data = plan_ln, fill = NA, colour = "black", linewidth = 0.8) +
      lab_box(plan_ln, label = .data[[lab]]) +
      scale + facet_wrap(~plan, nrow = 1) + labs(title = title, subtitle = subtitle) + theme_map
  }
  
  # 7a. Party x race by VTD under each reference plan and a few sampled plans
  # Class breaks come from the VTDs: a third of VTDs fall in the middle party class, nonwhite share is cut at terciles.
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
  pick <- c(take(which(n_dem == 2), 2), take(which(n_dem == 3), 2))[seq_len(max(0, 6 - length(PLANS)))]
  gal_plans <- c(PLANS, setNames(lapply(pick, \(j) K[, j]), paste("Sampled", LETTERS[seq_along(pick)])))
  gal <- do.call(rbind, lapply(names(gal_plans), \(nm) {
    vtd |> mutate(dist = gal_plans[[nm]]) |> group_by(dist) |>
      summarise(dem = sum(ndv) / sum(ndv + nrv), nwv = sum(vap - vap_white) / sum(vap), .groups = "drop") |>
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
  
  # 7b. Composite baseline
  plan_map("dshare", fill_party(vtd$dshare), "l_dem", "2020-26 composite")
  
  # 7c. 2026 vote, with each plan's result by race
  with_totals(plan_map("share26", fill_party(vtd$share26, "2026 Dem. share"), "l_26", "2026 vote"), 2026)
  
  # 7d. Shift from the 2020-24 baseline to 2026
  with_totals(plan_map("shift26", fill_shift(vtd$shift26), "l_shift", "2026 shift", "From 2020-24"), c(2024, 2026))
  
  # 7e. How often sampled plans put each VTD in a Democratic-leaning precinct
  plan_map("freq_dem", fill_party(vtd$freq_dem, "Sampled plans"), "l_dem", "How often a D-leaning precinct")
  
  # 7f. Hispanic, Black and nonwhite voting-age population
  plan_map("h_sh", fill_seq(vtd$h_sh, "Hispanic share of VAP"), "l_hisp", "Hispanic voting-age population")
  plan_map("b_sh", fill_seq(vtd$b_sh, "Black share of VAP"), "l_black", "Black voting-age population")
  plan_map("freq_mm", fill_seq(vtd$freq_mm, "Sampled plans"), "l_nw", "How often a majority-nonwhite precinct")
  
  # 7g. Election by election, with every plan's result in every race
  vtd_year <- vtd |> select(vtdkey) |> left_join(select(year_vtd, vtdkey, year, share), by = "vtdkey")
  with_totals(
    ggplot() +
      geom_sf(data = vtd_year, aes(fill = share), colour = NA) +
      facet_wrap(~year, nrow = 1) + fill_party(vtd_year$share) +
      labs(title = "Tarrant County, 2020 to 2026") + theme_map,
    unique(year_vtd$year))
  
  # 7h. Which cities each plan splits (VTD level)
  city_pieces <- imap_dfr(PLANS, \(a, nm) tibble(city = tar_sf$city_name, d = a) |> filter(!is.na(city)) |>
                            group_by(city) |> summarise(pieces = n_distinct(d)) |> mutate(plan = nm))
  city_pieces |> filter(pieces > 1) |> mutate(plan = factor(plan, levels = names(PLANS))) |> arrange(plan) |>
    pivot_wider(names_from = plan, values_from = pieces, values_fill = 1) |> print(n = Inf)
  split_by <- city_pieces |> filter(pieces > 1) |> group_by(city) |> summarise(by = paste(plan, collapse = ", "))
  
  # Fort Worth and Arlington under each plan: party x race by VTD, the plan's pieces, and the 2026 result by piece
  CITY_SHOW <- c("Fort Worth", "Arlington")
  city_panel <- function(cty, nm) {
    a <- as.integer(PLANS[[nm]])
    v <- vtd |> mutate(piece = a) |> filter(city_name %in% cty)
    pieces <- v |> group_by(piece) |>
      summarise(dem = sum(ndv) / sum(ndv + nrv), nwv = sum(vap - vap_white) / sum(vap), .groups = "drop")
    mp <- ggplot() +
      geom_sf(data = v, aes(fill = biv), colour = "white", linewidth = 0.05) +
      geom_sf(data = pieces, fill = NA, colour = "black", linewidth = 0.9) +
      lab_box(pieces, label = sprintf("Pct %d\nD %.0f  NW %.0f", piece, 100 * dem, 100 * nwv)) +
      scale_fill_manual(values = BIV, na.value = "grey90", guide = "none") +
      labs(title = paste0(cty, ": ", nm)) + theme_map
    mp / dist_bar(2026, setNames(list(PLANS[[nm]]), nm), keep = tar_sf$city_name %in% cty) +
      plot_layout(heights = c(1, 0.32))
  }
  city_grid <- unlist(lapply(CITY_SHOW, \(cty) lapply(names(PLANS), \(nm) wrap_elements(full = city_panel(cty, nm)))),
                      recursive = FALSE)
  wrap_plots(city_grid, ncol = length(PLANS), byrow = TRUE) +
    plot_annotation(title = "The two largest cities under each plan", theme = theme(plot.title = element_text(face = "bold")))
  
  # 7i. How often sampled plans split each city, and which reference plans split it (cities with 2+ VTDs)
  city_freq <- tibble(city = names(city_split_n), freq = as.numeric(city_split_n) / n_plans) |>
    left_join(tibble(city = cgrp) |> count(city, name = "vtds"), by = "city") |>
    left_join(split_by, by = "city") |>
    filter(vtds >= 2)
  ggplot(city_freq, aes(freq, fct_reorder(city, freq))) +
    geom_col(aes(fill = !is.na(by)), width = 0.7) +
    geom_text(aes(label = replace_na(by, "")), hjust = -0.05, size = 2.8) +
    scale_fill_manual(values = c(`TRUE` = "grey45", `FALSE` = "grey78"), guide = "none") +
    scale_x_continuous(labels = pct, expand = expansion(mult = c(0, 0.35))) +
    labs(x = "Sampled plans splitting the city", y = NULL, title = "City splits",
         subtitle = "Labels: reference plans that split the city") +
    theme_cc + theme(panel.grid.major.y = element_blank(), panel.grid.major.x = element_line(colour = "grey90"))
  
  # ---- 8. Interactive map: every plan with its precinct shares, toggleable boundaries and 2026 results ----
  ideal <- sum(tar_sf$pop) / 4
  LY <- lapply(split(plan_ln, plan_ln$plan), \(x) x |>
                 mutate(dist = as.character(district),
                        tip  = sprintf("%s Pct %s<br>Pop %s (%+.1f%%)<br>D %.1f%% composite | %.1f%% 2026<br>Nonwhite VAP %.1f%%",
                                       plan, dist, format(pop, big.mark = ","), 100 * (pop / ideal - 1),
                                       100 * dem, 100 * sen26, 100 * nonwhite_vap),
                        lab  = sprintf("%s\nD %.0f | '26 %.0f", dist, 100 * dem, 100 * sen26)) |>
                 st_transform(4326))
  pc_ll <- pc26 |> st_transform(4326) |>
    mutate(sen_tip = sprintf("Pct %s<br>Senate D %s R %s<br>D %.1f%%", PCT, SEN_D, SEN_R, 100 * SEN_2P),
           cc_tip  = sprintf("Pct %s | Commissioner Pct %s<br>D %s R %s<br>D %.1f%%", PCT, CC_PCT, CC_D, CC_R, 100 * CC_2P))
  # red-white-blue around 50%, stretched to the spread of the layer's own values
  ramp <- function(col, x) {
    r <- max(abs(quantile(x - 0.5, c(0.02, 0.98), na.rm = TRUE)))
    interpolate(column = col, values = 0.5 + c(-r, 0, r), stops = c(REP, "#f7f7f7", DEM))
  }
  SHOW <- if ("R-pack" %in% names(LY)) "R-pack" else names(LY)[1]             # plan whose fill and labels start switched on
  m <- maplibre(style = "https://tiles.openfreemap.org/styles/positron", bounds = LY[[1]]) |>
    add_fill_layer(id = "2026 Senate", source = pc_ll, fill_opacity = 0.7, tooltip = "sen_tip",
                   visibility = "none", fill_color = ramp("SEN_2P", pc_ll$SEN_2P)) |>
    add_fill_layer(id = "2026 Commissioner", source = filter(pc_ll, CC_PCT > 0), fill_opacity = 0.7, tooltip = "cc_tip",
                   visibility = "none", fill_color = ramp("CC_2P", pc_ll$CC_2P[pc_ll$CC_PCT > 0]))
  for (nm in names(LY)) {
    on <- if (nm == SHOW) "visible" else "none"
    m <- m |>
      add_fill_layer(id = paste(nm, "precincts"), source = LY[[nm]], fill_opacity = 0.35, tooltip = "tip",
                     visibility = on, fill_color = match_expr("dist", values = names(DCOL), stops = unname(DCOL))) |>
      add_line_layer(id = paste(nm, "lines"), source = LY[[nm]], line_color = PCOL[[nm]], line_width = 2.5,
                     visibility = "visible") |>
      add_symbol_layer(id = paste(nm, "shares"), source = suppressWarnings(st_point_on_surface(LY[[nm]])),
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