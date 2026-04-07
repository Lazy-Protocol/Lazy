"""Execution ratio calibration.

Pulls Derive trade history, filters to RFQ trades, computes the fill-to-mark
ratio distribution, and outputs a recommended execution ratio update.

For our arb strategy we SELL on Derive via RFQ. The relevant bucket is:
  direction=buy + liquidity_role=maker + rfq_id present
  (MMs buying via RFQ means the counterparty was a taker SELLING)

The recorded mark_price is post-trade, so for sell trades it slightly
understates the pre-trade mark. We pick a slightly conservative number
from the distribution (near median, erring lower) to account for this.
"""

import statistics
from dataclasses import dataclass

from scripts.arb.config import MIN_EXEC_RATIO, MAX_EXEC_RATIO


@dataclass
class FillSample:
    instrument: str
    price: float
    mark: float
    amount: float
    ratio: float
    timestamp: int
    strike: float = 0.0
    expiry_ts: int = 0
    option_type: str = ""
    spot_at_trade: float = 0.0  # index_price at time of trade

    @property
    def otm_pct(self) -> float:
        """OTM percentage at time of trade. Positive = OTM, negative = ITM."""
        if self.spot_at_trade <= 0 or self.strike <= 0:
            return 0.0
        if self.option_type == "P":
            return (self.spot_at_trade - self.strike) / self.spot_at_trade
        elif self.option_type == "C":
            return (self.strike - self.spot_at_trade) / self.spot_at_trade
        return 0.0

    @property
    def days_to_expiry(self) -> float:
        """Approximate days to expiry at time of trade."""
        if self.expiry_ts <= 0 or self.timestamp <= 0:
            return 0.0
        secs = self.expiry_ts - (self.timestamp / 1000)
        return secs / 86400


def _parse_instrument_metadata(name: str) -> dict:
    """Extract strike, expiry, type from instrument name like HYPE-20260424-33-P."""
    parts = name.split("-")
    if len(parts) != 4:
        return {}
    try:
        from datetime import datetime, timezone
        expiry_dt = datetime.strptime(parts[1], "%Y%m%d").replace(
            hour=8, tzinfo=timezone.utc
        )
        return {
            "strike": float(parts[2]),
            "expiry_ts": int(expiry_dt.timestamp()),
            "option_type": parts[3],
        }
    except Exception:
        return {}


def fetch_trade_samples(client, instruments: list[str], page_size: int = 100) -> list[FillSample]:
    """Fetch Derive trade history and extract taker-sell RFQ samples."""
    samples = []
    seen_ids = set()

    for inst in instruments:
        meta = _parse_instrument_metadata(inst)
        try:
            result = client._public("get_trade_history", {
                "instrument_name": inst,
                "page_size": page_size,
            })
        except Exception as e:
            print(f"  [calibrate] Failed to fetch {inst}: {e}")
            continue

        trades = result.get("trades", []) if isinstance(result, dict) else []
        for t in trades:
            tid = t.get("trade_id")
            if not tid or tid in seen_ids:
                continue
            seen_ids.add(tid)

            # Filter to the "taker sells via RFQ" bucket
            if t.get("direction") != "buy":
                continue
            if t.get("liquidity_role") != "maker":
                continue
            if not t.get("rfq_id"):
                continue

            try:
                price = float(t.get("trade_price", 0))
                mark = float(t.get("mark_price", 0))
                amount = float(t.get("trade_amount", 0))
                ts = int(t.get("timestamp", 0))
                spot = float(t.get("index_price", 0) or 0)
            except (ValueError, TypeError):
                continue

            if mark <= 0 or price <= 0 or amount <= 0:
                continue

            samples.append(FillSample(
                instrument=inst,
                price=price,
                mark=mark,
                amount=amount,
                ratio=price / mark,
                timestamp=ts,
                strike=meta.get("strike", 0),
                expiry_ts=meta.get("expiry_ts", 0),
                option_type=meta.get("option_type", ""),
                spot_at_trade=spot,
            ))

    return samples


