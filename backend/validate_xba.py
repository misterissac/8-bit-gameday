"""
Validate the xBA model improvements by comparing old (nearest-neighbour)
and new (bilinear interpolation) predictions against:
  1. Savant's ``estimated_ba_using_speedangle`` (the reference / ground-truth)
  2. Actual hit outcomes (log loss, Brier score, MAE)

Builds the EV/LA grid from a 45-day Statcast window, then scores both
methods on the most recent 5 days (holdout).  Also reports the overlapping
subset where *both* methods produce a prediction, isolating interpolation
quality from coverage gains.

Usage:  python backend/validate_xba.py
"""

import sys
import os
import math
import time
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np

from backend.main import (
    _XBA_EV_MIN, _XBA_EV_MAX, _XBA_EV_STEP,
    _XBA_LA_MIN, _XBA_LA_MAX, _XBA_LA_STEP,
    _XBA_HIT_EVENTS,
    _XBA_GRID_DAYS,
    _XBA_GRID_SIGMA,
    _XBA_SPRINT_GROUND_SLOPE,
    _XBA_SPRINT_LEAGUE_AVG,
    _gaussian_blur,
    _savant_day_rows,
)

EPS = 1e-15


# ── old (nearest-neighbour) lookup ──────────────────────────────────────────

def _old_xba(grid, ev, la, sprint_speed=None):
    if not (_XBA_EV_MIN <= ev <= _XBA_EV_MAX and _XBA_LA_MIN <= la <= _XBA_LA_MAX):
        return None
    ei = int(round((ev - _XBA_EV_MIN) / _XBA_EV_STEP))
    li = int(round((la - _XBA_LA_MIN) / _XBA_LA_STEP))
    if not (0 <= ei < grid.shape[1] and 0 <= li < grid.shape[0]):
        return None
    base = grid[li, ei]
    if math.isnan(base):
        return None
    xba = float(base)
    if sprint_speed is not None:
        weight = min(max((10.0 - la) / 10.0, 0.0), 1.0)
        xba += _XBA_SPRINT_GROUND_SLOPE * (sprint_speed - _XBA_SPRINT_LEAGUE_AVG) * weight
    return min(max(xba, 0.02), 0.99)


# ── new (bilinear) lookup ───────────────────────────────────────────────────

def _new_xba(grid, ev, la, sprint_speed=None):
    ev_frac = (ev - _XBA_EV_MIN) / _XBA_EV_STEP
    la_frac = (la - _XBA_LA_MIN) / _XBA_LA_STEP
    ev_frac_clamped = min(max(ev_frac, 0.0), grid.shape[1] - 1.001)
    la_frac_clamped = min(max(la_frac, 0.0), grid.shape[0] - 1.001)

    ev0 = int(ev_frac_clamped)
    la0 = int(la_frac_clamped)
    ev1 = min(ev0 + 1, grid.shape[1] - 1)
    la1 = min(la0 + 1, grid.shape[0] - 1)

    ev_w = ev_frac_clamped - ev0
    la_w = la_frac_clamped - la0

    corners = [grid[la0, ev0], grid[la0, ev1], grid[la1, ev0], grid[la1, ev1]]
    weights = [(1 - ev_w) * (1 - la_w), ev_w * (1 - la_w),
               (1 - ev_w) * la_w, ev_w * la_w]

    valid_weight = 0.0
    xba = 0.0
    for v, w in zip(corners, weights):
        if not math.isnan(v):
            xba += v * w
            valid_weight += w
    if valid_weight == 0.0:
        return None
    xba /= valid_weight

    if sprint_speed is not None:
        weight = math.exp(-la / 3.0) if la > 0 else 1.0
        xba += _XBA_SPRINT_GROUND_SLOPE * (sprint_speed - _XBA_SPRINT_LEAGUE_AVG) * weight
    return min(max(xba, 0.02), 0.99)


# ── grid builder ────────────────────────────────────────────────────────────

