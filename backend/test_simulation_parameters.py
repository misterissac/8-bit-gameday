"""Pinned-regression tests for the simulation's statistical parameters.

These tests are offline and deterministic. ``REFERENCE_PITCHES`` holds six real
Statcast rows captured from game 822774 (a completed game), reduced to exactly
the fields the live feed provides. Each row is pushed through the production
path — ``_pitch_parameters_from_event`` -> ``FullBallTrajectorySimulator`` with
``DEFAULT_ENV`` — and every number asserted below is what the calibrated model
produced when the tests were written.

The point is not to re-derive the physics in the test: it is to make any change
to the release back-propagation, the spin inversion, the aerodynamic model, the
lift calibration, or the sampling interval fail loudly with the parameter's
name. If a change is intentional, re-measure and update the pinned table in the
same commit.

``PayloadPassthroughTests`` covers the other half of the contract: the values
the frontend actually consumes (Hawkeye pX/pZ, the strike zone, player heights,
bat tracking, and the full-resolution trajectory) must cross the payload
boundary unmodified.
"""

import json
import math
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import main  # noqa: E402

FIXTURE_PATH = Path(__file__).with_name("fixtures") / "live_feed.json"

# The density the sim integrates with for DEFAULT_ENV. Pinned because the spin
# inversion and the forward model must use the same air.
DEFAULT_AIR_DENSITY = 1.1938153356910344