def compute_distribution(samples: list[FillSample]) -> dict:
    """Compute statistical distribution of fill ratios."""
    if not samples:
        return {"n": 0}

    ratios = sorted(s.ratio for s in samples)
    n = len(ratios)

    return {
        "n": n,
        "mean": statistics.mean(ratios),
        "median": statistics.median(ratios),
        "stdev": statistics.stdev(ratios) if n > 1 else 0,
        "p10": ratios[max(0, n // 10)],
        "p25": ratios[max(0, n // 4)],
        "p50": ratios[n // 2],
        "p75": ratios[min(n - 1, 3 * n // 4)],
        "p90": ratios[min(n - 1, 9 * n // 10)],
        "min": ratios[0],
        "max": ratios[-1],
    }


def bucket_by_size(samples: list[FillSample]) -> dict:
    """Group samples by trade size bucket."""
    buckets = {
        "1-9": [],
        "10-99": [],
        "100-499": [],
        "500-999": [],
        "1000+": [],
    }
    for s in samples:
        if s.amount < 10:
            buckets["1-9"].append(s)
        elif s.amount < 100:
            buckets["10-99"].append(s)
        elif s.amount < 500:
            buckets["100-499"].append(s)
        elif s.amount < 1000:
            buckets["500-999"].append(s)
        else:
            buckets["1000+"].append(s)
    return buckets


def bucket_by_moneyness(samples: list[FillSample]) -> dict:
    """Group samples by how OTM the strike was at trade time."""
    buckets = {
        "ITM":     [],  # ITM (negative OTM%)
        "0-5%":    [],  # Near ATM
        "5-10%":   [],
        "10-20%":  [],
        "20-30%":  [],
        "30%+":    [],  # Deep OTM
    }
    for s in samples:
        otm = s.otm_pct
        if otm < 0:
            buckets["ITM"].append(s)
        elif otm < 0.05:
            buckets["0-5%"].append(s)
        elif otm < 0.10:
            buckets["5-10%"].append(s)
        elif otm < 0.20:
            buckets["10-20%"].append(s)
        elif otm < 0.30:
            buckets["20-30%"].append(s)
        else:
            buckets["30%+"].append(s)
    return buckets


def bucket_by_dte(samples: list[FillSample]) -> dict:
    """Group samples by days-to-expiry at trade time."""
    buckets = {
        "0-3d":    [],
        "3-7d":    [],
        "7-14d":   [],
        "14-28d":  [],
        "28d+":    [],
    }
    for s in samples:
        dte = s.days_to_expiry
        if dte < 3:
            buckets["0-3d"].append(s)
        elif dte < 7:
            buckets["3-7d"].append(s)
        elif dte < 14:
            buckets["7-14d"].append(s)
        elif dte < 28:
            buckets["14-28d"].append(s)
        else:
            buckets["28d+"].append(s)
    return buckets


def recommend_ratios(dist: dict, buffer: float = 0.01) -> dict:
    """Recommend execution ratios at different risk levels.

    Returns three options:
      - conservative: P25 - buffer (underbids ~25% of the time)
      - balanced: median - buffer (underbids ~50% of the time)
      - aggressive: P75 - buffer (underbids ~75% of the time)

    The buffer accounts for the post-trade mark understating
    pre-trade mark for sell trades.

    For arb strategies where overbidding produces real losses,
    use conservative. Use balanced once calibrated from your
    own maker-side fills (not just public trade history).
    """
    if dist.get("n", 0) == 0:
        return {"conservative": 0.0, "balanced": 0.0, "aggressive": 0.0}

    def clamp(x):
        return max(MIN_EXEC_RATIO, min(MAX_EXEC_RATIO, x - buffer))

    return {
        "conservative": clamp(dist["p25"]),
        "balanced": clamp(dist["median"]),
        "aggressive": clamp(dist["p75"]),
    }


def get_active_instruments(client, underlying: str, max_count: int = 20) -> list[str]:
    """Get active option instruments for an underlying, most-traded first.

    Returns a sample of instruments to query trade history for.
    """
    instruments = client.get_instruments(currency=underlying, expired=False)

    # Sort by some heuristic: recent expiries first, near-ATM strikes
    # Without volume data, just take a spread across strikes and expiries
    spot = client.get_index_price(underlying)

    scored = []
    for inst in instruments:
        opt = inst.get("option_details") or {}
        try:
            strike = float(opt.get("strike", 0))
            if strike <= 0:
                continue
            otm_pct = abs(strike - spot) / spot
            # Favor 5-25% OTM (typical trading range)
            if otm_pct > 0.40:
                continue
            scored.append((inst["instrument_name"], otm_pct))
        except (ValueError, TypeError):
            continue

    # Sort by OTM percentage (near ATM first)
    scored.sort(key=lambda x: x[1])
    return [name for name, _ in scored[:max_count]]


def run_calibration(client, underlying: str = "HYPE", max_instruments: int = 20) -> dict:
    """Full calibration pipeline.

    Returns a dict with overall distribution + breakdowns by size,
    moneyness, and days-to-expiry. Also a moneyness-based lookup table
    that pricing.py can use at runtime for strike-dependent ratios.
    """
    instruments = get_active_instruments(client, underlying, max_instruments)
    if not instruments:
        return {"error": f"No active {underlying} instruments found"}

    samples = fetch_trade_samples(client, instruments)
    if not samples:
        return {"error": "No RFQ samples found"}

    overall = compute_distribution(samples)

    size_buckets = {
        label: compute_distribution(bucket)
        for label, bucket in bucket_by_size(samples).items()
    }
    moneyness_buckets = {
        label: compute_distribution(bucket)
        for label, bucket in bucket_by_moneyness(samples).items()
    }
    dte_buckets = {
        label: compute_distribution(bucket)
        for label, bucket in bucket_by_dte(samples).items()
    }

    # Build a moneyness-based lookup table using conservative recommendations
    # (P25 - buffer) for each bucket with sufficient sample size.
    moneyness_lookup = {}
    for label, dist in moneyness_buckets.items():
        if dist.get("n", 0) >= 5:
            recs = recommend_ratios(dist)
            moneyness_lookup[label] = recs["conservative"]

    # Global recommendation: use the size bucket most relevant to our trades
    target_bucket = size_buckets.get("500-999", {})
    if target_bucket.get("n", 0) >= 5:
        source_dist = target_bucket
        rec_source = "500-999 size bucket"
    elif size_buckets.get("100-499", {}).get("n", 0) >= 5:
        source_dist = size_buckets["100-499"]
        rec_source = "100-499 size bucket"
    else:
        source_dist = overall
        rec_source = "overall"

    recommendations = recommend_ratios(source_dist)

    return {
        "underlying": underlying,
        "instruments_queried": len(instruments),
        "samples": len(samples),
        "overall": overall,
        "size_buckets": size_buckets,
        "moneyness_buckets": moneyness_buckets,
        "dte_buckets": dte_buckets,
        "moneyness_lookup": moneyness_lookup,
        "recommendations": recommendations,
        "recommended_source": rec_source,
    }


def print_calibration_report(result: dict):
    """Pretty-print a calibration result."""
    if "error" in result:
        print(f"Calibration failed: {result['error']}")
        return

    print("=" * 70)
    print(f"  EXECUTION RATIO CALIBRATION - {result['underlying']}")
    print("=" * 70)
    print()
    print(f"  Instruments queried: {result['instruments_queried']}")
    print(f"  RFQ samples found:   {result['samples']}")
    print()

    overall = result["overall"]
    if overall.get("n", 0) > 0:
        print(f"  OVERALL (all sizes, all strikes, all expiries)")
        print(f"  {'-' * 60}")
        print(f"  n={overall['n']}  mean={overall['mean']:.3f}  median={overall['median']:.3f}  stdev={overall['stdev']:.3f}")
        print(f"  p10={overall['p10']:.3f}  p25={overall['p25']:.3f}  p75={overall['p75']:.3f}  p90={overall['p90']:.3f}")
        print(f"  range: [{overall['min']:.3f}, {overall['max']:.3f}]")
        print()

    def _print_bucket_table(label, bucket_order, bucket_data):
        print(f"  BY {label}")
        print(f"  {'-' * 60}")
        print(f"  {'Bucket':<12} {'N':>4} {'Mean':>8} {'Median':>8} {'P25':>7} {'P75':>7}")
        any_data = False
        for key in bucket_order:
            stats = bucket_data.get(key, {})
            if stats.get("n", 0) > 0:
                any_data = True
                print(f"  {key:<12} {stats['n']:>4} {stats['mean']:>8.3f} {stats['median']:>8.3f} "
                      f"{stats['p25']:>7.3f} {stats['p75']:>7.3f}")
        if not any_data:
            print("  (no data)")
        print()

    _print_bucket_table(
        "SIZE BUCKET",
        ["1-9", "10-99", "100-499", "500-999", "1000+"],
        result.get("size_buckets", {}),
    )
    _print_bucket_table(
        "MONEYNESS BUCKET",
        ["ITM", "0-5%", "5-10%", "10-20%", "20-30%", "30%+"],
        result.get("moneyness_buckets", {}),
    )
    _print_bucket_table(
        "DAYS-TO-EXPIRY BUCKET",
        ["0-3d", "3-7d", "7-14d", "14-28d", "28d+"],
        result.get("dte_buckets", {}),
    )

    # Moneyness-based lookup table
    lookup = result.get("moneyness_lookup", {})
    if lookup:
        print(f"  STRIKE-AWARE RATIO LOOKUP (conservative, P25 - buffer)")
        print(f"  {'-' * 60}")
        print(f"  Use this if running moneyness-aware pricing:")
        for label in ["ITM", "0-5%", "5-10%", "10-20%", "20-30%", "30%+"]:
            if label in lookup:
                print(f"    {label:<10} -> {lookup[label]:.3f}")
        print()

    print(f"  GLOBAL RECOMMENDATIONS")
    print(f"  {'-' * 50}")
    print(f"  Source: {result['recommended_source']}")
    print()
    recs = result["recommendations"]
    print(f"  Conservative (P25 - buffer):  {recs['conservative']:.3f}")
    print(f"    Underbids ~25% of trades. Safer when overbidding = loss.")
    print()
    print(f"  Balanced (median - buffer):   {recs['balanced']:.3f}")
    print(f"    50/50. Use after calibrating against your own maker fills.")
    print()
    print(f"  Aggressive (P75 - buffer):    {recs['aggressive']:.3f}")
    print(f"    Underbids ~75% of trades. Only if you want to win every RFQ.")
    print()
    print(f"  To apply, update scripts/arb/config.py:")
    print(f"    EXECUTION_RATIOS['{result['underlying']}'] = <chosen_value>")
    print()
    print("=" * 70)


def update_config_file(underlying: str, new_ratio: float, config_path: str = None):
    """Update EXECUTION_RATIOS in config.py with the new ratio.

    Returns True if updated, False if no change needed or file not writable.
    """
    import os
    import re

    if config_path is None:
        config_path = os.path.join(os.path.dirname(__file__), "config.py")

    with open(config_path, "r") as f:
        content = f.read()

    # Find the line like: "HYPE": 0.85,  # comment
    pattern = rf'(["\']){underlying}\1:\s*[\d.]+'
    replacement = f'"{underlying}": {new_ratio:.2f}'

    new_content, count = re.subn(pattern, replacement, content)
    if count == 0:
        return False

    if new_content == content:
        return False

    with open(config_path, "w") as f:
        f.write(new_content)

    return True
