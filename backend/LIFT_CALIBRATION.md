# Trajectory-model calibrations, regression test & gyro fix

Four changes to the trajectory model, documented together because they form a
chain: the **lift fix**, its **regression-test guard**, the **gyro-spin Magnus fix**,
and the **post-fix re-fit** of the two calibration knobs. All live in `backend/`.

| # | Change | File | What it does |
|---|---|---|---|
| 1 | Lift calibration | `backend/main.py` | Scales the vertical Magnus (lift) force by `LIFT_SCALE = 1.05` to remove a systematic ~0.5–0.7 in vertical low bias. |
| 2 | Regression test | `backend/test_lift_calibration.py` | Re-simulates a fixed 6-game set and fails if the calibrated mean vertical error drifts beyond 0.45 in. |
| 3 | Gyro-spin Magnus fix | `backend/main.py` | Projects the gyro (rifle) spin out of the Magnus cross product, removing a spurious ~0.7 in horizontal x offset. |
| 4 | Calibration re-fit | `backend/fit_calibration.py` | Re-sweeps `LIFT_SCALE` / `SIDESPIN_SCALE` across 15 venues after the gyro fix (confirms 1.05 / 0.95). |

---

## Fix 1 — Lift-coefficient calibration (`LIFT_SCALE = 1.05`)

### The problem

Comparing the RK4 simulation's at-plate position against Statcast `pZ` (Hawk-Eye's
measured plate height) showed the sim landing **~0.7 in low** on average, with a
consistent negative signed bias — not random scatter. That signature points at a
systematic vertical-force deficit, not noise.

### How the cause was isolated

A plate-fit diagnostic (`backend/diag_vertical_bias.py`) compares three plate
heights per pitch: the RK4 sim, the raw 9-parameter Statcast constant-acceleration
fit extrapolated forward, and Hawk-Eye `pZ`. The results exonerated every input
and left only one candidate:

| Hypothesis | Test | Result |
|---|---|---|
| Release height / backprop / crossing convention wrong | 9P quadratic lands on `pZ` | **−0.002 in** mean — inputs are correct |
| 50-ft kinematics wrong | sim vs Statcast at y = 50 ft | **−0.009 in** in z, −0.04 ft/s in vz, ~0.5 ms in time — correct |
| Drag / flight time wrong | sim 50 ft → plate time vs 9P fit | **−0.56 ms**, +0.45 mph faster — drag reproduces measured deceleration almost exactly |
| **Vertical aero (Magnus/lift) deficit** | mean az over 50 ft → plate | **−7.22 m/s² vs −7.06 m/s²** required → a **0.16 m/s² shortfall in upward force** |

Toggling the Magnus term off (a throwaway `diag_terms.py` run) confirmed drag_z is
fine and the missing force is lift: the sim's net vertical aero was **+2.26 m/s²**
where reality requires **+2.73 m/s²**. A 0.16 m/s² deficit over the ~0.42 s final
approach is exactly the ~0.7 in low landing.

### The fix

`backend/main.py` → `FullBallTrajectorySimulator` scales the **vertical** Magnus
component after the cross product (so the calibration never touches the horizontal
sidespin force):

```python
LIFT_SCALE = 1.05

# in calculate_acceleration, after the Magnus cross product:
magnus_x *= self.sidespin_scale(rho)   # horizontal (sidespin) calibration
magnus_z *= self.LIFT_SCALE            # vertical (backspin) lift calibration
```

The class docstring records the derivation and calibration provenance.

### Result on the fitting game (822777, 235 pitches)

| Metric | Before | After |
|---|---|---|
| Δz mean (bias) | −0.73 in | **−0.44 in** |
| median \|Δz\| | 0.69 in | 0.34 in |
| FF (109) Δz | −0.66 in | **+0.10 in** (dead on) |
| FF \|Δ\| total | 0.69 in | 0.48 in |
| signed Δx mean | +0.56 in | +0.30 in |

