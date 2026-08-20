"""Offline tests for the live endpoint response caches."""

import copy
import os
import sys
import unittest
from unittest import mock

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import main  # noqa: E402


class _FeedResponse:
    status_code = 200

    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


def _trajectory_feed():
    pitch = {
        "isPitch": True,
        "pitchNumber": 1,
        "pitchData": {
            "coordinates": {
                key: 1.0 for key in ("x0", "y0", "z0", "vX0", "vY0", "vZ0", "aX", "aY", "aZ")
            },
            "breaks": {"spinRate": 2200, "spinDirection": 180},
        },
        "details": {"call": {"code": "C"}},
    }
    return {
        "gameData": {},
        "liveData": {
            "plays": {
                "allPlays": [{
                    "about": {"atBatIndex": 4},
                    "matchup": {},
                    "playEvents": [pitch],
                }],
            },
        },
    }


def _batted_ball_feed():
    return {
        "gameData": {},
        "liveData": {
            "plays": {
                "allPlays": [{
                    "about": {"atBatIndex": 4},
                    "matchup": {},
                    "playEvents": [{
                        "hitData": {
                            "launchSpeed": 100,
                            "launchAngle": 20,
                            "location": "8",
                            "coordinates": {"coordX": 125, "coordY": 150},
                        },
                    }],
                }],
            },
        },
    }


