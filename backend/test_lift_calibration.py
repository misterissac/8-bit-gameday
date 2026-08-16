"""Regression test for the lift-coefficient calibration.

Fetches a fixed set of completed MLB games and checks that the calibrated
simulation's mean vertical plate error (sim z - Statcast pZ) stays close to
zero. If ``FullBallTrajectorySimulator.LIFT_SCALE`` is reverted or drifts, the
mean error moves from ~-0.27 in back toward ~-0.55 in and this test fails.

This is a network-dependent integration test: it is skipped (not failed) if
the MLB Stats API is unreachable, and it is comparatively slow (~4 min for the
full six-game set). Trim ``GAME_PKS`` to shorten a local run.
"""
import os
import sys
import unittest

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from validate_lift_calibration import measure  # noqa: E402

# Completed 2025 regular-season games used as a fixed, deterministic set.
GAME_PKS = (777573, 777569, 777566, 777571, 777570, 777565)

# Measured on this set: calibrated mean ~-0.27 in (median ~-0.30 in), baseline
# (uncalibrated lift) mean ~-0.55 in. The bound is wide enough to absorb
# game-to-game variation but tight enough to fail if the calibration is undone.
MAX_ABS_MEAN_Z_ERROR_IN = 0.45


class TestLiftCalibration(unittest.TestCase):
    def test_calibrated_mean_vertical_error_within_tolerance(self):
        errors = []
        fetched = 0
        for game_pk in GAME_PKS:
            try:
                errs = measure(game_pk, 1.05)
            except Exception:
                errs = None
            if not errs:
                continue
            fetched += 1
            errors.extend(errs)

        if fetched == 0:
            self.skipTest(
                "MLB Stats API unreachable; skipping network-dependent "
                "lift-calibration regression check"
            )

        mean = sum(errors) / len(errors)
        median = sorted(errors)[len(errors) // 2]
        self.assertLess(
            abs(mean),
            MAX_ABS_MEAN_Z_ERROR_IN,
            f"Calibrated mean vertical plate error drifted to {mean:+.3f} in "
            f"(median {median:+.3f} in) across {fetched} games / "
            f"{len(errors)} pitches; |mean| >= {MAX_ABS_MEAN_Z_ERROR_IN} in. "
            f"Check FullBallTrajectorySimulator.LIFT_SCALE.",
        )


if __name__ == "__main__":
    unittest.main()
