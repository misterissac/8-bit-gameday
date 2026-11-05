"""The trajectory wire contract: 1 ms sampling, full length, all bits.

The frontend animates every sample and solves the bat's contact against them
(``frontend/src/components/Pitch.jsx`` walks the whole array), so the sampling
interval and numeric precision of a trajectory are part of the API, not an
implementation detail. These tests read the JSON body the server actually
sends, so a decimation step, a resampling pass, or a serializer that rounds
(or downcasts to float32) fails here even if ``FullBallTrajectorySimulator``
still produces 1 ms samples internally.

Two endpoints serve the same simulation output and both are covered:
``/api/trajectory`` (the newest pitch) and ``/api/at-bat`` (every pitch of an
at-bat, rebuilt on demand for replay). Both go through
``_build_pitch_payload``, so a break in the builder or the serializer fails in
both places.

The pinned numbers come from the repo's static feed fixture, pushed through the
production path with ``DEFAULT_ENV``. They are deterministic for a fixed model;
if the physics is intentionally recalibrated, re-measure them in the same
commit rather than loosening the deltas.
"""

import json
import os
import struct
import sys
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from fastapi.testclient import TestClient

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import main  # noqa: E402

FIXTURE_PATH = Path(__file__).with_name("fixtures") / "live_feed.json"
GAME_PK = "818001"

# The integration step and the sampled cadence. Both are the contract.
INTEGRATION_DT_S = 0.001

# ``/api/trajectory``: the fixture's latest simulatable pitch. 387 integration
# steps plus the t = 0 state, sampled every step, stopping just past the plate.
PINNED_PLAY_ID = "AB42-P2"
PINNED_POINT_COUNT = 388
PINNED_LAST_T = 0.3870000000000003
PINNED_MID_INDEX = 194
PINNED_MID = {
    "t": 0.19400000000000014,
    "x": 0.1979953388913629,
    "y": 7.439756428891385,
    "z": 1.3504240385352937,
    "v": 39.45901658877148,
}

# ``/api/at-bat``: the fixture's newest at-bat, two replayable pitches. Both
# trajectories are pinned independently so one pitch's mutation cannot hide
# behind the other's.
AT_BAT_INDEX = 42
AT_BAT_PITCHES = {
    1: {
        "play_id": "AB42-P1",
        "points": 387,
        "last_t": 0.3860000000000003,
        "mid": {
            "t": 0.19300000000000014,
            "x": 0.05740043715638795,
            "y": 7.446444187304101,
            "z": 1.4196854907264425,
            "v": 39.59659487846836,
        },
    },
    2: {
        "play_id": "AB42-P2",
        "points": 388,
        "last_t": 0.3870000000000003,
        "mid": PINNED_MID,
    },
}

# Every numeric field of a saved sample. ``cd``/``cl`` are only present on the
# base simulator's samples, not the payload's, so they are deliberately absent.
FLOAT_FIELDS = (
    "t", "x", "y", "z",
    "vx", "vy", "vz",
    "ax", "ay", "az",
    "v", "v_mph", "distance", "height",
)


