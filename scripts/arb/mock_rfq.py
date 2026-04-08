"""Mock RFQ runner for end-to-end pipeline testing.

Simulates Rysk RFQs hitting our maker, runs them through pricer,
hedge orchestration, P&L tracking, and settlement. Uses real Derive
data for marks and fill ratios but never executes live trades.

Writes to data/mock-trades.json (separate from production ledger).
"""

import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from scripts.arb.config import (
    EXECUTION_RATIOS,
    MAX_OPTIONS_CAPITAL,
)
from scripts.arb.pricing import (
    MarkCache,
    RatioCache,
    black_scholes_call,
    black_scholes_put,
    calculate_bid,
    check_limits,
    derive_taker_fee,
    rysk_fee,
)
from scripts.arb.pnl import PnLTracker


MOCK_TRADES_FILE = "data/mock-trades.json"


@dataclass
class MockRFQ:
    """A simulated Rysk RFQ."""
    underlying: str
    option_type: str       # "P" or "C"
    strike: float
    expiry: str            # "YYYY-MM-DD"
    qty: float
    label: str = ""        # Human-readable label for reports

    @property
    def expiry_ts(self) -> int:
        dt = datetime.strptime(self.expiry, "%Y-%m-%d").replace(
            hour=8, tzinfo=timezone.utc
        )
        return int(dt.timestamp())


@dataclass
class MockRunResult:
    """Result of running a single RFQ through the pipeline."""
    rfq: MockRFQ
    bid: Optional[float] = None
    tier: Optional[int] = None
    reasoning: str = ""
    limits_ok: bool = False
    limits_reason: str = ""
    won_rfq: bool = False
    hedge_status: str = "not_attempted"
    hedge_instrument: str = ""
    hedge_fill_price: float = 0.0
    trade_id: str = ""
    net_est: float = 0.0
    decision: str = ""     # "bid", "pass", "blocked"


