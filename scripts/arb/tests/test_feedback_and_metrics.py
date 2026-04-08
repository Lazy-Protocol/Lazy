"""Unit tests for the feedback loop and metrics fixes.

Locks in:
- M1: load_learned_weights caches by mtime, no disk I/O in hot path
- M3: unrealized_pnl includes perp MTM minus funding
- M4: weekly_realized_loss buckets by settled_at, not created_at
"""

import json
import os
import time
from unittest.mock import MagicMock

import pytest

from scripts.arb.feedback import (
    _LEARNED_WEIGHTS_CACHE,
    load_learned_weights,
    save_learned_weights,
)
from scripts.arb.pnl import ArbTrade, PnLTracker


class TestM1LearnedWeightsMtimeCache:
    """M1: file should only be read on first call OR after mtime changes."""

    def test_repeat_calls_dont_reread_disk(self, tmp_path, monkeypatch):
        path = str(tmp_path / "tier-weights.json")
        with open(path, "w") as f:
            json.dump({"1": 0.95, "2": 0.80}, f)

        # Clear cache between tests
        _LEARNED_WEIGHTS_CACHE.clear()

        # Patch open() to count file reads
        real_open = open
        read_count = {"count": 0}
        def counting_open(*args, **kwargs):
            if args and str(args[0]) == path and (len(args) < 2 or args[1] == "r"):
                read_count["count"] += 1
            return real_open(*args, **kwargs)

        monkeypatch.setattr("builtins.open", counting_open)

        w1 = load_learned_weights(path)
        w2 = load_learned_weights(path)
        w3 = load_learned_weights(path)

        assert w1 == w2 == w3 == {1: 0.95, 2: 0.80}
        assert read_count["count"] == 1, (
            f"Expected 1 disk read across 3 calls, got {read_count['count']}"
        )

    def test_save_invalidates_cache(self, tmp_path):
        path = str(tmp_path / "tier-weights.json")
        _LEARNED_WEIGHTS_CACHE.clear()

        with open(path, "w") as f:
            json.dump({"1": 0.50}, f)
        w1 = load_learned_weights(path)
        assert w1[1] == 0.50

        # Update via save_learned_weights
        save_learned_weights({1: 0.99}, path)
        w2 = load_learned_weights(path)
        assert w2[1] == 0.99, "save_learned_weights should invalidate cache"

    def test_missing_file_returns_default(self, tmp_path):
        _LEARNED_WEIGHTS_CACHE.clear()
        path = str(tmp_path / "nonexistent.json")
        w = load_learned_weights(path)
        # Default weights from config come through
        assert 1 in w  # at least one tier key present

    def test_mtime_change_picks_up_new_value(self, tmp_path):
        path = str(tmp_path / "tier-weights.json")
        _LEARNED_WEIGHTS_CACHE.clear()

        with open(path, "w") as f:
            json.dump({"4": 0.50}, f)
        w1 = load_learned_weights(path)
        assert w1[4] == 0.50

        # External write (simulates someone else updating the file)
        # Ensure mtime actually moves forward
        time.sleep(0.01)
        with open(path, "w") as f:
            json.dump({"4": 0.75}, f)
        os.utime(path, None)  # bump mtime

        w2 = load_learned_weights(path)
        assert w2[4] == 0.75, "New file mtime should trigger re-read"


