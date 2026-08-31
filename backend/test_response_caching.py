"""Offline tests for the live endpoint response caches."""

import copy
import os
import sys
import threading
import time
import unittest
from unittest import mock

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import main  # noqa: E402


def _suppress_worker_network():
    """Neutralize the xBA-grid rebuild thread and the Sprint-Speed fetch.

    ``_compute_xba`` fires both: ``main._xba_grid`` lazily starts a background
    daemon thread that scrapes Baseball Savant, and ``main._sprint_speed_by_``
    ``player`` makes a synchronous Savant call when its cache is cold. Both
    funnel through the shared ``requests.get`` module attribute that these tests
    patch. A worker thread kicked off on a cached-response test (e.g. a
    trajectory cache hit calling ``_refresh_xba_in_place``) therefore keeps
    calling the *next* test's fresh mock and drains its ``side_effect`` list,
    producing an intermittent ``StopIteration`` far from the true source.

    Returning ``None`` / ``{}`` from these two keeps the suite hermetic and
    fast: no thread is ever spawned, so nothing can leak across tests. Returns
    the original callables as a (grid, sprint) tuple for ``_restore_worker_``
    ``network``.
    """
    saved = (main._xba_grid, main._sprint_speed_by_player)
    main._xba_grid = lambda: None  # grid stays cold -> xBA shows a dash
    main._sprint_speed_by_player = lambda: {}  # no synchronous Sprint Speed call
    return saved


def _restore_worker_network(saved):
    """Restore the xBA-grid / Sprint-Speed callables patched in setUp."""
    main._xba_grid, main._sprint_speed_by_player = saved


def _feed_side_effect(responses, game_pk):
    """Build a ``requests.get`` side_effect that can never StopIterate.

    A plain list side_effect raises ``StopIteration`` once every element is
    consumed, so any out-of-band call — a leftover background worker still
    holding the shared mock, hypothesis/typeguard introspection, etc. — turns a
    healthy test into a mystery failure. This callable sequences only the MLB
    live-feed URL for ``game_pk``: expected calls get ``responses`` in order,
    and any *overflow* feed call repeats the last response instead of raising.
    Every other URL returns a benign 200 payload so auxiliary fetches (Sprint
    Speed, xBA grid, Savant rows) no-op instantly instead of blocking or
    consuming a feed entry.
    """
    feed_url = main._feed_url(str(game_pk))
    sequence = list(responses)
    served = {"count": 0}

    def side_effect(url, *args, **kwargs):
        if url != feed_url:
            return _FeedResponse({"error": "not the MLB feed"})
        index = served["count"]
        served["count"] += 1
        if index < len(sequence):
            return sequence[index]
        return sequence[-1]  # never raise StopIteration on stray extra calls

    return side_effect


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
        main._clear_feed_cache()
        with main._TRAJECTORY_CACHE_GUARD:
            main._TRAJECTORY_CACHE.clear()
            main._TRAJECTORY_BUILD_LOCKS.clear()
            main._TRAJECTORY_BUILD_LOCKS_LAST_USED.clear()
        with main._BATTED_BALL_CACHE_GUARD:
            main._BATTED_BALL_CACHE.clear()
            main._BATTED_BALL_BUILD_LOCKS.clear()
            main._BATTED_BALL_BUILD_LOCKS_LAST_USED.clear()
        # Keep cached-response refreshes from spawning worker threads / stray
        # network calls that leak into the next test's requests.get mock.
        self._saved_workers = _suppress_worker_network()

    def tearDown(self):
        _restore_worker_network(self._saved_workers)

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
            side_effect=_feed_side_effect(
                [_FeedResponse(initial), _FeedResponse(advanced)], "game-1"
            ),
        ), mock.patch.object(
            main, "_build_trajectory_payload", side_effect=build_latest
        ), mock.patch.object(
            main, "_build_pitch_payload", side_effect=build_catch_up
        ):
            first = main.get_trajectory(env="default", game_pk="game-1")
            # Force a fresh feed fetch for the advanced poll (the feed cache
            # would otherwise serve the unchanged feed within its short TTL).
            main._clear_feed_cache()
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
            side_effect=_feed_side_effect(
                [
                    _FeedResponse(initial),
                    _FeedResponse(advanced),
                    _FeedResponse(advanced),
                ],
                "game-1",
            ),
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
                main._TRAJECTORY_BUILD_LOCKS_LAST_USED.clear()
            main._clear_feed_cache()
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

    def test_trajectory_build_locks_prune_beyond_window(self):
        """Per-cursor single-flight locks are bounded per game/environment (LRU)
        and a lock an in-flight build holds is never evicted."""
        original_max = main._TRAJECTORY_BUILD_LOCKS_MAX_ENTRIES
        main._TRAJECTORY_BUILD_LOCKS_MAX_ENTRIES = 4
        try:
            scope = ("game-1", "default")
            with main._TRAJECTORY_CACHE_GUARD:
                for cursor in range(6):
                    key = (scope[0], scope[1], f"P{cursor}")
                    main._TRAJECTORY_BUILD_LOCKS[key] = threading.Lock()
                    main._TRAJECTORY_BUILD_LOCKS_LAST_USED[key] = float(cursor)
                held_key = (scope[0], scope[1], "P1")
                main._TRAJECTORY_BUILD_LOCKS[held_key].acquire()
                # A different game's locks are a separate scope and must survive.
                other_key = ("game-2", "default", "P0")
                main._TRAJECTORY_BUILD_LOCKS[other_key] = threading.Lock()
                main._TRAJECTORY_BUILD_LOCKS_LAST_USED[other_key] = 99.0
            try:
                main._prune_build_locks(
                    main._TRAJECTORY_BUILD_LOCKS,
                    main._TRAJECTORY_BUILD_LOCKS_LAST_USED,
                    main._TRAJECTORY_CACHE_GUARD,
                    scope,
                    main._TRAJECTORY_BUILD_LOCKS_MAX_ENTRIES,
                )
            finally:
                main._TRAJECTORY_BUILD_LOCKS[held_key].release()
            with main._TRAJECTORY_CACHE_GUARD:
                remaining = set(main._TRAJECTORY_BUILD_LOCKS)

            scoped_remaining = [key for key in remaining if key[0:2] == scope]
            self.assertLessEqual(len(scoped_remaining), 4)
            self.assertIn(held_key, scoped_remaining)  # in-flight lock survives
            self.assertIn((scope[0], scope[1], "P5"), scoped_remaining)  # newest kept
            self.assertNotIn((scope[0], scope[1], "P0"), scoped_remaining)  # LRU dropped
            self.assertIn(other_key, remaining)  # other game untouched
        finally:
            main._TRAJECTORY_BUILD_LOCKS_MAX_ENTRIES = original_max

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
            side_effect=_feed_side_effect(
                [
                    _FeedResponse(initial),
                    _FeedResponse(advanced),
                    _FeedResponse(advanced),
                ],
                "game-1",
            ),
        ), mock.patch.object(main, "_build_hit_payload", side_effect=build_hit):
            first = main.get_batted_ball(game_pk="game-1")
            # The latest response is dropped. The next poll uses the last hit
            # the client applied and must recover the intervening hit payloads.
            main._clear_feed_cache()
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
            side_effect=_feed_side_effect(
                [_FeedResponse(incomplete), _FeedResponse(complete)], "game-1"
            ),
        ), mock.patch.object(main, "_build_hit_payload", side_effect=build):
            first = main.get_batted_ball(game_pk="game-1")
            main._clear_feed_cache()
            second = main.get_batted_ball(game_pk="game-1")

        self.assertIsNot(first, second)
        self.assertEqual(len(built), 2)


