# SCRIPT: tarrant_cc_planscore.R
# PlanScore-style partisan analysis of every plan in PLANS (set in tarrant_cc_redist_map7.R, section 4d),
# with 2026 data in the baseline. Runs the data-building part of that script first, then reads the cached SMC batches.
# Everything downloaded is kept in DIR/cache, so only the first run touches the network.
# Sign convention everywhere: positive favors Democrats.

library(tidyverse)
library(sf)
library(patchwork)
options(tigris_use_cache = TRUE)

MAIN <- "//apporto.com/dfs/GWU/Users/brysonkloesel_gwu/Documents/TarrantRedistricting/tarrant_cc_redist_map7.R"
if (!all(sapply(c("tar_sf", "PLANS", "PCOL", "contest_long", "DIR", "N_PER_RUN", "URLS", "low"), exists))) {
  src <- readLines(MAIN, warn = FALSE)
  eval(parse(text = src[1:grep("^# ==== END DATA BUILD", src)]), envir = globalenv())
}
DEM <- "#2166ac"; REP <- "#b2182b"
# PLANS and PCOL come from the main script (section 4d), so every script compares the same plans
N_SIM <- 10000
CACHE <- file.path(DIR, "cache")
dir.create(CACHE, showWarnings = FALSE)

# ---- 0. Downloads, each fetched once and kept ----
# 0a. TLC statewide election returns: keep the zip itself, and the Tarrant rows parsed from it
f_zip  <- file.path(CACHE, "tlc_2024_general_vtds_election_data.zip")
f_hist <- file.path(CACHE, "tarrant_returns_2012_2024.rds")
if (file.exists(f_hist)) hst <- readRDS(f_hist) else {
  if (!file.exists(f_zip)) { options(timeout = 1200); download.file(URLS["elec"], f_zip, mode = "wb") }
  d <- tempfile(); unzip(f_zip, exdir = d)
  fs <- list.files(d, "General_Election_Returns", full.names = TRUE, recursive = TRUE)
  hst <- map_dfr(fs, function(f) {
    x   <- read_csv(f, col_types = cols(.default = col_character())) |> low()   # no type guessing: one file reads party as logical
    key <- intersect(c("vtdkey", "vtdkeyvalue"), names(x))[1]
    x |> rename(vtdkey = all_of(key)) |>
      mutate(vtdkey = as.numeric(vtdkey), votes = as.numeric(votes)) |>
      filter(vtdkey %in% tar_sf$vtdkey, party %in% c("D", "R"),
             str_detect(office, "^(President|U\\.S\\. Sen|Governor)$")) |>
      group_by(vtdkey, year = as.integer(str_extract(basename(f), "\\d{4}")), office, party) |>
      summarise(votes = sum(votes), .groups = "drop")
  }) |> pivot_wider(names_from = party, values_from = votes, values_fill = 0)
  stopifnot(n_distinct(hst$year) == 7)
  unlink(d, recursive = TRUE)
  saveRDS(hst, f_hist)
}

# 0b. 2010 Census blocks: internal points and voting-age counts, kept as pulled
f_b10 <- file.path(CACHE, "tarrant_blocks2010_points.rds")
f_p10 <- file.path(CACHE, "tarrant_blocks2010_vap_sf1.rds")
if (file.exists(f_b10)) b10 <- readRDS(f_b10) else {
  b10 <- tigris::blocks("TX", "Tarrant", year = 2010) |> st_drop_geometry() |>
    transmute(GEOID = GEOID10, lon = as.numeric(INTPTLON10), lat = as.numeric(INTPTLAT10))
  saveRDS(b10, f_b10)
}
if (file.exists(f_p10)) p10 <- readRDS(f_p10) else {
  p10 <- tidycensus::get_decennial("block", state = "TX", county = "Tarrant", year = 2010, sumfile = "sf1",
                                   output = "wide", variables = c(vap = "P011001", vap_hisp = "P011002",
                                                                  vap_white = "P011005", vap_black = "P011006")) |>
    select(GEOID, starts_with("vap"))
  saveRDS(p10, f_p10)
}