class MockPipeline:
    """End-to-end pipeline runner using real Derive data.

    Never executes live trades. Records mock trades to a separate ledger.
    """

    def __init__(
        self,
        client,
        account_equity: float = None,
        dry_run: bool = True,
        win_rate: float = 1.0,  # Assume we win every RFQ unless specified
        trades_file: str = MOCK_TRADES_FILE,
    ):
        self.client = client
        self.cache = MarkCache(client)
        self.ratio_cache = RatioCache(client)
        self.tracker = PnLTracker(trades_file=trades_file)
        self.dry_run = dry_run
        self.win_rate = win_rate
        self.account_equity = account_equity or float(MAX_OPTIONS_CAPITAL)
        self._cache_refreshed = False
        self._ratio_refreshed = False

    def refresh_data(self, underlyings=("HYPE",)):
        """Pull fresh Derive data before running RFQs.

        Order matters: ratio cache is slow (20s+) and takes stale data,
        so we refresh it FIRST using the last-known instrument list.
        Then refresh the mark cache immediately before iterating RFQs
        to maximize mark freshness during the batch run.
        """
        # First mark cache pass (to discover instruments for ratio lookup)
        if not self._cache_refreshed:
            print(f"[mock] Initial mark cache refresh for {underlyings}...")
            t0 = time.time()
            self.cache.refresh(underlyings=underlyings)
            print(f"[mock]   {self.cache.fresh_count} instruments in {time.time() - t0:.1f}s")

        # Ratio cache (slow, uses previously-cached instrument list)
        print(f"[mock] Fetching trade history for ratio calibration...")
        t0 = time.time()
        self.ratio_cache.refresh(self.cache.instruments)
        print(f"[mock]   {self.ratio_cache.instrument_count} instrument ratios, "
              f"{len(self.ratio_cache._dte_ratios)} dte buckets in {time.time() - t0:.1f}s")
        self._ratio_refreshed = True

        # Final mark cache refresh right before iterating (maximize freshness)
        print(f"[mock] Final mark cache refresh...")
        t0 = time.time()
        self.cache.refresh(underlyings=underlyings)
        print(f"[mock]   {self.cache.fresh_count} instruments in {time.time() - t0:.1f}s")
        self._cache_refreshed = True

    def _current_positions(self) -> list[dict]:
        """Positions in the format check_limits() expects."""
        return [
            {
                "underlying": t.underlying,
                "premium_notional": t.premium_notional,
                "capital_deployed": t.capital_deployed,
                "hedge_status": t.hedge_status,
            }
            for t in self.tracker.get_open_trades()
        ]

    def _current_im(self) -> float:
        """Approximate current Derive IM from open mock positions."""
        total = 0.0
        for t in self.tracker.get_open_trades():
            if t.derive_instrument:
                mark = self.cache.get(t.derive_instrument)
                if mark:
                    # Rough IM estimate: live factor ~0.25 * spot + mark, per contract
                    im_pc = 0.25 * mark.spot + mark.derive_mark
                    total += im_pc * t.qty
        return total

    def run_rfq(self, rfq: MockRFQ) -> MockRunResult:
        """Run a single RFQ through the full pipeline."""
        if not self._cache_refreshed:
            self.refresh_data(underlyings=(rfq.underlying,))

        result = MockRunResult(rfq=rfq)
        spot = self.cache.get_spot(rfq.underlying)

        # Step 1: Calculate bid
        bid = calculate_bid(
            cache=self.cache,
            underlying=rfq.underlying,
            strike=rfq.strike,
            expiry_ts=rfq.expiry_ts,
            option_type=rfq.option_type,
            qty=rfq.qty,
            ratio_cache=self.ratio_cache,
        )

        if bid is None:
            result.decision = "pass"
            result.reasoning = "no profitable tier"
            return result

        result.bid = bid.max_bid
        result.tier = bid.tier
        result.reasoning = bid.reasoning

        # Step 2: Check limits
        positions = self._current_positions()
        current_im = self._current_im()
        allowed, reason = check_limits(
            bid=bid,
            qty=rfq.qty,
            spot=spot,
            cache=self.cache,
            current_positions=positions,
            underlying=rfq.underlying,
            account_equity=self.account_equity,
            account_current_im=current_im,
        )
        result.limits_ok = allowed
        result.limits_reason = reason
        if not allowed:
            result.decision = "blocked"
            return result

        # Step 3: Simulate winning the RFQ
        # For now, deterministic: win_rate = 1.0 means always win, 0.5 means 50/50
        import random
        result.won_rfq = random.random() < self.win_rate
        if not result.won_rfq:
            result.decision = "bid_lost"
            return result

        # Step 4: Record the Rysk buy leg, including expected derive price
        # and tier confidence so the feedback loop has data to learn from.
        hedge_mark_preview = self.cache.get(bid.hedge_instrument)
        if hedge_mark_preview is not None:
            ratio, _ = self.ratio_cache.get_ratio(
                bid.hedge_instrument, hedge_mark_preview.expiry_ts, rfq.underlying,
            )
            expected_derive_price = hedge_mark_preview.derive_mark * ratio
        else:
            expected_derive_price = 0.0

        trade = self.tracker.record_rysk_buy(
            underlying=rfq.underlying,
            option_type=rfq.option_type,
            strike=rfq.strike,
            expiry_ts=rfq.expiry_ts,
            qty=rfq.qty,
            rysk_instrument=f"{rfq.underlying}-{rfq.expiry.replace('-','')}-{int(rfq.strike)}-{rfq.option_type}",
            rysk_price=bid.max_bid,
            spot=spot,
            tier=bid.tier,
            expected_derive_price=expected_derive_price,
            tier_confidence=bid.confidence,
        )
        result.trade_id = trade.id

        # Step 5: Hedge. Tier 4 takes a different path (pending migration).
        if bid.tier == 4:
            # Tier 4: Open perp hedge, mark as pending migration, no Derive fill yet
            trade.hedge_mode = "tier4_pending_migration"
            trade.hedge_status = "perp_backstop"
            # Estimate option delta at entry (rough BS-based)
            # Real production will fetch from Derive ticker
            trade.perp_entry_delta = -0.3 * rfq.qty if rfq.option_type == "P" else 0.3 * rfq.qty
            trade.perp_current_delta = trade.perp_entry_delta  # Initialize live delta baseline
            trade.perp_qty = abs(trade.perp_entry_delta)
            trade.perp_entry_price = spot
            trade.perp_instrument = f"{rfq.underlying}-PERP"
            self.tracker._save()
            result.hedge_status = "tier4_pending_migration"
            result.hedge_instrument = f"{rfq.underlying}-PERP"
            result.hedge_fill_price = spot
            result.net_est = 0  # Tier 4 net P&L is TBD until migration or settlement
            result.decision = "bid_won"
            return result

        # Tiers 1-3: simulate the Derive hedge using cache + ratio
        hedge_mark = self.cache.get(bid.hedge_instrument)
        if hedge_mark is None:
            result.hedge_status = "no_mark"
            result.decision = "bid_won_no_hedge"
            return result

        ratio, _ = self.ratio_cache.get_ratio(
            bid.hedge_instrument, hedge_mark.expiry_ts, rfq.underlying,
        )
        expected_fill = hedge_mark.derive_mark * ratio

        self.tracker.record_derive_hedge(
            trade_id=trade.id,
            derive_instrument=bid.hedge_instrument,
            derive_price=expected_fill,
            spot=spot,
            order_type="rfq",
        )
        # Set hedge_mode to match the tier (normal path)
        trade.hedge_mode = f"tier{bid.tier}"
        self.tracker._save()

        result.hedge_status = "hedged"
        result.hedge_instrument = bid.hedge_instrument
        result.hedge_fill_price = expected_fill

        t = self.tracker.get_trade(trade.id)
        result.net_est = t.gross_spread - t.total_fees
        result.decision = "bid_won"
        return result

    def run_batch(self, rfqs: list[MockRFQ]) -> list[MockRunResult]:
        """Run a list of RFQs in order."""
        if not self._cache_refreshed:
            underlyings = tuple(set(r.underlying for r in rfqs))
            self.refresh_data(underlyings=underlyings)

        return [self.run_rfq(rfq) for rfq in rfqs]

    def simulate_settlement(self, spot_by_underlying: dict[str, float]):
        """Mark all expired positions as settled at the given spots."""
        now = time.time()
        expired = [t for t in self.tracker.get_open_trades() if t.expiry_ts <= now]

        settled = []
        for t in expired:
            spot = spot_by_underlying.get(t.underlying)
            if spot is None:
                continue

            # Compute per-contract payout on each leg
            if t.option_type == "P":
                rysk_per_ct = max(0, t.strike - spot)
                derive_per_ct = max(0, t.strike - spot)
            else:
                rysk_per_ct = max(0, spot - t.strike)
                derive_per_ct = max(0, spot - t.strike)

            # For exact-strike matches (Tier 1) the two payouts cancel.
            # For Tier 2 (adjacent strike), they differ by the strike gap.
            # record_settlement takes totals.
            self.tracker.record_settlement(
                trade_id=t.id,
                rysk_settlement=rysk_per_ct * t.qty,
                derive_settlement=derive_per_ct * t.qty,
            )
            settled.append(t.id)

        return settled


