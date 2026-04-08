"""Derive trade history logger.

Captures our actual fills (via private API) with mark-at-time, writes to
an append-only JSONL log. This data is fed back into calibration so the
execution ratio reflects OUR specific flow patterns (size, strike range,
expiry range) rather than whatever the broader market does.

Format: one JSON object per line, keys:
  trade_id, timestamp, instrument_name, direction, liquidity_role,
  rfq_id, quote_id, trade_price, mark_price, index_price, trade_amount,
  trade_fee, ratio (computed).

Usage:
  logger = TradeLogger(client)
  logger.sync(pages=3)  # Fetch recent trades, append new ones
  logger.stats()        # Print summary
"""

import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional


DEFAULT_LOG_FILE = "data/derive-fills.jsonl"


@dataclass
class LoggedTrade:
    trade_id: str
    timestamp: int         # milliseconds
    instrument_name: str
    direction: str          # "buy" or "sell"
    liquidity_role: str     # "taker" or "maker"
    rfq_id: Optional[str]
    quote_id: Optional[str]
    trade_price: float
    mark_price: float
    index_price: float
    trade_amount: float
    trade_fee: float
    order_id: str = ""
    tx_hash: str = ""
    ratio: float = 0.0

    @classmethod
    def from_api(cls, t: dict) -> "LoggedTrade":
        try:
            price = float(t.get("trade_price", 0))
            mark = float(t.get("mark_price", 0))
            ratio = price / mark if mark > 0 else 0
        except (ValueError, TypeError):
            price = 0
            mark = 0
            ratio = 0

        return cls(
            trade_id=t.get("trade_id", ""),
            timestamp=int(t.get("timestamp", 0)),
            instrument_name=t.get("instrument_name", ""),
            direction=t.get("direction", ""),
            liquidity_role=t.get("liquidity_role", ""),
            rfq_id=t.get("rfq_id"),
            quote_id=t.get("quote_id"),
            trade_price=price,
            mark_price=mark,
            index_price=float(t.get("index_price", 0) or 0),
            trade_amount=float(t.get("trade_amount", 0) or 0),
            trade_fee=float(t.get("trade_fee", 0) or 0),
            order_id=t.get("order_id", ""),
            tx_hash=t.get("tx_hash", ""),
            ratio=ratio,
        )

    def to_json(self) -> str:
        return json.dumps({
            "trade_id": self.trade_id,
            "timestamp": self.timestamp,
            "instrument_name": self.instrument_name,
            "direction": self.direction,
            "liquidity_role": self.liquidity_role,
            "rfq_id": self.rfq_id,
            "quote_id": self.quote_id,
            "trade_price": self.trade_price,
            "mark_price": self.mark_price,
            "index_price": self.index_price,
            "trade_amount": self.trade_amount,
            "trade_fee": self.trade_fee,
            "order_id": self.order_id,
            "tx_hash": self.tx_hash,
            "ratio": self.ratio,
        })

    @classmethod
    def from_json_line(cls, line: str) -> "LoggedTrade":
        d = json.loads(line)
        return cls(**d)


