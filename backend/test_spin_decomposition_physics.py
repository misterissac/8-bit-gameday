"""
Physical-accuracy tests for the per-pitch spin decomposition pipeline.

Context
-------
The MLB Stats API's live feed (what backend/main.py actually consumes)
only exposes:
    - breaks.spinRate      -> TOTAL spin rate (rpm)
    - breaks.spinDirection -> spin axis, projected on the catcher's-view clock
    - coordinates          -> release position/velocity + constant
                              acceleration (the classic 9-parameter fit)

It does NOT expose a measured "gyro spin" or "active spin" component.
backend/main.py relies entirely on statcast_to_sim.py's acceleration-based
method (`accel_method=True`, Nathan 2020) -- the same method used in
skill-vis:MyTrajectorySimulator-main -- to *infer* how much of the total
spin is transverse (ball-moving, "active") vs. gyroscopic (bullet-like,
non-lift-producing) purely from a single pitch's measured acceleration.

Since MLB doesn't publish ground-truth active-spin/gyro-spin percentages
through this API, the only way to check whether that inference is correct
is a round-trip test:

    1. Forward-simulate a pitch with a KNOWN backspin/sidespin/gyrospin
       split using this project's own trajectory simulator
       (MyBallTrajectorySim.BallTrajectorySimulator2).
    2. Reduce that simulated trajectory down to exactly the fields the real
       MLB Stats API would provide (release position, velocity at y=50ft,
       constant acceleration, total spin rate, spin axis) -- i.e. build a
       "statcast row" the same way backend/main.py does per pitch.
    3. Feed that row back into statcast_to_sim_params(..., accel_method=True)
       (the exact call backend/main.py makes for each live pitch) and compare
       the recovered gyro% to the known ground truth.

Run with:
    python3 -m unittest backend.test_spin_decomposition_physics -v
or, from the backend/ directory:
    python3 -m unittest test_spin_decomposition_physics -v
"""

import os
import sys
import math
import unittest

