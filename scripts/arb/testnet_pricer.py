"""Testnet fallback pricer.

On mainnet, calculate_bid uses Derive marks + ratio cache. On Base Sepolia
testnet there is no Derive data for WETH/WBTC options, so we need a
substitute pricer to exercise the bid code path.

Design principles for testnet:
- Deliberately CONSERVATIVE - we don't want to win quotes, we want to test
  code paths. A too-aggressive pricer accumulates positions we'd then have
  to settle, which adds operational risk without information value.
- Simple and auditable - BS fair value * fixed discount factor
- Spot price pulled from a trusted source (CoinGecko, Coinbase, or a
  Base Sepolia oracle if one is live)
- IV fixed at a sensible testnet value (80% is typical for crypto options)
- Every bid computation logged with inputs/outputs for Rysk team review

This pricer is ONLY called when env=testnet. Mainnet flow stays on
Derive + ratio cache.
"""

import json
import math
import os
import time
from dataclasses import dataclass
from typing import Optional

import requests

from scripts.arb.pricing import (
    BidResult,
    black_scholes_call,
    black_scholes_put,
    derive_taker_fee,
    rysk_fee,
)
from scripts.arb.rysk_client import RyskRequest


# Fixed testnet configuration. All hardcoded because we want determinism
# during error testing - no "is it broken or did the market move?" ambiguity.
TESTNET_IV = float(os.environ.get("TESTNET_IV", "0.80"))  # 80% IV, reasonable for crypto
# Bid at 50% of BS fair value by default (deliberately conservative).
# Override with TESTNET_BID_DISCOUNT=0.98 env var to force wins during trade-path
# testing. Never commit an override; this is deliberately non-competitive in normal runs.
TESTNET_BID_DISCOUNT = float(os.environ.get("TESTNET_BID_DISCOUNT", "0.50"))
TESTNET_RISK_FREE = 0.05
TESTNET_BID_LOG = "data/testnet-bid-decisions.jsonl"

# Spot price cache to avoid hammering external APIs
_spot_cache: dict[str, tuple[float, float]] = {}  # symbol -> (price, timestamp)
_SPOT_MAX_AGE = 30  # seconds


def get_spot_testnet(underlying: str) -> Optional[float]:
    """Fetch a reasonable spot price for a testnet underlying.

    Uses Coinbase as the primary source (free, no auth) and falls back
    to a static default if the API fails. Results are cached for 30s.
    """
    now = time.time()
    cached = _spot_cache.get(underlying)
    if cached and now - cached[1] < _SPOT_MAX_AGE:
        return cached[0]

    symbol_map = {
        "WETH": "ETH-USD",
        "WBTC": "BTC-USD",
        "ETH": "ETH-USD",
        "BTC": "BTC-USD",
        "HYPE": "HYPE-USD",
    }
    # Hardcoded fallbacks in case API fails (updated occasionally - these are
    # just sanity defaults, not accurate prices)
    fallback = {
        "WETH": 2000.0,
        "WBTC": 65000.0,
        "ETH": 2000.0,
        "BTC": 65000.0,
        "HYPE": 37.0,
    }
    sym = symbol_map.get(underlying, underlying)

    try:
        r = requests.get(
            f"https://api.coinbase.com/v2/prices/{sym}/spot",
            timeout=5,
        )
        if r.status_code == 200:
            data = r.json()
            price = float(data["data"]["amount"])
            _spot_cache[underlying] = (price, now)
            return price
    except Exception as e:
        print(f"[testnet pricer] Coinbase fetch failed for {sym}: {e}")

    price = fallback.get(underlying)
    if price:
        _spot_cache[underlying] = (price, now)
    return price


def calculate_testnet_bid(
    request: RyskRequest,
    iv: float = TESTNET_IV,
    discount: float = TESTNET_BID_DISCOUNT,
) -> Optional[BidResult]:
    """Compute a simple BS-based bid for a testnet RFQ.

    Returns a BidResult with tier=4 (delta-hedged in mainnet terms) since
    we have no Derive hedge on Base Sepolia. The "hedge" is notional - we
    just buy and hold to settlement on testnet.

    Returns None if:
    - Can't fetch spot price
    - Expiry is in the past
    - BS fair value is zero
    - Final bid is below min threshold
    """
    underlying = request.asset_name
    strike = request.strike_float
    qty = request.quantity_float
    option_type = request.option_type
    expiry_ts = request.expiry

    spot = get_spot_testnet(underlying)
    if spot is None:
        _log_bid({
            "rfq_id": request.request_id,
            "decision": "skip_no_spot",
            "underlying": underlying,
        })
        return None

    t_years = max(0, (expiry_ts - time.time()) / (365.25 * 86400))
    if t_years <= 0:
        _log_bid({
            "rfq_id": request.request_id,
            "decision": "skip_expired",
            "underlying": underlying,
            "expiry": expiry_ts,
        })
        return None

    # BS fair value
    if option_type == "P":
        bs_fair = black_scholes_put(spot, strike, t_years, iv, TESTNET_RISK_FREE)
    else:
        bs_fair = black_scholes_call(spot, strike, t_years, iv, TESTNET_RISK_FREE)

    if bs_fair <= 0:
        _log_bid({
            "rfq_id": request.request_id,
            "decision": "skip_zero_bs",
            "spot": spot, "strike": strike, "bs_fair": bs_fair,
        })
        return None

    # Fees (conservative estimates)
    r_fee_pc = rysk_fee(spot, bs_fair, 1)
    d_fee_pc = 0  # No Derive on testnet

    # Our bid: conservatively discounted BS fair minus fees
    # This is the MAX we'd pay per contract
    max_bid_pc = bs_fair * discount - r_fee_pc - d_fee_pc

    if max_bid_pc <= 0:
        _log_bid({
            "rfq_id": request.request_id,
            "decision": "skip_unprofitable",
            "spot": spot, "strike": strike,
            "bs_fair": bs_fair, "max_bid_pc": max_bid_pc,
        })
        return None

    result = BidResult(
        max_bid=max_bid_pc,
        tier=4,  # No real hedge on testnet
        tier_value=max_bid_pc,
        confidence=discount,
        fees={
            "rysk": r_fee_pc * qty,
            "derive": 0,
        },
        hedge_instrument=f"{underlying}-TESTNET-NOHEDGE",
        reasoning=(
            f"Testnet BS: spot=${spot:.2f} strike=${strike:.2f} "
            f"iv={iv:.0%} t={t_years*365:.0f}d BS=${bs_fair:.2f} "
            f"bid=${max_bid_pc:.4f} ({discount:.0%} discount)"
        ),
    )

    _log_bid({
        "rfq_id": request.request_id,
        "decision": "bid_computed",
        "underlying": underlying,
        "strike": strike,
        "option_type": option_type,
        "expiry": expiry_ts,
        "spot": spot,
        "iv": iv,
        "bs_fair": bs_fair,
        "discount": discount,
        "max_bid_pc": max_bid_pc,
        "qty": qty,
        "rysk_fee": r_fee_pc * qty,
    })

    return result


def _log_bid(payload: dict):
    """Write a bid decision to the testnet bid log."""
    os.makedirs(os.path.dirname(TESTNET_BID_LOG) or ".", exist_ok=True)
    entry = {
        "timestamp": time.time(),
        **payload,
    }
    try:
        with open(TESTNET_BID_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # Logging must never break bidding
