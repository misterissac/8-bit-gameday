"""Offline regression tests for a representative MLB live-feed response.

The live endpoints normally read a large, changing Stats API document. This
fixture keeps the important feed shapes in the repository so parser behavior
can be checked without network access or a running server.
"""

import copy
import json
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

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
            main._TRAJECTORY_BUILD_LOCKS_LAST_USED.clear()
        with main._BATTED_BALL_CACHE_GUARD:
            main._BATTED_BALL_CACHE.clear()
            main._BATTED_BALL_BUILD_LOCKS.clear()
            main._BATTED_BALL_BUILD_LOCKS_LAST_USED.clear()

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

        with mock.patch.object(main, "_fetch_savant_rows", return_value=[]):
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

        with mock.patch.object(main, "_fetch_savant_rows", return_value=[]):
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
        with mock.patch.object(main, "_fetch_savant_rows", return_value=[]):
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

    def test_batted_ball_payload_includes_fielder_name(self):
        """The batted ball carries the player name for its chaser position, so
        the fielder-cam's top-left pill (``battedBallData.fielderName``) can
        show the fielder instead of '—'."""
        feed = copy.deepcopy(self.feed)
        feed['liveData']['linescore']['defense'] = {
            "pitcher": {"id": 200, "fullName": "Fixture Pitcher"},
            "catcher": {"id": 96, "fullName": "Fixture Catcher"},
            "first": {"id": 101, "fullName": "Fixture First"},
            "second": {"id": 102, "fullName": "Fixture Second"},
            "third": {"id": 103, "fullName": "Fixture Third"},
            "shortstop": {"id": 104, "fullName": "Fixture Short"},
            "left": {"id": 105, "fullName": "Fixture Left"},
            "center": {"id": 100, "fullName": "Aaron Judge"},
            "right": {"id": 106, "fullName": "Fixture Right"},
        }
        # Patch _fetch_feed (not requests.get) so the defensive linescore block
        # reaches the builder regardless of the 1s feed-cache TTL shared across
        # sibling tests.
        with mock.patch.object(main, "_fetch_feed", return_value=feed), \
             mock.patch.object(main, "_sprint_speed_for_batter", return_value=None), \
             mock.patch.object(main, "_compute_xba", return_value=0.321):
            payload = main.get_batted_ball(game_pk="fixture-game")

        self.assertEqual(payload["fielder"], "CF")
        self.assertEqual(payload["fielderName"], "Aaron Judge")
        self.assertEqual(payload["fielder_name"], "Aaron Judge")

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

    def test_at_bat_game_state_before_reflects_the_state_before_each_pitch(self):
        response = _FixtureResponse(self.feed)

        def fake_pitch_payload(data, play, pitch_event, pitch_index,
                               env, env_meta, game_pk):
            return {
                "play_id": f"AB{play['about']['atBatIndex']}-P{pitch_event['pitchNumber']}",
                "is_contact": False,
            }

        with mock.patch.object(main.requests, "get", return_value=response), \
             mock.patch.object(main, "_build_pitch_payload", side_effect=fake_pitch_payload):
            payload = main.get_at_bat(at_bat_index=42, game_pk="fixture-game")

        self.assertEqual(len(payload["pitches"]), 2)

        # Before the at-bat's first pitch: 0-0 count, the runner from the
        # previous walk still on first, the pitcher at one pitch, and no runs
        # from this at-bat yet (the feed's final away score is 3).
        before_first = payload["pitches"][0]["pitch"]["game_state_before"]
        self.assertEqual(before_first["count"], {"balls": 0, "strikes": 0})
        self.assertEqual(before_first["outs"], 0)
        self.assertEqual(before_first["bases"], ["1B"])
        self.assertEqual(before_first["pitchesThrown"], 1)
        self.assertEqual(before_first["score"]["away"]["runs"], 0)

        # Before the second pitch: the count and pitch total have advanced,
        # and the at-bat's own result/baserunning still hasn't applied.
        before_second = payload["pitches"][1]["pitch"]["game_state_before"]
        self.assertEqual(before_second["count"], {"balls": 0, "strikes": 1})
        self.assertEqual(before_second["bases"], ["1B"])
        self.assertEqual(before_second["pitchesThrown"], 2)
        self.assertEqual(before_second["score"]["away"]["runs"], 0)

    def test_at_bat_game_state_carries_defensive_alignment_snapshot(self):
        feed = copy.deepcopy(self.feed)
        linescore = feed['liveData']['linescore']
        linescore['defense'] = {
            'pitcher': {'id': 91, 'fullName': 'Nestor Cortes'},
            'catcher': {'id': 92, 'fullName': 'Austin Wells'},
            'first': {'id': 93, 'fullName': 'Ben Rice'},
            'second': {'id': 94, 'fullName': 'Jazz Chisholm Jr.'},
            'third': {'id': 95, 'fullName': 'Jon Berti'},
            'shortstop': {'id': 96, 'fullName': 'Anthony Volpe'},
            'left': {'id': 97, 'fullName': 'Alex Verdugo'},
            'center': {'id': 98, 'fullName': 'Aaron Judge'},
            'right': {'id': 99, 'fullName': 'Juan Soto'},
            'defensiveAlignment': 'Strategic',
        }
        response = _FixtureResponse(feed)

        def fake_pitch_payload(data, play, pitch_event, pitch_index,
                               env, env_meta, game_pk):
            return {
                "play_id": f"AB{play['about']['atBatIndex']}-P{pitch_event['pitchNumber']}",
                "is_contact": False,
            }

        with mock.patch.object(main.requests, "get", return_value=response), \
             mock.patch.object(main, "_build_pitch_payload", side_effect=fake_pitch_payload):
            payload = main.get_at_bat(at_bat_index=42, game_pk="fixture-game")

        game_state = payload["pitches"][0]["pitch"]["game_state_before"]
        self.assertEqual(game_state["defenseFormation"], "Strategic")
        self.assertEqual(len(game_state["defenseAlignment"]), 9)
        # The linescore's defense block is the CURRENT alignment, and the
        # replayed at-bat's own matchup supplies the pitcher who threw it.
        self.assertEqual(game_state["defenseAlignment"]["P"]["name"], "Fixture Pitcher")
        self.assertEqual(game_state["defenseAlignment"]["SS"]["id"], 96)
        # The before-pitch snapshot carries the same alignment so rewind mode
        # can drive the defense panel from either.
        before = payload["pitches"][0]["pitch"]["game_state_before"]
        self.assertEqual(before["defenseFormation"], "Strategic")
        self.assertEqual(before["defenseAlignment"]["CF"]["name"], "Aaron Judge")

    def test_at_bat_game_state_reconstructs_the_alignment_before_a_defensive_sub(self):
        # The feed's linescore.defense only ever holds the CURRENT alignment.
        # Rewinding an at-bat must recover the alignment as of that at-bat by
        # undoing the substitutions that happened after it, so the fielder
        # names on the defense panel actually change in rewind mode.
        feed = copy.deepcopy(self.feed)
        linescore = feed["liveData"]["linescore"]
        # Current (post-sub) alignment: Anthony Volpe is the shortstop.
        linescore["defense"] = {
            "pitcher": {"id": 91, "fullName": "Nestor Cortes"},
            "catcher": {"id": 92, "fullName": "Austin Wells"},
            "first": {"id": 93, "fullName": "Ben Rice"},
            "second": {"id": 94, "fullName": "Jazz Chisholm Jr."},
            "third": {"id": 95, "fullName": "Jon Berti"},
            "shortstop": {"id": 98, "fullName": "Anthony Volpe"},
            "left": {"id": 97, "fullName": "Alex Verdugo"},
            "center": {"id": 99, "fullName": "Aaron Judge"},
            "right": {"id": 96, "fullName": "Juan Soto"},
        }
        # A defensive substitution happened AFTER the replayed at-bat (AB 42):
        # Anthony Volpe replaced shortstop Juan Soto. Rewind mode must show the
        # pre-sub lineup, not today's.
        plays = feed["liveData"]["plays"]["allPlays"]
        sub_play = copy.deepcopy(plays[-1])
        sub_play["about"]["atBatIndex"] = 43
        sub_play["playEvents"] = [{
            "details": {
                "eventType": "defensive_substitution",
                "description": "Defensive Substitution: Anthony Volpe replaces shortstop Juan Soto, batting 9th, playing shortstop.",
            },
            "type": "action",
            "isSubstitution": True,
            "player": {"id": 98},
            "replacedPlayer": {"id": 96},
            "position": {"abbreviation": "SS"},
        }]
        plays.append(sub_play)
        # Boxscore entries so the reconstruction can name the outgoing player.
        box_players = feed["liveData"]["boxscore"]["teams"]["home"]["players"]
        box_players["ID96"] = {"person": {"id": 96, "fullName": "Juan Soto"}}
        box_players["ID98"] = {"person": {"id": 98, "fullName": "Anthony Volpe"}}
        response = _FixtureResponse(feed)

        def fake_pitch_payload(data, play, pitch_event, pitch_index,
                               env, env_meta, game_pk):
            return {
                "play_id": f"AB{play['about']['atBatIndex']}-P{pitch_event['pitchNumber']}",
                "is_contact": False,
            }

        with mock.patch.object(main.requests, "get", return_value=response), \
             mock.patch.object(main, "_build_pitch_payload", side_effect=fake_pitch_payload):
            payload = main.get_at_bat(at_bat_index=42, game_pk="fixture-game")

        before = payload["pitches"][0]["pitch"]["game_state_before"]
        # The sub happened after AB 42, so its snapshot keeps the pre-sub SS.
        self.assertEqual(before["defenseAlignment"]["SS"], {"id": 96, "name": "Juan Soto"})
        # The pitcher slot reflects who actually threw the replayed at-bat.
        self.assertEqual(before["defenseAlignment"]["P"], {"id": 200, "name": "Fixture Pitcher"})
        # The current linescore still reports the post-sub shortstop.
        self.assertEqual(linescore["defense"]["shortstop"]["id"], 98)

    def test_at_bat_snapshot_reconstructs_the_other_team_from_its_starting_lineup(self):
        # The linescore's defense belongs to the CURRENT half-inning's team (the
        # home team here). An at-bat from the other half had the AWAY team in the
        # field, which the linescore can't show — the snapshot must rebuild that
        # team's alignment from its starting lineup instead of falling back to
        # the live (home) lineup, so rewind mode shows the true historical
        # fielders for either half.
        feed = copy.deepcopy(self.feed)
        linescore = feed["liveData"]["linescore"]
        linescore["defense"] = {
            "pitcher": {"id": 91, "fullName": "Nestor Cortes"},
            "catcher": {"id": 92, "fullName": "Austin Wells"},
            "first": {"id": 93, "fullName": "Ben Rice"},
            "second": {"id": 94, "fullName": "Jazz Chisholm Jr."},
            "third": {"id": 95, "fullName": "Jon Berti"},
            "shortstop": {"id": 96, "fullName": "Anthony Volpe"},
            "left": {"id": 97, "fullName": "Alex Verdugo"},
            "center": {"id": 99, "fullName": "Aaron Judge"},
            "right": {"id": 98, "fullName": "Juan Soto"},
        }
        # The replayed at-bat is a BOTTOM-half play while the linescore is top.
        plays = feed["liveData"]["plays"]["allPlays"]
        plays[1]["about"]["halfInning"] = "bottom"
        # Give the away team a full starting lineup in the boxscore (starters
        # carry a battingOrder of 100..900 and an allPositions list whose first
        # entry is the position they opened the game at).
        away_players = feed["liveData"]["boxscore"]["teams"]["away"]["players"]
        away_lineup = [
            (201, "C", "C", "Away Catcher", 100),
            (202, "1B", "1B", "Away First", 200),
            (203, "2B", "2B", "Away Second", 300),
            (204, "3B", "3B", "Away Third", 400),
            (205, "SS", "SS", "Away Shortstop", 500),
            (206, "LF", "LF", "Away Left", 600),
            (207, "CF", "CF", "Away Center", 700),
            (208, "RF", "RF", "Away Right", 800),
        ]
        for pid, pos_abbr, all_pos, name, batting_order in away_lineup:
            away_players[f"ID{pid}"] = {
                "person": {"id": pid, "fullName": name},
                "battingOrder": batting_order,
                "position": {"abbreviation": pos_abbr},
                "allPositions": [{"abbreviation": all_pos}],
            }
        response = _FixtureResponse(feed)

        def fake_pitch_payload(data, play, pitch_event, pitch_index,
                               env, env_meta, game_pk):
            return {
                "play_id": f"AB{play['about']['atBatIndex']}-P{pitch_event['pitchNumber']}",
                "is_contact": False,
            }

        with mock.patch.object(main.requests, "get", return_value=response), \
             mock.patch.object(main, "_build_pitch_payload", side_effect=fake_pitch_payload):
            payload = main.get_at_bat(at_bat_index=42, game_pk="fixture-game")

        before = payload["pitches"][0]["pitch"]["game_state_before"]
        alignment = before["defenseAlignment"]
        # The away team's own starting lineup, not the home team's live one.
        self.assertEqual(alignment["SS"], {"id": 205, "name": "Away Shortstop"})
        self.assertEqual(alignment["CF"], {"id": 207, "name": "Away Center"})
        self.assertEqual(alignment["2B"], {"id": 203, "name": "Away Second"})
        # The pitcher slot reflects who actually threw the replayed at-bat.
        self.assertEqual(alignment["P"], {"id": 200, "name": "Fixture Pitcher"})
        self.assertEqual(len(alignment), 9)

    def test_at_bat_snapshot_from_the_other_half_keeps_live_without_a_starting_lineup(self):
        # Without a usable away starting lineup in the boxscore (the fixture's
        # default), the other team can't be rebuilt — the snapshot must keep
        # the live alignment rather than show a wrong lineup.
        feed = copy.deepcopy(self.feed)
        linescore = feed["liveData"]["linescore"]
        linescore["defense"] = {
            "pitcher": {"id": 91, "fullName": "Nestor Cortes"},
            "catcher": {"id": 92, "fullName": "Austin Wells"},
            "first": {"id": 93, "fullName": "Ben Rice"},
            "second": {"id": 94, "fullName": "Jazz Chisholm Jr."},
            "third": {"id": 95, "fullName": "Jon Berti"},
            "shortstop": {"id": 96, "fullName": "Anthony Volpe"},
            "left": {"id": 97, "fullName": "Alex Verdugo"},
            "center": {"id": 99, "fullName": "Aaron Judge"},
            "right": {"id": 98, "fullName": "Juan Soto"},
        }
        # The replayed at-bat is a BOTTOM-half play while the linescore is top.
        plays = feed["liveData"]["plays"]["allPlays"]
        plays[1]["about"]["halfInning"] = "bottom"
        response = _FixtureResponse(feed)

        def fake_pitch_payload(data, play, pitch_event, pitch_index,
                               env, env_meta, game_pk):
            return {
                "play_id": f"AB{play['about']['atBatIndex']}-P{pitch_event['pitchNumber']}",
                "is_contact": False,
            }

        with mock.patch.object(main.requests, "get", return_value=response), \
             mock.patch.object(main, "_build_pitch_payload", side_effect=fake_pitch_payload):
            payload = main.get_at_bat(at_bat_index=42, game_pk="fixture-game")

        before = payload["pitches"][0]["pitch"]["game_state_before"]
        # Unchanged from the live linescore (the away team can't be rebuilt).
        self.assertEqual(before["defenseAlignment"]["SS"]["id"], 96)
        self.assertEqual(before["defenseAlignment"]["CF"]["name"], "Aaron Judge")

    def test_defensive_shuffle_undoes_both_position_legs(self):
        # "…replaces first baseman X, playing second base" is a shuffle: the
        # 2B player moves to 1B while the new player takes 2B. Undoing it must
        # restore the outgoing player at 1B AND the displaced player at 2B.
        feed = copy.deepcopy(self.feed)
        linescore = feed["liveData"]["linescore"]
        # Final (post-sub) alignment: Jazz Chisholm Jr. has taken 2B and the
        # displaced 2B player (Juan Soto) now holds 1B; Ben Rice left the game.
        linescore["defense"] = {
            "pitcher": {"id": 91, "fullName": "Nestor Cortes"},
            "catcher": {"id": 92, "fullName": "Austin Wells"},
            "first": {"id": 98, "fullName": "Juan Soto"},
            "second": {"id": 94, "fullName": "Jazz Chisholm Jr."},
            "third": {"id": 95, "fullName": "Jon Berti"},
            "shortstop": {"id": 96, "fullName": "Anthony Volpe"},
            "left": {"id": 97, "fullName": "Alex Verdugo"},
            "center": {"id": 99, "fullName": "Aaron Judge"},
            "right": {"id": 100, "fullName": "Giancarlo Stanton"},
        }
        plays = feed["liveData"]["plays"]["allPlays"]
        sub_play = copy.deepcopy(plays[-1])
        sub_play["about"]["atBatIndex"] = 43
        sub_play["playEvents"] = [{
            "details": {
                "eventType": "defensive_substitution",
                "description": "Defensive Substitution: Jazz Chisholm Jr. replaces first baseman Ben Rice, batting 4th, playing second base.",
            },
            "type": "action",
            "isSubstitution": True,
            "player": {"id": 94},
            "replacedPlayer": {"id": 93},
            "position": {"abbreviation": "2B"},
        }]
        plays.append(sub_play)
        box_players = feed["liveData"]["boxscore"]["teams"]["home"]["players"]
        box_players["ID93"] = {"person": {"id": 93, "fullName": "Ben Rice"}}
        box_players["ID94"] = {"person": {"id": 94, "fullName": "Jazz Chisholm Jr."}}
        box_players["ID98"] = {"person": {"id": 98, "fullName": "Juan Soto"}}
        response = _FixtureResponse(feed)

        def fake_pitch_payload(data, play, pitch_event, pitch_index,
                               env, env_meta, game_pk):
            return {
                "play_id": f"AB{play['about']['atBatIndex']}-P{pitch_event['pitchNumber']}",
                "is_contact": False,
            }

        with mock.patch.object(main.requests, "get", return_value=response), \
             mock.patch.object(main, "_build_pitch_payload", side_effect=fake_pitch_payload):
            payload = main.get_at_bat(at_bat_index=42, game_pk="fixture-game")

        before = payload["pitches"][0]["pitch"]["game_state_before"]
        alignment = before["defenseAlignment"]
        # Undoing the shuffle restores Ben Rice to first AND the displaced
        # player (Juan Soto) back to second — the pre-sub infield.
        self.assertEqual(alignment["1B"], {"id": 93, "name": "Ben Rice"})
        self.assertEqual(alignment["2B"], {"id": 98, "name": "Juan Soto"})

    def test_at_bat_snapshot_applies_the_other_teams_subs_walking_forward(self):
        # The other team's alignment is rebuilt from its starting lineup and
        # walked FORWARD, so a substitution that happened before the replayed
        # at-bat shows up in the reconstructed fielders.
        feed = copy.deepcopy(self.feed)
        linescore = feed["liveData"]["linescore"]
        linescore["defense"] = {
            "pitcher": {"id": 91, "fullName": "Nestor Cortes"},
            "catcher": {"id": 92, "fullName": "Austin Wells"},
            "first": {"id": 93, "fullName": "Ben Rice"},
            "second": {"id": 94, "fullName": "Jazz Chisholm Jr."},
            "third": {"id": 95, "fullName": "Jon Berti"},
            "shortstop": {"id": 96, "fullName": "Anthony Volpe"},
            "left": {"id": 97, "fullName": "Alex Verdugo"},
            "center": {"id": 99, "fullName": "Aaron Judge"},
            "right": {"id": 98, "fullName": "Juan Soto"},
        }
        plays = feed["liveData"]["plays"]["allPlays"]
        plays[1]["about"]["halfInning"] = "bottom"
        away_players = feed["liveData"]["boxscore"]["teams"]["away"]["players"]
        away_lineup = [
            (201, "C", "C", "Away Catcher", 100),
            (202, "1B", "1B", "Away First", 200),
            (203, "2B", "2B", "Away Second", 300),
            (204, "3B", "3B", "Away Third", 400),
            (205, "SS", "SS", "Away Shortstop", 500),
            (206, "LF", "LF", "Away Left", 600),
            (207, "CF", "CF", "Away Center", 700),
            (208, "RF", "RF", "Away Right", 800),
        ]
        for pid, pos_abbr, all_pos, name, batting_order in away_lineup:
            away_players[f"ID{pid}"] = {
                "person": {"id": pid, "fullName": name},
                "battingOrder": batting_order,
                "position": {"abbreviation": pos_abbr},
                "allPositions": [{"abbreviation": all_pos}],
            }
        # A defensive sub happened in the earlier play (AB41): a substitute
        # took over second base before the replayed at-bat (AB42).
        plays[0]["playEvents"].append({
            "details": {
                "eventType": "defensive_substitution",
                "description": "Defensive Substitution: Away Backup replaces second baseman Away Second, batting 9th, playing second base.",
            },
            "type": "action",
            "isSubstitution": True,
            "player": {"id": 209},
            "replacedPlayer": {"id": 203},
            "position": {"abbreviation": "2B"},
        })
        away_players["ID209"] = {
            "person": {"id": 209, "fullName": "Away Backup"},
            "position": {"abbreviation": "2B"},
        }
        response = _FixtureResponse(feed)

        def fake_pitch_payload(data, play, pitch_event, pitch_index,
                               env, env_meta, game_pk):
            return {
                "play_id": f"AB{play['about']['atBatIndex']}-P{pitch_event['pitchNumber']}",
                "is_contact": False,
            }

        with mock.patch.object(main.requests, "get", return_value=response), \
             mock.patch.object(main, "_build_pitch_payload", side_effect=fake_pitch_payload):
            payload = main.get_at_bat(at_bat_index=42, game_pk="fixture-game")

        alignment = payload["pitches"][0]["pitch"]["game_state_before"]["defenseAlignment"]
        # The pre-at-bat sub is applied to the rebuilt away lineup.
        self.assertEqual(alignment["2B"], {"id": 209, "name": "Away Backup"})
        self.assertEqual(alignment["SS"], {"id": 205, "name": "Away Shortstop"})

    def test_forward_walk_resolves_a_defensive_switch_chain(self):
        # A defensive shuffle at a play boundary lists the displaced players'
        # switches out of displacement order (the real Marlins case lists
        # Norby→2B before Stowers→RF, Lopez→SS and Hensley→3B). Walking the
        # events forward as a chain of assignments must land on the final
        # alignment, with each player at exactly one spot.
        feed = copy.deepcopy(self.feed)
        away_players = feed["liveData"]["boxscore"]["teams"]["away"]["players"]
        lineup = [
            (601, "C", "C", "Chain Catcher", 100),
            (602, "1B", "1B", "Chain First", 200),
            (603, "2B", "2B", "Otto Lopez", 300),
            (604, "SS", "SS", "Vidal Bruján", 400),
            (605, "3B", "3B", "Connor Norby", 500),
            (606, "LF", "LF", "Chain Left", 600),
            (607, "CF", "CF", "Chain Center", 700),
            (608, "RF", "RF", "David Hensley", 800),
        ]
        for pid, pos_abbr, all_pos, name, batting_order in lineup:
            away_players[f"ID{pid}"] = {
                "person": {"id": pid, "fullName": name},
                "battingOrder": batting_order,
                "position": {"abbreviation": pos_abbr},
                "allPositions": [{"abbreviation": all_pos}],
            }
        away_players["ID609"] = {
            "person": {"id": 609, "fullName": "Kyle Stowers"},
            "position": {"abbreviation": "RF"},
        }
        switch_play = {
            "about": {"atBatIndex": 42, "halfInning": "top", "isComplete": True},
            "matchup": {"pitcher": {"id": 604, "fullName": "Vidal Bruján"}},
            "playEvents": [
                {"details": {"eventType": "defensive_switch", "description": "Defensive switch from third base to second base for Connor Norby."}, "player": {"id": 605}, "position": {"abbreviation": "2B"}},
                {"details": {"eventType": "defensive_substitution", "description": "Defensive Substitution: Kyle Stowers replaces Jake Burger, batting 2nd, playing right field."}, "player": {"id": 609}, "replacedPlayer": {"id": 610}, "position": {"abbreviation": "RF"}},
                {"details": {"eventType": "defensive_switch", "description": "Defensive switch from second base to shortstop for Otto Lopez."}, "player": {"id": 603}, "position": {"abbreviation": "SS"}},
                {"details": {"eventType": "defensive_switch", "description": "Defensive switch from right field to third base for David Hensley."}, "player": {"id": 608}, "position": {"abbreviation": "3B"}},
                {"details": {"eventType": "pitching_substitution", "description": "Pitching Change: Vidal Bruján replaces Brett de Geus."}, "player": {"id": 604}, "position": {"abbreviation": "P"}},
            ],
        }
        alignment = main._forward_defense_walk(feed, [switch_play], "away")
        self.assertEqual(alignment["2B"]["id"], 605)  # Norby
        self.assertEqual(alignment["SS"]["id"], 603)  # Lopez
        self.assertEqual(alignment["3B"]["id"], 608)  # Hensley
        self.assertEqual(alignment["RF"]["id"], 609)  # Stowers
        self.assertEqual(alignment["P"]["id"], 604)   # Bruján moved to the mound
        # Every fielder appears at exactly one spot.
        ids = [v["id"] for v in alignment.values()]
        self.assertEqual(len(ids), len(set(ids)))

    def test_at_bat_game_state_formation_comes_from_statcast_rows(self):
        # The formation for a replayed pitch is looked up from Savant's
        # Statcast rows (the linescore only knows the current formation), so
        # rewind mode shows the historical Infield In / Strategic alignment
        # instead of always showing today's.
        feed = copy.deepcopy(self.feed)
        linescore = feed["liveData"]["linescore"]
        linescore["defense"] = {
            "pitcher": {"id": 91, "fullName": "Nestor Cortes"},
            "catcher": {"id": 92, "fullName": "Austin Wells"},
            "first": {"id": 93, "fullName": "Ben Rice"},
            "second": {"id": 94, "fullName": "Jazz Chisholm Jr."},
            "third": {"id": 95, "fullName": "Jon Berti"},
            "shortstop": {"id": 96, "fullName": "Anthony Volpe"},
            "left": {"id": 97, "fullName": "Alex Verdugo"},
            "center": {"id": 99, "fullName": "Aaron Judge"},
            "right": {"id": 98, "fullName": "Juan Soto"},
            "defensiveAlignment": "Strategic",
        }
        rows = [{
            "batter": "101",
            "at_bat_number": "43",  # fixture AB42 is 0-based → Savant 43
            "pitch_number": "1",
            "if_fielding_alignment": "Infield In",
            "of_fielding_alignment": "Standard",
        }]
        response = _FixtureResponse(feed)

        def fake_pitch_payload(data, play, pitch_event, pitch_index,
                               env, env_meta, game_pk):
            return {
                "play_id": f"AB{play['about']['atBatIndex']}-P{pitch_event['pitchNumber']}",
                "is_contact": False,
            }

        with mock.patch.object(main.requests, "get", return_value=response), \
             mock.patch.object(main, "_fetch_savant_rows", return_value=rows), \
             mock.patch.object(main, "_build_pitch_payload", side_effect=fake_pitch_payload):
            payload = main.get_at_bat(at_bat_index=42, game_pk="fixture-game")

        # The pitch's own Statcast row overrides the linescore's current
        # formation (which the fixture sets to Strategic).
        first = payload["pitches"][0]["pitch"]["game_state_before"]
        self.assertEqual(first["defenseFormation"], "Infield In")
        # The at-bat's second pitch has no Statcast row → falls back to the
        # linescore's current formation label.
        second = payload["pitches"][1]["pitch"]["game_state_before"]
        self.assertEqual(second["defenseFormation"], "Strategic")

    def test_combine_fielding_alignment_maps_statcast_labels(self):
        # Savant's alignment labels collapse onto the three the frontend's
        # DefenseDiagram understands: Standard / Infield In / Strategic.
        self.assertEqual(main._combine_fielding_alignment("Standard", "Standard"), "Standard")
        self.assertEqual(main._combine_fielding_alignment("Infield In", "Standard"), "Infield In")
        self.assertEqual(main._combine_fielding_alignment("Infield Shift", "Standard"), "Strategic")
        self.assertEqual(main._combine_fielding_alignment("Infield shade", "Standard"), "Strategic")
        self.assertEqual(main._combine_fielding_alignment("Standard", "4th Outfielder"), "Strategic")
        self.assertEqual(main._combine_fielding_alignment("", ""), "Standard")

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

    def test_game_log_endpoint_formats_fixture_plays_with_inning_labels(self):
        response = _FixtureResponse(self.feed)
        with mock.patch.object(main.requests, "get", return_value=response):
            payload = main.get_game_log(game_pk="fixture-game")

        self.assertTrue(payload["success"])
        self.assertEqual([play["inning_label"] for play in payload["plays"]], ["Top 5th", "Top 5th"])
        self.assertEqual(payload["plays"][0]["description"], "Previous Batter walks")
        self.assertEqual(payload["plays"][1]["description"], "Fixture Batter line drive single to center field")

    def test_game_log_does_not_repeat_batter_out_after_fielding_detail(self):
        play = {
            "about": {"inning": 8, "halfInning": "top", "atBatIndex": 82},
            "matchup": {"batter": {"id": 14, "fullName": "Brett Bateman"}},
            "result": {
                "event": "Groundout",
                "description": "Brett Bateman grounds out, P Tim Hill to 1B Ben Rice",
            },
            "runners": [
                {
                    "details": {"runner": {"id": 14, "fullName": "Brett Bateman"}},
                    "movement": {"start": None, "end": "1B", "isOut": True, "outBase": "1B"},
                },
            ],
        }
        description = main._game_log_description(play)
        self.assertEqual(description, "Brett Bateman grounds out, P Tim Hill to 1B Ben Rice")
        self.assertNotIn("Brett Bateman is out", description)

    def test_game_log_does_not_repeat_runner_out_already_in_description(self):
        play = {
            "about": {"inning": 8, "halfInning": "top", "atBatIndex": 83},
            "matchup": {"batter": {"id": 15, "fullName": "Heliot Ramos"}},
            "result": {
                "event": "Grounded Into DP",
                "description": (
                    "Heliot Ramos grounds into a double play, shortstop Andrés Giménez "
                    "to second baseman Ernie Clement to first baseman Kazuma Okamoto. "
                    "Luis García Jr. out at 2nd. Heliot Ramos out at 1st."
                ),
            },
            "runners": [
                {
                    "details": {"runner": {"id": 16, "fullName": "Luis García Jr."}},
                    "movement": {"start": "1B", "outBase": "2B", "isOut": True},
                },
                {
                    "details": {"runner": {"id": 15, "fullName": "Heliot Ramos"}},
                    "movement": {"start": None, "outBase": "1B", "isOut": True},
                },
            ],
        }
        description = main._game_log_description(play)
        self.assertEqual(description.count("Luis García Jr."), 1)
        self.assertEqual(description.count("Heliot Ramos out"), 1)

    def test_game_log_describes_scoring_advances_and_caught_stealing(self):
        play = {
            "about": {"inning": 8, "halfInning": "top", "atBatIndex": 80},
            "matchup": {"batter": {"id": 10, "fullName": "George Springer"}},
            "result": {"event": "Single"},
            "runners": [
                {
                    "details": {"runner": {"id": 11, "fullName": "Vladimir Guerrero Jr."}, "isScoringEvent": True},
                    "movement": {"start": "2B", "end": "score", "isOut": False},
                },
            ],
        }
        self.assertEqual(
            main._game_log_description(play),
            "George Springer singles, scoring Vladimir Guerrero Jr.",
        )

        caught = {
            "about": {"inning": 8, "halfInning": "top", "atBatIndex": 81},
            "matchup": {"batter": {"id": 12, "fullName": "Daulton Varsho"}},
            "result": {"event": "Caught Stealing 2B"},
            "runners": [
                {
                    "details": {"runner": {"id": 13, "fullName": "Andreas Gimenez"}},
                    "movement": {"start": "1B", "outBase": "2B", "isOut": True},
                },
            ],
        }
        self.assertEqual(main._game_log_description(caught), "Andreas Gimenez caught stealing 2nd")

    def test_extra_innings_regular_season_seeds_ghost_runner_on_second(self):
        # Regular-season extra innings start with the automatic runner on
        # second. The feed never models that placement as a runner movement,
        # so the base replay must seed 2B itself — otherwise the scorebug
        # shows an empty diamond while a runner is standing there.
        feed = copy.deepcopy(self.feed)
        feed["gameData"]["game"] = {"type": "R"}
        feed["liveData"]["plays"]["allPlays"] = [
            {
                "about": {"atBatIndex": 50, "inning": 10, "halfInning": "top", "isComplete": True},
                "matchup": {
                    "pitcher": {"id": 200, "fullName": "Fixture Pitcher"},
                    "batter": {"id": 101, "fullName": "Fixture Batter"},
                },
                "result": {"type": "atBat", "event": "Single", "eventType": "hit"},
                # Ghost runner advances 2B -> 3B; the batter reaches 1B.
                "runners": [
                    {"details": {"runner": {"id": 900}},
                     "movement": {"start": "2B", "end": "3B", "isOut": False},
                     "credits": []},
                    {"details": {"runner": {"id": 101}},
                     "movement": {"start": None, "end": "1B", "isOut": False},
                     "credits": []},
                ],
                "playEvents": [],
            }
        ]

        with mock.patch.object(main, "_fetch_savant_rows", return_value=[]):
            snapshot = main._game_state_snapshot(
                feed, feed["liveData"]["plays"]["allPlays"][0],
                feed["liveData"]["plays"]["allPlays"][0]["playEvents"][0]
                if feed["liveData"]["plays"]["allPlays"][0]["playEvents"] else {},
                pitch_index=None,
            )

        # 2B was seeded, vacated by the ghost's advance, and 3B + 1B occupied.
        self.assertEqual(snapshot["bases"], ["1B", "3B"])

    def test_extra_innings_empty_half_seeds_ghost_runner(self):
        # The very first at-bat of an extra half-inning, before any runner has
        # moved: the automatic runner must show on 2B by itself.
        feed = copy.deepcopy(self.feed)
        feed["gameData"]["game"] = {"type": "R"}
        feed["liveData"]["plays"]["allPlays"] = [
            {
                "about": {"atBatIndex": 51, "inning": 10, "halfInning": "bottom", "isComplete": False},
                "matchup": {
                    "pitcher": {"id": 200, "fullName": "Fixture Pitcher"},
                    "batter": {"id": 101, "fullName": "Fixture Batter"},
                },
                "result": {},
                "runners": [],
                "playEvents": [],
            }
        ]

        with mock.patch.object(main, "_fetch_savant_rows", return_value=[]):
            snapshot = main._game_state_snapshot(
                feed, feed["liveData"]["plays"]["allPlays"][0], {}, pitch_index=None,
            )

        self.assertEqual(snapshot["bases"], ["2B"])

    def test_extra_innings_postseason_has_no_ghost_runner(self):
        # Postseason games (game.type != "R") start extra innings with the
        # bases empty — no automatic runner.
        feed = copy.deepcopy(self.feed)
        feed["gameData"]["game"] = {"type": "W"}  # World Series
        feed["liveData"]["plays"]["allPlays"] = [
            {
                "about": {"atBatIndex": 52, "inning": 10, "halfInning": "top", "isComplete": False},
                "matchup": {
                    "pitcher": {"id": 200, "fullName": "Fixture Pitcher"},
                    "batter": {"id": 101, "fullName": "Fixture Batter"},
                },
                "result": {},
                "runners": [],
                "playEvents": [],
            }
        ]

        with mock.patch.object(main, "_fetch_savant_rows", return_value=[]):
            snapshot = main._game_state_snapshot(
                feed, feed["liveData"]["plays"]["allPlays"][0], {}, pitch_index=None,
            )

        self.assertEqual(snapshot["bases"], [])

    def test_ninth_inning_still_has_no_ghost_runner(self):
        # The rule only applies in innings 10+; the 9th must stay empty.
        feed = copy.deepcopy(self.feed)
        feed["gameData"]["game"] = {"type": "R"}
        feed["liveData"]["plays"]["allPlays"] = [
            {
                "about": {"atBatIndex": 53, "inning": 9, "halfInning": "bottom", "isComplete": False},
                "matchup": {
                    "pitcher": {"id": 200, "fullName": "Fixture Pitcher"},
                    "batter": {"id": 101, "fullName": "Fixture Batter"},
                },
                "result": {},
                "runners": [],
                "playEvents": [],
            }
        ]

        with mock.patch.object(main, "_fetch_savant_rows", return_value=[]):
            snapshot = main._game_state_snapshot(
                feed, feed["liveData"]["plays"]["allPlays"][0], {}, pitch_index=None,
            )

        self.assertEqual(snapshot["bases"], [])

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

    def test_live_game_state_formation_resolves_from_statcast(self):
        # The statsapi feed no longer carries a per-pitch defensive alignment,
        # so the live endpoint's linescore label would always read Standard.
        # The current formation must resolve from the newest pitch Statcast has
        # ingested (reusing the same batter+at-bat+pitch match as the rewind
        # formation), overriding the linescore's dead ``defensiveAlignment``.
        feed = copy.deepcopy(self.feed)
        feed["liveData"]["linescore"]["defense"] = {
            "pitcher": {"id": 200, "fullName": "Fixture Pitcher"},
            "catcher": {"id": 92, "fullName": "Austin Wells"},
            "first": {"id": 93, "fullName": "Ben Rice"},
            "second": {"id": 94, "fullName": "Jazz Chisholm Jr."},
            "third": {"id": 95, "fullName": "Jon Berti"},
            "shortstop": {"id": 96, "fullName": "Anthony Volpe"},
            "left": {"id": 97, "fullName": "Alex Verdugo"},
            "center": {"id": 98, "fullName": "Aaron Judge"},
            "right": {"id": 99, "fullName": "Juan Soto"},
            "defensiveAlignment": "Standard",
        }
        rows = [{
            # AB42 (0-based atBatIndex 42) is Savant's 43rd at-bat; its newest
            # pitch is pitch 2.
            "batter": "101", "at_bat_number": "43", "pitch_number": "2",
            "if_fielding_alignment": "Strategic", "of_fielding_alignment": "Standard",
        }]
        with mock.patch.object(main, "_fetch_feed", return_value=feed), \
             mock.patch.object(main, "_fetch_savant_rows", return_value=rows):
            payload = main.get_game_state(game_pk="fixture-game")

        self.assertEqual(payload["defenseFormation"], "Strategic")

    def test_live_game_state_formation_walks_newest_first_to_fallback_pitch(self):
        # The newest pitch (AB42-P2) has no Statcast row yet — the live
        # formation must walk backward to the previous pitch (AB42-P1) rather
        # than giving up, so the diagram still reflects the last known setup.
        feed = copy.deepcopy(self.feed)
        feed["liveData"]["linescore"]["defense"] = {
            "defensiveAlignment": "Standard",
        }
        rows = [{
            "batter": "101", "at_bat_number": "43", "pitch_number": "1",
            "if_fielding_alignment": "Infield In", "of_fielding_alignment": "Standard",
        }]
        with mock.patch.object(main, "_fetch_feed", return_value=feed), \
             mock.patch.object(main, "_fetch_savant_rows", return_value=rows):
            payload = main.get_game_state(game_pk="fixture-game")

        self.assertEqual(payload["defenseFormation"], "Infield In")

    def test_live_game_state_formation_falls_back_to_linescore_label(self):
        # Before Savant ingests the game the row lookup is empty — the live
        # formation degrades to the linescore's label instead of hard-failing.
        feed = copy.deepcopy(self.feed)
        feed["liveData"]["linescore"]["defense"] = {
            "defensiveAlignment": "Infield In",
        }
        with mock.patch.object(main, "_fetch_feed", return_value=feed), \
             mock.patch.object(main, "_fetch_savant_rows", return_value=[]):
            payload = main.get_game_state(game_pk="fixture-game")

        self.assertEqual(payload["defenseFormation"], "Infield In")

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

    def test_box_score_rows_carry_extended_hover_stats(self):
        # The scorebug hover cards read extended fields off the box-score rows
        # (singles/doubles/HR/HBP/SB/GDP for batters; pitches/strikes/wild
        # pitches/balks for pitchers). The backend must actually send them,
        # or the hovers render empty.
        feed = {
            "gameData": {
                "game": {"type": "R"},
                "datetime": {"officialDate": "2025-06-15"},
                "status": {"detailedState": "Final", "abstractGameState": "Final"},
                "venue": {"name": "Fenway"},
                "teams": {
                    "away": {"id": 121, "name": "Blue Jays", "abbreviation": "TOR"},
                    "home": {"id": 111, "name": "Red Sox", "abbreviation": "BOS"},
                },
            },
            "liveData": {
                "linescore": {
                    "innings": [],
                    "teams": {"away": {"runs": 3}, "home": {"runs": 2}},
                },
                "plays": {"allPlays": []},
                "boxscore": {
                    "teams": {
                        "away": {
                            "team": {"name": "Blue Jays", "abbreviation": "TOR"},
                            "batters": [1],
                            "pitchers": [9],
                            "players": {
                                "ID1": {
                                    "person": {"id": 1, "fullName": "Bo Bichette"},
                                    "position": {"abbreviation": "SS"},
                                    "battingOrder": "1",
                                    "stats": {"batting": {
                                        "atBats": 4, "runs": 1, "hits": 2,
                                        "doubles": 1, "triples": 0, "homeRuns": 1,
                                        "rbi": 3, "baseOnBalls": 1, "strikeOuts": 1,
                                        "hitByPitch": 0, "stolenBases": 1,
                                        "caughtStealing": 0, "groundedIntoDoublePlay": 1,
                                        "groundedIntoTriplePlay": 0, "groundOuts": 1,
                                        "flyOuts": 0, "sacFlies": 0, "sacBunts": 0,
                                    }},
                                    "seasonStats": {"batting": {"avg": 0.29}},
                                },
                                "ID9": {
                                    "person": {"id": 9, "fullName": "Alec Manoah"},
                                    "position": {"abbreviation": "P"},
                                    "stats": {"pitching": {
                                        "inningsPitched": 6.0, "hits": 5, "runs": 2,
                                        "earnedRuns": 2, "baseOnBalls": 3, "strikeOuts": 7,
                                        "numberOfPitches": 95, "strikes": 61,
                                        "wildPitches": 1, "hitByPitch": 0, "balks": 1,
                                        "saves": 0, "blownSaves": 0,
                                    }},
                                    "seasonStats": {"pitching": {"era": 3.2, "whip": 1.1}},
                                },
                            },
                        },
                        "home": {
                            "team": {"name": "Red Sox", "abbreviation": "BOS"},
                            "batters": [], "pitchers": [], "players": {},
                        },
                    },
                },
            },
        }
        with mock.patch.object(main, "_fetch_feed", return_value=feed):
            payload = main.get_box_score(game_pk="fixture-game")

        batter = payload["teams"]["away"]["batting"][0]
        # 2 hits − 1 double − 1 HR ⇒ 0 singles.
        self.assertEqual(batter["singles"], 0)
        self.assertEqual(batter["doubles"], 1)
        self.assertEqual(batter["homeRuns"], 1)
        self.assertEqual(batter["stolenBases"], 1)
        self.assertEqual(batter["groundedIntoDoublePlay"], 1)
        self.assertEqual(batter["sacrificeFlies"], 0)
        self.assertEqual(batter["sacrificeBunts"], 0)

        pitcher = payload["teams"]["away"]["pitching"][0]
        self.assertEqual(pitcher["pitchesThrown"], 95)
        self.assertEqual(pitcher["strikesThrown"], 61)
        self.assertEqual(pitcher["wildPitches"], 1)
        self.assertEqual(pitcher["balks"], 1)