# ---- 1. Metrics from a 4 x n matrix of precinct Democratic shares (one column per plan or election) ----
ps_metrics <- function(m) {
  tot <- colSums(m); V <- tot / 4; S <- colSums(m > 0.5)
  mx  <- pmax(m[1, ], m[2, ], m[3, ], m[4, ]); mn <- pmin(m[1, ], m[2, ], m[3, ], m[4, ])
  wD  <- colSums(m * (m > 0.5)) / pmax(S, 1)                 # average winning share, D precincts
  wR  <- colSums((1 - m) * (m <= 0.5)) / pmax(4 - S, 1)      # average winning share, R precincts
  tibble(seats = S, votes = V,
         eff_gap  = (S / 4 - 0.5) - 2 * (V - 0.5),           # equal-turnout efficiency gap
         mean_med = (tot - mx - mn) / 2 - V,                 # median minus mean
         bias     = colSums(m - rep(V - 0.5, each = 4) > 0.5) / 4 - 0.5,   # seat share at a 50-50 vote
         lopsided = if_else(S %in% 1:3, wR - wD, NA_real_))  # R wins bigger than D wins = D spread efficiently
}

# ---- 2. Each plan in each election ----
votes <- bind_rows(
  contest_long |> transmute(vtdkey, election = paste(year, recode(office, USSen = "Senate")), D, R),
  tar_sf |> st_drop_geometry() |> transmute(vtdkey, election = "Composite", D = ndv, R = nrv),
  tar_sf |> st_drop_geometry() |> transmute(vtdkey, election = "2026 avg", D = ndv26, R = nrv26))
ELEC <- unique(votes$election)

dist_share <- imap_dfr(PLANS, \(a, nm) votes |>
                         mutate(dist = a[match(vtdkey, tar_sf$vtdkey)]) |>
                         group_by(plan = nm, election, dist) |> summarise(d = sum(D) / sum(D + R), .groups = "drop"))

plan_tab <- dist_share |> arrange(plan, election, dist) |>
  group_by(plan, election) |>
  group_modify(\(x, k) ps_metrics(matrix(x$d, nrow = 4))) |> ungroup() |>
  mutate(plan = factor(plan, levels = names(PLANS)), election = factor(election, levels = ELEC)) |>
  arrange(plan, election)

# ---- 3. The same metrics on every sampled plan (kept: reading 20 batch files is the slow local step) ----
SWING <- seq(-0.15, 0.15, by = 0.005)
f_ens <- file.path(CACHE, sprintf("ps_ens_%s_%d_%d.rds", ENS_TAG, N_PER_RUN, N_RUNS))
if (file.exists(f_ens)) ens <- readRDS(f_ens) else {
  BDIR <- file.path(DIR, sprintf("smc_batches_%s_%d", ENS_TAG, N_PER_RUN))
  parts <- lapply(seq_len(N_RUNS), \(b) {
    d  <- readRDS(file.path(BDIR, sprintf("batch_%04d.rds", b)))$dist
    mc <- matrix(d$dem, nrow = 4); m26 <- matrix(d$sen26, nrow = 4)
    list(met = bind_rows(mutate(ps_metrics(mc), election = "Composite"),
                         mutate(ps_metrics(m26), election = "2026 avg")),
         sv  = tibble(swing = SWING, seats = map_dbl(SWING, \(s) mean(colSums(mc + s > 0.5)))))
  })
  ens <- list(met = bind_rows(lapply(parts, `[[`, "met")),
              sv  = bind_rows(lapply(parts, `[[`, "sv")) |> group_by(swing) |> summarise(seats = mean(seats)))
  saveRDS(ens, f_ens)
}