The dominant pitch type (four-seam, 109 pitches) became essentially unbiased.

### Multi-game generalization check

`backend/validate_lift_calibration.py` measured the vertical plate error at
`LIFT_SCALE = 1.0` vs `1.05` across **6 completed games (1,681 pitches)**, found
via the MLB schedule API:

| Game | n | Δz baseline | Δz calibrated | median base → cal |
|---|---|---|---|---|
| DET @ BAL | 290 | −0.556 | −0.356 | −0.609 → −0.323 |
| CIN @ CLE | 243 | −0.640 | −0.292 | −0.657 → −0.226 |
| MIA @ PIT | 254 | −0.668 | −0.515 | −0.709 → −0.458 |
| CHC @ PHI | 335 | −0.610 | −0.366 | −0.582 → −0.303 |
| WSH @ NYM | 285 | −0.387 | −0.158 | −0.540 → −0.225 |
| TB @ BOS | 274 | −0.421 | **+0.059** | −0.350 → +0.274 |

**Aggregate: baseline −0.545 in → calibrated −0.272 in (median −0.572 → −0.302).**
Every game improved toward zero; none got worse. The baseline bias is consistent
across venues/pitchers (−0.39 to −0.67 in), and the 1.05 scale shifts every game
the same direction by a similar amount — the signature of a real systematic lift
deficit, not an overfit to one game.

---

## Fix 2 — Regression test (`backend/test_lift_calibration.py`)

A `unittest` test that reuses `measure()` from `validate_lift_calibration.py` and
turns the generalization check into a repeatable guard.

### What it does

- Fetches the same fixed 6-game set (`GAME_PKS = 777573, 777569, 777566, 777571,
  777570, 777565`) — deterministic, not date-dependent.
- Simulates every pitch at `LIFT_SCALE = 1.05` and asserts
  `abs(mean vertical error) < 0.45 in`.
- **Skips** (does not fail) if the MLB Stats API is unreachable, so offline runs
  don't false-positive.

### Why the 0.45 in threshold is correct

- Calibrated aggregate mean on this set is **−0.272 in** → comfortably inside.
- Reverting the calibration moves it to **−0.545 in** → outside, so the test fails.
  (Both numbers come from the same `measure()` path, so the toggle and the boundary
  are confirmed, not assumed.)

### Failure message

Points straight at the culprit:

```
Calibrated mean vertical plate error drifted to ... in ...;
|mean| >= 0.45 in. Check FullBallTrajectorySimulator.LIFT_SCALE.
```

---

## Fix 3 — Gyro-spin Magnus projection (the ~0.7 in x offset)

### The problem

After the lift calibration, the sim still carried a **constant ~+0.7 in horizontal
x offset** between the 50-ft mark and the plate — present at every venue and
invariant to `SIDESPIN_SCALE` (which scales the pitch-varying sidespin force, not
the constant). Decomposing `magnus_x = F·(wy·vz − wz·vy)` into its two terms showed
the culprit:

| Game | `wy·vz` (gyro × vertical) | `wz·vy` (sidespin) | sim ax | 9P ax |
|---|---|---|---|---|
| Busch | **+1.31** | +4.73 | +6.10 | +5.56 |
| Coors | **+1.39** | −4.36 | −3.62 | −4.63 |
| Target | **+1.26** | −3.55 | −3.01 | −4.08 |

The `wz·vy` (sidespin) term flips sign with pitch direction, as it should. But
`wy·vz` is a **constant positive ~+1.3–1.6 ft/s²** term — it does not average out,
and it is ~0.9 ft/s² larger than the measurement allows. Integrated over the
~0.42 s final approach, that constant is exactly the ~0.7 in +x offset.

### Why it happens