class FeedCacheTests(unittest.TestCase):
    """Tests for the short-TTL MLB feed cache in ``_fetch_feed``."""

    def setUp(self):
        main._clear_feed_cache()
        self._saved_workers = _suppress_worker_network()

    def tearDown(self):
        _restore_worker_network(self._saved_workers)

    def _feed_fetches(self, session_patch, game_pk):
        """Count only the mock calls that target the MLB live-feed URL for
        ``game_pk``. Endpoint helpers make their own auxiliary ``requests.get``
        calls (xBA grid, break averages, etc.), so a raw call count would
        overcount; what the feed cache deduplicates is exactly the feed fetch."""
        feed_url = main._feed_url(str(game_pk))
        return sum(1 for call in getattr(session_patch, "call_args_list", []) if call.args and call.args[0] == feed_url)

    def test_feed_shared_across_concurrent_endpoint_polls_within_ttl(self):
        """Several endpoint polls landing in one window reuse a single MLB
        fetch, even though each endpoint fetches before its own cache check."""
        feed = _trajectory_feed()
        built = []

        def build(*args, **kwargs):
            payload = {"success": True, "play_id": "AB4-P1"}
            built.append(payload)
            return payload

        with mock.patch.object(main.requests, "get", return_value=_FeedResponse(feed)) as get, \
             mock.patch.object(main, "_build_trajectory_payload", side_effect=build), \
             mock.patch.object(main, "_build_hit_payload", side_effect=build):
            main.get_trajectory(env="default", game_pk="game-1")
            main.get_trajectory(env="default", game_pk="game-1")
            main.get_game_state(game_pk="game-1")

        # All three polls hit a different endpoint path but share one feed fetch.
        self.assertEqual(self._feed_fetches(get, "game-1"), 1)

    def test_different_games_each_fetch_their_own_feed(self):
        feed = _trajectory_feed()
        built = []

        def build(*args, **kwargs):
            payload = {"success": True, "play_id": "AB4-P1"}
            built.append(payload)
            return payload

        with mock.patch.object(main.requests, "get", return_value=_FeedResponse(feed)) as get, \
             mock.patch.object(main, "_build_trajectory_payload", side_effect=build):
            main.get_trajectory(env="default", game_pk="game-1")
            main.get_trajectory(env="default", game_pk="game-2")

        self.assertEqual(self._feed_fetches(get, "game-1"), 1)
        self.assertEqual(self._feed_fetches(get, "game-2"), 1)

    def test_feed_refetched_after_ttl_expires(self):
        """Once the TTL passes, the next poll fetches a fresh feed instead of
        serving a stale copy forever."""
        initial = _trajectory_feed()
        advanced = copy.deepcopy(initial)
        events = advanced["liveData"]["plays"]["allPlays"][0]["playEvents"]
        for pitch_number in (2, 3):
            pitch = copy.deepcopy(events[0])
            pitch["pitchNumber"] = pitch_number
            events.append(pitch)

        def build_latest(data, *args, **kwargs):
            _, pitch, _ = main._latest_simulatable_pitch(data)
            return {"success": True, "play_id": f"AB4-P{pitch['pitchNumber']}"}

        with mock.patch.object(
            main.requests,
            "get",
            side_effect=_feed_side_effect(
                [_FeedResponse(initial), _FeedResponse(advanced)], "game-1"
            ),
        ), mock.patch.object(main, "_build_trajectory_payload", side_effect=build_latest):
            first = main.get_trajectory(env="default", game_pk="game-1")
            # Whatever the wall-clock TTL elapsed here, the feed cache must never
            # serve a stale copy of the (barely-changed) feed forever.
            with main._TRAJECTORY_CACHE_GUARD:
                main._TRAJECTORY_CACHE.clear()
                main._TRAJECTORY_BUILD_LOCKS.clear()
                main._TRAJECTORY_BUILD_LOCKS_LAST_USED.clear()
            with main._FEED_CACHE_GUARD:
                main._FEED_CACHE["game-1"]["fetched_at"] = -1e9  # force expiry
            second = main.get_trajectory(env="default", game_pk="game-1")

        self.assertEqual(first["play_id"], "AB4-P1")
        self.assertEqual(second["play_id"], "AB4-P3")

    def test_feed_build_locks_prune_beyond_window(self):
        """Heavy multi-game sessions don't accumulate per-game feed locks (or
        stale feed payloads) forever; the LRU-style prune bounds them and never
        evicts a lock a fetch is currently holding."""
        original_max = main._FEED_BUILD_LOCKS_MAX_ENTRIES
        main._FEED_BUILD_LOCKS_MAX_ENTRIES = 4
        try:
            with main._FEED_CACHE_GUARD:
                for index, game in enumerate(("g1", "g2", "g3", "g4", "g5", "g6")):
                    main._FEED_BUILD_LOCKS[game] = threading.Lock()
                    main._FEED_BUILD_LOCKS_LAST_USED[game] = float(index)
                # One in-flight fetch holds a lock; it must survive eviction.
                held_game = "g2"
                main._FEED_BUILD_LOCKS[held_game].acquire()
                # An expired feed payload should be freed and cannot pin a game.
                main._FEED_CACHE["stale"] = {"data": {}, "fetched_at": -1e9}
            try:
                main._prune_feed_build_locks()
            finally:
                # Whatever happens, release the held lock so the suite resets.
                main._FEED_BUILD_LOCKS[held_game].release()
            with main._FEED_CACHE_GUARD:
                remaining = set(main._FEED_BUILD_LOCKS)

            # Window enforced (g6..g2 kept by recency; g1 dropped first).
            self.assertLessEqual(len(remaining), 4)
            self.assertIn(held_game, remaining)  # never evict an in-flight lock
            self.assertIn("g6", remaining)
            self.assertNotIn("g1", remaining)
            # Stale feed payload freed alongside.
            with main._FEED_CACHE_GUARD:
                self.assertNotIn("stale", main._FEED_CACHE)
        finally:
            main._FEED_BUILD_LOCKS_MAX_ENTRIES = original_max

    def test_feed_payloads_prune_beyond_window(self):
        """Many games polled within the same TTL window can't pin unbounded
        parsed feeds; the cap on ``_FEED_CACHE`` evicts the oldest-fetched, an
        expired entry is freed, and a game whose fetch is in flight is spared."""
        original_max = main._FEED_CACHE_MAX_ENTRIES
        main._FEED_CACHE_MAX_ENTRIES = 4
        held_game = "g1"  # the OLDEST-fetched game, with its fetch in flight
        try:
            base = time.monotonic()
            with main._FEED_CACHE_GUARD:
                # All live (within TTL); g1 is the oldest-fetched, g6 the newest.
                for index, game in enumerate(("g1", "g2", "g3", "g4", "g5", "g6")):
                    main._FEED_CACHE[game] = {
                        "data": {}, "fetched_at": base - 0.1 * (5 - index),
                    }
                    main._FEED_BUILD_LOCKS[game] = threading.Lock()
                    main._FEED_BUILD_LOCKS_LAST_USED[game] = base - 0.1 * (5 - index)
                # Expired payload: must be freed regardless of the cap.
                main._FEED_CACHE["stale"] = {"data": {}, "fetched_at": base - 1e9}
                main._FEED_BUILD_LOCKS[held_game].acquire()
            try:
                main._prune_feed_build_locks()
            finally:
                main._FEED_BUILD_LOCKS[held_game].release()
            with main._FEED_CACHE_GUARD:
                remaining = set(main._FEED_CACHE)

            # Cap enforced: g1 spared (in-flight fetch), g2/g3 evicted as oldest.
            self.assertEqual(sorted(remaining), ["g1", "g4", "g5", "g6"])
            # Expired feed payload freed alongside.
            self.assertNotIn("stale", remaining)
        finally:
            main._FEED_CACHE_MAX_ENTRIES = original_max

    def test_feed_side_effect_never_exhausts(self):
        """The resilient side_effect can't overrun its response list: a stray
        feed call repeats the last response and non-feed URLs no-op, so no test
        can die with StopIteration from an out-of-band requests.get."""
        initial = _trajectory_feed()
        advanced = copy.deepcopy(initial)
        events = advanced["liveData"]["plays"]["allPlays"][0]["playEvents"]
        pitch = copy.deepcopy(events[0])
        pitch["pitchNumber"] = 2
        events.append(pitch)

        effect = _feed_side_effect(
            [_FeedResponse(initial), _FeedResponse(advanced)], "game-1"
        )
        feed_url = main._feed_url("game-1")

        # Expected sequence served in order.
        self.assertIs(effect(feed_url).json(), initial)
        self.assertIs(effect(feed_url).json(), advanced)
        # Overflow call (the historical flake's extra mocked request) must not
        # raise StopIteration; it repeats the last response.
        self.assertIs(effect(feed_url).json(), advanced)
        # Any non-feed URL (Sprint Speed, xBA grid, Savant rows) no-ops fast.
        self.assertEqual(
            effect("https://baseballsavant.mlb.com/leaderboard/sprint_speed").json(),
            {"error": "not the MLB feed"},
        )


