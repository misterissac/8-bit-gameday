"""Fast, offline regression tests for the two A/B comparison confounds.

Guards against silently reintroducing:

1. Roof-closed (indoor) games being fed outdoor Open-Meteo weather instead of
   neutral climate-controlled conditions.
2. The default arm recovering spin at the hardcoded sea-level density
   (1.225 kg/m^3) while integrating with DEFAULT_ENV (~1.19 kg/m^3), which
   made the default arm internally inconsistent.

These are pure/offline tests: no MLB Stats API or Open-Meteo network access.
Run with:  venv/bin/python -m unittest backend.test_weather_regressions -v
"""

import os
import sys
import unittest
from unittest import mock

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import main  # noqa: E402
from main import DEFAULT_ENV, _air_density_from_env, fetch_environment_params  # noqa: E402
from test_weather_accuracy import arm_air_densities  # noqa: E402


def _game_data(condition):
    """A minimal synthetic ``gameData`` block (no datetime → no real network)."""
    return {
        "weather": {"condition": condition, "temp": 76},
        "venue": {
            "name": "Test Field",
            "location": {
                "elevation": 500,
                "defaultCoordinates": {"latitude": 40.0, "longitude": -80.0},
            },
            "fieldInfo": {"roofType": "Retractable"},
        },
    }


def _assert_env_matches_default(testcase, env):
    """Assert an EnvironmentParameters is field-for-field the neutral default."""
    for attr in ("temp_F", "elev_m", "relative_humidity", "pressure_mmHg",
                 "vwind_mph", "phiwind_deg", "hwind_m"):
        testcase.assertEqual(
            getattr(env, attr), getattr(DEFAULT_ENV, attr),
            f"env.{attr} != DEFAULT_ENV.{attr}")


class RoofClosedNeutralTests(unittest.TestCase):
    def test_indoor_conditions_return_neutral_env(self):
        # The roof-closed branch returns before any weather fetch, so prove it
        # makes no network call AND yields DEFAULT_ENV-equivalent conditions.
        with mock.patch.object(main, "_fetch_observed_weather",
                               side_effect=AssertionError("network accessed")):
            for condition in ("Roof Closed", "Dome", "Indoor",
                              "roof closed", "retractable roof closed"):
                with self.subTest(condition=condition):
                    env, meta = fetch_environment_params(
                        _game_data(condition), observed=True)
                    _assert_env_matches_default(self, env)
                    self.assertEqual(meta["pressure_source"], "neutral (indoor)")
                    self.assertEqual(meta["humidity_source"], "neutral (indoor)")

    def test_open_condition_skips_indoor_branch(self):
        # A normal outdoor condition must NOT be swept into the indoor branch.
        with mock.patch.object(main, "_fetch_observed_weather", return_value=None):
            env, meta = fetch_environment_params(_game_data("Clear"), observed=True)
        self.assertNotEqual(meta["pressure_source"], "neutral (indoor)")
        self.assertNotEqual(meta["humidity_source"], "neutral (indoor)")


class DefaultArmDensityTests(unittest.TestCase):
    def test_default_env_density_differs_from_sea_level_standard(self):
        # Premise of confound #2: DEFAULT_ENV is NOT the 1.225 kg/m^3 standard,
        # so recovering spin at 1.225 would be internally inconsistent.
        rho = _air_density_from_env(DEFAULT_ENV)
        self.assertGreater(abs(rho - 1.225), 0.01)

    def test_default_arm_recovers_spin_at_default_env_density(self):
        # The default arm's density must equal _air_density_from_env(DEFAULT_ENV),
        # not the hardcoded sea-level standard.
        live_env = fetch_environment_params(_game_data("Clear"), observed=False)[0]
        live_rho, default_rho = arm_air_densities(live_env)
        self.assertEqual(live_rho, _air_density_from_env(live_env))
        self.assertEqual(default_rho, _air_density_from_env(DEFAULT_ENV))
        self.assertNotAlmostEqual(default_rho, 1.225, places=3)

    def test_roof_closed_game_is_an_exact_tie(self):
        # A roof-closed game maps to neutral conditions, so both arms recover
        # spin at the same density and integrate the same air — the A/B is an
        # exact tie (this is what the two fixes jointly guarantee).
        neutral_env = fetch_environment_params(_game_data("Roof Closed"),
                                               observed=True)[0]
        live_rho, default_rho = arm_air_densities(neutral_env)
        self.assertEqual(live_rho, default_rho)


if __name__ == "__main__":
    unittest.main()