def print_batch_report(results: list[MockRunResult], account_equity: float):
    """Pretty-print the results of a batch run."""
    print()
    print("=" * 110)
    print("  MOCK RFQ BATCH RESULTS")
    print("=" * 110)
    print()
    print(f"  Account equity: ${account_equity:,.0f}")
    print(f"  RFQs processed: {len(results)}")

    by_decision = {}
    for r in results:
        by_decision.setdefault(r.decision, []).append(r)

    print()
    print(f"  OUTCOMES")
    print(f"  {'-' * 50}")
    for decision, group in sorted(by_decision.items()):
        print(f"  {decision:<20} {len(group):>4}")

    # Table of all RFQs
    print()
    print(f"  {'RFQ':<28} {'T':>2} {'Bid':>8} {'Net Est':>10} {'Decision':<15} {'Hedge':>20}")
    print(f"  {'-' * 95}")
    for r in results:
        label = r.rfq.label or f"{r.rfq.underlying} {r.rfq.option_type} ${r.rfq.strike} {r.rfq.expiry}"
        label = label[:28]
        tier = str(r.tier) if r.tier is not None else "-"
        bid = f"${r.bid:.4f}" if r.bid is not None else "-"
        net = f"${r.net_est:,.2f}" if r.net_est else "-"
        hedge = r.hedge_instrument[:20] if r.hedge_instrument else "-"
        print(f"  {label:<28} {tier:>2} {bid:>8} {net:>10} {r.decision:<15} {hedge:>20}")

    # Aggregate P&L
    won = [r for r in results if r.decision == "bid_won"]
    if won:
        total_net = sum(r.net_est for r in won)
        print()
        print(f"  WON RFQs: {len(won)}")
        print(f"  Total estimated net: ${total_net:,.2f}")

    # Blocked reasons
    blocked = [r for r in results if r.decision == "blocked"]
    if blocked:
        print()
        print(f"  BLOCKED RFQs:")
        for r in blocked:
            label = r.rfq.label or f"${r.rfq.strike}{r.rfq.option_type} {r.rfq.expiry}"
            print(f"    {label}: {r.limits_reason}")

    print()
    print("=" * 110)


