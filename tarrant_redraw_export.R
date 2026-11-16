# SCRIPT: tarrant_redraw_export.R
# Writes the TarrantRedraw app's data files into a local clone of github.com/Bryvado/TarrantRedraw,
# copies in the two pipeline scripts, then commits and pushes.
# Self-starting: it runs the data-building part of tarrant_cc_redist_map7.R first (checkpoints only,
# no charts or maps), so it works from a fresh R session.
#
# Before sourcing, in the CONSOLE only (never in this file, which is pushed to a public repo):
#   Sys.setenv(GITHUB_PAT = "github_pat_...")

library(tidyverse)
library(sf)
library(tigris)
library(tidycensus)
library(jsonlite)
library(rmapshaper)
library(gert)

MAIN      <- "//apporto.com/dfs/GWU/Users/brysonkloesel_gwu/Documents/TarrantRedistricting/tarrant_cc_redist_map7.R"
REPO_URL  <- "https://github.com/Bryvado/TarrantRedraw.git"
REPO      <- file.path(Sys.getenv("USERPROFILE"), "TarrantRedraw")   # local disk: libgit2 can't open repos on the network share
OUT       <- file.path(REPO, "data")
GIT_NAME  <- "Bryvado"
GIT_EMAIL <- "166976989+Bryvado@users.noreply.github.com"

# ---- 0. Build the pipeline objects (main script, top through the R-pack plan) ----
NEED_OBJ <- c("tar_sf", "cc_pack", "map7_sf", "cities", "comms", "DIR")
if (!all(sapply(NEED_OBJ, exists))) {
  stopifnot(file.exists(MAIN))
  src  <- readLines(MAIN)
  stop_at <- grep("^stopifnot\\(length\\(cc_pack\\)", src)
  stopifnot(length(stop_at) == 1)
  eval(parse(text = src[1:stop_at]), envir = globalenv())
}
stopifnot(all(sapply(NEED_OBJ, exists)))

# ---- 0b. Local clone ----
if (!dir.exists(file.path(REPO, ".git"))) git_clone(REPO_URL, REPO)
stopifnot(dir.exists(file.path(REPO, ".git")))
dir.create(file.path(OUT, "blocks"), recursive = TRUE, showWarnings = FALSE)

wr <- function(x, f) {
  f <- file.path(OUT, f)
  if (file.exists(f)) file.remove(f)
  st_write(st_transform(x, 4326), f, quiet = TRUE, layer_options = "COORDINATE_PRECISION=6")
}
slim <- function(x, keep) ms_simplify(x, keep = keep, keep_shapes = TRUE)   # keeps shared borders aligned

# ---- 1. VTDs: geometry + everything the analytics panel needs ----
vtd_out <- tar_sf |>
  select(vtdkey, pop, vap, vap_white, vap_black, vap_hisp, ndv, nrv, dshare, dshare_pre,
         ndv26, nrv26, share26, shift26, city_name, comm_raw) |>
  mutate(across(where(is.double), \(x) round(x, 4)))
wr(slim(vtd_out, 0.3), "vtd.geojson")

# ---- 2. Adjacency, shared border lengths, perimeters, areas (feet, EPSG:2276) ----
f_adj <- file.path(DIR, "tarrant_vtd_adj.rds")
if (file.exists(f_adj)) adj <- readRDS(f_adj) else {
  v   <- tar_sf |> st_transform(2276) |> select(vtdkey)
  b   <- st_boundary(st_geometry(v))
  rel <- st_relate(v, v, pattern = "F***1****")                 # neighbours sharing a border segment
  edges <- tibble(i = rep(seq_along(rel), lengths(rel)), j = unlist(rel)) |> filter(i < j)
  edges$len <- map2_dbl(edges$i, edges$j, \(i, j) sum(as.numeric(st_length(st_intersection(b[i], b[j])))))
  adj <- list(
    units = tibble(vtdkey = v$vtdkey, area = as.numeric(st_area(v)), perim = as.numeric(st_length(b))),
    edges = tibble(a = v$vtdkey[edges$i], b = v$vtdkey[edges$j], len = round(edges$len, 1)))
  saveRDS(adj, f_adj)
}
write_json(adj, file.path(OUT, "vtd_adj.json"), dataframe = "columns", digits = 8)

# ---- 3. Reference plans: Map 7 and R-pack (pre-2025 if you have it) ----
plan_tab <- tibble(vtdkey = tar_sf$vtdkey, map7 = tar_sf$cc_map7, rpack = cc_pack)
if (!anyNA(tar_sf$cc_pre2025)) plan_tab$pre2025 <- tar_sf$cc_pre2025
write_csv(plan_tab, file.path(OUT, "plans.csv"))

