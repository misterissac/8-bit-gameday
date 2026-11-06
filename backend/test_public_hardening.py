"""Offline tests for the public-request guards.

Covers the three things a stranger on the internet can hit before the MLB feed
is ever consulted: a malformed ``game_pk``, request volume, and the CORS grant.
"""

import asyncio
import os
import sys
import time
import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi.testclient import TestClient

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import main  # noqa: E402


class GamePkValidationTests(unittest.TestCase):
    """A bad game id must fail at the edge, not become an outbound fetch."""

    def setUp(self):
        # These assertions are about validation, not volume: reset both buckets
        # so traffic from an earlier test file cannot turn the last probe into
        # a 429.
        with main._RATE_LIMIT_GUARD:
            main._RATE_LIMIT_BUCKETS.clear()
            main._RATE_LIMIT_GLOBAL.clear()
        self.client = TestClient(main.app)

    def test_malformed_game_pk_is_rejected_before_any_fetch(self):
        for bad in ("abc", "../../api/v1/teams", "1234", "12345678", "82 2774", ""):
            response = self.client.get("/api/game-status", params={"game_pk": bad})
            self.assertEqual(response.status_code, 400, bad)
            self.assertIn("game_pk", response.json()["detail"])

    def test_malformed_game_pk_is_rejected_on_the_polled_endpoints(self):
        headers = {"If-None-Match": '"x"'}
        for path in ("/api/trajectory", "/api/batted-ball", "/api/game-state",
                     "/api/game-log", "/api/at-bat", "/api/batter-pitches",
                     "/api/box-score", "/api/trajectory/compare"):
            response = self.client.get(path, params={"game_pk": "not-a-game"}, headers=headers)
            self.assertEqual(response.status_code, 400, path)

    def test_helper_accepts_the_ids_the_mlb_api_issues(self):
        self.assertEqual(main._checked_game_pk("822774"), "822774")
        self.assertEqual(main._checked_game_pk(" 745804 "), "745804")


class RateLimitTests(unittest.TestCase):
    """Token bucket per client, 429 with Retry-After once the burst is gone."""

    def setUp(self):
        self._saved = (main.RATE_LIMIT_PER_SECOND, main.RATE_LIMIT_BURST)
        main.RATE_LIMIT_PER_SECOND = 0.0
        main.RATE_LIMIT_BURST = 2.0
        with main._RATE_LIMIT_GUARD:
            main._RATE_LIMIT_BUCKETS.clear()
            main._RATE_LIMIT_GLOBAL.clear()
        self.client = TestClient(main.app)

    def tearDown(self):
        main.RATE_LIMIT_PER_SECOND, main.RATE_LIMIT_BURST = self._saved
        with main._RATE_LIMIT_GUARD:
            main._RATE_LIMIT_BUCKETS.clear()
            main._RATE_LIMIT_GLOBAL.clear()

    def test_burst_then_429_with_retry_after(self):
        self.assertEqual(self.client.get("/openapi.json").status_code, 200)
        self.assertEqual(self.client.get("/openapi.json").status_code, 200)
        blocked = self.client.get("/openapi.json")
        self.assertEqual(blocked.status_code, 429)
        self.assertEqual(blocked.headers["retry-after"], "1")
        self.assertEqual(blocked.json()["detail"], "too many requests")

    def test_forwarded_for_from_a_direct_caller_is_ignored(self):
        # TestClient's peer is not loopback, so it must not be able to pick its
        # own bucket by inventing X-Forwarded-For.
        headers = {"X-Forwarded-For": "9.9.9.9"}
        self.assertEqual(self.client.get("/openapi.json", headers=headers).status_code, 200)
        self.assertEqual(self.client.get("/openapi.json", headers=headers).status_code, 200)
        self.assertEqual(self.client.get("/openapi.json", headers=headers).status_code, 429)

    def test_client_key_reads_the_last_hop_from_a_loopback_proxy(self):
        class _Request:
            class client:
                host = "127.0.0.1"

            headers = {"x-forwarded-for": "198.51.100.7, 203.0.113.9"}

        self.assertEqual(main._client_key(_Request()), "203.0.113.9")


class _FakeRequest:
    """Enough of a Starlette Request to exercise the middleware's key logic."""

    def __init__(self, peer, forwarded=None):
        self.client = SimpleNamespace(host=peer) if peer is not None else None
        self.headers = {"x-forwarded-for": forwarded} if forwarded is not None else {}


async def _ok(request):
    return main.Response(status_code=200)