# Real pitches from game 822774, one per pitch type. Coordinates are the live
# feed's 50-ft measurements in feet and feet/second; extension in feet.
REFERENCE_PITCHES = {
    "FF": {
        "at_bat": 0, "pitch_number": 1, "batter_hand": "L", "pitch_hand": "R",
        "pitch_type": "FF",
        "coordinates": {
            "x0": -1.4310422084856145, "y0": 50.00656712715555, "z0": 5.889918606342533,
            "vX0": 6.944944187119027, "vY0": -136.72975630941048, "vZ0": -11.581725634152644,
            "aX": -5.959003400503576, "aY": 27.941300053009233, "aZ": -10.625076030926953,
            "pfxX": -3.1219753063946354, "pfxZ": 11.29448365744447,
            "pX": 0.727516556487566, "pZ": 0.8883175806180394,
        },
        "extension": 6.496333607598051, "spin_rate": 2385, "spin_direction": 195,
        "start_speed": 94.2, "strike_zone_top": 3.281, "strike_zone_bottom": 1.656,
        "expect": {
            "release": (-0.49865160699625877, 16.460317516404114, 1.8967628756040436),
            "v0_mps": 42.12032503250097, "theta_deg": -4.678552973375924,
            "phi_deg": 2.962802551271783,
            "backspin_rpm": 1562.7749530146646, "sidespin_rpm": -398.38946735108,
            "wg_rpm": 1737.271964558223,
            "cross_x_in": 8.72874164330917, "cross_z_in": 11.27081202384956,
            "residual_x_in": -0.0014570345416213826, "residual_z_in": 0.6110010564330874,
            "points": 413,
        },
    },
    "CH": {
        "at_bat": 1, "pitch_number": 3, "batter_hand": "L", "pitch_hand": "R",
        "pitch_type": "CH",
        "coordinates": {
            "x0": -1.3078550405615126, "y0": 50.004441485811334, "z0": 5.978499202376112,
            "vX0": 4.328776694077245, "vY0": -120.2493905909904, "vZ0": -6.775347496584531,
            "aX": -5.987956709651169, "aY": 19.77563784913822, "aZ": -17.494747015115163,
            "pfxX": -4.023070347244174, "pfxZ": 9.865173148693259,
            "pX": -0.020617353425576187, "pZ": 1.6118381731448657,
        },
        "extension": 6.35727417641391, "spin_rate": 1843, "spin_direction": 190,
        "start_speed": 82.6, "strike_zone_top": 3.248, "strike_zone_bottom": 1.639,
        "expect": {
            "release": (-0.444987610778548, 16.50270283102904, 1.8899762625357073),
            "v0_mps": 36.93296951868538, "theta_deg": -2.920797457010223,
            "phi_deg": 2.1474239616768434,
            "backspin_rpm": 1180.4011350175972, "sidespin_rpm": -503.6283912178232,
            "wg_rpm": 1289.9508475179437,
            "cross_x_in": -0.2191912352379049, "cross_z_in": 19.763586947904262,
            "residual_x_in": 0.028217005869009326, "residual_z_in": 0.4215288701658757,
            "points": 471,
        },
    },
    "SL": {
        "at_bat": 2, "pitch_number": 1, "batter_hand": "L", "pitch_hand": "R",
        "pitch_type": "SL",
        "coordinates": {
            "x0": -1.3715509733153965, "y0": 50.002278311574045, "z0": 5.887188084473471,
            "vX0": 4.700379598225634, "vY0": -125.1938428083332, "vZ0": -7.445158204594918,
            "aX": 1.3779527317492761, "aY": 24.39646109158291, "aZ": -25.67387812674076,
            "pfxX": 0.8652510263798261, "pfxZ": 4.07888399155801,
            "pX": 0.6397802369176386, "pZ": 0.7845559274126782,
        },
        "extension": 6.2555980085006135, "spin_rate": 2514, "spin_direction": 165,
        "start_speed": 86.1, "strike_zone_top": 3.184, "strike_zone_bottom": 1.607,
        "expect": {
            "release": (-0.4661953976447577, 16.533693727009013, 1.8665931919824337),
            "v0_mps": 38.48879172775091, "theta_deg": -2.985846789510903,
            "phi_deg": 2.114955349390903,
            "backspin_rpm": 257.2896249531713, "sidespin_rpm": 157.0849897233862,
            "wg_rpm": 2505.231457671854,
            "cross_x_in": 7.444127956371353, "cross_z_in": 8.79534862502466,
            "residual_x_in": -0.2332348866403109, "residual_z_in": -0.6193225039274779,
            "points": 452,
        },
    },
    "SI": {
        "at_bat": 2, "pitch_number": 2, "batter_hand": "L", "pitch_hand": "R",
        "pitch_type": "SI",
        "coordinates": {
            "x0": -1.1601240707912808, "y0": 50.0056502410812, "z0": 6.077283140248822,
            "vX0": 3.652217472358691, "vY0": -136.07007982164785, "vZ0": -6.589475346125616,
            "aX": -9.538781464958323, "aY": 28.81764323290249, "aZ": -16.25947602574402,
            "pfxX": -5.067158174855079, "pfxZ": 8.456675047565911,
            "pX": -0.4613881841417442, "pZ": 2.5046960729835184,
        },
        "extension": 6.427691577572224, "spin_rate": 2400, "spin_direction": 185,
        "start_speed": 93.5, "strike_zone_top": 3.184, "strike_zone_bottom": 1.607,
        "expect": {
            "release": (-0.3880610185109785, 16.481239607155988, 1.909993915477258),
            "v0_mps": 41.79489049849428, "theta_deg": -2.551528968597369,
            "phi_deg": 1.6468263794786124,
            "backspin_rpm": 1085.8596202310314, "sidespin_rpm": -722.6667867193172,
            "wg_rpm": 1977.8554897189608,
            "cross_x_in": -5.616342752323973, "cross_z_in": 30.872473447496354,
            "residual_x_in": -0.07968454262304281, "residual_z_in": 0.8161205716941353,
            "points": 416,
        },
    },
    "KC": {
        "at_bat": 3, "pitch_number": 1, "batter_hand": "R", "pitch_hand": "R",
        "pitch_type": "KC",
        "coordinates": {
            "x0": -1.625643331109103, "y0": 50.002669807060094, "z0": 6.275482409312761,
            "vX0": 3.1496810200256005, "vY0": -117.77600237218857, "vZ0": 1.3958379531559528,
            "aX": 1.0131555238837142, "aY": 22.840088590405763, "aZ": -40.03773031450353,
            "pfxX": 0.722819846724766, "pfxZ": -5.609340552773897,
            "pX": -0.1758452820315341, "pZ": 3.1667415981415266,
        },
        "extension": 6.287874892040119, "spin_rate": 2455, "spin_direction": 23,
        "start_speed": 80.9, "strike_zone_top": 3.138, "strike_zone_bottom": 1.584,
        "expect": {
            "release": (-0.5294944676546051, 16.52385573290617, 1.8898722167193343),
            "v0_mps": 36.168934953705005, "theta_deg": 1.3630901227319294,
            "phi_deg": 1.5039503443183027,
            "backspin_rpm": -771.2069406091128, "sidespin_rpm": 139.62214732929218,
            "wg_rpm": 2336.0203267761954,
            "cross_x_in": -2.0614061577449223, "cross_z_in": 35.611307649554604,
            "residual_x_in": 0.048737226633486674, "residual_z_in": -2.3895915281437112,
            "points": 481,
        },
    },
    "CU": {
        "at_bat": 58, "pitch_number": 1, "batter_hand": "R", "pitch_hand": "R",
        "pitch_type": "CU",
        "coordinates": {
            "x0": -1.5327563704457112, "y0": 50.005091751589326, "z0": 6.008653127109787,
            "vX0": 4.73178574379945, "vY0": -108.37815838573373, "vZ0": -0.8667949714271356,
            "aX": 4.334905396747138, "aY": 22.227463274292383, "aZ": -37.26799083299073,
            "pfxX": 3.713690074566162, "pfxZ": -4.36055761398494,
            "pX": 1.1772555039998829, "pZ": 1.465782949154159,
        },
        "extension": 5.9795000626959, "spin_rate": 2402, "spin_direction": 50,
        "start_speed": 74.5, "strike_zone_top": 3.118, "strike_zone_bottom": 1.574,
        "expect": {
            "release": (-0.5258815581013945, 16.61784838089029, 1.8326226754582378),
            "v0_mps": 33.34457102992433, "theta_deg": 0.3567066362386462,
            "phi_deg": 2.384645814054836,
            "backspin_rpm": -673.5956514386243, "sidespin_rpm": 522.5265666088345,
            "wg_rpm": 2287.790333994267,
            "cross_x_in": 14.335507257187553, "cross_z_in": 15.492650393499492,
            "residual_x_in": 0.20844120918895825, "residual_z_in": -2.0967449963504166,
            "points": 526,
        },
    },
}

