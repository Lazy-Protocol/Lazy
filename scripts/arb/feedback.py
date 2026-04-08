"""Performance feedback module.

Reads settled trades from PnLTracker and computes:
- Per-tier win rate, spread capture, realization rate
- Hedge fill success rate (% trades that successfully got a Derive fill)
- Tier weight recommendations based on actual vs expected P&L
- Win rate drift alerts (healthy range 20-60% per spec Section 5.7)

This closes the feedback loop: settled trade outcomes inform future bid
confidence via learned tier weights. Tier weights ship as static defaults
in config.TIER_WEIGHTS but can be overridden at runtime by feedback-derived
values stored in data/tier-weights.json.

Reading: `PerformanceAnalyzer(tracker).compute_all()`
Writing: no automatic mutation - operator must apply recommendations
         via `cli performance --apply` (safety rail)
"""

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from scripts.arb.config import (
    MIN_WIN_RATE,
    MAX_WIN_RATE,
    TIER_WEIGHT_LEARNING_RATE,
    TIER_WEIGHT_MIN_TRADES,
    TIER_WEIGHTS,
)
from scripts.arb.pnl import ArbTrade, PnLTracker


LEARNED_WEIGHTS_FILE = "data/tier-weights.json"


@dataclass
class TierStats:
    tier: int
    total_trades: int = 0
    winning_trades: int = 0
    losing_trades: int = 0
    total_expected_net: float = 0.0
    total_actual_net: float = 0.0
    total_expected_gross: float = 0.0
    total_actual_gross: float = 0.0
    hedge_fills: int = 0
    hedge_failures: int = 0

    @property
    def win_rate(self) -> float:
        if self.total_trades == 0:
            return 0.0
        return self.winning_trades / self.total_trades

    @property
    def realization_rate(self) -> float:
        """Actual net / expected net. 1.0 = matched expectations."""
        if self.total_expected_net == 0:
            return 0.0
        return self.total_actual_net / self.total_expected_net

    @property
    def spread_capture_rate(self) -> float:
        """Actual gross / expected gross. Measures fill quality."""
        if self.total_expected_gross == 0:
            return 0.0
        return self.total_actual_gross / self.total_expected_gross

    @property
    def hedge_fill_rate(self) -> float:
        """% of trades that successfully got a Derive hedge."""
        total = self.hedge_fills + self.hedge_failures
        if total == 0:
            return 0.0
        return self.hedge_fills / total

    @property
    def avg_expected_net(self) -> float:
        if self.total_trades == 0:
            return 0.0
        return self.total_expected_net / self.total_trades

    @property
    def avg_actual_net(self) -> float:
        if self.total_trades == 0:
            return 0.0
        return self.total_actual_net / self.total_trades


@dataclass
class WeightRecommendation:
    tier: int
    current_weight: float
    observed_realization: float
    recommended_weight: float
    sample_size: int
    status: str  # "OK", "NOT_ENOUGH_DATA", "RECOMMEND_UPDATE"
    reason: str