def _build_grid():
    today = datetime.now(timezone.utc).date()
    days = [today - timedelta(days=i) for i in range(_XBA_GRID_DAYS)]
    ev_bins = int(round((_XBA_EV_MAX - _XBA_EV_MIN) / _XBA_EV_STEP)) + 1
    la_bins = int(round((_XBA_LA_MAX - _XBA_LA_MIN) / _XBA_LA_STEP)) + 1
    counts = np.zeros((la_bins, ev_bins))
    hits = np.zeros((la_bins, ev_bins))

    print(f"  Fetching {_XBA_GRID_DAYS} days of Statcast data …")
    t0 = time.time()
    n_batted = 0
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(_savant_day_rows, day) for day in days]
        for future in futures:
            try:
                rows = future.result()
            except Exception:
                continue
            for row in rows:
                ev = (row.get("launch_speed") or "").strip()
                la = (row.get("launch_angle") or "").strip()
                events = (row.get("events") or "").strip().lower()
                if not ev or not la or not events:
                    continue
                try:
                    ev = float(ev)
                    la = float(la)
                except ValueError:
                    continue
                if not (_XBA_EV_MIN <= ev <= _XBA_EV_MAX
                        and _XBA_LA_MIN <= la <= _XBA_LA_MAX):
                    continue
                ei = min(max(int(round((ev - _XBA_EV_MIN) / _XBA_EV_STEP)), 0), ev_bins - 1)
                li = min(max(int(round((la - _XBA_LA_MIN) / _XBA_LA_STEP)), 0), la_bins - 1)
                counts[li, ei] += 1
                hits[li, ei] += 1 if events in _XBA_HIT_EVENTS else 0
                n_batted += 1

    if counts.sum() == 0:
        raise ValueError("no batted-ball data in statcast window")
    with np.errstate(invalid="ignore", divide="ignore"):
        rate = np.where(
            counts > 0,
            _gaussian_blur(hits, _XBA_GRID_SIGMA) / _gaussian_blur(counts, _XBA_GRID_SIGMA),
            np.nan,
        )
    print(f"  Done in {time.time() - t0:.0f}s — {n_batted:,} batted balls, "
          f"{np.isfinite(rate).sum():,}/{rate.size:,} valid cells")
    return rate


# ── evaluation ──────────────────────────────────────────────────────────────

def _evaluate(rows, grid):
    """Score both methods on rows.  Returns two dicts of metrics.

    ``all``  — every row the method can score (includes coverage gains).
    ``overlap`` — the subset where BOTH methods produce a prediction.
    """
    # Per-row accumulators.
    old_p = []
    new_p = []
    savant_p = []
    actual = []

    for row in rows:
        ev_s = (row.get("launch_speed") or "").strip()
        la_s = (row.get("launch_angle") or "").strip()
        events = (row.get("events") or "").strip().lower()
        sav = (row.get("estimated_ba_using_speedangle") or "").strip()
        if not ev_s or not la_s or not events:
            continue
        try:
            ev = float(ev_s)
            la = float(la_s)
        except ValueError:
            continue

        o = _old_xba(grid, ev, la)
        n = _new_xba(grid, ev, la)
        s = float(sav) if sav else None

        old_p.append(o)
        new_p.append(n)
        savant_p.append(s)
        actual.append(1.0 if events in _XBA_HIT_EVENTS else 0.0)

    old_p = np.array([x if x is not None else np.nan for x in old_p], dtype=float)
    new_p = np.array([x if x is not None else np.nan for x in new_p], dtype=float)
    savant_p = np.array([x if x is not None else np.nan for x in savant_p], dtype=float)
    actual = np.array(actual, dtype=float)

    def _metrics(pred, act, label):
        mask = ~np.isnan(pred)
        n = int(mask.sum())
        if n == 0:
            return {"n": 0}
        p = pred[mask]
        a = act[mask]
        # Correlation / MAE vs Savant.
        sav_masked = savant_p[mask]
        sav_mask = ~np.isnan(sav_masked)
        r_savant = float(np.corrcoef(p[sav_mask], sav_masked[sav_mask])[0, 1]) if sav_mask.sum() > 1 else float("nan")
        mae_savant = float(np.mean(np.abs(p[sav_mask] - sav_masked[sav_mask]))) if sav_mask.sum() > 0 else float("nan")

        # Scoring rules vs actual outcomes.
        p_clip = np.clip(p, EPS, 1 - EPS)
        ll = -np.mean(a * np.log(p_clip) + (1 - a) * np.log(1 - p_clip))
        brier = np.mean((p - a) ** 2)
        mae = np.mean(np.abs(p - a))
        return {
            "n": int(n),
            "r_vs_savant": r_savant,
            "mae_vs_savant": mae_savant,
            "logloss": ll,
            "brier": brier,
            "mae": mae,
        }

    # All-scored (each method's full coverage).
    old_all = _metrics(old_p, actual, "old-all")
    new_all = _metrics(new_p, actual, "new-all")

    # Overlap: rows where both methods produce a value.
    overlap_mask = ~np.isnan(old_p) & ~np.isnan(new_p)
    old_overlap = _metrics(np.where(overlap_mask, old_p, np.nan), actual, "old-overlap")
    new_overlap = _metrics(np.where(overlap_mask, new_p, np.nan), actual, "new-overlap")

    return old_all, new_all, old_overlap, new_overlap


