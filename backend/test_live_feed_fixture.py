"""Offline regression tests for a representative MLB live-feed response.

The live endpoints normally read a large, changing Stats API document. This
fixture keeps the important feed shapes in the repository so parser behavior
can be checked without network access or a running server.
"""

import copy
import json
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
LAGGING_SPIN_FIXTURE_PATH = (
    Path(__file__).with_name("fixtures") / "live_feed_lagging_spin.json"
)
LAGGING_METADATA_FIXTURE_PATH = (
    Path(__file__).with_name("fixtures") / "live_feed_lagging_metadata.json"
)


class _FixtureResponse:
    status_code = 200

    def __init__(self, data):
        self._data = data

    def json(self):
        return copy.deepcopy(self._data)



def _load_fixture(path=FIXTURE_PATH):
    with path.open(encoding="utf-8") as fixture_file:
        return json.load(fixture_file)


class LiveFeedFixtureTests(unittest.TestCase):
    def setUp(self):
        self.feed = _load_fixture()
        with main._TRAJECTORY_CACHE_GUARD:
            main._TRAJECTORY_CACHE.clear()
            main._TRAJECTORY_BUILD_LOCKS.clear()
        with main._BATTED_BALL_CACHE_GUARD:
            main._BATTED_BALL_CACHE.clear()
            main._BATTED_BALL_BUILD_LOCKS.clear()

    def test_fixture_contains_the_latest_simulatable_pitch_and_hit(self):
        play, pitch, pitch_index = main._latest_simulatable_pitch(self.feed)
        self.assertEqual(play["about"]["atBatIndex"], 42)
        self.assertEqual(pitch["pitchNumber"], 2)
        self.assertEqual(pitch_index, 1)
        self.assertTrue(main._pitch_is_simulatable(pitch))

        hit_play, hit_data, hit_index = main._latest_batted_ball(self.feed)
        self.assertIs(hit_play, play)
        self.assertEqual(hit_index, pitch_index)
        self.assertEqual(hit_data["launchSpeed"], 101.4)

    def test_game_status_endpoint_is_lightweight_and_tracks_delay(self):
        with mock.patch.object(
            main.requests,
            "get",
            return_value=_FixtureResponse(self.feed),
        ):
            live_status = main.get_game_status(game_pk="fixture-game")

        self.assertEqual(live_status["gameState"], "In Progress")
        self.assertTrue(live_status["isLive"])
        self.assertEqual(live_status["pitcher"], "Fixture Pitcher")
        self.assertEqual(live_status["pitcherId"], 200)
        self.assertNotIn("score", live_status)
        self.assertNotIn("count", live_status)

        delayed_feed = copy.deepcopy(self.feed)
        delayed_feed["gameData"]["status"]["detailedState"] = "Rain Delay"
        delayed_feed["liveData"]["plays"]["currentPlay"]["matchup"] = {}
        with mock.patch.object(
            main.requests,
            "get",
            return_value=_FixtureResponse(delayed_feed),
        ):
            delayed_status = main.get_game_status(game_pk="fixture-game")

        self.assertEqual(delayed_status["gameState"], "Rain Delay")
        self.assertEqual(delayed_status["pitcher"], "Fixture Pitcher")
        self.assertEqual(delayed_status["pitcherId"], 200)

    def test_trajectory_endpoint_falls_back_when_latest_spin_metadata_lags(self):
        lagging_feed = _load_fixture(LAGGING_SPIN_FIXTURE_PATH)
        events = lagging_feed["liveData"]["plays"]["allPlays"][0]["playEvents"]
        self.assertFalse(main._pitch_is_simulatable(events[-1]))
        self.assertTrue(main._pitch_is_simulatable(events[-2]))

        selected = {}

        def fake_pitch_payload(data, play, pitch_event, pitch_index,
                               env, env_meta, game_pk):
            selected.update({
                "pitch_number": pitch_event["pitchNumber"],
                "pitch_index": pitch_index,
            })
            return {
                "success": True,
                "play_id": f"AB{play['about']['atBatIndex']}-P{pitch_event['pitchNumber']}",
            }

        response = _FixtureResponse(lagging_feed)
        with mock.patch.object(main.requests, "get", return_value=response), \
             mock.patch.object(main, "_build_pitch_payload", side_effect=fake_pitch_payload) as build:
            payload = main.get_trajectory(env="default", game_pk="lagging-game")

        self.assertTrue(payload["success"])
        self.assertEqual(payload["play_id"], "AB77-P4")
        self.assertTrue(payload["waiting_for_pitch_data"])
        self.assertEqual(payload["pending_pitch_id"], "AB77-P5")
        self.assertEqual(payload["pending_pitch_number"], 5)
        self.assertEqual(selected, {"pitch_number": 4, "pitch_index": 0})
        build.assert_called_once()

    def test_trajectory_skips_each_incomplete_metadata_shape(self):
        lagging_feed = _load_fixture(LAGGING_METADATA_FIXTURE_PATH)
        events = lagging_feed["liveData"]["plays"]["allPlays"][0]["playEvents"]
        self.assertTrue(main._pitch_is_simulatable(events[0]))
        self.assertFalse(main._pitch_is_simulatable(events[1]))  # coordinates lag
        self.assertFalse(main._pitch_is_simulatable(events[2]))  # spin lags
        self.assertFalse(main._pitch_is_simulatable(events[3]))  # both lag

        selected = {}

        def fake_pitch_payload(data, play, pitch_event, pitch_index,
                               env, env_meta, game_pk):
            selected.update({
                "pitch_number": pitch_event["pitchNumber"],
                "pitch_index": pitch_index,
            })
            return {
                "success": True,
                "play_id": f"AB{play['about']['atBatIndex']}-P{pitch_event['pitchNumber']}",
            }

        response = _FixtureResponse(lagging_feed)
        with mock.patch.object(main.requests, "get", return_value=response), \
             mock.patch.object(main, "_build_pitch_payload", side_effect=fake_pitch_payload):
            payload = main.get_trajectory(env="default", game_pk="metadata-lag-game")

        self.assertEqual(payload["play_id"], "AB78-P10")
        self.assertTrue(payload["waiting_for_pitch_data"])
        self.assertEqual(payload["pending_pitch_id"], "AB78-P13")
        self.assertEqual(selected, {"pitch_number": 10, "pitch_index": 0})

    def test_scoreboard_snapshot_stops_before_a_later_play(self):
        feed = copy.deepcopy(self.feed)
        plays = feed["liveData"]["plays"]["allPlays"]
        queued_play = plays[1]
        queued_pitch = queued_play["playEvents"][1]
        queued_play["runners"].append({
            "details": {"runner": {"id": 400}},
            "movement": {
                "start": "3B",
                "end": "score",
                "isOut": False,
                "isScoringEvent": True,
            },
            "credits": [],
        })
        plays.append({
            "about": {
                "atBatIndex": 43,
                "inning": 5,
                "halfInning": "top",
                "isComplete": True,
            },
            "matchup": queued_play["matchup"],
            "playEvents": [],
        })
        feed["liveData"]["linescore"]["teams"]["away"]["runs"] = 2

        snapshot = main._game_state_snapshot(
            feed, queued_play, queued_pitch, pitch_index=1
        )

        # The later play has already advanced the live linescore to two runs,
        # but the queued pitch's snapshot contains only the one run scored
        # through that pitch. This is the state the scorebug commits first.
        self.assertEqual(snapshot["score"]["away"]["runs"], 1)
        self.assertEqual(snapshot["count"], {"balls": 0, "strikes": 0})

    def test_scoreboard_snapshot_reports_outs_recorded_by_a_completed_play(self):
        feed = copy.deepcopy(self.feed)
        plays = feed["liveData"]["plays"]["allPlays"]
        target_play = plays[1]  # AB42 single, complete in the feed
        target_pitch = target_play["playEvents"][1]  # its final pitch
        # The pitch's count records the outs BEFORE the at-bat (0). Put a
        # runner out on the play so the resolved snapshot must show 1 out —
        # the state the scorebug commits after this play finishes animating.
        target_play["runners"].append({
            "details": {"runner": {"id": 401}},
            "movement": {"start": "2B", "end": "3B", "isOut": True, "outNumber": 1},
            "credits": [],
        })

        snapshot = main._game_state_snapshot(
            feed, target_play, target_pitch, pitch_index=1
        )

        self.assertEqual(snapshot["outs"], 1)

    def test_scoreboard_snapshot_keeps_pre_play_outs_for_queued_mid_atbat_pitch(self):
        feed = copy.deepcopy(self.feed)
        plays = feed["liveData"]["plays"]["allPlays"]
        target_play = plays[1]  # AB42, complete in the feed but two pitches long
        target_pitch = target_play["playEvents"][0]  # the earlier pitch
        target_play["runners"].append({
            "details": {"runner": {"id": 401}},
            "movement": {"start": "2B", "end": "3B", "isOut": True, "outNumber": 1},
            "credits": [],
        })

        # A queued mid-at-bat pitch is snapshotted as of that pitch, before the
        # play resolved — the play's recorded out must not leak into it.
        snapshot = main._game_state_snapshot(
            feed, target_play, target_pitch, pitch_index=0
        )

        self.assertEqual(snapshot["outs"], 0)

    def test_batted_ball_endpoint_builds_the_fixture_hit_payload(self):
        response = _FixtureResponse(self.feed)
        with mock.patch.object(main.requests, "get", return_value=response), \
             mock.patch.object(main, "_sprint_speed_for_batter", return_value=None), \
             mock.patch.object(main, "_compute_xba", return_value=0.321):
            payload = main.get_batted_ball(game_pk="fixture-game")

        self.assertTrue(payload["success"])
        self.assertEqual(payload["play_id"], "AB42-EV1")
        self.assertEqual(payload["pitch_play_id"], "AB42-P2")
        self.assertEqual(payload["event"], "Single")
        self.assertEqual(payload["fielder"], "CF")
        self.assertFalse(payload["was_caught"])
        self.assertEqual(payload["launch_speed"], 101.4)
        self.assertEqual(payload["launch_angle"], 18.0)
        self.assertEqual(payload["xba"], 0.321)
        self.assertIsNotNone(payload["spray_angle"])
        self.assertEqual(payload["total_outs"], 0)

    def test_at_bat_endpoint_classifies_and_replays_fixture_pitches(self):
        response = _FixtureResponse(self.feed)

        def fake_pitch_payload(data, play, pitch_event, pitch_index,
                               env, env_meta, game_pk):
            call_code = pitch_event["details"]["call"]["code"]
            return {
                "play_id": f"AB{play['about']['atBatIndex']}-P{pitch_event['pitchNumber']}",
                "is_contact": call_code in {"X", "E", "D", "F", "L"},
                "statcast_px_mid": pitch_event["pitchData"]["coordinates"]["pX"],
                "statcast_pz_mid": pitch_event["pitchData"]["coordinates"]["pZ"],
            }

        with mock.patch.object(main.requests, "get", return_value=response), \
             mock.patch.object(main, "_build_pitch_payload", side_effect=fake_pitch_payload), \
             mock.patch.object(main, "_sprint_speed_for_batter", return_value=None), \
             mock.patch.object(main, "_compute_xba", return_value=0.321):
            payload = main.get_at_bat(at_bat_index=42, game_pk="fixture-game")

        self.assertTrue(payload["success"])
        self.assertEqual(payload["at_bat_index"], 42)
        self.assertEqual(payload["strike_zone_top"], 3.45)
        self.assertEqual(len(payload["pitches"]), 2)

        first, second = payload["pitches"]
        self.assertEqual(first["outcome"], "strike")
        self.assertFalse(first["is_contact"])
        self.assertTrue(first["replayable"])
        self.assertFalse(first["is_at_bat_final"])

        self.assertEqual(second["outcome"], "in_play")
        self.assertTrue(second["is_contact"])
        self.assertTrue(second["is_at_bat_final"])
        self.assertEqual(second["result_event"], "Single")
        self.assertIsNotNone(second["hit"])
        self.assertEqual(second["hit"]["play_id"], "AB42-EV1")

    def test_trajectory_queued_payloads_mark_the_at_bat_final_pitch(self):
        # Catching up through the queue returns the intervening mid-at-bat pitch
        # (AB42-P1). It must carry ``is_at_bat_final=False`` so the frontend
        # falls back to that pitch's own called-strike outcome instead of
        # surfacing the at-bat's final "Single" result early.
        response = _FixtureResponse(self.feed)
        with mock.patch.object(main.requests, "get", return_value=response), \
             mock.patch.object(
                 main, "_bat_tracking_for_pitch",
                 return_value={"swing_path_tilt": None, "attack_angle": None},
             ), \
             mock.patch.object(main, "_sprint_speed_for_batter", return_value=None):
            payload = main.get_trajectory(
                env="default", game_pk="fixture-game", after_play_id="AB41-P1"
            )

        # The newest play (AB42-P2) is the at-bat's final pitch.
        self.assertEqual(payload["play_id"], "AB42-P2")
        self.assertTrue(payload["is_at_bat_final"])

        queued = payload["queued_trajectories"]
        self.assertEqual([q["play_id"] for q in queued], ["AB42-P1"])
        self.assertFalse(queued[0]["is_at_bat_final"])
        self.assertEqual(queued[0]["result_event"], "Single")

    def test_game_state_endpoint_replays_fixture_score_count_and_bases(self):
        response = _FixtureResponse(self.feed)
        with mock.patch.object(main.requests, "get", return_value=response):
            payload = main.get_game_state(game_pk="fixture-game")

        self.assertTrue(payload["success"])
        self.assertEqual(payload["teams"]["away"]["abbreviation"], "AWY")
        self.assertEqual(payload["teams"]["home"]["abbreviation"], "HME")
        self.assertEqual(payload["score"]["away"]["runs"], 3)
        self.assertEqual(payload["inning"]["number"], 5)
        self.assertTrue(payload["inning"]["isTop"])
        self.assertEqual(payload["outs"], 0)
        self.assertEqual(payload["count"], {"balls": 1, "strikes": 1})
        self.assertEqual(payload["bases"], ["1B", "2B"])
        self.assertEqual(payload["pitchesThrown"], 3)
        self.assertEqual(payload["batter"], "Fixture Batter")
        self.assertEqual(payload["batterLine"], {"atBats": 3, "hits": 1})
        self.assertEqual(payload["gameState"], "In Progress")
        self.assertTrue(payload["isLive"])

    def test_batter_pitches_endpoint_groups_all_at_bats_by_pitcher(self):
        # The fixture only has one at-bat for batter 101, so extend it with a
        # second at-bat facing a different pitcher to exercise the whole-game
        # aggregation and per-pitcher grouping.
        feed = copy.deepcopy(self.feed)
        second_at_bat = {
            "about": {
                "atBatIndex": 43,
                "inning": 7,
                "halfInning": "top",
                "isComplete": True,
            },
            "matchup": {
                "pitcher": {"id": 999, "fullName": "Relief Pitcher"},
                "batter": {"id": 101, "fullName": "Fixture Batter"},
            },
            "result": {"type": "atBat", "event": "Strikeout", "eventType": "strikeout"},
            "runners": [],
            "playEvents": [
                {
                    "isPitch": True,
                    "pitchNumber": 1,
                    "details": {
                        "type": {"code": "SL", "description": "Slider"},
                        "call": {"code": "S"},
                    },
                    "pitchData": {
                        "startSpeed": 85.1,
                        "strikeZoneTop": 3.45,
                        "strikeZoneBottom": 1.55,
                        "coordinates": {"pX": -0.4, "pZ": 3.1},
                    },
                },
                {
                    "isPitch": True,
                    "pitchNumber": 2,
                    "details": {
                        "type": {"code": "SL", "description": "Slider"},
                        "call": {"code": "S"},
                    },
                    "pitchData": {
                        "startSpeed": 84.8,
                        "strikeZoneTop": 3.45,
                        "strikeZoneBottom": 1.55,
                        "coordinates": {"pX": 0.1, "pZ": 2.3},
                    },
                },
                {
                    "isPitch": True,
                    "pitchNumber": 3,
                    "details": {
                        "type": {"code": "CU", "description": "Curveball"},
                        "call": {"code": "S"},
                    },
                    "pitchData": {
                        "startSpeed": 77.0,
                        "strikeZoneTop": 3.45,
                        "strikeZoneBottom": 1.55,
                        "coordinates": {"pX": 0.6, "pZ": 1.7},
                    },
                },
            ],
        }
        feed["liveData"]["plays"]["allPlays"].append(second_at_bat)
        response = _FixtureResponse(feed)

        with mock.patch.object(main.requests, "get", return_value=response):
            payload = main.get_batter_pitches(at_bat_index=42, game_pk="fixture-game")

        self.assertTrue(payload["success"])
        self.assertEqual(payload["batter"], "Fixture Batter")
        self.assertEqual(payload["batter_id"], 101)
        self.assertEqual(payload["strike_zone_top"], 3.45)
        self.assertEqual(payload["strike_zone_bottom"], 1.55)

        # All five pitches thrown to batter 101 across both at-bats, in order.
        self.assertEqual(len(payload["pitches"]), 5)
        self.assertEqual(payload["pitches"][0]["at_bat_index"], 42)
        # The fixture's first pitch has no details.type; later ones do.
        self.assertIsNone(payload["pitches"][0]["pitch_type"])
        self.assertEqual(payload["pitches"][1]["pitch_type"], "FF")
        self.assertEqual(payload["pitches"][0]["pitcher"], "Fixture Pitcher")
        self.assertEqual(payload["pitches"][0]["speed_mph"], 94.2)
        self.assertEqual(payload["pitches"][3]["at_bat_index"], 43)
        self.assertEqual(payload["pitches"][3]["pitch_type"], "SL")
        self.assertEqual(payload["pitches"][3]["speed_mph"], 84.8)
        self.assertEqual(payload["pitches"][4]["at_bat_index"], 43)
        self.assertEqual(payload["pitches"][4]["pitch_type"], "CU")
        self.assertTrue(payload["pitches"][4]["is_at_bat_final"])

        # Pitchers are listed in first-appearance order with pitch counts, and
        # the earlier batter's at-bat (AB41) is excluded.
        self.assertEqual(
            [p["pitcher"] for p in payload["pitchers"]],
            ["Fixture Pitcher", "Relief Pitcher"],
        )
        self.assertEqual(payload["pitchers"][0]["pitches"], 2)
        self.assertEqual(payload["pitchers"][1]["pitches"], 3)
        self.assertNotIn(41, {p["at_bat_index"] for p in payload["pitches"]})

        # A pitch without full simulation data is still listed (game view only
        # needs location/type), just not replayable.
        self.assertTrue(payload["pitches"][0]["replayable"])
        self.assertFalse(payload["pitches"][3]["replayable"])

    def test_batter_pitches_endpoint_404s_for_unknown_at_bat(self):
        response = _FixtureResponse(self.feed)
        with mock.patch.object(main.requests, "get", return_value=response):
            with self.assertRaises(Exception) as ctx:
                main.get_batter_pitches(at_bat_index=999, game_pk="fixture-game")
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("not found", str(ctx.exception.detail))


if __name__ == "__main__":
    unittest.main()