# The simulator integrates at 1 ms and saves every step; both are part of the
# accuracy contract, not an implementation detail.
INTEGRATION_DT_S = 0.001


def _play_and_event(row):
    """The minimal live-feed shape ``_pitch_parameters_from_event`` reads."""
    play = {
        "about": {"atBatIndex": row["at_bat"]},
        "matchup": {
            "pitcherHand": {"code": row["pitch_hand"]},
            "batterHand": {"code": row["batter_hand"]},
            "pitcher": {"id": 200, "fullName": "Reference Pitcher"},
            "batter": {"id": 101, "fullName": "Reference Batter"},
        },
        "playEvents": [],
        "result": {"event": "Called Strike", "eventType": "strike_out"},
        "runners": [],
    }
    pitch_event = {
        "isPitch": True,
        "pitchNumber": row["pitch_number"],
        "details": {"type": {"code": row["pitch_type"]}, "call": {"code": "C"}},
        "pitchData": {
            "startSpeed": row["start_speed"],
            "strikeZoneTop": row["strike_zone_top"],
            "strikeZoneBottom": row["strike_zone_bottom"],
            "extension": row["extension"],
            "coordinates": dict(row["coordinates"]),
            "breaks": {
                "spinRate": row["spin_rate"],
                "spinDirection": row["spin_direction"],
            },
        },
    }
    return play, pitch_event


def _parse(name):
    row = REFERENCE_PITCHES[name]
    play, pitch_event = _play_and_event(row)
    return main._pitch_parameters_from_event(
        play, pitch_event, air_density_kg_m3=DEFAULT_AIR_DENSITY
    )