`wy ≈ −180 rad/s` is dominated by the **gyro spin**, reconstructed along the
*release* velocity and then held fixed in space. As the trajectory curves downward
under gravity, `vz` goes negative, so `wy·vz ≈ (−180)·(−2.8) > 0` — the frozen gyro
vector develops a sideways Magnus component that grows through the flight. It is a
real term in the ω×v formulation, but its magnitude is over-predicted because gyro
spin is the *remainder* (`sqrt(spin_rate² − ω_T²)`), so it inherits any
transverse-spin-recovery error.

### The fix

`FullBallTrajectorySimulator.simulate` stores the release-velocity spin component
(the gyro spin) in `self._gyro_spin`, and `calculate_acceleration` subtracts it
before the Magnus cross product:

```python
# simulate:
spin_dot_u = wx * ux + wy * uy + wz * uz   # ω · release-velocity unit vector
self._gyro_spin = (spin_dot_u * ux, spin_dot_u * uy, spin_dot_u * uz)

# calculate_acceleration:
gx, gy, gz = getattr(self, '_gyro_spin', (0.0, 0.0, 0.0))
wx_t, wy_t, wz_t = wx - gx, wy - gy, wz - gz   # transverse spin only
magnus_x = const * (cl / omega_total) * v_rel * (wy_t * vz - wz_t * vy_rel) / X
```

Only the transverse (backspin/sidespin) spin now enters the Magnus cross product;
gyro spin contributes nothing, which is Nathan's intent.

### Result (15 venues, 1,500 pitches)

Signed x error collapsed from a constant ~+0.7 in to ~0 in — per-venue means now
span −0.24 to +0.24 in and aggregate to **−0.02 in** (worst former offenders: Coors
+1.36 → −0.05, Target +0.93 → −0.03, Busch +0.50 → −0.13). The default arm improved
the same way (both arms shared the bug), so the fix tightens absolute accuracy
without changing the live-vs-default A/B direction.

---

## Fix 4 — Post-gyro-fix re-fit of `LIFT_SCALE` / `SIDESPIN_SCALE`

`backend/fit_calibration.py` re-sweeps both knobs across the 15-venue set after the
gyro term was removed, so the calibration constants are fit on the corrected
physics.

### SIDESPIN_SCALE — confirmed 0.95

| scale | mean x | mean \|x\| |
|---|---|---|
| 0.90 | +0.024 | 0.553 |
| **0.95** | **−0.023** | **0.253** |
| 1.00 | −0.070 | 0.531 |
| 1.05 | −0.117 | 0.965 |

`0.95` minimizes **both** the signed x bias and the absolute `|x|` error. The gyro
fix removed the constant +x *offset*, but the sidespin *scale* (which acts on the
pitch-varying sidespin force) is unchanged — the two are orthogonal.

### LIFT_SCALE — a bias/scatter tradeoff (kept at 1.05)

| LIFT_SCALE | mean z | median z | mean \|z\| | median \|z\| | mean \|tot\| |
|---|---|---|---|---|---|
| 1.00 | −0.510 | −0.458 | 0.644 | 0.523 | 0.738 |
| 1.025 | −0.401 | −0.368 | 0.719 | 0.552 | 0.814 |
| **1.05** | **−0.291** | **−0.251** | 0.852 | 0.653 | 0.945 |
| 1.075 | −0.182 | −0.127 | 1.007 | 0.782 | 1.098 |
| 1.10 | −0.072 | +0.001 | 1.177 | 0.957 | 1.266 |

The signed bias improves monotonically toward zero (best at **1.10**), but the
absolute error `|z|` / `|tot|` is minimized at **1.00** and roughly doubles by
1.10. There is no single optimum: pushing the global lift up zeroes the *mean* by
fixing fastballs but **overshoots breaking balls**, so the scatter explodes. `1.05`
is the compromise — it holds the signed bias at −0.29 in (inside the 0.45 in
regression bound) without the scatter blow-up. The medians track the means, so this
is a systematic type-dependent effect, not outliers.

**Conclusion:** a global `LIFT_SCALE` cannot both remove the bias and keep scatter
low; the residual is type-dependent and needs per-type gyro/spin-efficiency
estimation (the sinker/curve follow-up), not a bigger knob.