class TradeLogger:
    """Append-only log of our Derive trade fills.

    Designed for incremental sync: `sync()` fetches recent trades
    and appends only new trade_ids. Safe to run on a cron schedule.
    """

    def __init__(self, client, log_file: str = DEFAULT_LOG_FILE):
        self.client = client
        self.log_file = log_file
        self._seen_ids: set[str] = self._load_seen_ids()

    def _load_seen_ids(self) -> set[str]:
        """Load trade_ids already in the log file for dedup."""
        if not os.path.exists(self.log_file):
            return set()
        seen = set()
        with open(self.log_file) as f:
            for line in f:
                try:
                    d = json.loads(line)
                    tid = d.get("trade_id")
                    if tid:
                        seen.add(tid)
                except json.JSONDecodeError:
                    continue
        return seen

    def _append(self, trade: LoggedTrade):
        """Append one trade to the log file."""
        os.makedirs(os.path.dirname(self.log_file) or ".", exist_ok=True)
        with open(self.log_file, "a") as f:
            f.write(trade.to_json() + "\n")
        self._seen_ids.add(trade.trade_id)

    def sync(self, pages: int = 3, page_size: int = 100) -> dict:
        """Fetch recent trades from Derive and append new ones.

        Returns dict with counts: fetched, new, duplicate.
        """
        fetched = 0
        new = 0
        duplicate = 0
        error = 0

        for page in range(1, pages + 1):
            try:
                result = self.client._private("get_trade_history", {
                    "subaccount_id": self.client.subaccount_id,
                    "page": page,
                    "page_size": page_size,
                })
            except Exception as e:
                print(f"[logger] Page {page} error: {e}")
                break

            trades = result.get("trades", []) if isinstance(result, dict) else []
            if not trades:
                break

            for t in trades:
                fetched += 1
                tid = t.get("trade_id", "")
                if not tid:
                    error += 1
                    continue
                if tid in self._seen_ids:
                    duplicate += 1
                    continue

                try:
                    logged = LoggedTrade.from_api(t)
                    self._append(logged)
                    new += 1
                except Exception as e:
                    print(f"[logger] Failed to log trade {tid}: {e}")
                    error += 1

            # If this page had no new trades, we're caught up
            if new == 0 and duplicate > 0:
                break

        return {
            "fetched": fetched,
            "new": new,
            "duplicate": duplicate,
            "error": error,
        }

    def load_all(self) -> list[LoggedTrade]:
        """Load all trades from the log file."""
        if not os.path.exists(self.log_file):
            return []
        trades = []
        with open(self.log_file) as f:
            for line in f:
                try:
                    trades.append(LoggedTrade.from_json_line(line))
                except Exception:
                    continue
        return trades

    def stats(self) -> dict:
        """Compute summary statistics on the logged trades."""
        trades = self.load_all()
        if not trades:
            return {"total": 0}

        # Group by direction + liquidity_role
        by_role = {}
        for t in trades:
            key = f"{t.direction}/{t.liquidity_role}"
            by_role.setdefault(key, []).append(t)

        # For OUR trades, compute ratio stats
        ratios_by_role = {}
        for key, group in by_role.items():
            valid = [t.ratio for t in group if t.ratio > 0]
            if valid:
                sorted_ratios = sorted(valid)
                n = len(sorted_ratios)
                ratios_by_role[key] = {
                    "n": n,
                    "mean": sum(sorted_ratios) / n,
                    "median": sorted_ratios[n // 2],
                    "min": sorted_ratios[0],
                    "max": sorted_ratios[-1],
                }

        # Aggregate by instrument
        by_instrument = {}
        for t in trades:
            by_instrument.setdefault(t.instrument_name, []).append(t)

        # Oldest and newest timestamps
        timestamps = [t.timestamp for t in trades if t.timestamp > 0]
        oldest = min(timestamps) if timestamps else 0
        newest = max(timestamps) if timestamps else 0

        return {
            "total": len(trades),
            "instruments": len(by_instrument),
            "oldest": oldest,
            "newest": newest,
            "by_role": {k: len(v) for k, v in by_role.items()},
            "ratios_by_role": ratios_by_role,
            "by_instrument": {k: len(v) for k, v in by_instrument.items()},
        }

    def print_stats(self):
        """Pretty-print the trade log stats."""
        stats = self.stats()

        print("=" * 70)
        print("  DERIVE TRADE LOG")
        print("=" * 70)
        print()
        print(f"  Log file:     {self.log_file}")
        print(f"  Total trades: {stats['total']}")
        print(f"  Instruments:  {stats.get('instruments', 0)}")

        if stats.get("oldest"):
            oldest_dt = datetime.fromtimestamp(stats["oldest"] / 1000, tz=timezone.utc)
            newest_dt = datetime.fromtimestamp(stats["newest"] / 1000, tz=timezone.utc)
            print(f"  Date range:   {oldest_dt.strftime('%Y-%m-%d %H:%M')} -> "
                  f"{newest_dt.strftime('%Y-%m-%d %H:%M')} UTC")

        by_role = stats.get("by_role", {})
        if by_role:
            print()
            print(f"  BY ROLE")
            print(f"  {'-' * 50}")
            for key in sorted(by_role.keys()):
                print(f"  {key:<20} {by_role[key]:>5}")

        ratios = stats.get("ratios_by_role", {})
        if ratios:
            print()
            print(f"  FILL-TO-MARK RATIOS (YOUR ACTUAL FILLS)")
            print(f"  {'-' * 50}")
            print(f"  {'Side/Role':<20} {'N':>4} {'Mean':>8} {'Median':>8} {'Min':>7} {'Max':>7}")
            for key in sorted(ratios.keys()):
                r = ratios[key]
                print(f"  {key:<20} {r['n']:>4} {r['mean']:>8.3f} {r['median']:>8.3f} "
                      f"{r['min']:>7.3f} {r['max']:>7.3f}")

        by_inst = stats.get("by_instrument", {})
        if by_inst:
            print()
            print(f"  BY INSTRUMENT (top 10)")
            print(f"  {'-' * 50}")
            for inst in sorted(by_inst.keys(), key=lambda k: -by_inst[k])[:10]:
                print(f"  {inst:<30} {by_inst[inst]:>5}")

        print()
        print("=" * 70)


def calibrate_from_log(log_file: str = DEFAULT_LOG_FILE, buffer: float = 0.01) -> dict:
    """Re-run calibration using OUR logged fills instead of public data.

    Returns distribution stats for sell/taker trades (our arb pattern).
    """
    logger = TradeLogger.__new__(TradeLogger)
    logger.log_file = log_file
    logger._seen_ids = set()

    trades = logger.load_all()
    # Filter to sell + taker (our arb direction)
    sell_taker = [
        t for t in trades
        if t.direction == "sell" and t.liquidity_role == "taker" and t.ratio > 0
    ]

    if not sell_taker:
        return {"error": "No sell/taker trades in log"}

    ratios = sorted(t.ratio for t in sell_taker)
    n = len(ratios)

    def clamp(x):
        from scripts.arb.config import MIN_EXEC_RATIO, MAX_EXEC_RATIO
        return max(MIN_EXEC_RATIO, min(MAX_EXEC_RATIO, x - buffer))

    p25 = ratios[max(0, n // 4)]
    median = ratios[n // 2]
    p75 = ratios[min(n - 1, 3 * n // 4)]

    # Standard error of median (rough): stdev / sqrt(n) * 1.25
    # This gives a sense of how much we can trust the number
    import statistics
    stdev = statistics.stdev(ratios) if n > 1 else 0
    stderr = (stdev / (n ** 0.5)) * 1.25 if n > 1 else 0

    return {
        "n": n,
        "mean": sum(ratios) / n,
        "median": median,
        "stdev": stdev,
        "stderr": stderr,
        "p25": p25,
        "p75": p75,
        "min": ratios[0],
        "max": ratios[-1],
        "recommendations": {
            "conservative": clamp(p25),
            "balanced": clamp(median),
            "aggressive": clamp(p75),
        },
    }


# ---------------------------------------------------------------------------
# Retune: decide whether to update config based on accumulated data
# ---------------------------------------------------------------------------

from scripts.arb.config import (
    RETUNE_DRIFT_THRESHOLD,
    RETUNE_MIN_SAMPLES,
    RETUNE_STDERR_THRESHOLD,
)


def retune_recommendation(
    own_fill_calibration: dict,
    current_config_ratio: float,
    underlying: str = "HYPE",
) -> dict:
    """Recommend whether to update config based on drift and sample size.

    Logic:
    - If own-fill n < MIN_SAMPLES_FOR_OWN_FILL: NOT_ENOUGH_DATA
    - If |own_fill_balanced - current| < DRIFT_ALERT_THRESHOLD: OK (no change)
    - If drift > threshold AND n sufficient: RECOMMEND_RETUNE
    - If stderr > 0.02: HIGH_UNCERTAINTY (caution, more data needed)

    Returns dict with: status, current, recommended, drift, reason, action.
    """
    if "error" in own_fill_calibration:
        return {
            "status": "NO_DATA",
            "reason": own_fill_calibration["error"],
            "action": "Run `trade-log --sync` to accumulate fills",
        }

    n = own_fill_calibration["n"]
    balanced = own_fill_calibration["recommendations"]["balanced"]
    conservative = own_fill_calibration["recommendations"]["conservative"]
    stderr = own_fill_calibration.get("stderr", 0)

    drift = abs(balanced - current_config_ratio)

    result = {
        "underlying": underlying,
        "current": current_config_ratio,
        "own_fill_n": n,
        "own_fill_balanced": balanced,
        "own_fill_conservative": conservative,
        "drift": drift,
        "stderr": stderr,
    }

    if n < RETUNE_MIN_SAMPLES:
        result.update({
            "status": "NOT_ENOUGH_DATA",
            "reason": f"Only {n} own fills (need >= {RETUNE_MIN_SAMPLES})",
            "action": f"Continue logging. Current config {current_config_ratio} unchanged.",
        })
    elif drift < RETUNE_DRIFT_THRESHOLD:
        result.update({
            "status": "OK",
            "reason": f"Drift {drift:.3f} within threshold {RETUNE_DRIFT_THRESHOLD}",
            "action": "No change needed.",
        })
    elif stderr > RETUNE_STDERR_THRESHOLD:
        result.update({
            "status": "HIGH_UNCERTAINTY",
            "reason": f"Drift {drift:.3f} but stderr {stderr:.3f} exceeds {RETUNE_STDERR_THRESHOLD}",
            "action": "Wait for more samples before retuning.",
        })
    else:
        direction = "DOWN" if balanced < current_config_ratio else "UP"
        result.update({
            "status": "RECOMMEND_RETUNE",
            "reason": f"Drift {drift:.3f} exceeds threshold, direction {direction}",
            "action": f"Update config: EXECUTION_RATIOS['{underlying}'] = {conservative:.2f} "
                      f"(conservative) or {balanced:.2f} (balanced)",
        })

    return result
