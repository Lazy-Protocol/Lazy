"""Pricing engine: Black-Scholes, fee calculators, mark cache, bid calculator.

Port of normalCDF + BS from backtest-rysk-puts.js:48-70.
All fee formulas from docs/OPTIONS_ARB_STRATEGY.md Section 6.5.
"""

import math
import time
import sys
import os
from dataclasses import dataclass, field
from typing import Optional

# Import DeriveClient from existing script
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from scripts.arb.config import (
    BS_RISK_FREE_RATE,
    CACHE_REFRESH_INTERVAL,
    DEFAULT_EXEC_RATIO,
    DERIVE_MAKER_NOTIONAL_PCT,
    DERIVE_TAKER_BASE_FEE,
    DERIVE_TAKER_MAX_PCT,
    DERIVE_TAKER_NOTIONAL_PCT,
    EXECUTION_RATIOS,
    HL_PERP_FEE_PCT,
    MARK_CACHE_MAX_WORKERS,
    MAX_CACHE_AGE_SECONDS,
    MAX_EXEC_RATIO,
    MAX_EXPIRY_DAYS,
    MAX_MARGIN_UTILIZATION,
    MAX_NET_DELTA,
    MAX_OTM_PCT,
    MAX_OPEN_POSITIONS,
    MAX_OPTIONS_CAPITAL,
    MAX_PER_UNDERLYING,
    MAX_SINGLE_POSITION,
    MAX_UNHEDGED_INVENTORY,
    MIN_EXEC_RATIO,
    MIN_SPREADS,
    RATIO_BUFFER,
    RATIO_CACHE_MAX_AGE,
    RATIO_CACHE_MAX_WORKERS,
    RATIO_DTE_MIN_SAMPLES,
    RATIO_MIN_SAMPLES,
    RATIO_UNRELIABLE_THRESHOLD,
    RYSK_FEE_PREMIUM_FACTOR,
    RYSK_FEE_SPOT_FACTOR,
    TIER2_MAX_DEBIT_PCT,
    TIER3_MIN_PREMIUM_RATIO,
    TIER4_MIN_BS_DISCOUNT,
    TIER_WEIGHTS,
)


# ---------------------------------------------------------------------------
# Black-Scholes (ported from backtest-rysk-puts.js:48-70)
# ---------------------------------------------------------------------------

def normal_cdf(x: float) -> float:
    """Abramowitz-Stegun approximation of the cumulative normal distribution."""
    a1 = 0.254829592
    a2 = -0.284496736
    a3 = 1.421413741
    a4 = -1.453152027
    a5 = 1.061405429
    p = 0.3275911

    sign = -1 if x < 0 else 1
    x = abs(x) / math.sqrt(2)
    t = 1.0 / (1.0 + p * x)
    y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * math.exp(-x * x)
    return 0.5 * (1.0 + sign * y)


def black_scholes_put(
    spot: float,
    strike: float,
    t_years: float,
    vol: float,
    r: float = BS_RISK_FREE_RATE,
) -> float:
    """Black-Scholes European put price."""
    if t_years <= 0:
        return max(0.0, strike - spot)

    d1 = (math.log(spot / strike) + (r + vol * vol / 2) * t_years) / (vol * math.sqrt(t_years))
    d2 = d1 - vol * math.sqrt(t_years)

    price = strike * math.exp(-r * t_years) * normal_cdf(-d2) - spot * normal_cdf(-d1)
    return max(0.0, price)


def black_scholes_call(
    spot: float,
    strike: float,
    t_years: float,
    vol: float,
    r: float = BS_RISK_FREE_RATE,
) -> float:
    """Black-Scholes European call price via put-call parity."""
    if t_years <= 0:
        return max(0.0, spot - strike)

    put = black_scholes_put(spot, strike, t_years, vol, r)
    # C = P + S - K*e^(-rT)
    call = put + spot - strike * math.exp(-r * t_years)
    return max(0.0, call)


# ---------------------------------------------------------------------------
# Fee calculators (from spec Section 6.5)
# ---------------------------------------------------------------------------

def rysk_fee(spot: float, option_price: float, qty: float) -> float:
    """Rysk protocol fee. Assumed maker pays (70% confidence, verify on testnet)."""
    per_contract = min(RYSK_FEE_SPOT_FACTOR * spot, RYSK_FEE_PREMIUM_FACTOR * option_price)
    return per_contract * qty


def derive_taker_fee(spot: float, qty: float, premium: float) -> float:
    """Derive taker fee: $0.50 base + 0.03% notional, capped at 12.5% of premium."""
    notional = spot * qty
    uncapped = DERIVE_TAKER_BASE_FEE + DERIVE_TAKER_NOTIONAL_PCT * notional
    cap = DERIVE_TAKER_MAX_PCT * premium * qty
    return min(uncapped, cap)


