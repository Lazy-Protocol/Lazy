"""Tier 4 migration monitor and state machine.

Scans open trades in `hedge_mode = tier4_pending_migration` state, checks
for Derive hedge upgrade opportunities, and executes atomic migrations
with rollback on failure.

See docs/OPTIONS_ARB_STRATEGY.md Section 4.5 for the full state machine
and invariants. Key rules:

1. Never open a naked window: Derive must fill BEFORE perp closes.
2. tier4_INCONSISTENT is terminal. Do NOT retry. Alert.
3. Every state transition written to migration_history synchronously.
4. Margin pre-flight before sending Derive RFQ.
5. Don't migrate for gains below MIGRATION_MIN_BENEFIT.
6. Don't migrate during unstable markets (wide spreads).

Usage:
    monitor = MigrationMonitor(tracker, derive_client, cache,
                                ratio_cache, perp_client)
    results = monitor.run_cycle()
    for r in results:
        print(r.summary())
"""

import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from scripts.arb.config import (
    MIGRATION_DELTA_DRIFT_THRESHOLD,
    MIGRATION_MAX_SPREAD_MULTIPLIER,
    MIGRATION_MAX_SPREAD_PCT,
    MIGRATION_MIN_BENEFIT,
    MIGRATION_RFQ_TIMEOUT_SECONDS,
    TIER4_DECISIONS_LOG,
)


# ---------------------------------------------------------------------------
# Decision and result types
# ---------------------------------------------------------------------------

@dataclass
class MigrationDecision:
    """Read-only outcome of the check phase."""
    should_migrate: bool
    target_tier: int = 0
    target_instrument: str = ""
    target_derive_price: float = 0.0
    current_value: float = 0.0
    migrated_value: float = 0.0
    migration_benefit: float = 0.0
    reason: str = ""


@dataclass
class MigrationResult:
    """Outcome of a single migration attempt."""
    trade_id: str
    started_at: float
    final_state: str
    target_tier: int = 0
    derive_fill_price: float = 0.0
    perp_close_price: float = 0.0
    benefit_realized: float = 0.0
    error: str = ""
    steps: list[dict] = field(default_factory=list)

    def summary(self) -> str:
        if self.final_state.endswith("_migrated"):
            return (f"{self.trade_id}: SUCCESS -> Tier {self.target_tier}, "
                    f"benefit ${self.benefit_realized:.2f}")
        elif self.final_state == "tier4_INCONSISTENT":
            return f"{self.trade_id}: INCONSISTENT (DOUBLE-HEDGED, MANUAL FIX REQUIRED)"
        else:
            return f"{self.trade_id}: {self.final_state} ({self.error or 'no migration'})"


@dataclass
class RebalanceResult:
    trade_id: str
    old_delta: float
    new_delta: float
    drift_pct: float
    rebalanced: bool
    adjustment_size: float = 0.0
    error: str = ""


# ---------------------------------------------------------------------------
# Decision log (for calibration)
# ---------------------------------------------------------------------------

def log_tier4_decision(event_type: str, payload: dict, log_file: str = TIER4_DECISIONS_LOG):
    """Append a decision event to the Tier 4 decision log (JSONL).

    event_type values: "check", "migration_attempt", "rebalance", "settlement"
    payload: dict with all relevant context
    """
    os.makedirs(os.path.dirname(log_file) or ".", exist_ok=True)
    entry = {
        "timestamp": time.time(),
        "event_type": event_type,
        **payload,
    }
    with open(log_file, "a") as f:
        f.write(json.dumps(entry) + "\n")


# ---------------------------------------------------------------------------
# Migration monitor
# ---------------------------------------------------------------------------