class TestM3UnrealizedPnLWithPerp:
    """M3: Tier 4 positions with an open perp hedge should contribute MTM."""

    def _make_tracker_with_tier4(self, tmp_path):
        tracker = PnLTracker(trades_file=str(tmp_path / "trades.json"))
        t = ArbTrade(
            id="t4",
            created_at=0,
            underlying="HYPE",
            option_type="P",
            strike=33.0,
            expiry_ts=0,
            qty=500.0,
            rysk_instrument="HYPE-33-P",
            rysk_price=0.93,
            rysk_fee=58.0,
            tier=4,
            hedge_status="perp_backstop",
            perp_instrument="HYPE-PERP",
            perp_entry_price=37.0,
            perp_qty=150.0,
            perp_entry_delta=-150.0,  # short perp = positive delta hedge for long put
            perp_funding_accrued=5.0,
            status="open",
        )
        tracker.trades[t.id] = t
        return tracker, t

    def test_perp_mtm_included_when_spot_drops(self, tmp_path):
        tracker, t = self._make_tracker_with_tier4(tmp_path)

        # Long put hedged with LONG perp (perp_entry_delta=-150 means we had
        # negative option delta and opened a long perp to add positive delta).
        # If spot drops 37 -> 35, the long perp leg LOSES (the put leg gains,
        # but that's not captured here since there's no Derive leg).
        fake_cache = MagicMock()
        fake_cache.get_spot.return_value = 35.0
        fake_cache.get.return_value = None  # no Derive leg

        unrealized = tracker.unrealized_pnl(cache=fake_cache)
        # Long perp: entry 37, mark 35, size 150 -> (35-37)*150 = -300
        # Minus funding accrued 5 = -305
        assert unrealized == pytest.approx(-305.0, rel=1e-6)

    def test_perp_mtm_positive_when_spot_rises(self, tmp_path):
        tracker, t = self._make_tracker_with_tier4(tmp_path)

        # Spot rises 37 -> 40, long perp leg gains.
        fake_cache = MagicMock()
        fake_cache.get_spot.return_value = 40.0
        fake_cache.get.return_value = None

        unrealized = tracker.unrealized_pnl(cache=fake_cache)
        # Long perp: (40-37)*150 = +450
        # Minus funding 5 = +445
        assert unrealized == pytest.approx(445.0, rel=1e-6)

    def test_no_perp_hedge_yields_zero_unrealized(self, tmp_path):
        tracker = PnLTracker(trades_file=str(tmp_path / "trades.json"))
        t = ArbTrade(
            id="t0",
            created_at=0,
            underlying="HYPE",
            option_type="P",
            strike=33.0,
            expiry_ts=0,
            qty=500.0,
            rysk_instrument="HYPE-33-P",
            rysk_price=0.93,
            rysk_fee=58.0,
            tier=4,
            hedge_status="unhedged",
            status="open",
        )
        tracker.trades[t.id] = t
        unrealized = tracker.unrealized_pnl(cache=MagicMock())
        assert unrealized == 0.0


class TestM4WeeklyLossBySettledAt:
    """M4: kill switch looks at losses when they hit the books, not when
    the bet was placed."""

    def test_old_trade_settled_this_week_counts(self, tmp_path):
        tracker = PnLTracker(trades_file=str(tmp_path / "trades.json"))
        # Trade created 2 weeks ago
        created = time.time() - 14 * 86400
        # Settled today
        settled = time.time() - 3600
        t = ArbTrade(
            id="old",
            created_at=created,
            underlying="HYPE",
            option_type="P",
            strike=33.0,
            expiry_ts=int(settled),
            qty=500.0,
            rysk_instrument="HYPE-33-P",
            rysk_price=0.93,
            rysk_fee=58.0,
            tier=4,
            hedge_status="perp_backstop",
            status="settled",
            settled_at=settled,
            realized_pnl=-500.0,
        )
        tracker.trades[t.id] = t

        weekly_loss = tracker.weekly_realized_loss()
        # Should include this trade because it settled this week
        assert weekly_loss == -500.0

    def test_recent_trade_settled_last_week_excluded(self, tmp_path):
        tracker = PnLTracker(trades_file=str(tmp_path / "trades.json"))
        # Created recently, but settled 10 days ago (clearly last week or earlier)
        t = ArbTrade(
            id="old",
            created_at=time.time() - 1000,
            underlying="HYPE",
            option_type="P",
            strike=33.0,
            expiry_ts=0,
            qty=500.0,
            rysk_instrument="HYPE-33-P",
            rysk_price=0.93,
            rysk_fee=58.0,
            tier=4,
            hedge_status="perp_backstop",
            status="settled",
            settled_at=time.time() - 10 * 86400,  # 10 days ago
            realized_pnl=-500.0,
        )
        tracker.trades[t.id] = t

        weekly_loss = tracker.weekly_realized_loss()
        assert weekly_loss == 0.0, (
            "Trade settled 10 days ago should NOT count in this week's loss"
        )

    def test_open_trade_excluded(self, tmp_path):
        tracker = PnLTracker(trades_file=str(tmp_path / "trades.json"))
        t = ArbTrade(
            id="open",
            created_at=time.time() - 1000,
            underlying="HYPE",
            option_type="P",
            strike=33.0,
            expiry_ts=0,
            qty=500.0,
            rysk_instrument="HYPE-33-P",
            rysk_price=0.93,
            rysk_fee=58.0,
            tier=4,
            hedge_status="perp_backstop",
            status="open",
            realized_pnl=0.0,
        )
        tracker.trades[t.id] = t
        assert tracker.weekly_realized_loss() == 0.0