class InducedBreaksRegressionTests(unittest.TestCase):
    """Regression tests for where the payload's pfx_x (H Break) and pfx_z
    (IVB) come from.

    Baseball Savant's game feed displays the live feed's ``breaks`` object
    values (IVB = breakVerticalInduced, H Break = -breakHorizontal — the
    feed's breakHorizontal is sign-flipped), which also equal the Savant CSV
    pfx_x/pfx_z in inches. The payload must prefer those over
    ``coordinates.pfxX/pfxZ``, which are a separate, smaller-magnitude raw
    measurement that does not match Savant. See main._induced_breaks_inches.
    """

    # Real values from game 822774 (Tim Hill, LHP, sinker, game pitch 289):
    # Savant CSV pfx_x = +1.39 ft = +16.7 in, pfx_z = -0.69 ft = -8.3 in,
    # while coordinates.pfxX/pfxZ carry a different, smaller magnitude.
    BREAKS_SOURCE = {
        "coordinates": {"pfxX": 10.91, "pfxZ": -5.49},
        "breaks": {"breakHorizontal": -16.7, "breakVerticalInduced": -8.3},
    }

    def test_prefers_breaks_object_over_coordinates(self):
        pfx_x, pfx_z = main._induced_breaks_inches(self.BREAKS_SOURCE)
        # From breaks: -breakHorizontal = +16.7, breakVerticalInduced = -8.3.
        # NOT the coordinates values (+10.91 / -5.49).
        self.assertEqual(pfx_x, 16.7)
        self.assertEqual(pfx_z, -8.3)

    def test_matches_savant_csv_convention(self):
        # pfx_x == -breakHorizontal and pfx_z == breakVerticalInduced are the
        # exact values Savant's CSV (feet * 12) and game feed show for the
        # same pitch (positive H Break = toward 1B, positive IVB = up).
        pfx_x, pfx_z = main._induced_breaks_inches(self.BREAKS_SOURCE)
        self.assertEqual(pfx_x, -self.BREAKS_SOURCE["breaks"]["breakHorizontal"])
        self.assertEqual(pfx_z, self.BREAKS_SOURCE["breaks"]["breakVerticalInduced"])
        # Sanity: these equal the CSV inches for that pitch.
        self.assertEqual(pfx_x, 16.7)
        self.assertEqual(pfx_z, -8.3)

    def test_falls_back_to_coordinates_when_breaks_fields_missing(self):
        # Fixture-style pitch_data: breaks carries only spinRate/spinDirection,
        # so the coordinates values are used unchanged.
        pitch_data = {
            "coordinates": {"pfxX": -4.2, "pfxZ": 15.8},
            "breaks": {"spinRate": 2250, "spinDirection": 184},
        }
        pfx_x, pfx_z = main._induced_breaks_inches(pitch_data)
        self.assertEqual(pfx_x, -4.2)
        self.assertEqual(pfx_z, 15.8)

    def test_zero_break_is_preserved(self):
        # A true 0.0 must not be treated as a missing value (falsy) and
        # replaced by the coordinates fallback.
        pitch_data = {
            "coordinates": {"pfxX": 9.0, "pfxZ": 2.0},
            "breaks": {"breakHorizontal": -0.0, "breakVerticalInduced": 0.0},
        }
        pfx_x, pfx_z = main._induced_breaks_inches(pitch_data)
        self.assertEqual(pfx_x, 0.0)
        self.assertEqual(pfx_z, 0.0)

    def test_returns_none_when_neither_source_has_values(self):
        self.assertEqual(main._induced_breaks_inches({}), (None, None))
        self.assertEqual(
            main._induced_breaks_inches({"breaks": {"spinRate": 2250}}),
            (None, None),
        )

    def _minimal_fixture(self):
        """Build a data/play/pitch_event triple that exercises
        _build_pitch_payload's pfx path without the simulator or network."""
        play = {
            "about": {"atBatIndex": 42, "isComplete": True},
            "matchup": {
                "pitcher": {"id": 200, "fullName": "Fixture Pitcher"},
                "batter": {"fullName": "Fixture Batter"},
                "batSide": {"code": "R"},
                "pitchHand": {"code": "L"},
            },
            "result": {"event": "Groundout"},
            "playEvents": [],
        }
        pitch_event = {
            "isPitch": True,
            "pitchNumber": 2,
            "details": {
                "type": {"code": "SI", "description": "Sinker"},
                "call": {"code": "X"},
            },
            "pitchData": {
                "startSpeed": 88.1,
                "strikeZoneTop": 3.4,
                "strikeZoneBottom": 1.5,
                "coordinates": {"pfxX": 10.91, "pfxZ": -5.49, "pX": -0.23, "pZ": 1.86},
                "breaks": {"breakHorizontal": -16.7, "breakVerticalInduced": -8.3},
            },
        }
        play["playEvents"] = [pitch_event]
        data = {
            "gameData": {"datetime": {"officialDate": "2026-08-16"}, "players": {}},
            "liveData": {"linescore": {"isTopInning": False}, "plays": {"allPlays": []}},
        }
        return data, play, pitch_event

    def test_payload_pfx_derives_from_breaks_object(self):
        """End-to-end through _build_pitch_payload: with both sources present,
        the payload's pfx_x/pfx_z come from the breaks object (matching the
        Savant CSV convention), not from coordinates.pfxX/pfxZ."""
        data, play, pitch_event = self._minimal_fixture()

        class _FakeSim:
            def __init__(self, **kwargs):
                self.trajectory = [{"x": 0.0, "y": 0.0, "z": 0.0, "t": 0.0}]

            def simulate(self, **kwargs):
                pass

            def calculate_air_density(self, *args, **kwargs):
                # _air_density_from_env builds a simulator to compute density;
                # return a plausible sea-level value.
                return 1.225

        parsed = {
            "pitch": mock.Mock(),
            "sim_params": {
                "spin_efficiency": 0.9, "backspin_rpm": 2000.0,
                "sidespin_rpm": 500.0, "wg_rpm": 300.0,
            },
            "x0_50": 0.0, "y0_50": 50.0, "z0_50": 5.0,
            "vx0_50": 0.0, "vy0_50": -135.0, "vz0_50": -4.0,
            "ax": 0.0, "ay": 28.0, "az": -20.0,
            "tR": 0.3,
        }
        with mock.patch.object(
            main, "_pitch_parameters_from_event", return_value=parsed,
        ), mock.patch.object(
            main, "FullBallTrajectorySimulator", return_value=_FakeSim(),
        ), mock.patch.object(
            main, "_reconstructed_spin_axis", return_value=[0.0, 0.0, -1.0],
        ), mock.patch.object(
            main, "_bat_tracking_for_pitch",
            return_value={"swing_path_tilt": 0.0, "attack_angle": 0.0},
        ), mock.patch.object(
            main, "_compute_xba", return_value=0.0,
        ), mock.patch.object(
            main, "_sprint_speed_for_batter", return_value=None,
        ), mock.patch.object(
            main, "_game_state_snapshot", return_value={},
        ):
            payload = main._build_pitch_payload(
                data, play, pitch_event, 0,
                main.DEFAULT_ENV, main.DEFAULT_ENV_META,
                game_pk="fixture-game",
            )

        # From breaks (Savant convention): -breakHorizontal = +16.7,
        # breakVerticalInduced = -8.3 — NOT coordinates (+10.91 / -5.49).
        self.assertEqual(payload["pfx_x"], 16.7)
        self.assertEqual(payload["pfx_z"], -8.3)


