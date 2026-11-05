"""Offline tests for the public-request guards.

Covers the three things a stranger on the internet can hit before the MLB feed
is ever consulted: a malformed ``game_pk``, request volume, and the CORS grant.
"""

import os
import sys
import unittest

from fastapi.testclient import TestClient

backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import main  # noqa: E402


class GamePkValidationTests(unittest.TestCase):
    """A bad game id must fail at the edge, not become an outbound fetch."""

    def setUp(self):
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
        self.client = TestClient(main.app)

    def tearDown(self):
        main.RATE_LIMIT_PER_SECOND, main.RATE_LIMIT_BURST = self._saved
        with main._RATE_LIMIT_GUARD:
            main._RATE_LIMIT_BUCKETS.clear()

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


class CorsPinTests(unittest.TestCase):
    """The API is same-origin in production; no grant for anyone else."""

    def setUp(self):
        with main._RATE_LIMIT_GUARD:
            main._RATE_LIMIT_BUCKETS.clear()
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


if __name__ == "__main__":
    unittest.main()