import numpy as np

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_BACKEND_DIR)
_SIM_DIR = os.path.join(_PROJECT_ROOT, "skill-vis:MyTrajectorySimulator-main")
for _p in (_BACKEND_DIR, _SIM_DIR, os.path.join(_SIM_DIR, "API")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from MyBallTrajectorySim import (
    BallTrajectorySimulator2,
    IntegrationMethod,
    PitchParameters,
    EnvironmentParameters,
)
from statcast_to_sim import statcast_to_sim_params

FT_PER_M = 3.280839895


def _forward_simulate_to_statcast_row(backspin_rpm, sidespin_rpm, wg_rpm,
                                       v0_mps=42.0, theta_deg=-2.0, phi_deg=1.0):
    """
    Forward-simulate a pitch with a known BSG (backspin/sidespin/gyrospin)
    decomposition, then reduce the resulting trajectory to the same
    9-parameter "statcast row" shape backend/main.py builds from the real
    MLB Stats API feed.

    Returns (statcast_row_dict, true_total_spin_rpm).
    """
    pitch = PitchParameters(
        x0=-0.15, y0=16.764, z0=1.70,
        v0_mps=v0_mps, theta_deg=theta_deg, phi_deg=phi_deg,
        backspin_rpm=backspin_rpm, sidespin_rpm=sidespin_rpm, wg_rpm=wg_rpm,
        batter_hand="R",
    )
    env = EnvironmentParameters()
    sim = BallTrajectorySimulator2(integration_method=IntegrationMethod.RK4)
    sim.simulate(pitch=pitch, env=env, max_time=1.0, save_interval=1)
    traj = sim.trajectory
    if len(traj) < 5:
        raise RuntimeError("Simulated trajectory too short to fit reliably")

    ts = np.array([p["t"] for p in traj])
    xs = np.array([p["x"] for p in traj]) * FT_PER_M
    ys = np.array([p["y"] for p in traj]) * FT_PER_M
    zs = np.array([p["z"] for p in traj]) * FT_PER_M

    # Statcast's convention: t=0 (and vx0/vy0/vz0) is defined at y = 50 ft,
    # not at release. Find that crossing and re-center time on it.
    idx50 = int(np.argmin(np.abs(ys - 50.0)))
    t50 = ts[idx50]
    tau = ts - t50
    design = np.vstack([np.ones_like(tau), tau, 0.5 * tau ** 2]).T

    def fit(coord):
        coeffs, *_ = np.linalg.lstsq(design, coord, rcond=None)
        return coeffs  # (position_at_tau0, velocity_at_tau0, acceleration)

    _, vx0_ft, ax_ft = fit(xs)
    _, vy0_ft, ay_ft = fit(ys)
    _, vz0_ft, az_ft = fit(zs)

    release_y0_ft = ys[0]
    release_extension = 60.5 - release_y0_ft

    spin_rate = math.sqrt(backspin_rpm ** 2 + sidespin_rpm ** 2 + wg_rpm ** 2)
    spin_axis_deg = math.degrees(math.atan2(sidespin_rpm, backspin_rpm)) % 360

    statcast_row = {
        "release_pos_x": xs[0],
        "release_extension": release_extension,
        "release_pos_z": zs[0],
        "vx0": vx0_ft, "vy0": vy0_ft, "vz0": vz0_ft,
        "ax": ax_ft, "ay": ay_ft, "az": az_ft,
        "release_spin_rate": spin_rate,
        "spin_axis": spin_axis_deg,
        "pitch_type": "FF",
        "p_throws": "R",
    }
    return statcast_row, spin_rate


def _recovered_gyro_pct(backspin_rpm, sidespin_rpm, wg_rpm, **kwargs):
    """Mirrors exactly what backend/main.py does per pitch."""
    statcast_row, spin_rate = _forward_simulate_to_statcast_row(
        backspin_rpm, sidespin_rpm, wg_rpm, **kwargs
    )
    sim_params = statcast_to_sim_params(statcast_row, spin_method="bsg", accel_method=True)
    gyro_pct = abs(sim_params["wg_rpm"]) / spin_rate
    return max(0.0, min(1.0, gyro_pct))


class TestSpinDecompositionRecoversKnownSplit(unittest.TestCase):
    """
    Ground-truth round-trip checks. If the acceleration-based spin
    decomposition method used by backend/main.py is "completely functional",
    pitches with a known, constructed spin decomposition should be recovered
    within a reasonable tolerance -- especially the unambiguous 0% and 100%
    gyro extremes.
    """

    def test_pure_backspin_pitch_recovers_low_gyro_pct(self):
        # 2400 rpm, 100% transverse (backspin only) -> true gyro% = 0%.
        recovered = _recovered_gyro_pct(2400.0, 0.0, 0.0)
        self.assertLess(
            recovered, 0.30,
            f"Pure-backspin pitch (true gyro%=0%) recovered as {recovered:.1%} gyro. "
            "The accel-based spin-efficiency inversion is overestimating gyro "
            "spin for high-efficiency pitches."
        )

    def test_pure_transverse_mixed_pitch_recovers_low_gyro_pct(self):
        # Backspin + sidespin, no gyro component -> true gyro% = 0%.
        recovered = _recovered_gyro_pct(1697.0, 1697.0, 0.0)
        self.assertLess(
            recovered, 0.30,
            f"Pure transverse-spin pitch (true gyro%=0%) recovered as "
            f"{recovered:.1%} gyro."
        )

    def test_pure_gyrospin_pitch_recovers_high_gyro_pct(self):
        # No transverse spin at all -> true gyro% = 100%.
        recovered = _recovered_gyro_pct(0.0, 0.0, 2400.0)
        self.assertGreater(
            recovered, 0.85,
            f"Pure-gyrospin pitch (true gyro%=100%) recovered as only "
            f"{recovered:.1%} gyro."
        )

    def test_fifty_percent_efficiency_pitch_recovered_within_tolerance(self):
        # backspin=1200, wg chosen so active_spin/total = 0.5 exactly.
        wg = 1200.0 * math.sqrt(3.0)
        true_gyro_pct = wg / math.sqrt(1200.0 ** 2 + wg ** 2)  # == sqrt(3)/2 ~= 86.6%
        recovered = _recovered_gyro_pct(1200.0, 0.0, wg)
        self.assertLess(
            abs(recovered - true_gyro_pct), 0.15,
            f"true gyro%={true_gyro_pct:.1%} recovered gyro%={recovered:.1%}"
        )

    def test_direction_of_transverse_spin_does_not_change_recovered_gyro(self):
        # Sanity check: rotating where the transverse spin points (spin_axis)
        # shouldn't change how much gyro is inferred, only backspin vs.
        # sidespin split. abs() in the gyro% formula should make sign/axis
        # irrelevant to the magnitude comparison.
        recovered_a = _recovered_gyro_pct(2400.0, 0.0, 0.0)
        recovered_b = _recovered_gyro_pct(0.0, 2400.0, 0.0)
        self.assertLess(abs(recovered_a - recovered_b), 0.05)


if __name__ == "__main__":
    unittest.main(verbosity=2)