class BreakAveragesConventionTests(unittest.TestCase):
    """Regression tests for the league-average break conventions.

    The Savant CSV pfx_x/pfx_z are already in the fixed Statcast convention
    (positive pfx_x = break toward first base for BOTH hands, positive pfx_z =
    upward IVB), so _aggregate_break_averages must NOT mirror left-handed
    pitchers. Because horizontal break is the mirror image across hands (a LHP
    sinker breaks +17 in toward 1B where a RHP's breaks -17 in), the averages
    are bucketed per pitcher hand so pooling the two hands can't cancel H
    Break toward zero. See main._aggregate_break_averages.
    """

    # Real values from game 822774: Tim Hill (LHP) sinker CSV pfx_x = +1.39 ft
    # = +16.7 in (toward 1B), pfx_z = -0.69 ft = -8.3 in.
    LHP_SINKER = {"pitch_type": "SI", "pfx_x": 1.39, "pfx_z": -0.69, "p_throws": "L"}
    RHP_FASTBALL = {"pitch_type": "FF", "pfx_x": -0.5, "pfx_z": 1.5, "p_throws": "R"}

    @staticmethod
    def _rows(row, n=30):
        """Repeat one row to clear the n >= 25 sample threshold."""
        return [dict(row, pfx_x=str(row["pfx_x"]), pfx_z=str(row["pfx_z"])) for _ in range(n)]

    def test_lhp_horizontal_break_is_not_mirrored(self):
        # Tim Hill's sinker must land in the L bucket as +16.68 in (1.39 ft *
        # 12) — the same sign the panel, the movement graph, and Savant
        # display. The old LHP mirror would have flipped it to -16.68.
        avgs = main._aggregate_break_averages(self._rows(self.LHP_SINKER))
        self.assertEqual(avgs["SI"]["L"]["x"], 16.68)
        self.assertEqual(avgs["SI"]["L"]["z"], -8.28)
        self.assertEqual(avgs["SI"]["L"]["n"], 30)
        self.assertNotIn("R", avgs["SI"])

    def test_rhp_horizontal_break_unmirrored(self):
        avgs = main._aggregate_break_averages(self._rows(self.RHP_FASTBALL))
        self.assertEqual(avgs["FF"]["R"]["x"], -6.0)
        self.assertEqual(avgs["FF"]["R"]["z"], 18.0)
        self.assertNotIn("L", avgs["FF"])

    def test_hands_bucketed_separately_in_fixed_convention(self):
        # Same pitch type from both hands sits on opposite sides of the plot
        # in the fixed convention; the buckets must NOT be pooled into one
        # ~zero H Break average.
        lhp_sinker = {"pitch_type": "SI", "pfx_x": 1.4, "pfx_z": -0.6, "p_throws": "L"}
        rhp_sinker = {"pitch_type": "SI", "pfx_x": -1.4, "pfx_z": -0.6, "p_throws": "R"}
        avgs = main._aggregate_break_averages(
            self._rows(lhp_sinker) + self._rows(rhp_sinker),
        )
        self.assertEqual(avgs["SI"]["L"]["x"], 16.8)
        self.assertEqual(avgs["SI"]["R"]["x"], -16.8)
        self.assertEqual(len(avgs["SI"]), 2)

    def test_ivb_identical_across_hands(self):
        # IVB (pfx_z) is handedness-independent: never mirrored.
        lhp = {"pitch_type": "FF", "pfx_x": 0.5, "pfx_z": 1.5, "p_throws": "L"}
        rhp = {"pitch_type": "FF", "pfx_x": -0.5, "pfx_z": 1.5, "p_throws": "R"}
        avgs = main._aggregate_break_averages(self._rows(lhp) + self._rows(rhp))
        self.assertEqual(avgs["FF"]["L"]["z"], avgs["FF"]["R"]["z"])

    def test_small_samples_skipped(self):
        # Below the n >= 25 threshold the bucket (and thus the type) is
        # dropped so tiny samples don't skew the league average.
        self.assertEqual(
            main._aggregate_break_averages(self._rows(self.RHP_FASTBALL, n=10)),
            {},
        )

    def test_unknown_hand_skipped(self):
        # Rows without a clean R/L p_throws are ignored entirely.
        row = {"pitch_type": "FF", "pfx_x": 0.5, "pfx_z": 1.5, "p_throws": "S"}
        self.assertEqual(main._aggregate_break_averages(self._rows(row)), {})