def derive_maker_fee(spot: float, qty: float) -> float:
    """Derive maker fee: 0.01% of notional."""
    return DERIVE_MAKER_NOTIONAL_PCT * spot * qty


def hl_perp_fee(notional: float) -> float:
    """Hyperliquid perp fee per side: 0.035% of notional."""
    return HL_PERP_FEE_PCT * notional


# ---------------------------------------------------------------------------
# Mark Cache
# ---------------------------------------------------------------------------

@dataclass
class CachedMark:
    instrument: str
    underlying: str
    strike: float
    expiry_ts: int           # Unix timestamp
    option_type: str         # "P" or "C"
    derive_mark: float
    derive_bid: float
    derive_ask: float
    spot: float
    iv: float                # Implied vol from Derive
    margin_per_contract: float  # From compute_margin API
    timestamp: float         # time.time() when cached

    @property
    def age(self) -> float:
        return time.time() - self.timestamp

    @property
    def is_stale(self) -> bool:
        return self.age > MAX_CACHE_AGE_SECONDS


# ---------------------------------------------------------------------------
# Execution ratio cache (per-instrument + DTE bucket fallback)
# All tuning constants come from config.py
# ---------------------------------------------------------------------------


def _clamp_ratio(x: float) -> float:
    """Clamp a ratio to [MIN_EXEC_RATIO, MAX_EXEC_RATIO]."""
    return max(MIN_EXEC_RATIO, min(MAX_EXEC_RATIO, x))


@dataclass
class InstrumentRatio:
    instrument: str
    ratio: float          # Conservative: P25 - buffer
    n_samples: int
    median: float
    timestamp: float

    @property
    def is_stale(self) -> bool:
        return time.time() - self.timestamp > RATIO_CACHE_MAX_AGE