class PerformanceAnalyzer:
    """Reads settled trades from PnLTracker and computes feedback metrics."""

    def __init__(self, tracker: PnLTracker):
        self.tracker = tracker

    def compute_tier_stats(self) -> dict[int, TierStats]:
        """Aggregate stats per tier from all closed trades."""
        stats: dict[int, TierStats] = {}

        for t in self.tracker.trades.values():
            if t.status not in ("settled", "closed_early"):
                continue

            tier = t.tier
            if tier not in stats:
                stats[tier] = TierStats(tier=tier)

            s = stats[tier]
            s.total_trades += 1

            if t.realized_pnl > 0:
                s.winning_trades += 1
            elif t.realized_pnl < 0:
                s.losing_trades += 1

            s.total_actual_net += t.realized_pnl
            s.total_actual_gross += t.gross_spread

            # Only count expected if stored (older trades won't have it)
            if t.expected_net != 0 or t.expected_gross != 0:
                s.total_expected_net += t.expected_net
                s.total_expected_gross += t.expected_gross

            # Hedge fill success
            if t.derive_price > 0 and t.hedge_status in ("hedged", "partial"):
                s.hedge_fills += 1
            else:
                s.hedge_failures += 1

        return stats

    def overall_win_rate(self) -> float:
        closed = [t for t in self.tracker.trades.values()
                  if t.status in ("settled", "closed_early")]
        if not closed:
            return 0.0
        wins = sum(1 for t in closed if t.realized_pnl > 0)
        return wins / len(closed)

    def recommend_tier_weights(self) -> list[WeightRecommendation]:
        """Suggest new tier weights based on observed realization rates.

        If a tier's realized P&L consistently runs at X% of expected, the
        tier weight should adjust toward current_weight * X%.

        Uses EWMA-style damping via TIER_WEIGHT_LEARNING_RATE so weights
        don't swing wildly on small samples.

        Emits NOT_ENOUGH_DATA below TIER_WEIGHT_MIN_TRADES.
        """
        stats = self.compute_tier_stats()
        recommendations = []

        for tier, current_weight in TIER_WEIGHTS.items():
            s = stats.get(tier)
            if s is None or s.total_trades == 0:
                recommendations.append(WeightRecommendation(
                    tier=tier,
                    current_weight=current_weight,
                    observed_realization=0,
                    recommended_weight=current_weight,
                    sample_size=0,
                    status="NOT_ENOUGH_DATA",
                    reason=f"No closed trades for tier {tier}",
                ))
                continue

            if s.total_trades < TIER_WEIGHT_MIN_TRADES:
                recommendations.append(WeightRecommendation(
                    tier=tier,
                    current_weight=current_weight,
                    observed_realization=s.realization_rate,
                    recommended_weight=current_weight,
                    sample_size=s.total_trades,
                    status="NOT_ENOUGH_DATA",
                    reason=f"{s.total_trades} trades (need >= {TIER_WEIGHT_MIN_TRADES})",
                ))
                continue

            # Apply EWMA adjustment
            realization = s.realization_rate
            target = current_weight * realization
            new_weight = (
                current_weight * (1 - TIER_WEIGHT_LEARNING_RATE)
                + target * TIER_WEIGHT_LEARNING_RATE
            )

            # Clamp to sensible range
            new_weight = max(0.3, min(1.0, new_weight))

            drift = abs(new_weight - current_weight)
            if drift < 0.02:
                status = "OK"
                reason = f"Drift {drift:.3f} within threshold"
            else:
                status = "RECOMMEND_UPDATE"
                reason = f"Realization {realization:.2f}, drift {drift:.3f}"

            recommendations.append(WeightRecommendation(
                tier=tier,
                current_weight=current_weight,
                observed_realization=realization,
                recommended_weight=new_weight,
                sample_size=s.total_trades,
                status=status,
                reason=reason,
            ))

        return recommendations

    def win_rate_health(self) -> dict:
        """Check whether overall win rate is in the healthy 20-60% range."""
        wr = self.overall_win_rate()
        closed_count = sum(
            1 for t in self.tracker.trades.values()
            if t.status in ("settled", "closed_early")
        )

        if closed_count < TIER_WEIGHT_MIN_TRADES:
            return {
                "status": "NOT_ENOUGH_DATA",
                "win_rate": wr,
                "n": closed_count,
                "message": f"Only {closed_count} closed trades (need >= {TIER_WEIGHT_MIN_TRADES})",
            }

        if wr < MIN_WIN_RATE:
            return {
                "status": "UNDERBIDDING",
                "win_rate": wr,
                "n": closed_count,
                "message": f"Win rate {wr:.0%} below {MIN_WIN_RATE:.0%} - "
                          f"bids too tight, widen spreads or increase ratios",
            }

        if wr > MAX_WIN_RATE:
            return {
                "status": "OVERBIDDING",
                "win_rate": wr,
                "n": closed_count,
                "message": f"Win rate {wr:.0%} above {MAX_WIN_RATE:.0%} - "
                          f"bids too loose, tighten spreads or decrease ratios",
            }

        return {
            "status": "HEALTHY",
            "win_rate": wr,
            "n": closed_count,
            "message": f"Win rate {wr:.0%} within healthy range",
        }

    def compute_all(self) -> dict:
        """One-shot report of all feedback metrics."""
        return {
            "tier_stats": self.compute_tier_stats(),
            "tier_weight_recommendations": self.recommend_tier_weights(),
            "win_rate_health": self.win_rate_health(),
            "overall_win_rate": self.overall_win_rate(),
            "total_closed": sum(
                1 for t in self.tracker.trades.values()
                if t.status in ("settled", "closed_early")
            ),
            "total_open": len(self.tracker.get_open_trades()),
        }

    def print_report(self):
        """Console report of performance feedback."""
        result = self.compute_all()

        print("=" * 70)
        print("  PERFORMANCE FEEDBACK REPORT")
        print("=" * 70)
        print()
        print(f"  Closed trades: {result['total_closed']}")
        print(f"  Open trades:   {result['total_open']}")
        print(f"  Overall win rate: {result['overall_win_rate']:.0%}")
        print()

        # Win rate health
        wrh = result["win_rate_health"]
        print(f"  WIN RATE HEALTH")
        print(f"  {'-' * 50}")
        print(f"  Status:  {wrh['status']}")
        print(f"  Message: {wrh['message']}")
        print()

        # Per-tier stats
        stats = result["tier_stats"]
        if stats:
            print(f"  PER-TIER PERFORMANCE")
            print(f"  {'-' * 75}")
            print(f"  {'Tier':<6}{'N':>5}{'Wins':>6}{'WinRate':>9}"
                  f"{'Realization':>13}{'SpreadCap':>12}{'HedgeFill':>12}")
            for tier in sorted(stats.keys()):
                s = stats[tier]
                print(
                    f"  Tier {tier:<3}{s.total_trades:>5}{s.winning_trades:>6}"
                    f"{s.win_rate:>8.0%} {s.realization_rate:>12.2f} "
                    f"{s.spread_capture_rate:>11.2f} {s.hedge_fill_rate:>11.0%}"
                )
        else:
            print("  (No closed trades yet. Nothing to analyze.)")
        print()

        # Tier weight recommendations
        recs = result["tier_weight_recommendations"]
        if recs:
            print(f"  TIER WEIGHT RECOMMENDATIONS")
            print(f"  {'-' * 75}")
            print(f"  {'Tier':<6}{'Current':>9}{'Observed':>11}{'Recommended':>14}"
                  f"{'N':>5}  Status")
            for r in recs:
                obs = f"{r.observed_realization:.2f}" if r.sample_size else "-"
                print(
                    f"  Tier {r.tier:<3}{r.current_weight:>9.2f}{obs:>11}"
                    f"{r.recommended_weight:>14.2f}{r.sample_size:>5}  {r.status}"
                )

        print()
        print("=" * 70)