class ResponseCacheTests(unittest.TestCase):
    def setUp(self):
        with main._TRAJECTORY_CACHE_GUARD:
            main._TRAJECTORY_CACHE.clear()
            main._TRAJECTORY_BUILD_LOCKS.clear()
        with main._BATTED_BALL_CACHE_GUARD:
            main._BATTED_BALL_CACHE.clear()
            main._BATTED_BALL_BUILD_LOCKS.clear()

    def test_trajectory_reuses_latest_response_for_same_game_and_pitch(self):
        feed = _trajectory_feed()
        built = []

        def build(*args, **kwargs):
            payload = {"success": True, "play_id": "AB4-P1", "build": len(built) + 1}
            built.append(payload)
            return payload

        with mock.patch.object(main.requests, "get", return_value=_FeedResponse(feed)), \
             mock.patch.object(main, "_build_trajectory_payload", side_effect=build):
            first = main.get_trajectory(env="default", game_pk="game-1")
            second = main.get_trajectory(env="default", game_pk="game-1")
            other_game = main.get_trajectory(env="default", game_pk="game-2")

        self.assertIs(first, second)
        self.assertEqual(len(built), 2)
        self.assertIsNot(first, other_game)

    def test_trajectory_returns_pitches_skipped_between_polls(self):
        initial = _trajectory_feed()
        advanced = copy.deepcopy(initial)
        events = advanced["liveData"]["plays"]["allPlays"][0]["playEvents"]
        for pitch_number in (2, 3, 4):
            pitch = copy.deepcopy(events[0])
            pitch["pitchNumber"] = pitch_number
            pitch["pitchData"]["coordinates"]["x0"] = float(pitch_number)
            events.append(pitch)

        def build_latest(data, *args, **kwargs):
            _, pitch, _ = main._latest_simulatable_pitch(data)
            return {
                "success": True,
                "play_id": f"AB4-P{pitch['pitchNumber']}",
            }

        def build_catch_up(data, play, pitch, pitch_index, *args, **kwargs):
            return {
                "success": True,
                "play_id": f"AB4-P{pitch['pitchNumber']}",
            }

        with mock.patch.object(
            main.requests,
            "get",
            side_effect=[_FeedResponse(initial), _FeedResponse(advanced)],
        ), mock.patch.object(
            main, "_build_trajectory_payload", side_effect=build_latest
        ), mock.patch.object(
            main, "_build_pitch_payload", side_effect=build_catch_up
        ):
            first = main.get_trajectory(env="default", game_pk="game-1")
            advanced_payload = main.get_trajectory(env="default", game_pk="game-1")

        self.assertEqual(first["play_id"], "AB4-P1")
        self.assertEqual(advanced_payload["play_id"], "AB4-P4")
        self.assertEqual(
            [p["play_id"] for p in advanced_payload["queued_trajectories"]],
            ["AB4-P2", "AB4-P3"],
        )

    def test_client_cursor_recovers_after_a_dropped_latest_response(self):
        initial = _trajectory_feed()
        advanced = copy.deepcopy(initial)
        events = advanced["liveData"]["plays"]["allPlays"][0]["playEvents"]
        for pitch_number in (2, 3, 4):
            pitch = copy.deepcopy(events[0])
            pitch["pitchNumber"] = pitch_number
            pitch["pitchData"]["coordinates"]["x0"] = float(pitch_number)
            events.append(pitch)

        def build_latest(data, *args, **kwargs):
            _, pitch, _ = main._latest_simulatable_pitch(data)
            return {
                "success": True,
                "play_id": f"AB4-P{pitch['pitchNumber']}",
            }

        def build_catch_up(data, play, pitch, pitch_index, *args, **kwargs):
            return {
                "success": True,
                "play_id": f"AB4-P{pitch['pitchNumber']}",
            }

        with mock.patch.object(
            main.requests,
            "get",
            side_effect=[
                _FeedResponse(initial),
                _FeedResponse(advanced),
                _FeedResponse(advanced),
            ],
        ), mock.patch.object(
            main, "_build_trajectory_payload", side_effect=build_latest
        ), mock.patch.object(
            main, "_build_pitch_payload", side_effect=build_catch_up
        ):
            first = main.get_trajectory(env="default", game_pk="game-1")
            # Simulate the response for P4 being lost after the backend built
            # it. The next request must use the client's P1 cursor, not the
            # backend's latest no-cursor cache entry, to recover P2/P3.
            with main._TRAJECTORY_CACHE_GUARD:
                main._TRAJECTORY_CACHE.clear()
                main._TRAJECTORY_BUILD_LOCKS.clear()
            dropped = main.get_trajectory(env="default", game_pk="game-1")
            recovered = main.get_trajectory(
                env="default", game_pk="game-1", after_play_id=first["play_id"]
            )

        self.assertEqual(dropped["play_id"], "AB4-P4")
        self.assertEqual(recovered["play_id"], "AB4-P4")
        self.assertEqual(
            [p["play_id"] for p in recovered["queued_trajectories"]],
            ["AB4-P2", "AB4-P3"],
        )

    def test_trajectory_cursor_cache_prunes_old_entries(self):
        limit = main._TRAJECTORY_CURSOR_CACHE_MAX_ENTRIES
        initial_key = ("game-1", "default", "")
        keep_key = ("game-1", "default", f"AB4-P{limit + 2}")
        with main._TRAJECTORY_CACHE_GUARD:
            main._TRAJECTORY_CACHE[initial_key] = {
                "source_key": "initial",
                "response": {},
                "last_used_at": 0.0,
            }
            for cursor in range(limit + 3):
                key = ("game-1", "default", f"AB4-P{cursor}")
                main._TRAJECTORY_CACHE[key] = {
                    "source_key": str(cursor),
                    "response": {},
                    "last_used_at": float(cursor),
                }
            main._prune_cursor_cache_entries(
                main._TRAJECTORY_CACHE,
                keep_key,
                limit,
            )
            keys = set(main._TRAJECTORY_CACHE)

        self.assertEqual(
            len([key for key in keys if key[0:2] == ("game-1", "default") and key[2]]),
            limit,
        )
        self.assertIn(initial_key, keys)
        self.assertIn(keep_key, keys)
        self.assertNotIn(("game-1", "default", "AB4-P0"), keys)

    def test_batted_ball_cursor_recovers_after_a_dropped_latest_response(self):
        initial = _batted_ball_feed()
        advanced = copy.deepcopy(initial)
        all_plays = advanced["liveData"]["plays"]["allPlays"]
        for at_bat_index in (5, 6, 7):
            play = copy.deepcopy(all_plays[0])
            play["about"] = {"atBatIndex": at_bat_index, "isComplete": True}
            all_plays.append(play)

        def build_hit(play, hit_data, hit_event_index, data):
            return {
                "success": True,
                "play_id": main._batted_ball_play_id(play, hit_event_index),
            }

        with mock.patch.object(
            main.requests,
            "get",
            side_effect=[
                _FeedResponse(initial),
                _FeedResponse(advanced),
                _FeedResponse(advanced),
            ],
        ), mock.patch.object(main, "_build_hit_payload", side_effect=build_hit):
            first = main.get_batted_ball(game_pk="game-1")
            # The latest response is dropped. The next poll uses the last hit
            # the client applied and must recover the intervening hit payloads.
            dropped = main.get_batted_ball(game_pk="game-1")
            recovered = main.get_batted_ball(
                game_pk="game-1", after_play_id=first["play_id"]
            )

        self.assertEqual(first["play_id"], "AB4-EV0")
        self.assertEqual(dropped["play_id"], "AB7-EV0")
        self.assertEqual(recovered["play_id"], "AB7-EV0")
        self.assertEqual(
            [hit["play_id"] for hit in recovered["queued_batted_balls"]],
            ["AB5-EV0", "AB6-EV0"],
        )

    def test_batted_ball_reuses_latest_response_for_same_game_and_hit(self):
        feed = _batted_ball_feed()
        built = []

        def build(*args, **kwargs):
            payload = {"success": True, "play_id": "AB4-E0", "build": len(built) + 1}
            built.append(payload)
            return payload

        with mock.patch.object(main.requests, "get", return_value=_FeedResponse(feed)), \
             mock.patch.object(main, "_build_hit_payload", side_effect=build):
            first = main.get_batted_ball(game_pk="game-1")
            second = main.get_batted_ball(game_pk="game-1")
            other_game = main.get_batted_ball(game_pk="game-2")

        self.assertIs(first, second)
        self.assertEqual(len(built), 2)
        self.assertIsNot(first, other_game)

    def test_batted_ball_rebuilds_when_feed_completes_the_play(self):
        incomplete = _batted_ball_feed()
        complete = copy.deepcopy(incomplete)
        play = complete["liveData"]["plays"]["allPlays"][0]
        play["about"]["isComplete"] = True
        play["result"] = {
            "event": "Flyout",
            "eventType": "field_out",
            "description": "flyout to center field",
        }
        play["runners"] = [{
            "movement": {"isOut": True, "outBase": "1B", "outNumber": 1},
            "credits": [],
        }]
        built = []

        def build(*args, **kwargs):
            payload = {"success": True, "build": len(built) + 1}
            built.append(payload)
            return payload

        with mock.patch.object(
            main.requests,
            "get",
            side_effect=[_FeedResponse(incomplete), _FeedResponse(complete)],
        ), mock.patch.object(main, "_build_hit_payload", side_effect=build):
            first = main.get_batted_ball(game_pk="game-1")
            second = main.get_batted_ball(game_pk="game-1")

        self.assertIsNot(first, second)
        self.assertEqual(len(built), 2)


if __name__ == "__main__":
    unittest.main()