class RatioCache:
    """Per-instrument execution ratio cache with DTE bucket fallback.

    Refreshes from Derive trade history every ~10 minutes. Stores:
    - Per-instrument conservative ratio (P25 - buffer) when n >= 3
    - Per-DTE-bucket conservative ratio when bucket has n >= 5
    - Global default from EXECUTION_RATIOS as ultimate fallback
    """

    def __init__(self, client):
        self.client = client
        self._instrument_ratios: dict[str, InstrumentRatio] = {}
        self._dte_ratios: dict[str, float] = {}  # "3-7d" -> ratio
        self._last_refresh: float = 0

    def refresh(self, instruments: list[str]):
        """Fetch trade history for each instrument and compute ratios."""
        from concurrent.futures import ThreadPoolExecutor, as_completed
        all_samples = []  # (instrument, ratio, dte_bucket)

        def _fetch(inst):
            try:
                result = self.client._public("get_trade_history", {
                    "instrument_name": inst,
                    "page_size": 50,
                })
                trades = result.get("trades", []) if isinstance(result, dict) else []
                samples = []
                for t in trades:
                    if (t.get("direction") != "buy"
                            or t.get("liquidity_role") != "maker"
                            or not t.get("rfq_id")):
                        continue
                    try:
                        price = float(t.get("trade_price", 0))
                        mark = float(t.get("mark_price", 0))
                        ts = int(t.get("timestamp", 0))
                        if mark <= 0 or price <= 0:
                            continue
                        samples.append((price / mark, ts))
                    except (ValueError, TypeError):
                        continue
                return inst, samples
            except Exception:
                return inst, []

        with ThreadPoolExecutor(max_workers=RATIO_CACHE_MAX_WORKERS) as executor:
            futures = [executor.submit(_fetch, inst) for inst in instruments]
            for future in as_completed(futures):
                try:
                    inst, samples = future.result()
                except Exception:
                    continue

                # Compute per-instrument ratio if enough samples
                if len(samples) >= RATIO_MIN_SAMPLES:
                    ratios = sorted(r for r, _ in samples)
                    n = len(ratios)
                    p25 = ratios[max(0, n // 4)]
                    median = ratios[n // 2]
                    conservative = _clamp_ratio(p25 - RATIO_BUFFER)
                    self._instrument_ratios[inst] = InstrumentRatio(
                        instrument=inst,
                        ratio=conservative,
                        n_samples=n,
                        median=median,
                        timestamp=time.time(),
                    )

                # Record for DTE bucket aggregation
                meta = parse_instrument_name(inst)
                if not meta:
                    continue
                try:
                    from datetime import datetime, timezone
                    expiry_dt = datetime.strptime(meta["expiry_str"], "%Y%m%d").replace(
                        hour=8, tzinfo=timezone.utc
                    )
                    expiry_ts = expiry_dt.timestamp()
                except Exception:
                    continue

                for ratio, ts in samples:
                    dte = max(0, (expiry_ts - ts / 1000) / 86400)
                    bucket = _dte_bucket(dte)
                    all_samples.append((bucket, ratio))

        # Compute per-DTE-bucket ratios
        bucket_samples: dict[str, list[float]] = {}
        for bucket, ratio in all_samples:
            bucket_samples.setdefault(bucket, []).append(ratio)

        new_dte_ratios = {}
        for bucket, ratios in bucket_samples.items():
            if len(ratios) >= RATIO_DTE_MIN_SAMPLES:
                ratios_sorted = sorted(ratios)
                n = len(ratios_sorted)
                p25 = ratios_sorted[max(0, n // 4)]
                new_dte_ratios[bucket] = _clamp_ratio(p25 - RATIO_BUFFER)
        self._dte_ratios = new_dte_ratios
        self._last_refresh = time.time()

    def get_ratio(self, instrument: str, expiry_ts: int, underlying: str = "HYPE") -> tuple[float, str]:
        """Return (ratio, source) for the given instrument.

        Lookup order (any unreliable result skips to next):
          1. Per-instrument cached ratio (if fresh, >= RATIO_MIN_SAMPLES, not noise)
          2. DTE bucket ratio
          3. Longer-DTE bucket as fallback (better-liquidity proxy)
          4. Global EXECUTION_RATIOS default

        A ratio is "unreliable" if it's below RATIO_UNRELIABLE_THRESHOLD
        (0.75). Such values typically indicate insufficient samples or
        outlier-dominated distributions.
        """
        # 1. Per-instrument
        ir = self._instrument_ratios.get(instrument)
        if ir and not ir.is_stale and ir.ratio >= RATIO_UNRELIABLE_THRESHOLD:
            return ir.ratio, f"instrument (n={ir.n_samples})"

        # 2. DTE bucket
        dte = max(0, (expiry_ts - time.time()) / 86400)
        bucket = _dte_bucket(dte)
        bucket_order = ["0-3d", "3-7d", "7-14d", "14-28d", "28d+"]

        if bucket in self._dte_ratios and self._dte_ratios[bucket] >= RATIO_UNRELIABLE_THRESHOLD:
            return self._dte_ratios[bucket], f"dte bucket {bucket}"

        # 3. Fall forward to next longer DTE bucket
        if bucket in bucket_order:
            idx = bucket_order.index(bucket)
            for next_bucket in bucket_order[idx + 1:]:
                if (next_bucket in self._dte_ratios
                        and self._dte_ratios[next_bucket] >= RATIO_UNRELIABLE_THRESHOLD):
                    return (
                        self._dte_ratios[next_bucket],
                        f"dte bucket {next_bucket} (fallback from {bucket})",
                    )

        # 4. Global default
        return EXECUTION_RATIOS.get(underlying, DEFAULT_EXEC_RATIO), "global default"

    @property
    def instrument_count(self) -> int:
        return sum(1 for r in self._instrument_ratios.values() if not r.is_stale)


def _dte_bucket(dte: float) -> str:
    if dte < 3:
        return "0-3d"
    elif dte < 7:
        return "3-7d"
    elif dte < 14:
        return "7-14d"
    elif dte < 28:
        return "14-28d"
    else:
        return "28d+"


def parse_instrument_name(name: str) -> dict:
    """Parse Derive instrument name like 'HYPE-20260424-33-P'."""
    parts = name.split("-")
    if len(parts) != 4:
        return {}
    return {
        "underlying": parts[0],
        "expiry_str": parts[1],
        "strike": float(parts[2]),
        "option_type": parts[3],
    }


class MarkCache:
    """Continuously updated cache of Derive marks and margins.

    Polls Derive for all active instrument marks. Used by calculate_bid()
    for instant lookups within the 1-second Rysk RFQ window.
    """

    def __init__(self, client):
        """client: a DeriveClient (or ArbDeriveClient) instance."""
        self.client = client
        self._marks: dict[str, CachedMark] = {}
        self._spots: dict[str, float] = {}
        self._last_refresh: float = 0

    def refresh(self, underlyings: tuple[str, ...] = ("HYPE",)):
        """Poll Derive for marks + margins for all active instruments.

        Steps (from spec Section 5.2):
        1. Poll Derive mark price via REST API
        2. Poll Derive index price (spot)
        3. Compute BS theoretical (stored but not used for bidding)
        4. Query Derive compute_margin for exact IM
        """
        for underlying in underlyings:
            # Get spot price
            try:
                perp_name = f"{underlying}-PERP"
                ticker = self.client.get_ticker(perp_name)
                spot = float(ticker["index_price"])
                self._spots[underlying] = spot
            except Exception as e:
                print(f"  [cache] Failed to get {underlying} spot: {e}")
                continue

            # Get all active instruments
            try:
                instruments = self.client.get_instruments(currency=underlying, expired=False)
            except Exception as e:
                print(f"  [cache] Failed to get {underlying} instruments: {e}")
                continue

            # Filter to tradeable instruments:
            # - Expiry within MAX_EXPIRY_DAYS (28 days)
            # - Strike within MIN_OTM to MAX_OTM range (6-30% OTM)
            now = time.time()
            max_expiry = now + MAX_EXPIRY_DAYS * 86400
            filtered = []

            for inst in instruments:
                name = inst["instrument_name"]
                parsed = parse_instrument_name(name)
                if not parsed:
                    continue

                # Expiry is in option_details.expiry (unix seconds)
                opt_details = inst.get("option_details") or {}
                expiry_ts = int(opt_details.get("expiry", 0))
                if expiry_ts > 1e12:
                    expiry_ts = expiry_ts // 1000

                # Skip expired or too far out
                if expiry_ts < now or expiry_ts > max_expiry:
                    continue

                # Skip strikes too far from spot
                strike = parsed["strike"]
                otm_pct = abs(strike - spot) / spot
                if otm_pct > MAX_OTM_PCT + 0.05:  # Small buffer
                    continue

                filtered.append((inst, parsed, expiry_ts))

            # Fetch tickers concurrently (288 sequential calls = 2min, concurrent = ~10s)
            from concurrent.futures import ThreadPoolExecutor, as_completed

            def _fetch_ticker(item):
                inst, parsed, expiry_ts = item
                name = inst["instrument_name"]
                ticker = self.client.get_ticker(name)
                return name, parsed, expiry_ts, ticker

            with ThreadPoolExecutor(max_workers=MARK_CACHE_MAX_WORKERS) as executor:
                futures = {executor.submit(_fetch_ticker, item): item for item in filtered}
                for future in as_completed(futures):
                    try:
                        name, parsed, expiry_ts, ticker = future.result()
                        mark = float(ticker.get("mark_price", 0))
                        bid = float(ticker.get("best_bid_price", 0) or 0)
                        ask = float(ticker.get("best_ask_price", 0) or 0)
                        opt_pricing = ticker.get("option_pricing") or {}
                        iv = float(opt_pricing.get("iv", 0) or 0)

                        self._marks[name] = CachedMark(
                            instrument=name,
                            underlying=parsed["underlying"],
                            strike=parsed["strike"],
                            expiry_ts=expiry_ts,
                            option_type=parsed["option_type"],
                            derive_mark=mark,
                            derive_bid=bid,
                            derive_ask=ask,
                            spot=spot,
                            iv=iv,
                            margin_per_contract=0.0,  # Queried on-demand via get_margin()
                            timestamp=time.time(),
                        )
                    except Exception as e:
                        inst, parsed, expiry_ts = futures[future]
                        print(f"  [cache] Failed to cache {inst['instrument_name']}: {e}")

        self._last_refresh = time.time()

    def _query_margin(self, instrument: str, qty: float) -> Optional[float]:
        """Query Derive private/get_margin for the marginal IM impact of
        opening a short position. Returns IM on success, None on failure.

        Protocol details (empirically verified on mainnet, April 2026):
        - Endpoint: `/private/get_margin` (NOT `compute_margin` — 404)
        - Parameter: `simulated_position_changes` (NOT `simulated_positions`)
        - Amount is SIGNED: negative for short
        - Response fields: pre_initial_margin / post_initial_margin are
          SURPLUS values. Required IM for the new position is pre - post.

        Audit M5 fix: None on failure, never 0.0. Callers MUST treat None
        as "unknown margin" and refuse to size against it. Earlier drafts
        returned 0.0 which silently rubber-stamped check_limits.

        Uses a reasonable default sample size (10 contracts). A qty of 1
        often produces a ~$0 surplus delta due to rounding; sampling at 10
        lets us divide out a stable per-contract IM.
        """
        sample_qty = max(10.0, float(qty))
        try:
            result = self.client._private("get_margin", {
                "subaccount_id": self.client.subaccount_id,
                "simulated_position_changes": [{
                    "instrument_name": instrument,
                    "amount": str(-sample_qty),
                }],
            })
            pre_im = float(result.get("pre_initial_margin", 0))
            post_im = float(result.get("post_initial_margin", 0))
            delta_im = pre_im - post_im  # Surplus consumed by the new short
            if delta_im <= 0:
                return None  # No meaningful margin impact; treat as unknown
            return delta_im / sample_qty  # Per-contract IM
        except Exception as e:
            print(f"[mark cache] get_margin failed for {instrument}: {e}")
            return None

    def get(self, instrument: str) -> Optional[CachedMark]:
        """Get cached mark. Returns None if stale (>30s) or missing."""
        mark = self._marks.get(instrument)
        if mark is None or mark.is_stale:
            return None
        return mark

    def find_exact_match(
        self,
        underlying: str,
        strike: float,
        expiry_ts: int,
        option_type: str,
    ) -> Optional[CachedMark]:
        """Find a cached mark with exact strike/expiry/type match."""
        for mark in self._marks.values():
            if mark.is_stale:
                continue
            if (
                mark.underlying == underlying
                and abs(mark.strike - strike) < 0.01
                and abs(mark.expiry_ts - expiry_ts) < 3600  # within 1 hour tolerance
                and mark.option_type == option_type
            ):
                return mark
        return None

    def find_adjacent_strikes(
        self,
        underlying: str,
        strike: float,
        expiry_ts: int,
        option_type: str,
    ) -> list[CachedMark]:
        """Find cached marks at adjacent strikes (+-1-2 strikes away), same expiry."""
        results = []
        for mark in self._marks.values():
            if mark.is_stale:
                continue
            if (
                mark.underlying == underlying
                and abs(mark.expiry_ts - expiry_ts) < 3600
                and mark.option_type == option_type
                and mark.strike != strike
                and abs(mark.strike - strike) <= 2  # within 2 strike widths
            ):
                results.append(mark)
        return sorted(results, key=lambda m: abs(m.strike - strike))

    def find_longer_expiry(
        self,
        underlying: str,
        strike: float,
        expiry_ts: int,
        option_type: str,
    ) -> list[CachedMark]:
        """Find cached marks at same/adjacent strike with LATER expiry.

        Used by Tier 3 calendar spreads. The returned instruments must
        have strictly later expiries than the requested one (by at least
        1 day to ensure a real calendar spread, not same-day noise).
        """
        results = []
        cutoff = expiry_ts + 86400  # At least 1 day later
        for mark in self._marks.values():
            if mark.is_stale:
                continue
            if (
                mark.underlying == underlying
                and mark.option_type == option_type
                and abs(mark.strike - strike) <= 2
                and mark.expiry_ts >= cutoff
            ):
                results.append(mark)
        return sorted(results, key=lambda m: m.expiry_ts)

    def get_spot(self, underlying: str) -> Optional[float]:
        return self._spots.get(underlying)

    def get_margin(self, instrument: str, qty: float) -> Optional[float]:
        """Get margin for a position size.

        Queries compute_margin on-demand if not already cached. Returns
        None if the mark is missing OR if the API query failed. Callers
        must distinguish "unknown" (None) from "zero margin" (0.0) and
        refuse to size against an unknown value.
        """
        mark = self._marks.get(instrument)
        if mark is None:
            return None
        if mark.margin_per_contract == 0.0:
            # Query on-demand. If the call fails, _query_margin returns None.
            margin = self._query_margin(instrument, 1)
            if margin is None:
                return None  # Propagate the uncertainty to the caller
            mark.margin_per_contract = margin
        return mark.margin_per_contract * qty

    @property
    def instruments(self) -> list[str]:
        return list(self._marks.keys())

    @property
    def fresh_count(self) -> int:
        return sum(1 for m in self._marks.values() if not m.is_stale)

    def __len__(self) -> int:
        return len(self._marks)


# ---------------------------------------------------------------------------
# Bid calculator
# ---------------------------------------------------------------------------

@dataclass
class BidResult:
    max_bid: float
    tier: int
    tier_value: float
    confidence: float         # The tier weight applied
    fees: dict                # Breakdown: rysk_fee, derive_fee, etc.
    hedge_instrument: str     # Derive instrument to sell (or "PERP" for Tier 4)
    reasoning: str

    @property
    def net_profit_estimate(self) -> float:
        return self.tier_value * self.confidence


def calculate_bid(
    cache: MarkCache,
    underlying: str,
    strike: float,
    expiry_ts: int,
    option_type: str,
    qty: float,
    ratio_cache: Optional["RatioCache"] = None,
) -> Optional[BidResult]:
    """Calculate maximum bid for a Rysk RFQ. Must complete in <1ms.

    Tries tiers in priority order (1 -> 2 -> 3 -> 4).
    Returns the FIRST viable bid, not the best across all tiers.
    Returns None if no profitable tier is available or data is stale.

    If ratio_cache is provided, uses per-instrument ratios with DTE
    bucket fallback. Otherwise uses the global EXECUTION_RATIOS default.
    """
    spot = cache.get_spot(underlying)
    if spot is None:
        return None

    def _exec_ratio(instrument_name: str, inst_expiry_ts: int) -> tuple[float, str]:
        if ratio_cache is not None:
            return ratio_cache.get_ratio(instrument_name, inst_expiry_ts, underlying)
        return EXECUTION_RATIOS.get(underlying, DEFAULT_EXEC_RATIO), "global default"

    # Use learned tier weights if available, else static defaults.
    # This is the performance feedback loop: tier weights are updated by
    # feedback.py based on observed realization rates per tier.
    from scripts.arb.feedback import get_tier_weight

    min_spread = MIN_SPREADS.get(underlying, 0.10)

    # Tier 1: Exact match
    #
    # Audit H7 fix: Rysk fee is `MIN(0.01*spot, 0.125*option_price)`. The
    # actual trade will settle at max_bid, not derive_expected. Using
    # derive_expected as the price basis overstates the fee in the
    # `0.125*option_price` regime (derive_expected > max_bid). Overstating
    # is safer than understating for arb bidding (we bid slightly lower)
    # but it's still wrong. We compute the fee at `max_bid` by solving
    # the relationship `tier1_value = derive_expected - r_fee_at(bid) - d_fee - spread`,
    # where `bid = tier1_value * weight`. With Rysk fee piecewise linear in
    # bid, the fixed point converges in a single pass.
    exact = cache.find_exact_match(underlying, strike, expiry_ts, option_type)
    if exact is not None:
        ratio, ratio_source = _exec_ratio(exact.instrument, exact.expiry_ts)
        derive_expected = exact.derive_mark * ratio
        weight = get_tier_weight(1)
        d_fee_pc = derive_taker_fee(spot, 1, derive_expected)

        # Initial estimate using derive_expected as an upper-bound proxy
        r_fee_pc = rysk_fee(spot, derive_expected, 1)
        tier1_value = derive_expected - r_fee_pc - d_fee_pc - min_spread

        # Refine: if we'd actually bid at tier1_value * weight, recompute
        # the Rysk fee at that price. If recomputation produces a better
        # (lower) fee, update tier1_value accordingly. Single pass is enough
        # because rysk_fee is monotonic in option_price within each regime.
        if tier1_value > 0:
            projected_bid = tier1_value * weight
            r_fee_at_bid = rysk_fee(spot, projected_bid, 1)
            if r_fee_at_bid < r_fee_pc:
                tier1_value = derive_expected - r_fee_at_bid - d_fee_pc - min_spread
                r_fee_pc = r_fee_at_bid

        if tier1_value > 0:
            return BidResult(
                max_bid=tier1_value * weight,
                tier=1,
                tier_value=tier1_value,
                confidence=weight,
                fees={"rysk": r_fee_pc * qty,
                      "derive": derive_taker_fee(spot, qty, derive_expected)},
                hedge_instrument=exact.instrument,
                reasoning=f"Tier 1: exact match {exact.instrument}, "
                          f"Derive mark ${exact.derive_mark:.2f} * {ratio:.3f} "
                          f"[{ratio_source}] = ${derive_expected:.2f}",
            )

    # Tier 2: Adjacent strike (debit spread)
    #
    # Audit H3 fix: filter adjacents by spread direction. For a debit spread
    # you BUY the more ITM leg and SELL the less ITM leg.
    #   PUT:  BUY higher strike (more ITM), SELL lower strike  → adj < strike
    #   CALL: BUY lower strike (more ITM),  SELL higher strike → adj > strike
    # Without this filter calculate_bid would happily price inverted spreads
    # that look like credits on paper but have the wrong risk profile.
    #
    # Audit H1 fix: the Tier 2 bid is now constrained so the per-contract
    # net debit (max_bid − derive_expected) cannot exceed TIER2_MAX_DEBIT_PCT
    # of the strike gap. The old formulation `tier2_value = derive_expected
    # − fees − spread` was always a credit, and the gate
    # `tier2_value <= max_debit + derive_expected` was a tautology.
    adjacents = cache.find_adjacent_strikes(underlying, strike, expiry_ts, option_type)
    for adj in adjacents:
        if option_type == "P" and adj.strike >= strike:
            continue  # Put: only lower adjacent = cheaper = sell leg
        if option_type == "C" and adj.strike <= strike:
            continue  # Call: only higher adjacent = cheaper = sell leg

        ratio, ratio_source = _exec_ratio(adj.instrument, adj.expiry_ts)
        derive_expected = adj.derive_mark * ratio
        strike_gap = abs(strike - adj.strike)
        if strike_gap == 0:
            continue

        # Max debit we're willing to pay on top of the Derive sell income.
        # Spec Section 4 Tier 2: net debit < 25% of strike gap width.
        max_debit = TIER2_MAX_DEBIT_PCT * strike_gap

        # Bid upper bound: pay derive_expected plus the debit budget minus
        # all fees and our minimum spread requirement.
        bid_upper = derive_expected + max_debit
        r_fee = rysk_fee(spot, bid_upper, 1)
        d_fee = derive_taker_fee(spot, 1, derive_expected)
        tier2_value = bid_upper - r_fee - d_fee - min_spread

        if tier2_value > 0:
            return BidResult(
                max_bid=tier2_value * get_tier_weight(2),
                tier=2,
                tier_value=tier2_value,
                confidence=get_tier_weight(2),
                fees={"rysk": rysk_fee(spot, bid_upper, qty),
                      "derive": derive_taker_fee(spot, qty, derive_expected)},
                hedge_instrument=adj.instrument,
                reasoning=(
                    f"Tier 2: buy strike ${strike:.0f} {option_type} / sell "
                    f"{adj.instrument} @ ${adj.derive_mark:.2f}*{ratio:.3f} "
                    f"[{ratio_source}], gap ${strike_gap:.1f}, "
                    f"debit cap ${max_debit:.2f}"
                ),
            )

    # Tier 3: Longer expiry (calendar spread)
    #
    # Audit H2 fix: TIER3_MIN_PREMIUM_RATIO is now actually enforced. Spec
    # Section 6.4: "Net premium > 2x single leg cost". We cap max_bid so
    # derive_expected / max_bid >= TIER3_MIN_PREMIUM_RATIO; if the tier3
    # value computation exceeds that cap we clamp to the cap.
    longer = cache.find_longer_expiry(underlying, strike, expiry_ts, option_type)
    for lg in longer:
        ratio, ratio_source = _exec_ratio(lg.instrument, lg.expiry_ts)
        derive_expected = lg.derive_mark * ratio
        r_fee = rysk_fee(spot, derive_expected, 1)
        d_fee = derive_taker_fee(spot, 1, derive_expected)

        est_roll_cost = r_fee  # rough estimate

        tier3_value = derive_expected - r_fee - d_fee - est_roll_cost - min_spread

        # Apply the premium-ratio cap AFTER tier_weight is applied, so the
        # actual on-wire bid satisfies the spec rule.
        weight = get_tier_weight(3)
        raw_max_bid = tier3_value * weight
        premium_ratio_cap = derive_expected / TIER3_MIN_PREMIUM_RATIO
        max_bid = min(raw_max_bid, premium_ratio_cap)

        if tier3_value > 0 and max_bid > 0:
            return BidResult(
                max_bid=max_bid,
                tier=3,
                tier_value=tier3_value,
                confidence=weight,
                fees={"rysk": rysk_fee(spot, derive_expected, qty),
                      "derive": derive_taker_fee(spot, qty, derive_expected),
                      "est_roll": rysk_fee(spot, derive_expected, qty)},
                hedge_instrument=lg.instrument,
                reasoning=(
                    f"Tier 3: calendar {lg.instrument}, "
                    f"Derive mark ${lg.derive_mark:.2f}*{ratio:.3f} [{ratio_source}], "
                    f"premium-ratio cap ${premium_ratio_cap:.2f}"
                ),
            )

    # Tier 4: Pending migration mode (rare, only for genuinely mispriced Rysk)
    # The max_bid must be <= TIER4_MIN_BS_DISCOUNT * bs_fair, meaning Rysk
    # is at least 25% below theoretical fair value. Otherwise we pass.
    # See docs/OPTIONS_ARB_STRATEGY.md Section 4 Tier 4 for rationale.
    best_iv = _find_best_iv(cache, underlying, strike, expiry_ts, option_type)
    if best_iv is not None and best_iv > 0:
        t_years = max(0, (expiry_ts - time.time()) / (365.25 * 86400))
        if option_type == "P":
            bs_fair = black_scholes_put(spot, strike, t_years, best_iv)
        else:
            bs_fair = black_scholes_call(spot, strike, t_years, best_iv)

        if bs_fair > 0:
            r_fee = rysk_fee(spot, bs_fair, 1)
            # Tier 4 hedge cost: funding + slippage over holding period.
            # Lighter is zero-fee so we budget ~0.5% of notional for
            # funding+slippage over a ~1 week holding period.
            hedge_notional = spot
            hedge_cost = hedge_notional * 0.005

            # The max we're willing to bid, after requiring the 0.75 discount
            tier4_value = bs_fair * TIER4_MIN_BS_DISCOUNT - r_fee - hedge_cost

            # Tier 4 decision logging (for calibration dataset)
            _log_tier4_bid_decision({
                "underlying": underlying,
                "strike": strike,
                "expiry_ts": expiry_ts,
                "option_type": option_type,
                "qty": qty,
                "spot": spot,
                "bs_fair": bs_fair,
                "iv": best_iv,
                "discount_threshold": TIER4_MIN_BS_DISCOUNT,
                "tier4_value": tier4_value,
                "would_bid": tier4_value > 0,
            })

            if tier4_value > 0:
                return BidResult(
                    max_bid=tier4_value * get_tier_weight(4),
                    tier=4,
                    tier_value=tier4_value,
                    confidence=get_tier_weight(4),
                    fees={"rysk": rysk_fee(spot, bs_fair, qty),
                          "hedge_budget": hedge_cost * qty},
                    hedge_instrument=f"{underlying}-PERP",
                    reasoning=f"Tier 4 (pending migration): BS fair ${bs_fair:.2f}, "
                              f"max bid at {TIER4_MIN_BS_DISCOUNT:.0%} discount, "
                              f"IV {best_iv:.0%}",
                )

    return None


def _log_tier4_bid_decision(payload: dict):
    """Append a Tier 4 bid-time decision to the decisions log."""
    import json
    import os
    from scripts.arb.config import TIER4_DECISIONS_LOG

    os.makedirs(os.path.dirname(TIER4_DECISIONS_LOG) or ".", exist_ok=True)
    entry = {
        "timestamp": time.time(),
        "event_type": "bid",
        **payload,
    }
    try:
        with open(TIER4_DECISIONS_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # Logging shouldn't break bidding


def _find_best_iv(
    cache: MarkCache,
    underlying: str,
    strike: float,
    expiry_ts: int,
    option_type: str,
) -> Optional[float]:
    """Find the best IV estimate from cached instruments."""
    # Try exact match first
    exact = cache.find_exact_match(underlying, strike, expiry_ts, option_type)
    if exact and exact.iv > 0:
        return exact.iv

    # Try adjacent strikes
    for adj in cache.find_adjacent_strikes(underlying, strike, expiry_ts, option_type):
        if adj.iv > 0:
            return adj.iv

    # Try any instrument for this underlying
    for mark in cache._marks.values():
        if mark.underlying == underlying and not mark.is_stale and mark.iv > 0:
            return mark.iv

    return None


# ---------------------------------------------------------------------------
# Position limit checker
# ---------------------------------------------------------------------------

def check_limits(
    bid: BidResult,
    qty: float,
    spot: float,
    cache: MarkCache,
    current_positions: list[dict],
    underlying: str,
    account_equity: float,
    account_current_im: float,
) -> tuple[bool, str]:
    """Validate a bid against position limits before accepting.

    Checks enforced (per spec Section 7):
    - Max single position (premium notional)
    - Max open positions count
    - Max per underlying (premium notional)
    - Max total premium notional (account-level)
    - Max Derive IM utilization (50% of account equity)
    - Max unhedged inventory (Tier 4 only)

    Returns (allowed, reason).
    """
    premium_notional = bid.max_bid * qty

    # Max single position
    if premium_notional > MAX_SINGLE_POSITION:
        return False, f"Single position ${premium_notional:.0f} exceeds max ${MAX_SINGLE_POSITION}"

    # Count open positions
    open_count = len(current_positions)
    if open_count >= MAX_OPEN_POSITIONS:
        return False, f"Already at max {MAX_OPEN_POSITIONS} open positions"

    # Per-underlying limit
    underlying_notional = sum(
        p.get("premium_notional", 0)
        for p in current_positions
        if p.get("underlying") == underlying
    )
    if underlying_notional + premium_notional > MAX_PER_UNDERLYING:
        return False, (
            f"Per-underlying {underlying}: ${underlying_notional + premium_notional:.0f} "
            f"exceeds ${MAX_PER_UNDERLYING}"
        )

    # Total premium notional (account-level, across all positions)
    total_premium = sum(p.get("premium_notional", 0) for p in current_positions)
    if total_premium + premium_notional > MAX_OPTIONS_CAPITAL:
        return False, (
            f"Total premium notional ${total_premium + premium_notional:.0f} "
            f"exceeds max ${MAX_OPTIONS_CAPITAL}"
        )

    # Derive IM utilization: max 50% of account equity.
    # Audit M5 fix: get_margin returns None when compute_margin is down.
    # We refuse to size against an unknown margin rather than treating it
    # as zero (which would rubber-stamp the check).
    new_im = cache.get_margin(bid.hedge_instrument, qty)
    if new_im is None:
        return False, (
            f"Derive compute_margin unavailable for {bid.hedge_instrument}; "
            "refusing to size without known IM"
        )
    projected_util = (account_current_im + new_im) / account_equity if account_equity > 0 else 1.0
    if projected_util > MAX_MARGIN_UTILIZATION:
        return False, (
            f"Derive IM utilization {projected_util:.0%} exceeds max {MAX_MARGIN_UTILIZATION:.0%} "
            f"(current IM ${account_current_im:.0f} + new ${new_im:.0f} vs equity ${account_equity:.0f})"
        )

    # Unhedged inventory check
    if bid.tier == 4:
        unhedged = sum(
            p.get("premium_notional", 0)
            for p in current_positions
            if p.get("hedge_status") in ("unhedged", "perp_backstop")
        )
        if unhedged + premium_notional > MAX_UNHEDGED_INVENTORY:
            return False, (
                f"Unhedged inventory ${unhedged + premium_notional:.0f} "
                f"exceeds max ${MAX_UNHEDGED_INVENTORY}"
            )

    return True, "OK"