def _simulate(name):
    parsed = _parse(name)
    sim = main.FullBallTrajectorySimulator(integration_method=main.IntegrationMethod.RK4)
    sim.simulate(pitch=parsed["pitch"], env=main.DEFAULT_ENV, max_time=1.0, save_interval=1)
    return parsed, sim


class SimDensityTests(unittest.TestCase):
    def test_default_env_density_is_pinned(self):
        # The spin inversion and the forward integration must share this air.
        self.assertAlmostEqual(
            main._air_density_from_env(main.DEFAULT_ENV), DEFAULT_AIR_DENSITY, places=12
        )


class ReleasePointTests(unittest.TestCase):
    """Release position, speed and angles derived from the 50-ft kinematics."""

    def test_release_point_and_angles_are_pinned(self):
        for name in REFERENCE_PITCHES:
            row = REFERENCE_PITCHES[name]
            expect = row["expect"]
            with self.subTest(pitch=name):
                sim_params = _parse(name)["sim_params"]
                release = (
                    sim_params["x0"], sim_params["y0"], sim_params["z0"],
                )
                for axis, got, want in zip("xyz", release, expect["release"]):
                    self.assertAlmostEqual(
                        got, want, places=9,
                        msg=f"{name} release {axis} moved: {got!r} != {want!r}",
                    )
                self.assertAlmostEqual(sim_params["v0_mps"], expect["v0_mps"], places=6)
                self.assertAlmostEqual(sim_params["theta_deg"], expect["theta_deg"], places=6)
                self.assertAlmostEqual(sim_params["phi_deg"], expect["phi_deg"], places=6)

    def test_release_is_backpropagated_from_the_50ft_measurements(self):
        """Double-entry check of the release geometry.

        Recomputes the march from y=50 ft to the reported extension with the
        kinematic equations directly, independent of production code, so a sign
        or unit slip in ``_pitch_parameters_from_event`` cannot agree with it.
        """
        for name, row in REFERENCE_PITCHES.items():
            c = row["coordinates"]
            with self.subTest(pitch=name):
                y_release_ft = 60.5 - row["extension"]
                vy2 = c["vY0"] ** 2 + 2.0 * c["aY"] * (y_release_ft - c["y0"])
                self.assertGreaterEqual(vy2, 0.0)
                vy_release = -math.sqrt(vy2)
                t_release = (vy_release - c["vY0"]) / c["aY"]
                x_release_ft = c["x0"] + c["vX0"] * t_release + 0.5 * c["aX"] * t_release ** 2
                z_release_ft = c["z0"] + c["vZ0"] * t_release + 0.5 * c["aZ"] * t_release ** 2

                sim_params = _parse(name)["sim_params"]
                # y is exactly (60.5 - extension) * 0.3048; x/z come from the march.
                self.assertAlmostEqual(
                    sim_params["y0"], y_release_ft * 0.3048, places=12
                )
                self.assertAlmostEqual(
                    sim_params["x0"], x_release_ft * 0.3048, places=12
                )
                self.assertAlmostEqual(
                    sim_params["z0"], z_release_ft * 0.3048, places=12
                )
                # The release is always in front of the 50-ft measurement plane.
                self.assertGreater(sim_params["y0"], 50.0 * 0.3048)

    def test_more_extension_moves_the_release_toward_the_plate(self):
        row = REFERENCE_PITCHES["FF"]
        previous = None
        for extension in (5.5, 6.0, 6.5, 7.0):
            row = json.loads(json.dumps(row))
            row["extension"] = extension
            play, pitch_event = _play_and_event(row)
            parsed = main._pitch_parameters_from_event(
                play, pitch_event, air_density_kg_m3=DEFAULT_AIR_DENSITY
            )
            y0 = parsed["sim_params"]["y0"]
            self.assertAlmostEqual(y0, (60.5 - extension) * 0.3048, places=12)
            if previous is not None:
                self.assertLess(y0, previous)
            previous = y0