class ClientIdentityTests(unittest.TestCase):
    """The bucket key comes from the socket peer, not from the caller's word."""

    def test_forwarded_chain_is_read_from_the_right(self):
        # A caller-invented entry sits to the left of the hop the proxy wrote.
        request = _FakeRequest("127.0.0.1", "1.2.3.4, 198.51.100.7")
        self.assertEqual(main._client_key(request), "198.51.100.7")

    def test_forwarded_header_from_an_untrusted_peer_is_ignored(self):
        for forged in ("198.51.100.7", "203.0.113.9", "not-an-ip"):
            request = _FakeRequest("203.0.113.50", forged)
            self.assertEqual(main._client_key(request), "203.0.113.50", forged)

    def test_a_request_with_no_peer_shares_one_key(self):
        self.assertEqual(
            main._client_key(_FakeRequest(None, "198.51.100.7")), "unknown"
        )

    def test_unparseable_forwarded_value_falls_back_to_the_peer(self):
        self.assertEqual(
            main._client_key(_FakeRequest("127.0.0.1", "not-an-ip")), "127.0.0.1"
        )

    @unittest.skipIf("TRUSTED_PROXY_CIDRS" in os.environ, "env overrides the default")
    def test_default_trust_is_loopback_only(self):
        self.assertTrue(main._peer_is_trusted("127.0.0.1"))
        self.assertTrue(main._peer_is_trusted("::1"))
        for public in ("203.0.113.9", "10.0.0.1", "198.51.100.7"):
            self.assertFalse(main._peer_is_trusted(public), public)

    def test_a_malformed_cidr_is_dropped_not_widened(self):
        self.assertEqual(
            main._parse_proxy_cidrs("127.0.0.1/32,nonsense,10.0.0.0/8"),
            main._parse_proxy_cidrs("127.0.0.1/32,10.0.0.0/8"),
        )


class ProxyBudgetTests(unittest.TestCase):
    """Budgets follow the proved client, not the header the client sent."""

    def setUp(self):
        self._saved = (
            main.RATE_LIMIT_PER_SECOND,
            main.RATE_LIMIT_BURST,
            main._TRUSTED_PROXY_NETWORKS,
        )
        main.RATE_LIMIT_PER_SECOND = 0.0
        main.RATE_LIMIT_BURST = 2.0
        # 10.0.0.0/8 stands in for a CDN whose ranges the operator configured.
        main._TRUSTED_PROXY_NETWORKS = main._parse_proxy_cidrs(
            "127.0.0.1/32,::1/128,10.0.0.0/8"
        )
        with main._RATE_LIMIT_GUARD:
            main._RATE_LIMIT_BUCKETS.clear()
            main._RATE_LIMIT_GLOBAL.clear()

    def tearDown(self):
        (
            main.RATE_LIMIT_PER_SECOND,
            main.RATE_LIMIT_BURST,
            main._TRUSTED_PROXY_NETWORKS,
        ) = self._saved
        with main._RATE_LIMIT_GUARD:
            main._RATE_LIMIT_BUCKETS.clear()
            main._RATE_LIMIT_GLOBAL.clear()

    def _status(self, peer, forwarded=None):
        response = asyncio.run(
            main.rate_limit_middleware(_FakeRequest(peer, forwarded), _ok)
        )
        return response.status_code

    def test_two_visitors_through_the_proxy_get_independent_budgets(self):
        self.assertEqual(self._status("127.0.0.1", "198.51.100.7"), 200)
        self.assertEqual(self._status("127.0.0.1", "198.51.100.7"), 200)
        self.assertEqual(self._status("127.0.0.1", "198.51.100.7"), 429)
        # A different visitor is not punished for the first one's spending.
        self.assertEqual(self._status("127.0.0.1", "198.51.100.8"), 200)

    def test_visitors_behind_a_trusted_cdn_are_not_merged_into_one_bucket(self):
        # The peer is the CDN, not the visitor: the key has to be the address the
        # CDN appended, or every visitor shares one budget.
        for _ in range(2):
            self.assertEqual(self._status("10.1.2.3", "198.51.100.7"), 200)
        self.assertEqual(self._status("10.1.2.3", "198.51.100.7"), 429)
        self.assertEqual(self._status("10.1.2.3", "198.51.100.8"), 200)

    def test_forged_forwarded_for_cannot_buy_a_fresh_budget(self):
        # An untrusted peer gets one bucket no matter what it puts in the header.
        self.assertEqual(self._status("203.0.113.50", "198.51.100.7"), 200)
        self.assertEqual(self._status("203.0.113.50", "198.51.100.8"), 200)
        self.assertEqual(self._status("203.0.113.50", "198.51.100.9"), 429)