class XbaBreakIsolationTests(unittest.TestCase):
    """Guardrail: the induced-break (H Break / IVB) fixes must never feed into
    xBA.

    xBA is computed purely from a batted ball's exit velocity, launch angle,
    and (on ground balls) the batter's sprint speed against a smoothed
    Statcast grid — it has nothing to do with a pitch's pfx_x/pfx_z. This test
    pins that invariant so a future refactor can't accidentally couple the two
    (e.g. by using the breaks payload for launch data or by deriving the xBA
    grid bins from break values). It exercises the real _compute_xba with a
    small deterministic grid, and feeds radically different break sources
    through _induced_breaks_inches to confirm the computed xBA is bit-for-bit
    identical either way.
    """

    # A 3x3 grid indexed [la][ev]. The EV/LA below (95 mph / 22°) clamp to the
    # bottom-right corner cell (0.80), so the result is a strict, deterministic
    # literal rather than an interpolation sum that floats with grid geometry.
    GRID = [[0.10, 0.20, 0.30],
            [0.15, 0.35, 0.55],
            [0.20, 0.50, 0.80]]

    # Two break sources that resolve to very different pfx_x/pfx_z values: one
    # from the breaks object (Savant convention), one falling back to
    # coordinates.pfxX/pfxZ. The xBA must not care which one is used.
    BREAKS_SOURCE = {"coordinates": {"pfxX": 10.91, "pfxZ": -5.49},
                     "breaks": {"breakHorizontal": -16.7, "breakVerticalInduced": -8.3}}
    COORDS_ONLY = {"coordinates": {"pfxX": -4.2, "pfxZ": 15.8},
                   "breaks": {"spinRate": 2250, "spinDirection": 184}}

    def _make_xba(self):
        """Return an xBA using the real _compute_xba against a fixed grid."""
        # Make sure a background rebuild isn't mid-flight (building flag set),
        # otherwise the real _xba_grid thread could overwrite the grid mid-test.
        original = main._xba_grid_cache
        patched = {"fetched_at": float("inf"), "grid": np.array(self.GRID), "building": False}
        main._xba_grid_cache = patched
        try:
            return main._compute_xba(95.0, 22.0, sprint_speed=None)
        finally:
            main._xba_grid_cache = original

    def test_xba_invariant_under_breaks_object(self):
        # Two different pfx_x/pfx_z values from real break sources.
        a = self._induced_breaks_and_xba(self.BREAKS_SOURCE)
        b = self._induced_breaks_and_xba(self.COORDS_ONLY)
        # pfx differs, but xBA must be identical (interpolates to the 0.80
        # corner, rounding to 0.799) regardless.
        self.assertNotEqual(a["pfx"], b["pfx"])
        self.assertEqual(a["xba"], b["xba"])
        self.assertEqual(b["xba"], 0.799)

    def _induced_breaks_and_xba(self, source):
        pfx_x, pfx_z = main._induced_breaks_inches(source)
        xba = self._make_xba()
        return {"pfx": (pfx_x, pfx_z), "xba": xba}

    def test_xba_rebuild_is_single_flighted_across_rapid_polls(self):
        """A burst of cold-cache polls starts exactly one rebuild thread: the
        ``building`` flag arms under the lock before the thread spawns, so
        duplicate concurrent spawns are impossible."""
        original_cache = main._xba_grid_cache
        build_calls = []
        build_started = threading.Event()
        release_build = threading.Event()

        def _slow_build():
            build_calls.append(1)
            build_started.set()
            release_build.wait(5)  # keep the rebuild in flight
            return np.array([[0.5]])

        try:
            main._xba_grid_cache = {
                "fetched_at": 0.0, "grid": None, "building": False, "next_attempt_at": 0.0,
            }
            with mock.patch.object(main, "_build_xba_grid", side_effect=_slow_build):
                main._xba_grid()  # first poll spawns the rebuild
                self.assertTrue(build_started.wait(5))
                for _ in range(5):  # rapid polls while the build is in flight
                    main._xba_grid()
                self.assertEqual(len(build_calls), 1)  # single-flight held
            release_build.set()  # let the in-flight rebuild finish
            deadline = time.time() + 5
            while time.time() < deadline and main._xba_grid_cache["grid"] is None:
                time.sleep(0.01)
            self.assertIsNotNone(main._xba_grid_cache["grid"])
        finally:
            main._xba_grid_cache = original_cache

    def test_xba_failed_rebuild_backs_off_before_retrying(self):
        """A failed build arms a cooldown instead of immediately re-arming, so
        rapid polls can't each spawn an overlapping Savant scrape while it's
        down."""
        original_cache = main._xba_grid_cache
        build_calls = []
        build_finished = []

        def _flaky_build():
            ev = threading.Event()
            build_finished.append(ev)
            try:
                raise RuntimeError("Savant down")
            finally:
                ev.set()

        def _rebuild_finished_and_armed():
            """The failed thread ran its failure handler AND its finally, so the
            cooldown is armed and ``building`` is False again."""
            with main._xba_grid_lock:
                return (
                    not main._xba_grid_cache["building"]
                    and main._xba_grid_cache["next_attempt_at"] > time.time()
                )

        try:
            main._xba_grid_cache = {
                "fetched_at": 0.0, "grid": None, "building": False,
                "next_attempt_at": time.time() + 3600,  # cooldown already armed
            }
            with mock.patch.object(main, "_build_xba_grid", side_effect=_flaky_build):
                main._xba_grid()  # within cooldown -> must not spawn
                self.assertEqual(len(build_finished), 0)
                # Cooldown expires -> a retry spawns and fails, re-arming it.
                with main._xba_grid_lock:
                    main._xba_grid_cache["next_attempt_at"] = 0.0
                main._xba_grid()
                deadline = time.time() + 5
                while time.time() < deadline and not build_finished:
                    time.sleep(0.01)
                self.assertTrue(build_finished and build_finished[0].wait(5))
                deadline = time.time() + 5
                while time.time() < deadline and not _rebuild_finished_and_armed():
                    time.sleep(0.01)
                self.assertTrue(_rebuild_finished_and_armed())
                main._xba_grid()  # freshly armed cooldown -> no re-spawn
                self.assertEqual(len(build_finished), 1)
                # Cooldown expires again -> retry allowed.
                with main._xba_grid_lock:
                    main._xba_grid_cache["next_attempt_at"] = 0.0
                main._xba_grid()
                deadline = time.time() + 5
                while time.time() < deadline and len(build_finished) < 2:
                    time.sleep(0.01)
                self.assertTrue(len(build_finished) >= 2 and build_finished[1].wait(5))
        finally:
            main._xba_grid_cache = original_cache

        self.assertEqual(len(build_finished), 2)