class _FixtureAppTestCase(unittest.TestCase):
    """Boots the real app against the static feed with network stubs.

    The xBA grid and Sprint Speed lookups are replaced by cheap callables (not
    a ``requests`` mock) so no background worker can outlive the class and hit
    a later test's mock.
    """

    @classmethod
    def _extra_patches(cls):
        return []

    @classmethod
    def _clear_response_caches(cls):
        with main._TRAJECTORY_CACHE_GUARD:
            main._TRAJECTORY_CACHE.clear()
            main._TRAJECTORY_BUILD_LOCKS.clear()
            main._TRAJECTORY_BUILD_LOCKS_LAST_USED.clear()

    @classmethod
    def setUpClass(cls):
        with FIXTURE_PATH.open(encoding="utf-8") as fh:
            cls.feed = json.load(fh)

        cls._saved_workers = (main._xba_grid, main._sprint_speed_by_player)
        main._xba_grid = lambda: None
        main._sprint_speed_by_player = lambda: {}

        cls._patches = [
            mock.patch.object(main, "_fetch_feed", return_value=cls.feed),
            mock.patch.object(main, "_compute_xba", return_value=0.321),
            mock.patch.object(
                main, "_bat_tracking_for_pitch",
                return_value={"swing_path_tilt": None, "attack_angle": None},
            ),
            mock.patch.object(main, "_fetch_savant_rows", return_value=[]),
            mock.patch.object(
                main, "_build_hit_payload", return_value={"play_id": "fixture-hit"}
            ),
        ] + list(cls._extra_patches())
        for patcher in cls._patches:
            patcher.start()

        cls._clear_response_caches()
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        for patcher in reversed(cls._patches):
            patcher.stop()
        main._xba_grid, main._sprint_speed_by_player = cls._saved_workers
        cls._clear_response_caches()

    @property
    def body(self):
        return self.response.json()


def _assert_one_millisecond_grid(testcase, traj, label):
    """Every consecutive sample is dt apart, after the JSON round trip."""
    testcase.assertEqual(traj[0]["t"], 0.0, f"{label}: first sample is not t=0")
    deltas = [b["t"] - a["t"] for a, b in zip(traj, traj[1:])]
    testcase.assertTrue(deltas, f"{label}: no samples after t=0")
    for index, delta in enumerate(deltas):
        testcase.assertLessEqual(
            abs(delta - INTEGRATION_DT_S), 1e-12,
            f"{label} step {index}: {delta!r} s is not 1 ms",
        )
        testcase.assertGreater(delta, 0.0, f"{label} step {index}: time went backwards")
    # A decimated trajectory would put 0.005 (or 0.002) in this set.
    testcase.assertEqual(
        {round(delta, 9) for delta in deltas}, {INTEGRATION_DT_S},
        f"{label}: non-uniform sampling",
    )


def _assert_point_count_is_one_per_step(testcase, traj, points, label):
    """Pinned length, and the identity N samples == N-1 steps at dt."""
    testcase.assertEqual(len(traj), points, f"{label}: point count changed")
    testcase.assertEqual(
        len(traj) - 1, round(traj[-1]["t"] / INTEGRATION_DT_S),
        f"{label}: sample count does not match the integration steps",
    )


def _assert_full_width(testcase, sample, field, label):
    """Reject both a float32 downcast and rounding to 6 decimals."""
    value = float(sample[field])
    testcase.assertNotEqual(
        value, float(np.float32(value)),
        f"{label} {field}: lost mantissa bits (float32 downcast)",
    )
    testcase.assertNotEqual(
        value, round(value, 6),
        f"{label} {field}: rounded to six decimals before serialization",
    )