# where each plan falls among neutral plans: share of sampled plans LESS favorable to Democrats, ties count half
MET <- c("seats", "eff_gap", "mean_med", "bias", "lopsided")
pct_rank <- function(x, v) mean(x < v, na.rm = TRUE) + 0.5 * mean(x == v, na.rm = TRUE)
pctile <- plan_tab |> filter(election %in% c("Composite", "2026 avg")) |>
  pivot_longer(all_of(MET), names_to = "metric") |>
  rowwise() |>
  mutate(ens_median = median(ens$met[[metric]][ens$met$election == election], na.rm = TRUE),
         pct_below  = pct_rank(ens$met[[metric]][ens$met$election == election], value)) |>
  ungroup() |> select(plan, election, metric, value, ens_median, pct_below)

# ---- 4. Wave simulations: turnout and vote share by VTD, 2012-2026 ----
# one row per VTD and cycle: contests averaged within the cycle
vy <- bind_rows(filter(hst, year < 2026),
                contest_long |> filter(year == 2026) |> select(vtdkey, year, office, D, R)) |>
  complete(vtdkey = tar_sf$vtdkey, nesting(year, office), fill = list(D = 0, R = 0)) |>
  group_by(vtdkey, year) |> summarise(D = mean(D), R = mean(R), .groups = "drop") |>
  mutate(tot = D + R) |> arrange(year, vtdkey)
YRS <- sort(unique(vy$year))
stopifnot(length(YRS) == 8)

# county environment: trend plus wave (the cycle's departure from trend), on the logit scale
env <- vy |> group_by(year) |> summarise(lc = qlogis(sum(D) / sum(tot)), T = sum(tot)) |>
  mutate(tt = (year - 2026) / 4, mid = as.numeric(year %% 4 == 2))
fit_env  <- lm(lc ~ tt, env)
env$wave <- resid(fit_env)
c0       <- unname(coef(fit_env)[1])                       # trend value at 2026
se0      <- summary(fit_env)$coefficients[1, 2]            # how unsure the trend is about 2026 itself
sd_wave  <- sd(env$wave)
yr_cty   <- env |> transmute(year, cty = plogis(lc))

# 2010 voting-age population moved onto the 2024 VTDs through block points (rebuilt from cache each run)
pts10 <- inner_join(b10, p10, by = "GEOID") |> st_as_sf(coords = c("lon", "lat"), crs = 4269) |> st_transform(2276)
v2276 <- tar_sf |> st_transform(2276) |> select(vtdkey)
pts10$vtdkey <- v2276$vtdkey[st_nearest_feature(pts10, v2276)]
d10 <- pts10 |> st_drop_geometry() |> group_by(vtdkey) |> summarise(across(starts_with("vap"), sum))

# VTD x cycle matrices (rows follow tar_sf)
wide <- function(col) matrix(vy[[col]], nrow = nrow(tar_sf), dimnames = list(unique(vy$vtdkey), YRS))[as.character(tar_sf$vtdkey), ]
Dm <- wide("D"); Tm <- wide("tot")

# each group's voting-age population in every cycle: straight line 2010 to 2020, then half that pace to 2026
dem_at <- function(col) {
  v10 <- replace_na(d10[[col]][match(tar_sf$vtdkey, d10$vtdkey)], 0); v20 <- tar_sf[[col]]
  sapply(YRS, \(y) pmax(0, if (y <= 2020) v10 + (v20 - v10) * (y - 2010) / 10 else v20 + 0.5 * (v20 - v10) * (y - 2020) / 10))
}
VAP <- dem_at("vap"); HI <- dem_at("vap_hisp"); WH <- dem_at("vap_white"); BL <- dem_at("vap_black")

ok <- apply(Tm, 1, min) >= 25 & apply(VAP, 1, min) >= 50
Ys <- qlogis(pmin(pmax(Dm[ok, ] / Tm[ok, ], 0.01), 0.99))            # vote share
Yt <- log(pmin(Tm[ok, ] / VAP[ok, ], 1.5))                           # turnout rate: votes per voting-age resident
sh   <- function(M) pmin(M[ok, ] / VAP[ok, ], 1)
lean <- rowMeans(Ys) - mean(rowMeans(Ys))
XA <- list(one = matrix(1, sum(ok), 8), h = sh(HI), bl = sh(BL),
           o = pmax(1 - sh(WH) - sh(HI) - sh(BL), 0), lean = matrix(lean, sum(ok), 8))   # composition by cycle