class _FakeSavantResponse:
    """Minimal stand-in for a requests response with a CSV body."""

    def __init__(self, content):
        self.content = content

    def raise_for_status(self):
        pass


class SprintSpeedCacheTests(unittest.TestCase):
    """Single-flight + backoff behavior of ``_sprint_speed_by_player``."""

    CSV = b"player_id,sprint_speed\n660271,28.7\n621020,27.1\n"

    def _install_fresh_cache(self):
        self._original_cache = main._sprint_speed_cache
        main._sprint_speed_cache = {
            "fetched_at": 0.0, "by_player": {}, "building": False, "next_attempt_at": 0.0,
        }

    def tearDown(self):
        main._sprint_speed_cache = self._original_cache

    def test_sprint_speed_fetch_is_single_flighted_across_rapid_polls(self):
        """A burst of cold-cache calls starts exactly one background fetch."""
        self._install_fresh_cache()
        fetch_calls = []
        fetch_started = threading.Event()
        release_fetch = threading.Event()

        def _slow_fetch(url, timeout=None):
            fetch_calls.append(1)
            fetch_started.set()
            release_fetch.wait(5)  # keep the fetch in flight
            return _FakeSavantResponse(self.CSV)

        try:
            with mock.patch.object(main.requests, "get", side_effect=_slow_fetch):
                self.assertEqual(main._sprint_speed_by_player(), {})  # cold -> {} now
                self.assertTrue(fetch_started.wait(5))
                for _ in range(5):  # rapid polls while the fetch is in flight
                    self.assertEqual(main._sprint_speed_by_player(), {})
                self.assertEqual(len(fetch_calls), 1)  # single-flight held
            release_fetch.set()
            deadline = time.time() + 5
            while time.time() < deadline and not main._sprint_speed_cache["by_player"]:
                time.sleep(0.01)
            self.assertEqual(main._sprint_speed_cache["by_player"]["660271"], 28.7)
        finally:
            release_fetch.set()

    def test_sprint_speed_failed_fetch_backs_off_before_retrying(self):
        """A failed fetch arms a cooldown instead of re-fetching on every call."""
        self._install_fresh_cache()
        fetch_calls = []

        def _flaky_fetch(url, timeout=None):
            fetch_calls.append(1)
            raise RuntimeError("Savant down")

        def _rebuild_finished_and_armed():
            with main._sprint_speed_lock:
                return (
                    not main._sprint_speed_cache["building"]
                    and main._sprint_speed_cache["next_attempt_at"] > time.time()
                )

        main._sprint_speed_cache["next_attempt_at"] = time.time() + 3600  # already armed
        with mock.patch.object(main.requests, "get", side_effect=_flaky_fetch):
            main._sprint_speed_by_player()  # within cooldown -> no fetch
            self.assertEqual(len(fetch_calls), 0)
            # Cooldown expires -> a fetch spawns and fails, re-arming it.
            with main._sprint_speed_lock:
                main._sprint_speed_cache["next_attempt_at"] = 0.0
            main._sprint_speed_by_player()
            deadline = time.time() + 5
            while time.time() < deadline and not _rebuild_finished_and_armed():
                time.sleep(0.01)
            self.assertTrue(_rebuild_finished_and_armed())
            main._sprint_speed_by_player()  # freshly armed cooldown -> no re-fetch
            self.assertEqual(len(fetch_calls), 1)
            # Cooldown expires again -> retry allowed.
            with main._sprint_speed_lock:
                main._sprint_speed_cache["next_attempt_at"] = 0.0
            main._sprint_speed_by_player()
            deadline = time.time() + 5
            while time.time() < deadline and len(fetch_calls) < 2:
                time.sleep(0.01)

        self.assertEqual(len(fetch_calls), 2)  # tearDown restores the cache