class CorsPinTests(unittest.TestCase):
    """The API is same-origin in production; no grant for anyone else."""

    def setUp(self):
        with main._RATE_LIMIT_GUARD:
            main._RATE_LIMIT_BUCKETS.clear()
            main._RATE_LIMIT_GLOBAL.clear()
        self.client = TestClient(main.app)

    def test_unknown_origin_gets_no_grant(self):
        response = self.client.get(
            "/openapi.json", headers={"Origin": "https://evil.example"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_dev_origin_is_allowed(self):
        response = self.client.get(
            "/openapi.json", headers={"Origin": "http://localhost:5173"}
        )
        self.assertEqual(
            response.headers.get("access-control-allow-origin"),
            "http://localhost:5173",
        )


class GlobalRateLimitTests(unittest.TestCase):
    """A flood spread over many addresses is bounded by the aggregate bucket."""

    def setUp(self):
        self._saved = (
            main.RATE_LIMIT_GLOBAL_PER_SECOND,
            main.RATE_LIMIT_GLOBAL_BURST,
        )
        main.RATE_LIMIT_GLOBAL_PER_SECOND = 0.0
        main.RATE_LIMIT_GLOBAL_BURST = 2.0
        with main._RATE_LIMIT_GUARD:
            main._RATE_LIMIT_BUCKETS.clear()
            main._RATE_LIMIT_GLOBAL.clear()
        self.client = TestClient(main.app)

    def tearDown(self):
        (
            main.RATE_LIMIT_GLOBAL_PER_SECOND,
            main.RATE_LIMIT_GLOBAL_BURST,
        ) = self._saved
        with main._RATE_LIMIT_GUARD:
            main._RATE_LIMIT_BUCKETS.clear()
            main._RATE_LIMIT_GLOBAL.clear()

    def test_aggregate_bucket_blocks_while_the_client_is_still_under_its_own(self):
        # The per-client bucket is untouched here (default 20/s, 40 burst), so
        # only the shared bucket can produce the 429.
        self.assertEqual(self.client.get("/openapi.json").status_code, 200)
        self.assertEqual(self.client.get("/openapi.json").status_code, 200)
        blocked = self.client.get("/openapi.json")
        self.assertEqual(blocked.status_code, 429)
        self.assertEqual(blocked.headers["retry-after"], "1")


class RateLimitMemoryTests(unittest.TestCase):
    """The per-client map is hard-bounded, even when every entry is fresh."""

    def test_map_stays_at_its_cap(self):
        saved = main._RATE_LIMIT_MAX_CLIENTS
        main._RATE_LIMIT_MAX_CLIENTS = 8
        try:
            with main._RATE_LIMIT_GUARD:
                main._RATE_LIMIT_BUCKETS.clear()
            now = time.monotonic()
            for index in range(200):
                with main._RATE_LIMIT_GUARD:
                    main._consume_token(
                        main._RATE_LIMIT_BUCKETS,
                        f"198.51.100.{index}",
                        main.RATE_LIMIT_PER_SECOND,
                        main.RATE_LIMIT_BURST,
                        now + index * 0.001,
                        main._RATE_LIMIT_MAX_CLIENTS,
                    )
            self.assertLessEqual(len(main._RATE_LIMIT_BUCKETS), 8)
        finally:
            main._RATE_LIMIT_MAX_CLIENTS = saved
            with main._RATE_LIMIT_GUARD:
                main._RATE_LIMIT_BUCKETS.clear()


class PitcherMovementGuardTests(unittest.TestCase):
    """A caller-supplied id may not become an outbound Savant fetch."""

    def test_ids_that_cannot_be_mlb_players_are_rejected(self):
        for bad in (0, 7, 123, "abc", "1e5", 12345678):
            with self.assertRaises(main.HTTPException, msg=str(bad)) as caught:
                main.get_pitcher_movement(bad)
            self.assertEqual(caught.exception.status_code, 400)

    def test_out_of_range_season_is_rejected(self):
        with self.assertRaises(main.HTTPException) as caught:
            main.get_pitcher_movement(592789, year=1990)
        self.assertEqual(caught.exception.status_code, 400)


class ScheduleCacheTests(unittest.TestCase):
    """The drawer's refresh must not become one statsapi fetch per click."""

    def setUp(self):
        main._live_games_cache.clear()

    def tearDown(self):
        main._live_games_cache.clear()

    def test_repeated_reads_share_one_fetch(self):
        calls = []

        class _Response:
            def raise_for_status(self):
                return None

            def json(self):
                return {"dates": []}

        def fake_get(url, **kwargs):
            calls.append(url)
            return _Response()

        with mock.patch.object(main.requests, "get", fake_get):
            for _ in range(5):
                self.assertEqual(
                    main.get_live_games(),
                    {"success": True, "games": [], "finished": [], "upcoming": []},
                )
        self.assertEqual(len(calls), 1)

    def test_a_failed_fetch_is_not_cached(self):
        calls = []

        def failing_get(url, **kwargs):
            calls.append(url)
            raise RuntimeError("statsapi down")

        with mock.patch.object(main.requests, "get", failing_get):
            for _ in range(2):
                with self.assertRaises(main.HTTPException) as caught:
                    main.get_live_games()
                self.assertEqual(caught.exception.status_code, 502)
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