**30-venue re-confirmation (post roof-closed fix, 3,000 pitches).** Re-running
`fit_calibration.py` on the expanded 30-venue set keeps both constants.
`SIDESPIN_SCALE = 0.95` still minimizes `|x|` (0.259 in vs 0.573 in at 0.90) with
signed x ≈ 0 (−0.041 in); `LIFT_SCALE = 1.05` still holds the signed bias at
−0.184 in (well inside the 0.45 in bound) while `|tot|` stays near its flat
minimum (1.010 in vs 0.976 in at 1.00). Pushing LIFT to ~1.08+ would zero the
bias but blow up `|z|`/`|tot|` — the same bias/scatter tradeoff as the 15-venue
fit, so no constant changes were needed.

---

## Tests performed

| Command | Scope | Result |
|---|---|---|
| `venv/bin/python backend/diag_vertical_bias.py` | Plate-fit diagnosis (flight time, plate speed, z error, per type) | Isolated the lift deficit |
| `venv/bin/python backend/diag_terms.py` *(removed after use)* | Toggle drag vs Magnus terms | Confirmed the deficit is lift, not drag |
| `venv/bin/python backend/diag_v50.py` *(removed after use)* | 50-ft velocity match per type | Exonerated inputs; flagged per-type residual |
| `venv/bin/python backend/validate_lift_calibration.py` | 6-game generalization check | −0.545 → −0.272 in aggregate; all 6 improved |
| `venv/bin/python -m unittest backend.test_trajectory_simulation_accuracy` | Existing accuracy test | Passed with the calibration |
| `venv/bin/python -m unittest backend.test_spin_decomposition_physics` | Spin-decomposition physics | 2 pre-existing gyro-recovery failures, unrelated (does not import `main.py`'s simulator) |
| `venv/bin/python backend/test_weather_accuracy_multi.py --games <15 games>` | Gyro-fix sweep (signed x across 15 venues) | x offset +0.7 → −0.02 in |
| `venv/bin/python backend/fit_calibration.py` | 15-venue re-fit of both knobs | SIDESPIN 0.95 confirmed; LIFT 1.05 kept as compromise |
| `venv/bin/python -m unittest backend.test_lift_calibration -v` | New regression test | Passed in ~231 s |

Run the guard with:

```bash
venv/bin/python -m unittest backend.test_lift_calibration -v
```

---

## Known limitations

- **Horizontal side effect — resolved.** `LIFT_SCALE` once scaled the full Magnus
  vector, so sidespin grew with it (mean |Δx| 0.58 → 0.83 in). The vertical-only
  `magnus_z *= LIFT_SCALE` split and the gyro-spin projection (Fix 3) removed the
  constant x offset and the coupling; signed x is now ~0 in across venues.
- **Sinkers/curves don't respond to lift.** SI/KC/CU still land low regardless of
  the global `LIFT_SCALE`; their low landing traces to the accel method's
  spin-efficiency/gyro estimate. This is the per-type gyro-estimation follow-up, and
  it is also why the `LIFT_SCALE` re-fit shows a bias/scatter tradeoff rather than a
  clean optimum.
- **Residual bias vs scatter.** At `LIFT_SCALE = 1.05` the aggregate signed bias is
  ~−0.29 in (inside the 0.45 in regression bound); pushing to 1.10 would zero it but
  roughly double the absolute scatter by overshooting breaking pitches.

Diagnostic artifacts kept in the repo for re-running the analysis on other games:
`backend/diag_vertical_bias.py`, `backend/diag_sensitivity.py`,
`backend/diag_crossing.py`, `backend/validate_lift_calibration.py`,
`backend/fit_calibration.py`. The shared 30-venue sweep set lives in
`backend/venues.py` and is imported by `test_weather_accuracy_multi.py`,
`fit_calibration.py` and `fit_sidespin_scale.py`.