stopifnot(all(sapply(XA, \(M) identical(dim(M), c(sum(ok), 8L)))))
x26 <- sapply(XA, \(M) M[, 8])                                       # composition in 2026
cov <- as_tibble(x26[, c("h", "bl", "o")])
wv  <- rowMeans(Tm[ok, ])

# cycle terms: midterm, Democratic wave, Republican wave. Each VTD keeps its own level and trend.
Z  <- cbind(mid = env$mid, wpos = pmax(env$wave, 0), wneg = pmin(env$wave, 0))
H  <- cbind(1, env$tt)
PH <- H %*% solve(crossprod(H)) %*% t(H)
MR <- diag(8) - PH
by_cycle <- function(M, z) M * rep(Z[, z], each = nrow(M))           # multiply each cycle's column by its term
fit_wave <- function(Y) {
  cols <- expand_grid(z = 1:3, k = seq_along(XA))
  X  <- sapply(seq_len(nrow(cols)), \(j) as.vector(by_cycle(XA[[cols$k[j]]], cols$z[j]) %*% MR))
  B  <- matrix(lm.wfit(X, as.vector(Y %*% MR), rep(wv, 8))$coefficients, nrow = length(XA))
  Ey <- lapply(1:3, \(z) Reduce(`+`, lapply(seq_along(XA), \(k) XA[[k]] * B[k, z])))
  R0 <- Y - Reduce(`+`, lapply(1:3, \(z) by_cycle(Ey[[z]], z)))
  ab <- R0 %*% H %*% solve(crossprod(H))                             # VTD level at 2026 and trend
  list(a = ab[, 1], E = x26 %*% B, sig = sd(R0 - ab %*% t(H)) * sqrt(8 / 6))
}
ms <- fit_wave(Ys); mt <- fit_wave(Yt)

# what a one-SD wave does to different kinds of VTDs (share in points, turnout rate in percent)
grp <- with(cov, case_when(h >= 0.5 ~ "Hispanic majority", bl >= 0.4 ~ "Black 40%+",
                           h + bl + o < 0.3 ~ "White 70%+", TRUE ~ "Mixed"))
wave_effect <- tibble(grp, w = wv,
                      share_D_wave   = plogis(ms$a + ms$E[, 2] * sd_wave) - plogis(ms$a),
                      share_R_wave   = plogis(ms$a - ms$E[, 3] * sd_wave) - plogis(ms$a),
                      turnout_D_wave = exp(mt$E[, 2] * sd_wave) - 1, turnout_R_wave = exp(-mt$E[, 3] * sd_wave) - 1,
                      turnout_midterm = exp(mt$E[, 1]) - 1) |>
  group_by(grp) |> summarise(vtds = n(), across(-c(w, vtds), \(x) round(100 * weighted.mean(x, w), 1)))

# simulate: year type, wave, and how far the true 2026 centre sits from the trend
set.seed(439)
mid_s <- rbinom(N_SIM, 1, 0.5)
w_s   <- rnorm(N_SIM, 0, sd_wave)
lvl_s <- rnorm(N_SIM, 0, se0)
lin <- function(m) m$a + outer(m$E[, 1], mid_s) + outer(m$E[, 2], pmax(w_s, 0)) + outer(m$E[, 3], pmin(w_s, 0)) +
  rnorm(sum(ok) * N_SIM, 0, m$sig)
W  <- exp(lin(mt)) * VAP[ok, 8]                                      # turnout rate x 2026 voting-age population
Dv <- W * plogis(lin(ms) + rep(lvl_s, each = sum(ok)))