class SpinSplitTests(unittest.TestCase):
    """The backspin/sidespin/gyro decomposition of each pitch's measured spin."""

    def test_spin_split_is_pinned(self):
        for name, row in REFERENCE_PITCHES.items():
            expect = row["expect"]
            with self.subTest(pitch=name):
                sim_params = _parse(name)["sim_params"]
                self.assertAlmostEqual(
                    sim_params["backspin_rpm"], expect["backspin_rpm"], places=6
                )
                self.assertAlmostEqual(
                    sim_params["sidespin_rpm"], expect["sidespin_rpm"], places=6
                )
                self.assertAlmostEqual(sim_params["wg_rpm"], expect["wg_rpm"], places=6)

    def test_split_reconstructs_the_reported_total_spin_rate(self):
        """Whatever the split, its magnitude must be the feed's spin rate.

        The feed reports total spin only; the inversion apportions it. A split
        that no longer sums to the reported rate means the inversion changed
        scale (or the axis) rather than merely redistributing it.
        """
        for name, row in REFERENCE_PITCHES.items():
            with self.subTest(pitch=name):
                sp = _parse(name)["sim_params"]
                total = math.sqrt(
                    sp["backspin_rpm"] ** 2 + sp["sidespin_rpm"] ** 2 + sp["wg_rpm"] ** 2
                )
                self.assertAlmostEqual(
                    total / row["spin_rate"], 1.0, delta=0.03,
                    msg=f"{name}: split magnitude {total:.1f} rpm vs reported {row['spin_rate']} rpm",
                )

    def test_active_spin_never_exceeds_total_spin(self):
        """Invariant the payload's ``active_spin_rpm`` depends on."""
        for name in REFERENCE_PITCHES:
            with self.subTest(pitch=name):
                sp = _parse(name)["sim_params"]
                active = math.hypot(sp["backspin_rpm"], sp["sidespin_rpm"])
                total = math.sqrt(active ** 2 + sp["wg_rpm"] ** 2)
                self.assertLessEqual(active, total + 1e-9)
                self.assertTrue(math.isfinite(active) and math.isfinite(total))


class PlateCrossingAccuracyTests(unittest.TestCase):
    """Where the simulated ball crosses the front of the plate.

    ``cross_*_in`` are the calibrated model's absolute plate locations; the
    ``residual_*_in`` are its error against the feed's Hawkeye ``pX``/``pZ``.
    Both are pinned: a model change that moves the ball without also improving
    the residual should be a deliberate, re-pinned decision.
    """

    def test_front_plate_crossing_is_pinned(self):
        for name, row in REFERENCE_PITCHES.items():
            expect = row["expect"]
            with self.subTest(pitch=name):
                _, sim = _simulate(name)
                crossing = sim.home_plate_crossing_front
                self.assertIsNotNone(crossing, f"{name}: no front-plate crossing")
                x_in = crossing["x"] / 0.0254
                z_in = crossing["z"] / 0.0254
                self.assertAlmostEqual(x_in, expect["cross_x_in"], delta=0.01,
                                       msg=f"{name} front-plate x moved: {x_in:.4f} in")
                self.assertAlmostEqual(z_in, expect["cross_z_in"], delta=0.01,
                                       msg=f"{name} front-plate z moved: {z_in:.4f} in")

    def test_hawkeye_residual_is_pinned_and_bounded(self):
        for name, row in REFERENCE_PITCHES.items():
            expect = row["expect"]
            c = row["coordinates"]
            with self.subTest(pitch=name):
                _, sim = _simulate(name)
                crossing = sim.home_plate_crossing_front
                dx = crossing["x"] / 0.0254 - c["pX"] * 12.0
                dz = crossing["z"] / 0.0254 - c["pZ"] * 12.0
                self.assertAlmostEqual(dx, expect["residual_x_in"], delta=0.01,
                                       msg=f"{name} horizontal Hawkeye residual moved")
                self.assertAlmostEqual(dz, expect["residual_z_in"], delta=0.01,
                                       msg=f"{name} vertical Hawkeye residual moved")
                # Regression guard independent of the pin: no pitch may drift
                # far from the measured plate location.
                self.assertLess(abs(dx), 3.0, f"{name}: {dx:+.2f} in horizontal error")
                self.assertLess(abs(dz), 3.0, f"{name}: {dz:+.2f} in vertical error")

    def test_strike_zone_plane_is_the_front_of_the_plate(self):
        """pX/pZ are reported at the plate front; the sim must cross there first."""
        for name in REFERENCE_PITCHES:
            with self.subTest(pitch=name):
                _, sim = _simulate(name)
                front = sim.home_plate_crossing_front
                mid = sim.home_plate_crossing_mid
                self.assertIsNotNone(mid, f"{name}: no mid-plate crossing")
                # The front edge is closer to the pitcher, so its crossing time
                # precedes the mid-plane crossing, and the ball is higher there
                # (gravity always pulls it down over that span).
                self.assertLess(front["t"], mid["t"])
                self.assertGreater(front["z"], mid["z"])