class SavantRowsCacheTests(unittest.TestCase):
    """Single-flight + backoff behavior of ``_fetch_savant_rows``."""

    GAME = "824802"
    DATE = "2026-08-21"
    CSV = (
        "game_pk,batter,at_bat_number,pitch_number,swing_path_tilt,attack_angle\n"
        f"{GAME},687952,1,1,22.5,14.2\n"
        f"{GAME},687952,1,2,20.1,11.0\n"
        f"999999,123456,1,1,1.0,2.0\n"
    )

    def setUp(self):
        self._orig_cache = main._savant_rows_cache
        self._orig_building = main._savant_rows_building
        self._orig_next_attempt = main._savant_rows_next_attempt
        self._orig_last_used = main._savant_rows_cache_last_used
        self._orig_max = main._SAVANT_ROWS_CACHE_MAX_ENTRIES
        self._orig_cooldown = main._SAVANT_ROWS_REBUILD_COOLDOWN_SECONDS
        main._savant_rows_cache = {}
        main._savant_rows_building = set()
        main._savant_rows_next_attempt = {}
        main._savant_rows_cache_last_used = {}

    def tearDown(self):
        main._savant_rows_cache = self._orig_cache
        main._savant_rows_building = self._orig_building
        main._savant_rows_next_attempt = self._orig_next_attempt
        main._savant_rows_cache_last_used = self._orig_last_used
        main._SAVANT_ROWS_CACHE_MAX_ENTRIES = self._orig_max
        main._SAVANT_ROWS_REBUILD_COOLDOWN_SECONDS = self._orig_cooldown

    def test_savant_rows_fetch_is_single_flighted_across_rapid_polls(self):
        """A burst of cold-cache calls starts exactly one background fetch and
        returns the (empty) rows immediately instead of blocking."""
        fetch_calls = []
        fetch_started = threading.Event()
        release_fetch = threading.Event()

        def _slow_fetch(url, params=None, timeout=None):
            fetch_calls.append(1)
            fetch_started.set()
            release_fetch.wait(5)  # keep the fetch in flight
            return _FakeSavantResponse(self.CSV.encode())

        try:
            with mock.patch.object(main.requests, "get", side_effect=_slow_fetch):
                self.assertEqual(main._fetch_savant_rows(self.GAME, self.DATE), [])
                self.assertTrue(fetch_started.wait(5))
                for _ in range(5):  # rapid polls while the fetch is in flight
                    self.assertEqual(main._fetch_savant_rows(self.GAME, self.DATE), [])
                self.assertEqual(len(fetch_calls), 1)  # single-flight held
            release_fetch.set()
            deadline = time.time() + 5
            while time.time() < deadline and self.GAME not in main._savant_rows_cache:
                time.sleep(0.01)
            self.assertIn(self.GAME, main._savant_rows_cache)
            # Filtered to this game only (the 999999 row is dropped).
            self.assertEqual(len(main._savant_rows_cache[self.GAME]), 2)
        finally:
            release_fetch.set()

    def test_savant_rows_failed_fetch_backs_off_before_retrying(self):
        """A failed/empty fetch arms a cooldown instead of re-fetching on every call."""
        fetch_calls = []

        def _flaky_fetch(url, params=None, timeout=None):
            fetch_calls.append(1)
            raise RuntimeError("Savant down")

        def _rebuild_done_and_armed():
            """The failed thread ran its failure handler AND its finally, so the
            cooldown is armed and ``building`` is cleared."""
            with main._savant_rows_lock:
                return (
                    self.GAME not in main._savant_rows_building
                    and main._savant_rows_next_attempt.get(self.GAME, 0.0) > time.time()
                )

        main._savant_rows_next_attempt[self.GAME] = time.time() + 3600  # already armed
        with mock.patch.object(main.requests, "get", side_effect=_flaky_fetch):
            main._fetch_savant_rows(self.GAME, self.DATE)  # within cooldown -> no fetch
            self.assertEqual(len(fetch_calls), 0)
            # Cooldown expires -> a retry spawns and fails, re-arming it.
            with main._savant_rows_lock:
                main._savant_rows_next_attempt[self.GAME] = 0.0
            main._fetch_savant_rows(self.GAME, self.DATE)
            deadline = time.time() + 5
            while time.time() < deadline and not _rebuild_done_and_armed():
                time.sleep(0.01)
            self.assertTrue(_rebuild_done_and_armed())
            main._fetch_savant_rows(self.GAME, self.DATE)  # freshly armed -> no re-fetch
            self.assertEqual(len(fetch_calls), 1)
            # Cooldown expires again -> retry allowed.
            with main._savant_rows_lock:
                main._savant_rows_next_attempt[self.GAME] = 0.0
            main._fetch_savant_rows(self.GAME, self.DATE)
            deadline = time.time() + 5
            while time.time() < deadline and len(fetch_calls) < 2:
                time.sleep(0.01)

        self.assertEqual(len(fetch_calls), 2)

    def test_savant_rows_cache_prunes_to_cap(self):
        """The rows cache is LRU-bounded: past max entries, least-recently-used
        games are evicted (and their backoff entries dropped) while a game whose
        rebuild is still in flight is never evicted."""
        main._SAVANT_ROWS_CACHE_MAX_ENTRIES = 4
        # Eight games resident, oldest first (last_used rising with index).
        for i in range(8):
            g = str(9000 + i)
            main._savant_rows_cache[g] = [{"game_pk": g}]
            main._savant_rows_cache_last_used[g] = float(i)
        main._savant_rows_next_attempt["9000"] = 123.0
        main._savant_rows_building.add("9005")  # mid-fetch; must survive

        main._prune_savant_rows_cache()

        self.assertEqual(
            sorted(main._savant_rows_cache),
            ["9004", "9005", "9006", "9007"],
        )
        # The backoff stamp for an evicted game is dropped with its rows.
        self.assertNotIn("9000", main._savant_rows_next_attempt)
        # The in-flight game kept both its rows and its building flag.
        self.assertIn("9005", main._savant_rows_building)
        self.assertIn("9005", main._savant_rows_cache)