# VTDs without a full 2012-26 record: their 2026 result set to a neutral year, then moved with the county
ex   <- !ok & Tm[, 8] > 0
a_ex <- qlogis(pmin(pmax(Dm[ex, 8] / Tm[ex, 8], 0.01), 0.99)) - env$wave[8]
W_ex <- outer(Tm[ex, 8], colSums(W) / sum(Tm[ok, 8]))
D_ex <- W_ex * plogis(outer(a_ex, w_s + lvl_s, `+`))
W <- rbind(W, W_ex); Dv <- rbind(Dv, D_ex)
sim_ix <- c(which(ok), which(ex))                                    # tar_sf rows, in the order of W's rows

kind  <- cut(w_s / sd_wave, c(-Inf, -0.5, 0.5, Inf), labels = c("R wave", "Neutral", "D wave"))
type  <- if_else(mid_s == 1, "Midterm", "Presidential")
cty_s <- colSums(Dv) / colSums(W)

sim_plan <- imap(PLANS, \(a, nm) {
  Dd <- rowsum(Dv, a[sim_ix]); Td <- rowsum(W, a[sim_ix]); Rd <- Td - Dd; win <- Dd > Rd
  wasteD <- Dd - win * Td / 2                                        # winners waste votes past half, losers waste all
  wasteR <- Rd - (!win) * Td / 2
  list(share = Dd / Td, seats = colSums(win), eg = (colSums(wasteR) - colSums(wasteD)) / colSums(Td))
})
comp_d   <- dist_share |> filter(election == "Composite") |> select(plan, dist, composite = d)
win_wave <- imap_dfr(sim_plan, \(x, nm) map_dfr(levels(kind), \(k)
                                                tibble(plan = nm, dist = 1:4, kind = factor(k, levels = levels(kind)), p_dem = rowMeans(x$share[, kind == k] > 0.5))))
win_prob <- imap_dfr(sim_plan, \(x, nm) tibble(plan = nm, dist = 1:4, p_dem = rowMeans(x$share > 0.5))) |>
  left_join(comp_d, by = c("plan", "dist"))
sim_sum <- imap_dfr(sim_plan, \(x, nm) tibble(
  plan = nm, exp_seats = mean(x$seats), p_3plus = mean(x$seats >= 3), p_2 = mean(x$seats == 2),
  p_1_or_0 = mean(x$seats <= 1), eff_gap = mean(x$eg), eg_lo = quantile(x$eg, 0.05),
  eg_hi = quantile(x$eg, 0.95), p_eg_favors_D = mean(x$eg > 0)))
sim_tab <- imap_dfr(sim_plan, \(x, nm) tibble(plan = nm, kind, type, cty = cty_s, seats = x$seats, eg = x$eg)) |>
  group_by(plan, kind, type) |>
  summarise(sims = n(), county_D = round(100 * mean(cty), 1), exp_seats = round(mean(seats), 2),
            p_3plus = round(100 * mean(seats >= 3), 1), eff_gap = round(100 * mean(eg), 1), .groups = "drop")
seat_dist <- imap_dfr(sim_plan, \(x, nm) tibble(plan = nm, kind, seats = x$seats)) |>
  count(plan, kind, seats) |> group_by(plan, kind) |> mutate(p = n / sum(n)) |> ungroup()
fac_plan <- \(x) mutate(x, plan = factor(plan, levels = names(PLANS)))
win_wave <- fac_plan(win_wave); win_prob <- fac_plan(win_prob); sim_sum <- fac_plan(sim_sum); seat_dist <- fac_plan(seat_dist)

# ---- 5. Plots ----
pct <- scales::label_percent(accuracy = 1)
th  <- theme_minimal(base_size = 11) +
  theme(panel.grid.minor = element_blank(), plot.title = element_text(face = "bold"),
        plot.title.position = "plot", strip.text = element_text(face = "bold"), legend.position = "top",
        legend.justification = "left")

# 5a. Where each plan sits among sampled plans, every metric on one 0-100 scale
MLAB <- c(seats = "D precincts", eff_gap = "Efficiency gap", mean_med = "Mean-median",
          bias = "Bias at 50-50", lopsided = "Lopsided wins")