class PrewarmTrajectoryTests(unittest.TestCase):
    """Fire-and-forget behavior of ``/api/trajectory/prewarm``."""

    def setUp(self):
        main._clear_feed_cache()
        with main._TRAJECTORY_CACHE_GUARD:
            main._TRAJECTORY_CACHE.clear()
            main._TRAJECTORY_BUILD_LOCKS.clear()
            main._TRAJECTORY_BUILD_LOCKS_LAST_USED.clear()
        self._saved_workers = _suppress_worker_network()

    def tearDown(self):
        _restore_worker_network(self._saved_workers)

    def test_prewarm_cold_game_kicks_background_build_fire_and_forget(self):
        calls = []

        def _throwing_build(env="live", game_pk=None):
            calls.append(game_pk)
            raise RuntimeError("must run in the background thread and be swallowed")

        # If the build ran synchronously, the raised error would propagate out
        # of ``prewarm_trajectory`` and fail this test; returning cleanly proves
        # the build is fire-and-forget.
        with mock.patch.object(main, "get_trajectory", side_effect=_throwing_build):
            result = main.prewarm_trajectory(game_pk="game-prewarm")

        self.assertFalse(result["warm"])
        self.assertEqual(result["game_pk"], "game-prewarm")
        # The background thread runs the requested build.
        deadline = time.time() + 5
        while time.time() < deadline and not calls:
            time.sleep(0.01)
        self.assertEqual(calls, ["game-prewarm"])

    def test_prewarm_warm_game_is_a_noop(self):
        with main._TRAJECTORY_CACHE_GUARD:
            main._TRAJECTORY_CACHE[("game-warm", "live", "")] = {
                "source_key": "k",
                "response": {"success": True},
                "last_used_at": 1.0,
            }
        calls = []
        with mock.patch.object(
            main, "get_trajectory", side_effect=lambda *a, **k: calls.append(1)
        ):
            result = main.prewarm_trajectory(game_pk="game-warm")
            time.sleep(0.1)  # give a stray thread time to appear (there must be none)
        self.assertTrue(result["warm"])
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