class TrajectoryContractTests(_FixtureAppTestCase):
    """``GET /api/trajectory`` for the fixture's newest pitch."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.response = cls.client.get(
            "/api/trajectory", params={"env": "default", "game_pk": GAME_PK}
        )

    def test_endpoint_answers_with_the_expected_pitch(self):
        self.assertEqual(self.response.status_code, 200)
        self.assertEqual(self.body["play_id"], PINNED_PLAY_ID)
        self.assertEqual(len(self.body["trajectory"]), PINNED_POINT_COUNT)

    def test_sample_interval_is_one_millisecond_after_serialization(self):
        _assert_one_millisecond_grid(self, self.body["trajectory"], PINNED_PLAY_ID)

    def test_point_count_matches_one_sample_per_integration_step(self):
        traj = self.body["trajectory"]
        _assert_point_count_is_one_per_step(self, traj, PINNED_POINT_COUNT, PINNED_PLAY_ID)
        self.assertAlmostEqual(traj[-1]["t"], PINNED_LAST_T, places=12)
        # The run stops just past the plate, not early and not at max_time.
        self.assertLessEqual(traj[-1]["y"], 0.0)
        self.assertGreater(traj[-2]["y"], 0.0)

    def test_wire_doubles_are_bit_identical_to_the_simulation(self):
        """Every coordinate crosses the JSON boundary without losing a bit.

        The reference is a fresh in-process build of the same payload; the
        simulation is deterministic, so any difference means the HTTP layer
        rounded, reformatted or downcast the value.
        """
        wire = self.body["trajectory"]
        reference = main._build_trajectory_payload(
            self.feed, main.DEFAULT_ENV, main.DEFAULT_ENV_META, GAME_PK
        )["trajectory"]
        self.assertEqual(len(wire), len(reference))

        for index, (sent, built) in enumerate(zip(wire, reference)):
            for field in FLOAT_FIELDS:
                self.assertEqual(
                    struct.pack(">d", float(sent[field])),
                    struct.pack(">d", float(built[field])),
                    f"point {index} {field}: wire {sent[field]!r} is not the "
                    f"simulated {built[field]!r}",
                )

    def test_pinned_midflight_point_is_unrounded_and_full_width(self):
        sample = self.body["trajectory"][PINNED_MID_INDEX]
        for field, expected in PINNED_MID.items():
            self.assertAlmostEqual(
                sample[field], expected, places=12,
                msg=f"mid-flight {field} moved: {sample[field]!r} != {expected!r}",
            )
        for field in ("x", "y", "z", "v"):
            _assert_full_width(self, sample, field, "mid-flight")

    def test_json_text_carries_the_shortest_roundtrip_digits(self):
        """The body must carry the full ``repr`` of the double, not a display form."""
        sample = self.body["trajectory"][PINNED_MID_INDEX]
        for field in ("x", "y", "z", "v"):
            token = repr(float(sample[field]))
            self.assertIn(
                token, self.response.text,
                f"{field} was serialized as something other than {token}",
            )
            # 0.1979953388913629 -> 16 significant digits.
            digits = len(token.lstrip("-").replace(".", "").lstrip("0"))
            self.assertGreaterEqual(
                digits, 15, f"{field} carries only {digits} significant digits"
            )

    def test_trajectory_is_not_the_coarse_quadratic_reference_curve(self):
        """``quadratic_trajectory`` is the 5 ms closed-form fit; they are distinct."""
        quad = self.body["quadratic_trajectory"]
        self.assertNotEqual(len(quad), len(self.body["trajectory"]))
        quad_deltas = {round(b["t"] - a["t"], 9) for a, b in zip(quad, quad[1:])}
        self.assertEqual(quad_deltas, {0.005})


class AtBatReplayContractTests(_FixtureAppTestCase):
    """``GET /api/at-bat`` replays every pitch through the same builder."""

    @classmethod
    def _extra_patches(cls):
        # The at-bat endpoint always resolves the live environment. Pin it to
        # DEFAULT_ENV so the replay is offline and matches the pinned numbers.
        return [
            mock.patch.object(
                main, "fetch_environment_params",
                return_value=(main.DEFAULT_ENV, main.DEFAULT_ENV_META),
            )
        ]

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.response = cls.client.get(
            "/api/at-bat", params={"game_pk": GAME_PK}
        )

    def _pitch_entries(self):
        return {entry["pitch_number"]: entry for entry in self.body["pitches"]}

    def _reference_payloads(self):
        """In-process payload for each replayable pitch of the same at-bat."""
        plays = self.feed["liveData"]["plays"]["allPlays"]
        play = main._find_play_by_at_bat(plays, AT_BAT_INDEX)
        self.assertIsNotNone(play, "fixture at-bat not found")
        payloads = {}
        for index, event in enumerate(play.get("playEvents", [])):
            if not event.get("isPitch"):
                continue
            payloads[event.get("pitchNumber")] = main._build_pitch_payload(
                self.feed, play, event, index,
                main.DEFAULT_ENV, main.DEFAULT_ENV_META, GAME_PK,
            )
        return payloads

    def test_every_pitch_of_the_at_bat_is_replayable(self):
        self.assertEqual(self.response.status_code, 200)
        body = self.body
        self.assertTrue(body["success"])
        self.assertEqual(body["at_bat_index"], AT_BAT_INDEX)
        self.assertEqual(sorted(self._pitch_entries()), sorted(AT_BAT_PITCHES))

        for number, expected in AT_BAT_PITCHES.items():
            entry = self._pitch_entries()[number]
            self.assertTrue(entry["replayable"], f"pitch {number} is not replayable")
            self.assertIsNotNone(entry["pitch"], f"pitch {number} has no payload")
            self.assertEqual(entry["play_id"], expected["play_id"])
            self.assertEqual(entry["pitch"]["play_id"], expected["play_id"])

    def test_replay_trajectories_keep_the_one_millisecond_grid(self):
        for number in AT_BAT_PITCHES:
            with self.subTest(pitch=number):
                traj = self._pitch_entries()[number]["pitch"]["trajectory"]
                _assert_one_millisecond_grid(self, traj, f"P{number}")

    def test_replay_point_counts_match_one_sample_per_step(self):
        for number, expected in AT_BAT_PITCHES.items():
            with self.subTest(pitch=number):
                traj = self._pitch_entries()[number]["pitch"]["trajectory"]
                _assert_point_count_is_one_per_step(
                    self, traj, expected["points"], f"P{number}"
                )
                self.assertAlmostEqual(traj[-1]["t"], expected["last_t"], places=12)
                self.assertLessEqual(traj[-1]["y"], 0.0)
                self.assertGreater(traj[-2]["y"], 0.0)

    def test_replay_wire_doubles_are_bit_identical_to_the_simulation(self):
        references = self._reference_payloads()
        for number, expected in AT_BAT_PITCHES.items():
            with self.subTest(pitch=number):
                wire = self._pitch_entries()[number]["pitch"]["trajectory"]
                reference = references[number]["trajectory"]
                self.assertEqual(len(wire), len(reference))

                for index, (sent, built) in enumerate(zip(wire, reference)):
                    for field in FLOAT_FIELDS:
                        self.assertEqual(
                            struct.pack(">d", float(sent[field])),
                            struct.pack(">d", float(built[field])),
                            f"P{number} point {index} {field}: wire "
                            f"{sent[field]!r} is not the simulated {built[field]!r}",
                        )

    def test_pinned_replay_midflight_points_are_full_width(self):
        for number, expected in AT_BAT_PITCHES.items():
            with self.subTest(pitch=number):
                traj = self._pitch_entries()[number]["pitch"]["trajectory"]
                sample = traj[expected["points"] // 2]
                for field, value in expected["mid"].items():
                    self.assertAlmostEqual(
                        sample[field], value, places=12,
                        msg=f"P{number} mid-flight {field} moved: "
                            f"{sample[field]!r} != {value!r}",
                    )
                for field in ("x", "y", "z", "v"):
                    _assert_full_width(self, sample, field, f"P{number}")
                # The body must carry the shortest round-trip digits, not a
                # six-decimal display form.
                self.assertIn(repr(float(sample["x"])), self.response.text)

    def test_replay_trajectories_are_distinct_pitches(self):
        """A shared/cached list would make both pitches animate one ball."""
        one = self._pitch_entries()[1]["pitch"]["trajectory"]
        two = self._pitch_entries()[2]["pitch"]["trajectory"]
        mid = min(len(one), len(two)) // 2
        self.assertNotEqual(one[mid]["x"], two[mid]["x"])
        self.assertNotEqual(one[mid]["z"], two[mid]["z"])
        self.assertNotEqual(len(one), len(two))


if __name__ == "__main__":
    unittest.main()