def _print_metrics(label, m):
    if m.get("n", 0) == 0:
        print(f"    {label}:  n=0")
        return
    print(
        f"    {label}:  n={m['n']:,}"
        f"  r(savant)={m['r_vs_savant']:.4f}"
        f"  MAE(savant)={m['mae_vs_savant']:.4f}"
        f"  logloss={m['logloss']:.4f}"
        f"  Brier={m['brier']:.4f}"
        f"  MAE={m['mae']:.4f}"
    )


def _print_delta(d_old, d_new):
    for key in ["r_vs_savant", "mae_vs_savant", "logloss", "brier", "mae"]:
        if d_old.get("n", 0) == 0 or d_new.get("n", 0) == 0:
            continue
        o = d_old[key]
        n = d_new[key]
        if math.isnan(o) or math.isnan(n):
            continue
        delta = n - o
        pct = delta / abs(o) * 100 if abs(o) > 1e-9 else 0.0
        direction = "↓" if delta < 0 else "↑"
        name = key.replace("_vs_savant", "⸝Savant")
        print(f"    {name:>16s}: {o:.4f} → {n:.4f}   Δ={delta:+.4f}  ({pct:+.2f}% {direction})")
    # Coverage delta.
    print(f"    {'coverage':>16s}: {d_old['n']:,} → {d_new['n']:,}   Δ={d_new['n'] - d_old['n']:+,}")


# ── main ────────────────────────────────────────────────────────────────────

def main():
    print("=== xBA model validation ===\n")

    # 1. Build the grid from the full 45-day window.
    grid = _build_grid()
    print()

    # 2. Fetch the most-recent 5 days as a holdout set.
    today = datetime.now(timezone.utc).date()
    holdout_days = [today - timedelta(days=i) for i in range(5)]

    print("  Fetching 5-day holdout set …")
    holdout_rows = []
    with ThreadPoolExecutor(max_workers=4) as executor:
        for future in [executor.submit(_savant_day_rows, d) for d in holdout_days]:
            try:
                holdout_rows.extend(future.result())
            except Exception:
                pass
    n_total = sum(
        1 for r in holdout_rows
        if (r.get("launch_speed") or "").strip()
        and (r.get("launch_angle") or "").strip()
        and (r.get("events") or "").strip()
    )
    print(f"  {len(holdout_rows):,} rows, {n_total:,} with EV/LA/event\n")

    # 3. Evaluate.
    old_all, new_all, old_overlap, new_overlap = _evaluate(holdout_rows, grid)

    print("── Full coverage (includes boundary / NaN cells the new method recovers) ──")
    _print_metrics("OLD", old_all)
    _print_metrics("NEW", new_all)
    print("  Deltas (OLD → NEW):")
    _print_delta(old_all, new_all)

    print("\n── Overlap subset (same data points, isolates interpolation quality) ──")
    _print_metrics("OLD", old_overlap)
    _print_metrics("NEW", new_overlap)
    print("  Deltas (OLD → NEW):")
    _print_delta(old_overlap, new_overlap)

    print("\n=== done ===")


if __name__ == "__main__":
    main()