class TrajectoryResolutionTests(unittest.TestCase):
    """The 1 ms sampling and the payload's first/last point."""

    def test_every_pitch_is_sampled_at_one_kilosecond(self):
        for name, row in REFERENCE_PITCHES.items():
            expect = row["expect"]
            with self.subTest(pitch=name):
                _, sim = _simulate(name)
                traj = sim.trajectory
                self.assertAlmostEqual(len(traj), expect["points"], delta=2,
                                       msg=f"{name}: point count changed")
                deltas = {
                    round(b["t"] - a["t"], 9) for a, b in zip(traj, traj[1:])
                }
                self.assertEqual(deltas, {INTEGRATION_DT_S},
                                 f"{name}: non-uniform sampling {sorted(deltas)[:5]}")
                # Every saved point carries the full state the frontend reads.
                for key in ("x", "y", "z", "vx", "vy", "vz", "ax", "ay", "az", "v", "v_mph",
                            "distance", "height"):
                    self.assertIn(key, traj[0], f"{name}: missing trajectory field {key}")

    def test_first_point_is_the_release_point_and_speed(self):
        for name in REFERENCE_PITCHES:
            with self.subTest(pitch=name):
                parsed, sim = _simulate(name)
                sp = parsed["sim_params"]
                first = sim.trajectory[0]
                self.assertEqual((first["x"], first["y"], first["z"]),
                                 (sp["x0"], sp["y0"], sp["z0"]))
                self.assertAlmostEqual(first["t"], 0.0, places=12)
                self.assertAlmostEqual(first["v_mph"], sp["v0_mps"] / 0.44704, places=9)

    def test_trajectory_finishes_past_the_plate(self):
        for name in REFERENCE_PITCHES:
            with self.subTest(pitch=name):
                _, sim = _simulate(name)
                self.assertLessEqual(sim.trajectory[-1]["y"], 0.0)
                self.assertGreater(sim.trajectory[0]["y"], 15.0)


