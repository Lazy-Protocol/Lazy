"""P&L tracking: trade book, metrics, console report.

Persists to data/arb-trades.json.
"""

import json
import os
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Optional

from scripts.arb.config import MAX_WEEKLY_LOSS, TRADES_FILE
from scripts.arb.pricing import MarkCache, rysk_fee, derive_taker_fee


@dataclass
class ArbTrade:
    id: str
    created_at: float                     # Unix timestamp
    underlying: str
    option_type: str                      # "P" or "C"
    strike: float
    expiry_ts: int                        # Unix timestamp

    qty: float

    # Rysk leg (buy side)
    rysk_instrument: str
    rysk_price: float                     # Per contract premium paid
    rysk_fee: float                       # Total fee

    # Derive leg (sell side)
    derive_instrument: str = ""
    derive_price: float = 0.0            # Per contract premium received
    derive_fee: float = 0.0
    derive_order_type: str = ""          # "rfq" or "limit"

    # Classification
    tier: int = 0
    hedge_status: str = "unhedged"       # hedged/partial/unhedged/perp_backstop

    # Hedge mode (for Tier 4 migration tracking)
    # Values: tier1/tier2/tier3 (normal hedged), tier4_pending_migration,
    #         tier4_migrating_rfq_sent, tier4_migrating_executing,
    #         tier4_migrating_perp_close, tier1_migrated, tier2_migrated,
    #         tier3_migrated, tier4_INCONSISTENT (double-hedged, manual),
    #         settled
    hedge_mode: str = ""

    # Expected outcomes at trade time (for performance feedback)
    expected_derive_price: float = 0.0   # What we priced the hedge at
    expected_gross: float = 0.0          # Expected (derive_expected - rysk_price) * qty
    expected_net: float = 0.0            # Expected gross - estimated fees
    tier_confidence: float = 0.0         # The TIER_WEIGHT applied at entry

    # Tier 4 / migration state
    #
    # perp_entry_delta is the IMMUTABLE baseline recorded at trade open
    # (spec Section 4.5). It must not be overwritten by rebalances; doing
    # so would lose the original hedge reference and cause future drift
    # calculations to compute drift from the last rebalance rather than
    # from entry. The live running delta goes in perp_current_delta.
    perp_entry_delta: float = 0.0        # Delta at time of perp open (IMMUTABLE)
    perp_current_delta: float = 0.0      # Most recent hedged delta after rebalances
    perp_funding_accrued: float = 0.0    # Running total of funding paid/received
    migration_attempts: int = 0          # Count of migration check cycles
    migration_history: list = field(default_factory=list)  # list of dict events

    # Lifecycle
    status: str = "open"                 # open/settled/closed_early
    settled_at: float = 0.0              # Unix ts when status moved away from open
                                         # (used by the kill switch to bucket by
                                         # realized-week, not created-week)

    # Settlement
    rysk_settlement: float = 0.0         # What Rysk paid us
    derive_settlement: float = 0.0       # What we paid Derive
    settlement_pnl: float = 0.0

    # P&L
    gross_spread: float = 0.0
    total_fees: float = 0.0
    realized_pnl: float = 0.0
    unrealized_pnl: float = 0.0

    # Perp hedge (Tier 4 / backstop)
    perp_instrument: str = ""
    perp_entry_price: float = 0.0
    perp_qty: float = 0.0
    perp_fee: float = 0.0
    perp_pnl: float = 0.0

    def compute_gross_spread(self):
        """Entry-time cash flow of the two legs.

        Tier 1-3 (Derive hedge present): derive_revenue − rysk_cost.
        Tier 4 (no Derive leg): −rysk_cost (pure outflow; negative number).

        Earlier drafts gated the whole formula on `derive_price > 0`, which
        silently left Tier 4 gross_spread at 0 and caused realized_pnl to
        omit the Rysk premium paid. Audit C5.
        """
        rysk_cost = self.rysk_price * self.qty
        derive_revenue = self.derive_price * self.qty  # 0 for Tier 4
        self.gross_spread = derive_revenue - rysk_cost

    def compute_fees(self):
        self.total_fees = self.rysk_fee + self.derive_fee + self.perp_fee

    def compute_realized_pnl(self):
        """Settled realized P&L across all tiers.

        Tier 1-3: gross_spread already nets Derive revenue − Rysk cost,
        and settlement_pnl nets the offsetting Rysk/Derive payoffs (≈0
        for a clean hedge).

        Tier 4: gross_spread is −(rysk_price*qty), a pure outflow.
        settlement_pnl = rysk_settlement (Derive leg is 0), which is the
        gross Rysk payoff at expiry. Net:
          −rysk_cost + rysk_payoff + perp_pnl − fees

        Callers of record_settlement must pass rysk_settlement / derive_settlement
        as GROSS per-leg payoffs (not net of premium). compute_realized_pnl
        subtracts the premium exactly once via gross_spread.
        """
        self.compute_gross_spread()
        self.compute_fees()
        if self.status == "settled":
            self.realized_pnl = self.gross_spread - self.total_fees + self.settlement_pnl + self.perp_pnl
        elif self.status == "closed_early":
            self.realized_pnl = self.gross_spread - self.total_fees + self.perp_pnl

    @property
    def premium_notional(self) -> float:
        return self.rysk_price * self.qty

    @property
    def capital_deployed(self) -> float:
        """Rysk premium + estimated Derive margin."""
        return self.premium_notional  # Margin tracked separately