OFF  <- setNames(seq(0.2, -0.2, length.out = length(PLANS)), names(PLANS))
strip <- pctile |> filter(!is.na(value)) |>
  mutate(y   = match(metric, rev(names(MLAB))) + unname(OFF[as.character(plan)]),
         lab = if_else(metric == "seats", sprintf("%.0f", value), sprintf("%+.0f", 100 * value)),
         election = factor(election, levels = c("Composite", "2026 avg"), labels = c("2020-26 composite", "2026")))
p_rank <- ggplot(strip, aes(pct_below, y, colour = plan)) +
  annotate("rect", xmin = 0.05, xmax = 0.95, ymin = -Inf, ymax = Inf, fill = "grey93") +
  geom_vline(xintercept = 0.5, colour = "white", linewidth = 1) +
  geom_point(size = 3.5) +
  geom_text(aes(label = lab, hjust = if_else(pct_below > 0.85, 1.9, -0.9)), size = 2.8, show.legend = FALSE) +
  facet_wrap(~election) +
  scale_colour_manual(values = PCOL, name = NULL) +
  scale_x_continuous(limits = c(0, 1), breaks = c(0, 0.5, 1), labels = c("Favors R", "Typical", "Favors D")) +
  scale_y_continuous(breaks = seq_along(MLAB), labels = rev(MLAB), limits = c(0.5, length(MLAB) + 0.5)) +
  labs(x = NULL, y = NULL, subtitle = "Grey: middle 90%",
       title = sprintf("Rank among %s sampled plans", format(nrow(ens$met) / 2, big.mark = ",", scientific = FALSE))) +
  th + theme(panel.grid.major.x = element_blank())

# 5b. Seats by countywide vote under uniform swing, election years marked once
cty_comp <- with(st_drop_geometry(tar_sf), sum(ndv) / sum(ndv + nrv))
sv_plan <- imap_dfr(PLANS, \(a, nm) {
  base <- dist_share |> filter(plan == nm, election == "Composite") |> pull(d)
  tibble(plan = nm, votes = cty_comp + SWING, seats = map_dbl(SWING, \(s) sum(base + s > 0.5)))
}) |> fac_plan()
p_sv <- ggplot(sv_plan, aes(votes, seats)) +
  geom_vline(data = yr_cty, aes(xintercept = cty), colour = "grey70", linetype = 3) +
  geom_text(data = yr_cty, aes(cty, 4.35, label = year), size = 2.8, colour = "grey35", angle = 90, hjust = 0.5) +
  geom_line(data = ens$sv, aes(cty_comp + swing, seats), colour = "grey60", linewidth = 1.4) +
  geom_step(aes(colour = plan), linewidth = 1.1, direction = "hv") +
  geom_vline(xintercept = 0.5, linetype = 2, colour = "grey40") +
  scale_colour_manual(values = PCOL, name = NULL) +
  scale_x_continuous(labels = pct) + scale_y_continuous(breaks = 0:4, limits = c(0, 4.6)) +
  labs(x = "Countywide Dem. share", y = "D precincts of 4",
       title = "Seats by vote share", subtitle = "Grey: average sampled plan") + th

# 5c. Chance each precinct goes Democratic, drawn on each plan's own map
pl_geo <- do.call(rbind, lapply(names(PLANS), \(nm)
                                tar_sf |> st_transform(2276) |> select(vtdkey) |> mutate(dist = as.integer(PLANS[[nm]])) |>
                                  group_by(dist) |> summarise(.groups = "drop") |> mutate(plan = factor(nm, levels = names(PLANS)))))
fill_win <- scale_fill_gradient2(low = REP, mid = "#f7f7f7", high = DEM, midpoint = 0.5, limits = c(0, 1),
                                 labels = pct, name = "Chance of a Democratic win")