# ---- 4. Overlays ----
wr(slim(select(cities, city, type, split_tier), 0.2), "cities.geojson")
wr(slim(select(comms, comm_id, name, city, source), 0.5), "communities.geojson")
wr(select(map7_sf, PRECINCT), "map7.geojson")

# ---- 5. Blocks ----
f_blk <- file.path(DIR, "tarrant_blocks_pl.rds")
if (file.exists(f_blk)) blk <- readRDS(f_blk) else {
  geo <- blocks("TX", "Tarrant", year = 2020) |>
    select(GEOID20, pop = POP20, lat = INTPTLAT20, lon = INTPTLON20)
  pl  <- get_decennial("block", state = "TX", county = "Tarrant", year = 2020, sumfile = "pl", output = "wide",
                       variables = c(vap = "P3_001N", vap_hisp = "P4_002N",
                                     vap_white = "P4_005N", vap_black = "P4_006N"))
  blk <- geo |> left_join(select(pl, GEOID20 = GEOID, starts_with("vap")), by = "GEOID20")
  saveRDS(blk, f_blk)
}
v2276 <- tar_sf |> st_transform(2276) |> select(vtdkey)
pts <- blk |> st_drop_geometry() |>
  mutate(lat = as.numeric(lat), lon = as.numeric(lon)) |>
  st_as_sf(coords = c("lon", "lat"), crs = 4269) |> st_transform(2276)
blk$vtdkey <- v2276$vtdkey[st_nearest_feature(pts, v2276)]
blk$pop    <- as.numeric(blk$pop)

# 5a. Block-to-VTD lookup: this alone lets the app turn any VTD plan into a DRA block file
blk |> st_drop_geometry() |> select(GEOID20, vtdkey, pop) |> arrange(GEOID20) |>
  write_csv(file.path(OUT, "block_vtd.csv"))
chk <- blk |> st_drop_geometry() |> count(vtdkey, wt = pop, name = "blk_pop") |>
  full_join(st_drop_geometry(tar_sf) |> select(vtdkey, pop), by = "vtdkey")
cat("Blocks:", nrow(blk), "| VTDs whose block population differs from TLC:",
    sum(replace_na(chk$blk_pop, 0) != chk$pop), "of", nrow(chk), "\n")

# 5b. Block geometry, one file per VTD, for the optional split-a-VTD mode.
#     Votes are the VTD's votes spread by voting-age population: ESTIMATES, not counts.
vv <- tar_sf |> st_drop_geometry() |> select(vtdkey, v_ndv = ndv, v_nrv = nrv, v_ndv26 = ndv26, v_nrv26 = nrv26)
blk_out <- blk |>
  select(-any_of(c("lat", "lon"))) |>
  left_join(vv, by = "vtdkey") |>
  group_by(vtdkey) |>
  mutate(wt = if (sum(vap, na.rm = TRUE) > 0) vap / sum(vap, na.rm = TRUE) else 1 / n()) |>
  ungroup() |>
  transmute(GEOID20, vtdkey, pop, vap, vap_white, vap_black, vap_hisp,
            ndv = round(wt * v_ndv, 2), nrv = round(wt * v_nrv, 2),
            ndv26 = round(wt * v_ndv26, 2), nrv26 = round(wt * v_nrv26, 2))
walk(split(blk_out, blk_out$vtdkey), \(d) wr(d, file.path("blocks", paste0(d$vtdkey[1], ".geojson"))))

# ---- 6. What was written ----
fs <- list.files(OUT, recursive = TRUE, full.names = TRUE)
is_blk <- str_detect(fs, "[/\\\\]blocks[/\\\\]")
tibble(file = basename(fs[!is_blk]), mb = round(file.size(fs[!is_blk]) / 1e6, 2)) |> print()
cat("Block files:", sum(is_blk), "| total MB:", round(sum(file.size(fs[is_blk])) / 1e6, 1), "\n")

# ---- 7. Copy the two scripts in, then commit and push ----
extras <- c(MAIN, file.path(dirname(MAIN), "tarrant_redraw_export.R"))
for (f in extras[file.exists(extras)]) file.copy(f, REPO, overwrite = TRUE)
if (any(!file.exists(extras))) cat("Not found, copy by hand:", basename(extras[!file.exists(extras)]), "\n")

# identity is stored in the repo itself: the global git config sits on the network share, where gert can't read it
stopifnot(!grepl("YOUR_ID", GIT_EMAIL))
git_config_set("user.name",  GIT_NAME,  repo = REPO)
git_config_set("user.email", GIT_EMAIL, repo = REPO)

git_add(".", repo = REPO)
if (nrow(git_status(repo = REPO))) git_commit("Add app data and pipeline scripts", repo = REPO)

stopifnot(nzchar(Sys.getenv("GITHUB_PAT")))
git_push(remote = "origin", set_upstream = TRUE, password = Sys.getenv("GITHUB_PAT"), repo = REPO)
git_log(repo = REPO, max = 3)