class PnLTracker:
    """Trade book with JSON persistence and P&L metrics."""

    def __init__(self, trades_file: str = TRADES_FILE):
        self.trades_file = trades_file
        self.trades: dict[str, ArbTrade] = {}
        self._load()

    def _load(self):
        if os.path.exists(self.trades_file):
            with open(self.trades_file) as f:
                data = json.load(f)
            for d in data:
                trade = ArbTrade(**d)
                self.trades[trade.id] = trade

    def _save(self):
        os.makedirs(os.path.dirname(self.trades_file) or ".", exist_ok=True)
        with open(self.trades_file, "w") as f:
            json.dump([asdict(t) for t in self.trades.values()], f, indent=2)

    # --- Recording ---

    def record_rysk_buy(
        self,
        underlying: str,
        option_type: str,
        strike: float,
        expiry_ts: int,
        qty: float,
        rysk_instrument: str,
        rysk_price: float,
        spot: float,
        tier: int = 0,
        expected_derive_price: float = 0.0,
        tier_confidence: float = 0.0,
    ) -> ArbTrade:
        """Record a Rysk buy (first leg of the arb).

        expected_derive_price and tier_confidence are optional but critical
        for the performance feedback loop. Supply them so feedback.py can
        compute realization rate per tier.
        """
        # Expected P&L at entry, before any Derive fill
        expected_gross = (expected_derive_price - rysk_price) * qty if expected_derive_price > 0 else 0
        r_fee = rysk_fee(spot, rysk_price, qty)
        # Rough fee estimate for net expectation (derive fee computed at hedge time)
        expected_fees = r_fee + (derive_taker_fee(spot, qty, expected_derive_price)
                                 if expected_derive_price > 0 else 0)
        expected_net = expected_gross - expected_fees

        trade = ArbTrade(
            id=str(uuid.uuid4())[:8],
            created_at=time.time(),
            underlying=underlying,
            option_type=option_type,
            strike=strike,
            expiry_ts=expiry_ts,
            qty=qty,
            rysk_instrument=rysk_instrument,
            rysk_price=rysk_price,
            rysk_fee=r_fee,
            tier=tier,
            expected_derive_price=expected_derive_price,
            expected_gross=expected_gross,
            expected_net=expected_net,
            tier_confidence=tier_confidence,
        )
        self.trades[trade.id] = trade
        self._save()
        return trade

    def record_derive_hedge(
        self,
        trade_id: str,
        derive_instrument: str,
        derive_price: float,
        spot: float,
        order_type: str = "rfq",
    ):
        """Record the Derive sell hedge (second leg)."""
        trade = self.trades[trade_id]
        trade.derive_instrument = derive_instrument
        trade.derive_price = derive_price
        trade.derive_fee = derive_taker_fee(spot, trade.qty, derive_price)
        trade.derive_order_type = order_type
        trade.hedge_status = "hedged"
        trade.compute_gross_spread()
        trade.compute_fees()
        self._save()

    def record_perp_hedge(
        self,
        trade_id: str,
        perp_instrument: str,
        entry_price: float,
        qty: float,
        fee: float,
    ):
        """Record a perp hedge (Tier 4 or backstop)."""
        trade = self.trades[trade_id]
        trade.perp_instrument = perp_instrument
        trade.perp_entry_price = entry_price
        trade.perp_qty = qty
        trade.perp_fee = fee
        # Audit M2 fix: distinguish "Derive-hedged only" from "Derive-hedged
        # plus open perp backstop" so downstream queries can tell whether
        # extra exposure sits on Lighter.
        if trade.hedge_status == "unhedged":
            trade.hedge_status = "perp_backstop"
        elif trade.hedge_status == "hedged":
            trade.hedge_status = "hedged_with_backstop"
        self._save()

    def record_settlement(
        self,
        trade_id: str,
        rysk_settlement: float,
        derive_settlement: float,
    ):
        """Record settlement values after expiry."""
        trade = self.trades[trade_id]
        trade.rysk_settlement = rysk_settlement
        trade.derive_settlement = derive_settlement
        trade.settlement_pnl = rysk_settlement - derive_settlement
        trade.status = "settled"
        trade.settled_at = time.time()
        trade.compute_realized_pnl()
        self._save()

    def close_early(self, trade_id: str, close_price: float = 0.0, perp_pnl: float = 0.0):
        """Close a trade before settlement (kill switch, manual close)."""
        trade = self.trades[trade_id]
        trade.status = "closed_early"
        trade.settled_at = time.time()
        trade.perp_pnl = perp_pnl
        trade.compute_realized_pnl()
        self._save()

    # --- Queries ---

    def get_open_trades(self) -> list[ArbTrade]:
        return [t for t in self.trades.values() if t.status == "open"]

    def get_trade(self, trade_id: str) -> Optional[ArbTrade]:
        return self.trades.get(trade_id)

    def get_trades_by_underlying(self, underlying: str) -> list[ArbTrade]:
        return [t for t in self.trades.values() if t.underlying == underlying]

    def get_expiring_trades(self, hours: float = 24) -> list[ArbTrade]:
        cutoff = time.time() + hours * 3600
        return [
            t for t in self.trades.values()
            if t.status == "open" and t.expiry_ts <= cutoff
        ]

    # --- Metrics ---

    def realized_pnl(self) -> float:
        return sum(t.realized_pnl for t in self.trades.values() if t.status in ("settled", "closed_early"))

    def unrealized_pnl(self, cache: Optional[MarkCache] = None) -> float:
        """Unrealized P&L across open positions.

        Audit M3 fix: includes perp MTM for trades with an open perp leg.
        Earlier drafts only looked at the Derive leg, which zeroed out
        Tier 4 unrealized P&L entirely and underreported risk.
        """
        total = 0.0
        for t in self.get_open_trades():
            # Derive leg MTM
            if cache and t.derive_instrument:
                mark = cache.get(t.derive_instrument)
                if mark:
                    # Unrealized = (entry derive price - current mark) * qty
                    # Positive if mark dropped (we sold high, can buy back low)
                    total += (t.derive_price - mark.derive_mark) * t.qty

            # Perp leg MTM (Tier 4 pending migration, or backstop)
            if cache and t.perp_instrument and t.perp_qty > 0 and t.perp_entry_price > 0:
                perp_mark = cache.get_spot(t.underlying)
                if perp_mark and perp_mark > 0:
                    # perp_entry_delta > 0 means we opened SHORT perp (hedging long put)
                    if t.perp_entry_delta > 0:
                        perp_mtm = (t.perp_entry_price - perp_mark) * t.perp_qty
                    else:
                        perp_mtm = (perp_mark - t.perp_entry_price) * t.perp_qty
                    total += perp_mtm - t.perp_funding_accrued
        return total

    def win_rate(self) -> float:
        closed = [t for t in self.trades.values() if t.status in ("settled", "closed_early")]
        if not closed:
            return 0.0
        winners = sum(1 for t in closed if t.realized_pnl > 0)
        return winners / len(closed)

    def avg_spread_captured(self) -> float:
        closed = [t for t in self.trades.values() if t.status in ("settled", "closed_early")]
        if not closed:
            return 0.0
        total_spread = sum(t.gross_spread for t in closed)
        total_qty = sum(t.qty for t in closed)
        return total_spread / total_qty if total_qty > 0 else 0.0

    def tier_distribution(self) -> dict[int, int]:
        dist: dict[int, int] = {}
        for t in self.trades.values():
            dist[t.tier] = dist.get(t.tier, 0) + 1
        return dist

    def net_delta(self, cache: Optional[MarkCache] = None) -> dict[str, float]:
        """Approximate net delta per underlying for open positions."""
        deltas: dict[str, float] = {}
        for t in self.get_open_trades():
            # Rough: long puts have negative delta, short puts have positive delta on Derive
            # Net delta from paired trade is small for Tier 1, larger for Tier 2-4
            # This is a simplification. Proper delta needs BS delta calculation.
            delta = 0.0
            if t.hedge_status == "perp_backstop" and t.perp_qty != 0:
                delta = -t.perp_qty  # Perp short = negative delta
            elif t.hedge_status == "unhedged":
                # Long put = negative delta, approximate with 0.3 for OTM
                delta = -0.3 * t.qty
            # Hedged (Tier 1): delta is near zero
            deltas[t.underlying] = deltas.get(t.underlying, 0) + delta
        return deltas

    def max_drawdown(self) -> float:
        """Maximum peak-to-trough drawdown in realized P&L."""
        closed = sorted(
            [t for t in self.trades.values() if t.status in ("settled", "closed_early")],
            key=lambda t: t.created_at,
        )
        if not closed:
            return 0.0

        cumulative = 0.0
        peak = 0.0
        max_dd = 0.0
        for t in closed:
            cumulative += t.realized_pnl
            if cumulative > peak:
                peak = cumulative
            dd = peak - cumulative
            if dd > max_dd:
                max_dd = dd
        return max_dd

    def weekly_breakdown(self) -> list[dict]:
        """P&L grouped by week (Monday-Sunday)."""
        weeks: dict[str, dict] = {}
        for t in self.trades.values():
            if t.status not in ("settled", "closed_early"):
                continue
            dt = datetime.fromtimestamp(t.created_at, tz=timezone.utc)
            # ISO week
            week_key = dt.strftime("%Y-W%V")
            if week_key not in weeks:
                weeks[week_key] = {"week": week_key, "trades": 0, "pnl": 0.0, "volume": 0.0}
            weeks[week_key]["trades"] += 1
            weeks[week_key]["pnl"] += t.realized_pnl
            weeks[week_key]["volume"] += t.premium_notional
        return sorted(weeks.values(), key=lambda w: w["week"])

    def weekly_realized_loss(self) -> float:
        """Current week's cumulative realized losses (for kill switch).

        Audit M4 fix: buckets by settled_at, not created_at. A trade opened
        last Friday that settles this Monday is realized THIS week. The
        kill switch looks at losses as they hit the books.
        """
        from datetime import timedelta
        now = datetime.now(timezone.utc)
        days_since_monday = now.weekday()
        week_start = (now - timedelta(days=days_since_monday)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        week_start_ts = week_start.timestamp()

        def _bucket_ts(t):
            # Fall back to created_at for old trades written before we added
            # settled_at (migration grace period).
            return t.settled_at if t.settled_at else t.created_at

        return sum(
            t.realized_pnl
            for t in self.trades.values()
            if t.status in ("settled", "closed_early")
            and _bucket_ts(t) >= week_start_ts
            and t.realized_pnl < 0
        )

    # --- Console report ---

    def print_report(self, cache: Optional[MarkCache] = None):
        """Full P&L report matching existing console conventions."""
        open_trades = self.get_open_trades()
        closed = [t for t in self.trades.values() if t.status in ("settled", "closed_early")]

        print("=" * 60)
        print("  OPTIONS ARB P&L REPORT")
        print("=" * 60)

        # Summary
        print(f"\n  Total trades:      {len(self.trades)}")
        print(f"  Open:              {len(open_trades)}")
        print(f"  Closed:            {len(closed)}")
        print(f"  Win rate:          {self.win_rate():.0%}")
        print(f"  Realized P&L:      ${self.realized_pnl():>10,.2f}")
        print(f"  Unrealized P&L:    ${self.unrealized_pnl(cache):>10,.2f}")
        print(f"  Max drawdown:      ${self.max_drawdown():>10,.2f}")
        print(f"  Avg spread/unit:   ${self.avg_spread_captured():>10,.4f}")

        # Per-underlying breakdown
        underlyings = sorted(set(t.underlying for t in self.trades.values()))
        if underlyings:
            print(f"\n{'':2}{'Underlying':<12}{'Trades':>8}{'Realized':>12}{'Win%':>8}")
            print(f"{'':2}{'-'*40}")
            for u in underlyings:
                u_trades = self.get_trades_by_underlying(u)
                u_closed = [t for t in u_trades if t.status in ("settled", "closed_early")]
                u_pnl = sum(t.realized_pnl for t in u_closed)
                u_wins = sum(1 for t in u_closed if t.realized_pnl > 0)
                u_wr = u_wins / len(u_closed) if u_closed else 0
                print(f"{'':2}{u:<12}{len(u_trades):>8}{u_pnl:>12,.2f}{u_wr:>7.0%}")

        # Tier distribution
        dist = self.tier_distribution()
        if dist:
            print(f"\n{'':2}{'Tier':<8}{'Count':>8}{'%':>8}")
            print(f"{'':2}{'-'*24}")
            total = sum(dist.values())
            for tier in sorted(dist.keys()):
                pct = dist[tier] / total if total else 0
                print(f"{'':2}Tier {tier:<3}{dist[tier]:>8}{pct:>7.0%}")

        # Open positions
        if open_trades:
            print(f"\n{'':2}OPEN POSITIONS")
            print(f"{'':2}{'-'*56}")
            print(f"{'':2}{'ID':<10}{'Instrument':<24}{'Qty':>8}{'Tier':>6}{'Hedge':>12}")
            for t in open_trades:
                inst = t.rysk_instrument[:22]
                print(f"{'':2}{t.id:<10}{inst:<24}{t.qty:>8.0f}{t.tier:>6}{t.hedge_status:>12}")

        # Weekly P&L
        weeks = self.weekly_breakdown()
        if weeks:
            print(f"\n{'':2}WEEKLY P&L")
            print(f"{'':2}{'-'*40}")
            print(f"{'':2}{'Week':<12}{'Trades':>8}{'P&L':>12}{'Volume':>12}")
            for w in weeks[-8:]:  # Last 8 weeks
                print(f"{'':2}{w['week']:<12}{w['trades']:>8}{w['pnl']:>12,.2f}{w['volume']:>12,.0f}")

        # Risk metrics
        deltas = self.net_delta(cache)
        if deltas:
            print(f"\n{'':2}NET DELTA")
            print(f"{'':2}{'-'*24}")
            for u, d in sorted(deltas.items()):
                print(f"{'':2}{u:<12}{d:>+12.1f}")

        weekly_loss = self.weekly_realized_loss()
        if weekly_loss < 0:
            print(f"\n{'':2}Weekly realized loss: ${weekly_loss:,.2f} (kill switch at ${MAX_WEEKLY_LOSS:,.0f})")

        print(f"\n{'=' * 60}")