# ---------------------------------------------------------------------------
# Predefined scenarios
# ---------------------------------------------------------------------------

def rysk_screenshots_scenario() -> list[MockRFQ]:
    """The 20 RFQs from the Rysk UI screenshots (covered calls + cash-secured puts).

    This is the test battery we used for earlier analysis.
    """
    return [
        # Covered calls (taker sells call = we buy)
        MockRFQ("HYPE", "C", 37,   "2026-04-10", 500, "CC Apr10 $37 (APR 214%)"),
        MockRFQ("HYPE", "C", 38,   "2026-04-10", 500, "CC Apr10 $38 (APR 116%)"),
        MockRFQ("HYPE", "C", 40,   "2026-04-10", 500, "CC Apr10 $40 (APR 41%)"),
        MockRFQ("HYPE", "C", 41.5, "2026-04-10", 500, "CC Apr10 $41.5 (APR 8%)"),
        MockRFQ("HYPE", "C", 38,   "2026-04-17", 500, "CC Apr17 $38 (APR 99%)"),
        MockRFQ("HYPE", "C", 39,   "2026-04-17", 500, "CC Apr17 $39 (APR 68%)"),
        MockRFQ("HYPE", "C", 41.5, "2026-04-17", 500, "CC Apr17 $41.5 (APR 28%)"),
        MockRFQ("HYPE", "C", 45,   "2026-04-17", 500, "CC Apr17 $45 (APR 5%)"),
        MockRFQ("HYPE", "C", 39,   "2026-04-24", 500, "CC Apr24 $39 (APR 65%)"),
        MockRFQ("HYPE", "C", 40,   "2026-04-24", 500, "CC Apr24 $40 (APR 49%)"),
        MockRFQ("HYPE", "C", 43.5, "2026-04-24", 500, "CC Apr24 $43.5 (APR 19%)"),
        MockRFQ("HYPE", "C", 47,   "2026-04-24", 500, "CC Apr24 $47 (APR 4%)"),
        # Cash-secured puts (taker sells put = we buy)
        MockRFQ("HYPE", "P", 33,   "2026-04-10", 500, "CSP Apr10 $33 (APR 16%)"),
        MockRFQ("HYPE", "P", 33.5, "2026-04-10", 500, "CSP Apr10 $33.5 (APR 20%)"),
        MockRFQ("HYPE", "P", 35.5, "2026-04-10", 500, "CSP Apr10 $35.5 (APR 91%)"),
        MockRFQ("HYPE", "P", 36.5, "2026-04-10", 500, "CSP Apr10 $36.5 (APR 158%)"),
        MockRFQ("HYPE", "P", 29.5, "2026-04-17", 500, "CSP Apr17 $29.5 (APR 6%)"),
        MockRFQ("HYPE", "P", 33,   "2026-04-17", 500, "CSP Apr17 $33 (APR 28%)"),
        MockRFQ("HYPE", "P", 34.5, "2026-04-17", 500, "CSP Apr17 $34.5 (APR 58%)"),
        MockRFQ("HYPE", "P", 36.5, "2026-04-17", 500, "CSP Apr17 $36.5 (APR 112%)"),
    ]
