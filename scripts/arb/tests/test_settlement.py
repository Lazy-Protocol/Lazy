"""Unit tests for settlement.py pure planner logic."""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import pytest

from scripts.arb.settlement import (
    BootstrapPlan,
    DeliveryRequirement,
    classify_trades_for_expiry,
    intrinsic_value,
    is_in_redemption_window,
    is_itm,
    minutes_until_trigger,
    next_settlement_time,
    plan_bootstrap,
)


# ---------------------------------------------------------------------------
# is_itm
# ---------------------------------------------------------------------------

class TestIsItm:
    @pytest.mark.parametrize(
        "opt,strike,spot,expected",
        [
            ("P", 33.0, 30.0, True),    # put ITM when spot < strike
            ("P", 33.0, 35.0, False),
            ("P", 33.0, 33.0, False),   # ATM is not strictly ITM
            ("C", 33.0, 35.0, True),    # call ITM when spot > strike
            ("C", 33.0, 30.0, False),
            ("C", 33.0, 33.0, False),
        ],
    )
    def test_classification(self, opt, strike, spot, expected):
        assert is_itm(opt, strike, spot) is expected

    def test_invalid_type_raises(self):
        with pytest.raises(ValueError):
            is_itm("X", 33, 30)


class TestIntrinsicValue:
    def test_put_itm_intrinsic(self):
        # $33 put, spot 30, qty 500 -> (33-30) * 500 = 1500
        assert intrinsic_value("P", 33, 30, 500) == 1500
    def test_put_otm_zero(self):
        assert intrinsic_value("P", 33, 35, 500) == 0
    def test_call_itm_intrinsic(self):
        assert intrinsic_value("C", 33, 40, 100) == 700
    def test_call_otm_zero(self):
        assert intrinsic_value("C", 33, 30, 100) == 0


# ---------------------------------------------------------------------------
# classify_trades_for_expiry
# ---------------------------------------------------------------------------

@dataclass
class FakeTrade:
    underlying: str
    option_type: str
    strike: float
    expiry_ts: int
    qty: float
    status: str = "open"
    id: str = "t"


class TestClassifyTrades:
    def test_put_itm_adds_to_delivery_requirement(self):
        expiry = 1775808000
        trades = [
            FakeTrade("WETH", "P", 2100.0, expiry, 5.0),  # ITM at spot 2000
            FakeTrade("WETH", "P", 1900.0, expiry, 3.0),  # OTM at spot 2000
        ]
        reqs = classify_trades_for_expiry(trades, expiry, {"WETH": 2000.0})
        assert "WETH" in reqs
        req = reqs["WETH"]
        assert req.underlying_to_deliver == pytest.approx(5.0)
        assert req.stablecoin_to_receive == pytest.approx(2100.0 * 5.0)
        assert len(req.itm_put_trades) == 1

    def test_call_itm_reverses_direction(self):
        expiry = 1775808000
        trades = [
            FakeTrade("WETH", "C", 1800.0, expiry, 2.0),  # ITM at spot 2000
        ]
        reqs = classify_trades_for_expiry(trades, expiry, {"WETH": 2000.0})
        req = reqs["WETH"]
        assert req.stablecoin_to_deliver == pytest.approx(1800.0 * 2.0)
        assert req.underlying_to_receive == pytest.approx(2.0)

    def test_otm_trades_produce_no_requirement(self):
        expiry = 1775808000
        trades = [FakeTrade("WETH", "P", 1900.0, expiry, 5.0)]  # OTM
        reqs = classify_trades_for_expiry(trades, expiry, {"WETH": 2000.0})
        # WETH entry exists (any trade at this expiry creates the group)
        # but requirements are zero
        assert reqs["WETH"].underlying_to_deliver == 0.0
        assert reqs["WETH"].stablecoin_to_receive == 0.0

    def test_closed_trades_are_skipped(self):
        expiry = 1775808000
        trades = [
            FakeTrade("WETH", "P", 2100.0, expiry, 5.0, status="settled"),
            FakeTrade("WETH", "P", 2100.0, expiry, 3.0, status="closed_early"),
        ]
        reqs = classify_trades_for_expiry(trades, expiry, {"WETH": 2000.0})
        # Neither should contribute
        assert "WETH" not in reqs or reqs["WETH"].underlying_to_deliver == 0

    def test_wrong_expiry_skipped(self):
        expiry = 1775808000
        other_expiry = 1776412800
        trades = [FakeTrade("WETH", "P", 2100.0, other_expiry, 5.0)]
        reqs = classify_trades_for_expiry(trades, expiry, {"WETH": 2000.0})
        assert "WETH" not in reqs

    def test_missing_spot_creates_entry_but_skips_classification(self):
        expiry = 1775808000
        trades = [FakeTrade("WETH", "P", 2100.0, expiry, 5.0)]
        reqs = classify_trades_for_expiry(trades, expiry, {})  # no WETH spot
        assert "WETH" in reqs
        assert reqs["WETH"].underlying_to_deliver == 0

    def test_multiple_underlyings(self):
        expiry = 1775808000
        trades = [
            FakeTrade("WETH", "P", 2100.0, expiry, 5.0),
            FakeTrade("WBTC", "P", 65000.0, expiry, 0.5),
        ]
        reqs = classify_trades_for_expiry(
            trades, expiry, {"WETH": 2000.0, "WBTC": 60000.0},
        )
        assert set(reqs.keys()) == {"WETH", "WBTC"}
        assert reqs["WETH"].underlying_to_deliver == 5.0
        assert reqs["WBTC"].underlying_to_deliver == 0.5