# Module-level cache to avoid disk I/O on every calculate_bid() call.
# Rysk has a 2-second aggregation window, and calculate_bid reads the tier
# weight for tiers 1-4 on every RFQ. File I/O in that hot path is needless
# latency. We invalidate by (mtime, path) so that `cli performance --apply`
# writing new weights shows up within one cycle without a process restart.
_LEARNED_WEIGHTS_CACHE: dict[str, tuple[float, dict[int, float]]] = {}


def load_learned_weights(path: str = LEARNED_WEIGHTS_FILE) -> dict[int, float]:
    """Load persistent learned tier weights if they exist.

    Falls back to static TIER_WEIGHTS from config if file missing.

    Audit M1 fix: results are cached by file mtime so the common hot
    path (every tier lookup in calculate_bid) does not touch disk.
    """
    try:
        mtime = os.path.getmtime(path)
    except FileNotFoundError:
        return dict(TIER_WEIGHTS)
    except OSError:
        return dict(TIER_WEIGHTS)

    cached = _LEARNED_WEIGHTS_CACHE.get(path)
    if cached and cached[0] == mtime:
        return cached[1]

    try:
        with open(path) as f:
            data = json.load(f)
        weights = {int(k): float(v) for k, v in data.items()}
    except Exception:
        weights = dict(TIER_WEIGHTS)

    _LEARNED_WEIGHTS_CACHE[path] = (mtime, weights)
    return weights


def save_learned_weights(weights: dict[int, float], path: str = LEARNED_WEIGHTS_FILE):
    """Write learned tier weights to disk. Called by `cli performance --apply`."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump({str(k): v for k, v in weights.items()}, f, indent=2)
    # Invalidate the in-process cache so the next load_learned_weights call
    # picks up the fresh values.
    _LEARNED_WEIGHTS_CACHE.pop(path, None)


def get_tier_weight(tier: int) -> float:
    """Get effective tier weight: learned if available, else static default.

    This is the function calculate_bid() should call instead of
    reading TIER_WEIGHTS directly. Thin wrapper around the mtime-cached
    load_learned_weights; safe to call on every RFQ.
    """
    weights = load_learned_weights()
    return weights.get(tier, TIER_WEIGHTS.get(tier, 0.5))