class PayloadPassthroughTests(unittest.TestCase):
    """The payload the frontend consumes carries these values unmodified."""

    @classmethod
    def setUpClass(cls):
        with FIXTURE_PATH.open(encoding="utf-8") as fh:
            cls.feed = json.load(fh)

    def _payload(self, tracking=None):
        play, pitch_event, pitch_index = main._latest_simulatable_pitch(self.feed)
        with mock.patch.object(
            main, "_compute_xba", return_value=0.321
        ), mock.patch.object(
            main, "_sprint_speed_for_batter", return_value=None
        ), mock.patch.object(
            main, "_bat_tracking_for_pitch",
            return_value=tracking or {"swing_path_tilt": None, "attack_angle": None},
        ), mock.patch.object(
            main, "_fetch_savant_rows", return_value=[]
        ), mock.patch.object(
            main, "_build_hit_payload", return_value={"play_id": "fixture-hit"}
        ):
            return main._build_pitch_payload(
                self.feed, play, pitch_event, pitch_index,
                main.DEFAULT_ENV, main.DEFAULT_ENV_META, "fixture-game",
            ), play, pitch_event

    def test_hawkeye_plate_location_is_passed_through_verbatim(self):
        payload, _, pitch_event = self._payload()
        coords = pitch_event["pitchData"]["coordinates"]
        self.assertEqual(payload["statcast_px"], coords["pX"])
        self.assertEqual(payload["statcast_pz"], coords["pZ"])
        # The mid-plane values are the payload's own 50-ft kinematics, and they
        # sit inside the strike zone for this pitch (sanity, not a pin).
        self.assertIsNotNone(payload["statcast_px_mid"])
        self.assertIsNotNone(payload["statcast_pz_mid"])

    def test_strike_zone_is_passed_through(self):
        payload, _, pitch_event = self._payload()
        self.assertEqual(payload["strike_zone_top"], pitch_event["pitchData"]["strikeZoneTop"])
        self.assertEqual(payload["strike_zone_bottom"],
                         pitch_event["pitchData"]["strikeZoneBottom"])
        self.assertEqual(payload["speed_mph"], pitch_event["pitchData"]["startSpeed"])

    def test_player_heights_are_parsed_from_the_feed(self):
        payload, play, _ = self._payload()
        self.assertEqual(payload["batter_height"], 74)   # ID101: 6' 2"
        self.assertEqual(payload["pitcher_height"], 76)  # ID200: 6' 4"

    def test_bat_tracking_values_reach_the_payload_verbatim(self):
        tracking = {"swing_path_tilt": 31.5, "attack_angle": 12.25}
        payload, _, _ = self._payload(tracking=tracking)
        self.assertEqual(payload["swing_path_tilt"], 31.5)
        self.assertEqual(payload["attack_angle"], 12.25)

    def test_missing_bat_tracking_stays_null(self):
        payload, _, _ = self._payload()
        self.assertIsNone(payload["swing_path_tilt"])
        self.assertIsNone(payload["attack_angle"])

    def test_active_spin_is_the_transverse_part_of_the_split(self):
        payload, _, _ = self._payload()
        sp = payload["sim_params"]
        self.assertAlmostEqual(
            payload["active_spin_rpm"],
            math.hypot(sp["backspin_rpm"], sp["sidespin_rpm"]),
            places=9,
        )
        efficiency = payload["spin_efficiency"]
        if efficiency is not None:
            self.assertGreaterEqual(efficiency, 0.0)
            self.assertLessEqual(efficiency, 1.0)

    def test_payload_trajectory_is_the_full_resolution_simulation(self):
        payload, _, _ = self._payload()
        traj = payload["trajectory"]
        self.assertGreater(len(traj), 300)
        deltas = {round(b["t"] - a["t"], 9) for a, b in zip(traj, traj[1:])}
        self.assertEqual(deltas, {INTEGRATION_DT_S})
        sp = payload["sim_params"]
        self.assertEqual((traj[0]["x"], traj[0]["y"], traj[0]["z"]),
                         (sp["x0"], sp["y0"], sp["z0"]))
        self.assertEqual(traj, payload["trajectory"])

    def test_quadratic_reference_curve_is_a_separate_coarse_fit(self):
        """``quadratic_trajectory`` is the 5 ms closed-form fit, not the sim."""
        payload, _, _ = self._payload()
        quad = payload["quadratic_trajectory"]
        self.assertGreater(len(quad), 10)
        deltas = {round(b["t"] - a["t"], 9) for a, b in zip(quad, quad[1:])}
        self.assertEqual(deltas, {0.005})
        self.assertNotEqual(len(quad), len(payload["trajectory"]))


class HeightParsingTests(unittest.TestCase):
    def test_standard_height_strings(self):
        self.assertEqual(main._parse_height_inches('6\' 2"'), 74)
        self.assertEqual(main._parse_height_inches('5\' 11"'), 71)
        self.assertEqual(main._parse_height_inches('6\' 0"'), 72)
        self.assertEqual(main._parse_height_inches("6'"), 72)

    def test_malformed_height_strings_return_none(self):
        self.assertIsNone(main._parse_height_inches(None))
        self.assertIsNone(main._parse_height_inches(""))
        self.assertIsNone(main._parse_height_inches("unknown"))


if __name__ == "__main__":
    unittest.main()