th_map <- theme_void(base_size = 11) +
  theme(plot.title = element_text(face = "bold"), strip.text = element_text(face = "bold"),
        legend.position = "bottom", legend.key.width = unit(1.2, "cm"))
win_lab <- win_prob |> left_join(select(sim_sum, plan, exp_seats), by = "plan") |>
  mutate(panel = fct_reorder(factor(sprintf("%s: %.1f D expected", plan, exp_seats)), as.integer(plan)))
p_win <- ggplot(left_join(pl_geo, win_lab, by = c("plan", "dist"))) +
  geom_sf(aes(fill = p_dem), colour = "black", linewidth = 0.6) +
  geom_sf_label(aes(label = sprintf("Pct %d\n%s", dist, pct(p_dem))), size = 3, fontface = "bold",
                fill = "white", colour = "grey10", lineheight = 0.9) +
  facet_wrap(~panel, nrow = 1) + fill_win +
  labs(title = "Chance of a Democratic win") + th_map

# 5d. Seats by kind of year
p_seats <- ggplot(seat_dist, aes(p, fct_rev(kind), fill = factor(seats, levels = 0:4))) +
  geom_col(width = 0.7) +
  geom_text(aes(label = if_else(p >= 0.08, as.character(seats), "")), position = position_stack(vjust = 0.5),
            colour = "white", fontface = "bold", size = 3.4) +
  facet_wrap(~plan) +
  scale_fill_manual(values = c("0" = "#67001f", "1" = REP, "2" = "grey60", "3" = DEM, "4" = "#053061"), guide = "none") +
  scale_x_continuous(labels = pct) +
  labs(x = "Simulated elections", y = NULL, title = "D precincts won, by kind of year") +
  th + theme(panel.grid = element_blank())

# 5e. The same chance by kind of year: rows are years, columns are plans
p_wave <- ggplot(left_join(pl_geo, win_wave, by = c("plan", "dist"))) +
  geom_sf(aes(fill = p_dem), colour = "black", linewidth = 0.5) +
  geom_sf_label(aes(label = pct(p_dem)), size = 2.8, fontface = "bold", fill = "white", colour = "grey10") +
  facet_grid(kind ~ plan, switch = "y") + fill_win +
  labs(title = "Chance of a Democratic win, by kind of year") + th_map

# ---- 6. Output, all together ----
cat("\nCounty VAP 2010:", format(sum(d10$vap), big.mark = ","), "| 2020:", format(sum(tar_sf$vap), big.mark = ","),
    "| VTDs modelled:", sum(ok), "of", length(ok), "| added from 2026 only:", sum(ex),
    "| share of 2026 votes modelled:", round(100 * sum(Tm[ok, 8]) / sum(Tm[, 8]), 1), "%\n")
cat(sprintf("2026 trend centre: %.1f%% (90%% range %.1f to %.1f) | simulated mean: %.1f%% | one-SD wave: about %.1f pts\n\n",
            100 * plogis(c0), 100 * plogis(c0 - 1.645 * se0), 100 * plogis(c0 + 1.645 * se0),
            100 * mean(cty_s), 100 * (plogis(c0 + sd_wave) - plogis(c0))))
print(env |> transmute(year, midterm = mid == 1, county_D = round(100 * plogis(lc), 1), wave_logit = round(wave, 3)))
print(wave_effect)
print(plan_tab |> mutate(across(c(votes, eff_gap, mean_med, bias, lopsided), \(x) round(100 * x, 1))), n = Inf)
print(pctile |> mutate(across(c(value, ens_median), \(x) if_else(metric == "seats", x, round(100 * x, 1))),
                       pct_below = round(100 * pct_below, 1)), n = Inf)
print(sim_tab, n = Inf)
print(sim_sum |> mutate(across(-c(plan, exp_seats), \(x) round(100 * x, 1)), exp_seats = round(exp_seats, 2)))
print(win_prob |> mutate(across(c(p_dem, composite), \(x) round(100 * x, 1))), n = Inf)
print(p_rank); print(p_sv); print(p_win); print(p_seats); print(p_wave)