class MigrationMonitor:
    """Scans Tier 4 positions and executes migrations when viable.

    Composed from the arb's core components: tracker (read/write trades),
    derive_client (RFQ execution), cache (mark lookups), ratio_cache
    (fill ratio estimates), perp_client (hedge management).
    """

    def __init__(
        self,
        tracker,
        derive_client,
        cache,
        ratio_cache,
        perp_client,
        dry_run: bool = False,
    ):
        self.tracker = tracker
        self.derive_client = derive_client
        self.cache = cache
        self.ratio_cache = ratio_cache
        self.perp_client = perp_client
        self.dry_run = dry_run

    # --- Public API ---

    def run_cycle(self) -> dict:
        """One full sweep over Tier 4 positions.

        Returns a dict summarizing the cycle:
            {
                "tier4_trades": N,
                "migrations": list[MigrationResult],
                "rebalances": list[RebalanceResult],
                "errors": list[str],
            }
        """
        tier4_trades = self._get_tier4_trades()
        migrations = []
        rebalances = []
        errors = []

        for trade in tier4_trades:
            trade.migration_attempts += 1

            # Step 1: Delta rebalance check (independent of migration)
            try:
                rebalance = self.rebalance_delta(trade)
                if rebalance.rebalanced:
                    rebalances.append(rebalance)
            except Exception as e:
                errors.append(f"rebalance_delta failed for {trade.id}: {e}")

            # Step 2: Migration check
            try:
                decision = self.check_trade(trade)
                log_tier4_decision("check", {
                    "trade_id": trade.id,
                    "should_migrate": decision.should_migrate,
                    "target_tier": decision.target_tier,
                    "migration_benefit": decision.migration_benefit,
                    "reason": decision.reason,
                })

                if decision.should_migrate:
                    result = self.execute_migration(trade, decision)
                    migrations.append(result)
                    log_tier4_decision("migration_attempt", {
                        "trade_id": trade.id,
                        "final_state": result.final_state,
                        "target_tier": result.target_tier,
                        "benefit_realized": result.benefit_realized,
                        "error": result.error,
                        "steps": result.steps,
                    })
            except Exception as e:
                errors.append(f"migration failed for {trade.id}: {e}")

            # Save trade state after each step
            self.tracker._save()

        return {
            "tier4_trades": len(tier4_trades),
            "migrations": migrations,
            "rebalances": rebalances,
            "errors": errors,
        }

    # --- Internal helpers ---

    def _get_tier4_trades(self) -> list:
        """Return open trades in tier4_pending_migration state."""
        return [
            t for t in self.tracker.get_open_trades()
            if t.hedge_mode == "tier4_pending_migration"
        ]

    def _add_history(self, trade, event: str, data: Optional[dict] = None):
        """Append a state transition event to trade.migration_history."""
        entry = {
            "timestamp": time.time(),
            "iso": datetime.now(timezone.utc).isoformat(),
            "event": event,
        }
        if data:
            entry.update(data)
        trade.migration_history.append(entry)

    # --- Migration decision (read-only) ---

    def check_trade(self, trade) -> MigrationDecision:
        """Read-only: should we migrate this trade right now?

        Returns a MigrationDecision with should_migrate=True only if:
        - A Tier 1/2/3 hedge candidate exists in the cache
        - Expected migration benefit exceeds MIGRATION_MIN_BENEFIT
        - Account margin can absorb the new Derive IM
        - Target instrument spread is stable
        """
        # Look up hedge candidates, Tier 1 preferred.
        #
        # Audit H9 fix: apply the same direction filter the bidder uses
        # (put debit spread sells the lower strike, call debit spread sells
        # the higher) and prefer candidates whose Derive mark * ratio is
        # meaningfully positive. We walk the candidate list instead of
        # blindly taking the first element.
        exact = self.cache.find_exact_match(
            trade.underlying, trade.strike, trade.expiry_ts, trade.option_type,
        )
        target_tier = 0
        target_mark_obj = None

        if exact is not None and exact.derive_mark > 0:
            target_tier = 1
            target_mark_obj = exact
        else:
            adjacents = self.cache.find_adjacent_strikes(
                trade.underlying, trade.strike, trade.expiry_ts, trade.option_type,
            )
            for adj in adjacents:
                # Direction filter: put spread sells lower strike, call spread sells higher
                if trade.option_type == "P" and adj.strike >= trade.strike:
                    continue
                if trade.option_type == "C" and adj.strike <= trade.strike:
                    continue
                if adj.derive_mark <= 0:
                    continue
                target_tier = 2
                target_mark_obj = adj
                break

            if target_mark_obj is None:
                longer = self.cache.find_longer_expiry(
                    trade.underlying, trade.strike, trade.expiry_ts, trade.option_type,
                )
                for lg in longer:
                    if lg.derive_mark <= 0:
                        continue
                    target_tier = 3
                    target_mark_obj = lg
                    break

        if target_mark_obj is None:
            return MigrationDecision(
                should_migrate=False,
                reason="No Tier 1/2/3 hedge candidate available",
            )

        # Spread stability check.
        # Audit L3 fix: threshold now lives in config (MIGRATION_MAX_SPREAD_PCT)
        # rather than a magic 0.10 literal. MIGRATION_MAX_SPREAD_MULTIPLIER
        # is reserved for a future rolling-median impl per spec Section 4.5.
        if target_mark_obj.derive_ask > 0 and target_mark_obj.derive_bid > 0:
            spread = target_mark_obj.derive_ask - target_mark_obj.derive_bid
            mid = (target_mark_obj.derive_ask + target_mark_obj.derive_bid) / 2
            spread_pct = spread / mid if mid > 0 else 0
            if spread_pct > MIGRATION_MAX_SPREAD_PCT:
                return MigrationDecision(
                    should_migrate=False,
                    target_tier=target_tier,
                    target_instrument=target_mark_obj.instrument,
                    reason=(
                        f"Target spread {spread_pct:.1%} "
                        f"exceeds MIGRATION_MAX_SPREAD_PCT {MIGRATION_MAX_SPREAD_PCT:.1%}"
                    ),
                )

        # Expected Derive fill
        ratio, _ = self.ratio_cache.get_ratio(
            target_mark_obj.instrument,
            target_mark_obj.expiry_ts,
            trade.underlying,
        )
        expected_fill = target_mark_obj.derive_mark * ratio

        # Audit H4 fix: compute migration benefit as an apples-to-apples
        # comparison of Path A (migrate now) vs Path B (hold perp to expiry).
        #
        # The Rysk long is a sunk cost identical in both paths and cancels.
        # perp_pnl at this moment is unrealized and would be realized in
        # both paths (at migration OR at expiry), so it also cancels in
        # expectation (random walk assumption).
        #
        # What differs between the two paths:
        # - Path A captures derive_hedge_value now (minus derive fee and
        #   estimated perp closing slippage)
        # - Path A avoids future funding drag that Path B would pay
        # - Path A loses any future favorable perp P&L drift (zero in expectation)
        #
        # Conservative benefit = gross derive receipt − derive fee −
        # closing slippage. We ignore the "avoided funding" term since
        # forecasting funding is noisy. This is strictly less than or
        # equal to the true benefit, which is the right direction for a
        # migration gate (false negatives are cheap, false positives cost
        # real money).
        qty = trade.qty
        current_mark = self.perp_client.get_mark_price(trade.underlying) or 0
        derive_hedge_value = expected_fill * qty
        derive_fee_est = 0.50 + 0.0003 * current_mark * qty if current_mark else 0
        perp_close_slippage_est = 0  # Lighter has 0 fee; slippage is small for our sizes
        migration_benefit = derive_hedge_value - derive_fee_est - perp_close_slippage_est

        # current_hedge_value is reported for observability only. It's the
        # realized P&L of the perp leg at current mark minus funding paid.
        current_mark_price = current_mark
        if current_mark_price > 0 and trade.perp_entry_price > 0:
            perp_pnl = (
                (trade.perp_entry_price - current_mark_price) * abs(trade.perp_qty)
                if trade.perp_entry_delta > 0  # SHORT perp (hedging a long put)
                else (current_mark_price - trade.perp_entry_price) * abs(trade.perp_qty)
            )
        else:
            perp_pnl = 0
        current_hedge_value = perp_pnl - trade.perp_funding_accrued

        if migration_benefit < MIGRATION_MIN_BENEFIT:
            return MigrationDecision(
                should_migrate=False,
                target_tier=target_tier,
                target_instrument=target_mark_obj.instrument,
                target_derive_price=expected_fill,
                current_value=current_hedge_value,
                migrated_value=derive_hedge_value,
                migration_benefit=migration_benefit,
                reason=f"Benefit ${migration_benefit:.2f} below MIGRATION_MIN_BENEFIT ${MIGRATION_MIN_BENEFIT}",
            )

        # Margin pre-flight (query Derive compute_margin)
        try:
            margin_info = self.derive_client.query_margin(
                target_mark_obj.instrument, qty,
            )
            new_im = margin_info.get("initial_margin", 0)
            account = self.derive_client.get_account_margin()
            projected_im = account["total_im"] + new_im
            projected_util = projected_im / account["equity"] if account["equity"] > 0 else 1.0

            from scripts.arb.config import MAX_MARGIN_UTILIZATION
            if projected_util > MAX_MARGIN_UTILIZATION:
                return MigrationDecision(
                    should_migrate=False,
                    target_tier=target_tier,
                    target_instrument=target_mark_obj.instrument,
                    reason=f"Margin pre-flight failed: projected util {projected_util:.0%}",
                )
        except Exception as e:
            return MigrationDecision(
                should_migrate=False,
                target_tier=target_tier,
                target_instrument=target_mark_obj.instrument,
                reason=f"Margin pre-flight error: {e}",
            )

        return MigrationDecision(
            should_migrate=True,
            target_tier=target_tier,
            target_instrument=target_mark_obj.instrument,
            target_derive_price=expected_fill,
            current_value=current_hedge_value,
            migrated_value=derive_hedge_value,
            migration_benefit=migration_benefit,
            reason=f"Migration to Tier {target_tier}: +${migration_benefit:.2f}",
        )

    # --- Delta rebalancing ---

    def rebalance_delta(self, trade) -> RebalanceResult:
        """Check perp hedge vs current option delta and rebalance if drifted.

        Does not migrate; this is independent upkeep while in Tier 4 mode.

        Audit H5 fix: "old" delta is `perp_current_delta` (the most recent
        hedged delta) with `perp_entry_delta` as fallback for the first
        rebalance. The entry delta is preserved as an immutable baseline
        for audit / analysis; drift is measured vs the live position.
        """
        spot = self.cache.get_spot(trade.underlying)
        # Old delta: live position if we've rebalanced before, else the entry baseline.
        live_old_delta = (
            trade.perp_current_delta
            if abs(trade.perp_current_delta) > 1e-6
            else trade.perp_entry_delta
        )

        if spot is None:
            return RebalanceResult(
                trade_id=trade.id, old_delta=live_old_delta, new_delta=live_old_delta, drift_pct=0,
                rebalanced=False, error="no spot price",
            )

        # Fetch current option delta from cached Derive ticker if available
        exact = self.cache.find_exact_match(
            trade.underlying, trade.strike, trade.expiry_ts, trade.option_type,
        )
        if exact is None:
            # No Derive match; fall back to simple moneyness-based estimate
            return RebalanceResult(
                trade_id=trade.id, old_delta=live_old_delta,
                new_delta=live_old_delta, drift_pct=0,
                rebalanced=False, error="no delta source",
            )

        # Read current delta from mark object (stored when we last cached it)
        # The mark's iv field is set; we don't have delta stored separately yet.
        # For MVP: use BS approximation with current spot and cached IV.
        from scripts.arb.pricing import normal_cdf
        import math

        # Audit M8 fix: when cached IV is missing, the spec Section 5.2
        # calls for a fallback to 30-day realized vol from Hyperliquid 1h
        # candles. That dep is not wired yet, so as an interim measure we
        # use a conservative crypto IV baseline (80%) rather than silently
        # skipping the rebalance and letting the hedge drift.
        iv_to_use = exact.iv if exact.iv > 0 else 0.80
        iv_source = "cache" if exact.iv > 0 else "fallback_0.80"

        t_years = max(1e-6, (trade.expiry_ts - time.time()) / (365.25 * 86400))
        d1 = (
            math.log(spot / trade.strike) + (0.05 + iv_to_use ** 2 / 2) * t_years
        ) / (iv_to_use * math.sqrt(t_years))

        if trade.option_type == "P":
            per_contract_delta = normal_cdf(d1) - 1  # Negative for puts
        else:
            per_contract_delta = normal_cdf(d1)       # Positive for calls

        current_position_delta = per_contract_delta * trade.qty

        # Compare to live perp delta (not entry baseline)
        old_delta = live_old_delta
        drift = current_position_delta - old_delta
        drift_pct = (
            abs(drift) / abs(old_delta) if abs(old_delta) > 1e-6 else 0
        )

        if drift_pct < MIGRATION_DELTA_DRIFT_THRESHOLD:
            return RebalanceResult(
                trade_id=trade.id, old_delta=old_delta,
                new_delta=current_position_delta, drift_pct=drift_pct,
                rebalanced=False,
            )

        # Rebalance: adjust perp by the drift amount
        if self.dry_run:
            self._add_history(trade, "rebalance_dry_run", {
                "old_delta": old_delta,
                "new_delta": current_position_delta,
                "drift": drift,
            })
            return RebalanceResult(
                trade_id=trade.id, old_delta=old_delta,
                new_delta=current_position_delta, drift_pct=drift_pct,
                rebalanced=True, adjustment_size=abs(drift),
            )

        try:
            # Rebalancing is routine maintenance, not time-critical.
            # Use the most patient urgency for best fill quality.
            result = self.perp_client.hedge_delta(
                trade.underlying, drift, urgency="routine",
            )
            if result.success:
                # Audit H5 fix: do NOT overwrite perp_entry_delta here.
                # That field is the immutable baseline from trade open.
                # Rebalances update perp_current_delta (the live position).
                trade.perp_current_delta = current_position_delta
                trade.perp_qty += result.filled_size if drift > 0 else -result.filled_size
                self._add_history(trade, "rebalance", {
                    "entry_delta": trade.perp_entry_delta,
                    "old_current_delta": old_delta,
                    "new_current_delta": current_position_delta,
                    "adjustment": drift,
                    "filled": result.filled_size,
                    "avg_price": result.avg_price,
                })
            return RebalanceResult(
                trade_id=trade.id, old_delta=old_delta,
                new_delta=current_position_delta, drift_pct=drift_pct,
                rebalanced=result.success, adjustment_size=result.filled_size,
                error=result.error,
            )
        except Exception as e:
            return RebalanceResult(
                trade_id=trade.id, old_delta=old_delta,
                new_delta=current_position_delta, drift_pct=drift_pct,
                rebalanced=False, error=str(e),
            )

    # --- Atomic migration execution ---

    def execute_migration(self, trade, decision: MigrationDecision) -> MigrationResult:
        """Atomic migration state machine. Never opens a naked window.

        State transitions (see spec Section 4.5):
        tier4_pending_migration
          -> tier4_migrating_rfq_sent   (send Derive RFQ)
          -> tier4_migrating_executing  (execute_quote)
          -> tier4_migrating_perp_close (close perp)
          -> tier{N}_migrated           (SUCCESS)

        On failure at any step:
        - Before Derive fill: rollback to tier4_pending_migration
        - After Derive fill but perp close fails: tier4_INCONSISTENT
          (terminal, manual intervention)
        """
        started_at = time.time()
        steps: list[dict] = []

        def step(name: str, data: Optional[dict] = None):
            entry = {"step": name, "timestamp": time.time()}
            if data:
                entry.update(data)
            steps.append(entry)
            self._add_history(trade, name, data)

        if self.dry_run:
            step("dry_run_would_migrate", {
                "target_tier": decision.target_tier,
                "benefit": decision.migration_benefit,
            })
            return MigrationResult(
                trade_id=trade.id,
                started_at=started_at,
                final_state="dry_run",
                target_tier=decision.target_tier,
                benefit_realized=decision.migration_benefit,
                steps=steps,
            )

        # Phase 1: Send Derive RFQ
        trade.hedge_mode = "tier4_migrating_rfq_sent"
        self.tracker._save()
        step("rfq_sent", {"instrument": decision.target_instrument})

        try:
            rfq = self.derive_client.send_rfq(
                decision.target_instrument, "sell", trade.qty,
            )
            rfq_id = rfq.get("rfq_id")
        except Exception as e:
            trade.hedge_mode = "tier4_pending_migration"
            self.tracker._save()
            step("rfq_error", {"error": str(e)})
            return MigrationResult(
                trade_id=trade.id,
                started_at=started_at,
                final_state="tier4_pending_migration",
                error=f"rfq_error: {e}",
                steps=steps,
            )

        # Phase 2: Poll for quotes
        best_quote = None
        start = time.time()
        while time.time() - start < MIGRATION_RFQ_TIMEOUT_SECONDS:
            time.sleep(2)
            try:
                quotes = self.derive_client.poll_quotes(rfq_id)
                if quotes and isinstance(quotes, list):
                    for q in quotes:
                        price = float(q.get("price", 0))
                        if best_quote is None or price > best_quote.get("price", 0):
                            best_quote = {
                                "quote_id": q.get("quote_id"),
                                "price": price,
                                "direction": q.get("direction"),
                            }
                if best_quote:
                    break
            except Exception:
                continue

        if not best_quote:
            trade.hedge_mode = "tier4_pending_migration"
            self.tracker._save()
            step("no_quotes")
            return MigrationResult(
                trade_id=trade.id,
                started_at=started_at,
                final_state="tier4_pending_migration",
                error="no_quotes_within_timeout",
                steps=steps,
            )

        # Check if quote is acceptable (must be at least 90% of expected fill)
        min_acceptable = decision.target_derive_price * 0.90
        if best_quote["price"] < min_acceptable:
            trade.hedge_mode = "tier4_pending_migration"
            self.tracker._save()
            step("quote_too_low", {
                "quote_price": best_quote["price"],
                "min_acceptable": min_acceptable,
            })
            return MigrationResult(
                trade_id=trade.id,
                started_at=started_at,
                final_state="tier4_pending_migration",
                error=f"quote_too_low: ${best_quote['price']:.4f} < ${min_acceptable:.4f}",
                steps=steps,
            )

        # Phase 3: Execute Derive quote
        trade.hedge_mode = "tier4_migrating_executing"
        self.tracker._save()
        step("executing_quote", {
            "quote_id": best_quote["quote_id"],
            "price": best_quote["price"],
        })

        try:
            self.derive_client.execute_quote(
                rfq_id=rfq_id,
                quote_id=best_quote["quote_id"],
                quote_direction=best_quote["direction"],
                legs_with_prices=[{
                    "instrument_name": decision.target_instrument,
                    "direction": "sell",
                    "price": best_quote["price"],
                    "amount": trade.qty,
                }],
            )
        except Exception as e:
            # Rollback to pending. We haven't touched the perp yet, so state is clean.
            trade.hedge_mode = "tier4_pending_migration"
            self.tracker._save()
            step("execute_failed", {"error": str(e)})
            return MigrationResult(
                trade_id=trade.id,
                started_at=started_at,
                final_state="tier4_pending_migration",
                error=f"execute_failed: {e}",
                steps=steps,
            )

        # Derive is now filled. We are now DOUBLE-HEDGED until perp closes.
        # From here, failure is INCONSISTENT (manual).
        step("derive_filled", {"price": best_quote["price"]})

        # Phase 4: Close perp hedge
        trade.hedge_mode = "tier4_migrating_perp_close"
        self.tracker._save()

        # Audit L1 fix: initialize close_result before the try so that any
        # future refactor (e.g., a retry loop) that falls through without
        # binding close_result does not produce a NameError. The current
        # code works by luck because every except branch returns, but the
        # explicit init makes the invariant defensive.
        close_result = None
        try:
            # Patient close: HYPE is mean-reverting so limits usually fill.
            # 40s window with tight slippage cap beats aggressive market orders.
            close_result = self.perp_client.close_position(
                trade.underlying, urgency="patient",
            )
            if not close_result.success:
                trade.hedge_mode = "tier4_INCONSISTENT"
                self.tracker._save()
                step("perp_close_failed", {"error": close_result.error})
                return MigrationResult(
                    trade_id=trade.id,
                    started_at=started_at,
                    final_state="tier4_INCONSISTENT",
                    error=f"INCONSISTENT: perp close failed: {close_result.error}",
                    steps=steps,
                )
            step("perp_closed", {
                "size": close_result.filled_size,
                "avg_price": close_result.avg_price,
            })
        except Exception as e:
            trade.hedge_mode = "tier4_INCONSISTENT"
            self.tracker._save()
            step("perp_close_exception", {"error": str(e)})
            return MigrationResult(
                trade_id=trade.id,
                started_at=started_at,
                final_state="tier4_INCONSISTENT",
                error=f"INCONSISTENT: perp close exception: {e}",
                steps=steps,
            )

        # Success: finalize trade state
        trade.derive_instrument = decision.target_instrument
        trade.derive_price = best_quote["price"]
        trade.derive_order_type = "rfq"
        trade.tier = decision.target_tier
        trade.hedge_mode = f"tier{decision.target_tier}_migrated"
        trade.hedge_status = "hedged"
        trade.compute_gross_spread()

        # Derive fee on the migration RFQ
        from scripts.arb.pricing import derive_taker_fee
        spot = self.cache.get_spot(trade.underlying) or 0
        trade.derive_fee = derive_taker_fee(spot, trade.qty, best_quote["price"])
        trade.compute_fees()
        self.tracker._save()

        step("migrated", {
            "final_tier": decision.target_tier,
            "derive_price": best_quote["price"],
            "perp_close_price": close_result.avg_price,
        })

        return MigrationResult(
            trade_id=trade.id,
            started_at=started_at,
            final_state=f"tier{decision.target_tier}_migrated",
            target_tier=decision.target_tier,
            derive_fill_price=best_quote["price"],
            perp_close_price=close_result.avg_price,
            benefit_realized=decision.migration_benefit,
            steps=steps,
        )

    # --- Console report ---

    def print_cycle_report(self, result: dict):
        """Pretty-print the result of a run_cycle() call."""
        print("=" * 70)
        print("  TIER 4 MIGRATION CYCLE")
        print("=" * 70)
        print()
        print(f"  Tier 4 trades scanned: {result['tier4_trades']}")
        print(f"  Migrations attempted:  {len(result['migrations'])}")
        print(f"  Rebalances:            {len(result['rebalances'])}")
        print(f"  Errors:                {len(result['errors'])}")
        print()

        if result["migrations"]:
            print("  MIGRATION RESULTS")
            print(f"  {'-' * 50}")
            for m in result["migrations"]:
                print(f"  {m.summary()}")
            print()

        if result["rebalances"]:
            print("  DELTA REBALANCES")
            print(f"  {'-' * 50}")
            for r in result["rebalances"]:
                print(f"  {r.trade_id}: {r.old_delta:.2f} -> {r.new_delta:.2f} "
                      f"(drift {r.drift_pct:.1%})")
            print()

        if result["errors"]:
            print("  ERRORS")
            print(f"  {'-' * 50}")
            for e in result["errors"]:
                print(f"  {e}")
            print()

        print("=" * 70)