# ---------------------------------------------------------------------------
# plan_bootstrap
# ---------------------------------------------------------------------------

class TestPlanBootstrap:
    def test_sufficient_eoa_balance_no_cycles(self):
        plan = plan_bootstrap(
            required_underlying=5.0,
            eoa_underlying_balance=10.0,
            eoa_stablecoin_balance=0,
            dex_spot_price=2000,
        )
        assert plan.cycles == 0
        assert plan.feasible
        assert plan.expected_underlying_delivered == 5.0

    def test_single_swap_from_eoa_stablecoin(self):
        plan = plan_bootstrap(
            required_underlying=10.0,
            eoa_underlying_balance=3.0,
            eoa_stablecoin_balance=50_000.0,  # 50k USDC, plenty
            dex_spot_price=2000.0,             # WETH @ $2k
        )
        # Need 7 more WETH = 14000 USDC, we have 50k, one cycle
        assert plan.cycles == 1
        assert plan.feasible
        assert plan.expected_underlying_delivered == 10.0

    def test_insufficient_everything_not_feasible(self):
        plan = plan_bootstrap(
            required_underlying=1000.0,
            eoa_underlying_balance=1.0,
            eoa_stablecoin_balance=1000.0,
            dex_spot_price=2000.0,
            max_cycles=3,
        )
        assert plan.feasible is False
        assert "cycles" in plan.reason.lower()

    def test_zero_dex_price_not_feasible(self):
        plan = plan_bootstrap(
            required_underlying=10.0,
            eoa_underlying_balance=1.0,
            eoa_stablecoin_balance=50_000.0,
            dex_spot_price=0.0,
        )
        assert plan.feasible is False


# ---------------------------------------------------------------------------
# Time window helpers
# ---------------------------------------------------------------------------

class TestRedemptionWindow:
    def test_friday_8am_is_in_window(self):
        # 2026-04-10 is a Friday
        ts = datetime(2026, 4, 10, 8, 0, 0, tzinfo=timezone.utc)
        assert is_in_redemption_window(ts)

    def test_friday_8_30_in_window(self):
        ts = datetime(2026, 4, 10, 8, 30, 0, tzinfo=timezone.utc)
        assert is_in_redemption_window(ts)

    def test_friday_9am_not_in_window(self):
        """At 9:00 exactly the trigger fires; window is [8:00, 9:00)."""
        ts = datetime(2026, 4, 10, 9, 0, 0, tzinfo=timezone.utc)
        assert not is_in_redemption_window(ts)

    def test_thursday_not_in_window(self):
        ts = datetime(2026, 4, 9, 8, 30, 0, tzinfo=timezone.utc)
        assert not is_in_redemption_window(ts)

    def test_friday_7am_not_in_window(self):
        ts = datetime(2026, 4, 10, 7, 59, 59, tzinfo=timezone.utc)
        assert not is_in_redemption_window(ts)

    def test_naive_datetime_raises(self):
        with pytest.raises(ValueError):
            is_in_redemption_window(datetime(2026, 4, 10, 8, 0))


class TestMinutesUntilTrigger:
    def test_at_window_start_returns_60(self):
        ts = datetime(2026, 4, 10, 8, 0, 0, tzinfo=timezone.utc)
        assert minutes_until_trigger(ts) == pytest.approx(60.0)

    def test_at_8_30_returns_30(self):
        ts = datetime(2026, 4, 10, 8, 30, 0, tzinfo=timezone.utc)
        assert minutes_until_trigger(ts) == pytest.approx(30.0)

    def test_outside_window_returns_minus_1(self):
        ts = datetime(2026, 4, 10, 7, 30, 0, tzinfo=timezone.utc)
        assert minutes_until_trigger(ts) == -1


class TestNextSettlementTime:
    def test_monday_returns_this_friday(self):
        ts = datetime(2026, 4, 6, 12, 0, 0, tzinfo=timezone.utc)  # Monday
        nxt = next_settlement_time(ts)
        assert nxt.weekday() == 4  # Friday
        assert nxt.hour == 8
        assert nxt.day == 10  # Apr 10

    def test_friday_before_8am_returns_same_day(self):
        ts = datetime(2026, 4, 10, 7, 0, 0, tzinfo=timezone.utc)  # Fri 7am
        nxt = next_settlement_time(ts)
        assert nxt.day == 10
        assert nxt.hour == 8

    def test_friday_after_9am_returns_next_week(self):
        ts = datetime(2026, 4, 10, 9, 30, 0, tzinfo=timezone.utc)  # Fri 9:30am
        nxt = next_settlement_time(ts)
        assert nxt.day == 17  # next Friday
        assert nxt.hour == 8

    def test_saturday_returns_next_friday(self):
        ts = datetime(2026, 4, 11, 12, 0, 0, tzinfo=timezone.utc)  # Sat
        nxt = next_settlement_time(ts)
        assert nxt.day == 17  # next Friday
