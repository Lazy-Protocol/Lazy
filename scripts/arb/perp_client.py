"""Perp exchange client abstraction.

Used by Tier 4 delta hedging and HYPE perp backstop. We prefer
zero-fee venues (Lighter) for HYPE since the native Hyperliquid
depth is only marginally better for our modest sizes and the fee
drag compounds across hundreds of trades.

Architecture:
- `PerpClient` abstract base class defines the operations we need
- `LighterPerpClient` implements Lighter.xyz (zero-fee, zkLighter L2)
- Future: `HyperliquidPerpClient` for builder-code rebates

Usage from `derive_om.py`:
    from scripts.arb.perp_client import get_perp_client
    client = get_perp_client("HYPE")
    result = client.open_short("HYPE", size=150)
    if result["success"]:
        ...

All methods are SYNCHRONOUS (the rest of arb/ is sync). The Lighter
SDK is async so LighterPerpClient wraps calls with asyncio.run().
"""

import asyncio
import os
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

from scripts.arb.config import (
    PERP_DEFAULT_URGENCY,
    PERP_SIGN_PRECISION,
    PERP_URGENCY_PROFILES,
    PERP_VENUE,
)


# ---------------------------------------------------------------------------
# Lighter market specs (ported from trendtradingstrategyv1)
# ---------------------------------------------------------------------------

LIGHTER_MARKETS = {
    "BTC":  {"market_id": 1,   "price_decimals": 1, "size_decimals": 5},
    "ETH":  {"market_id": 0,   "price_decimals": 2, "size_decimals": 4},
    "SOL":  {"market_id": 2,   "price_decimals": 3, "size_decimals": 3},
    "HYPE": {"market_id": 24,  "price_decimals": 4, "size_decimals": 2},
}

LIGHTER_URL = "https://mainnet.zklighter.elliot.ai"


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------

@dataclass
class PerpOrderResult:
    success: bool
    filled_size: float
    avg_price: float
    venue: str
    order_id: str = ""
    error: str = ""

    def to_dict(self) -> dict:
        return {
            "success": self.success,
            "filled_size": self.filled_size,
            "avg_price": self.avg_price,
            "venue": self.venue,
            "order_id": self.order_id,
            "error": self.error,
        }


@dataclass
class PerpPosition:
    symbol: str
    size: float          # Absolute (always positive)
    side: str            # "LONG" or "SHORT"
    entry_price: float
    unrealized_pnl: float
    venue: str

    @property
    def signed_size(self) -> float:
        return self.size if self.side == "LONG" else -self.size


class PerpClient(ABC):
    """Abstract perp exchange client.

    Any venue implementing these methods can be plugged in per-underlying
    via the PERP_VENUE config map.
    """

    @property
    @abstractmethod
    def venue(self) -> str:
        """Venue name (e.g., 'lighter', 'hyperliquid')."""

    @abstractmethod
    def get_mark_price(self, symbol: str) -> Optional[float]:
        """Current mark price for the symbol, or None if unavailable."""

    @abstractmethod
    def get_position(self, symbol: str) -> Optional[PerpPosition]:
        """Current perp position for the symbol, or None if no position."""

    @abstractmethod
    def open_short(
        self, symbol: str, size: float, urgency: str = PERP_DEFAULT_URGENCY,
    ) -> PerpOrderResult:
        """Open or increase a short position.

        urgency: "urgent" | "patient" | "routine"
          urgent  - speed critical (Rysk post-win hedge), ~6s total
          patient - balanced (migration close), ~40s total, mostly limits
          routine - very patient (rebalance), ~90s total, tight slippage
        """

    @abstractmethod
    def open_long(
        self, symbol: str, size: float, urgency: str = PERP_DEFAULT_URGENCY,
    ) -> PerpOrderResult:
        """Open or increase a long position. See open_short for urgency."""

    @abstractmethod
    def close_position(
        self,
        symbol: str,
        size: Optional[float] = None,
        urgency: str = PERP_DEFAULT_URGENCY,
    ) -> PerpOrderResult:
        """Close (or partially close) an existing position.

        If size is None, close the full position.
        Defaults to 'patient' urgency since closing is rarely time-critical.
        Migration close uses 'patient'; kill-switch emergencies use 'urgent'.
        """

    def hedge_delta(
        self, symbol: str, delta: float, urgency: str = "urgent",
    ) -> PerpOrderResult:
        """Open a perp position to hedge a given delta exposure.

        delta > 0 -> open short. delta < 0 -> open long.
        Defaults to 'urgent' since this is called post-Rysk-win where
        speed matters (15s window before we're considered unhedged).
        """
        size = abs(delta)
        if delta > 0:
            return self.open_short(symbol, size, urgency=urgency)
        elif delta < 0:
            return self.open_long(symbol, size, urgency=urgency)
        return PerpOrderResult(
            success=True, filled_size=0, avg_price=0, venue=self.venue,
            error="zero delta, no hedge needed",
        )


# ---------------------------------------------------------------------------
# Lighter implementation
# ---------------------------------------------------------------------------

class LighterPerpClient(PerpClient):
    """Lighter.xyz perp client (zero trading fees on standard accounts).

    Uses post-only limit orders with market fallback for execution.
    All methods are synchronous externally; internally wraps async
    SDK calls via asyncio.run().

    Auth env vars (from AYP .env):
      LIGHTER_API_KEY       - signer private key (hex)
      LIGHTER_ACCOUNT_INDEX - account index
      LIGHTER_API_KEY_INDEX - API key index
    """

    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run
        self._signer = None
        self._order_counter = int(time.time() * 1000)

        # Load env (the same way derive_om.py does)
        self._load_dotenv()

        self.private_key = os.environ.get("LIGHTER_API_KEY", "")
        # Audit M6 fix: use None sentinel for missing account_index so
        # _get_signer can distinguish "unset" from "legitimately zero".
        raw_idx = os.environ.get("LIGHTER_ACCOUNT_INDEX", "")
        raw_key_idx = os.environ.get("LIGHTER_API_KEY_INDEX", "0")
        try:
            self.account_index = int(raw_idx) if raw_idx != "" else None
            self.api_key_index = int(raw_key_idx)
        except (ValueError, TypeError):
            self.account_index = None
            self.api_key_index = 0

    @staticmethod
    def _load_dotenv():
        """Load .env from project root into os.environ (same as derive_om)."""
        env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
        env_path = os.path.abspath(env_path)
        if not os.path.exists(env_path):
            return
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key, value = key.strip(), value.strip()
                if not os.environ.get(key):
                    os.environ[key] = value

    @property
    def venue(self) -> str:
        return "lighter"

    def _get_signer(self):
        """Lazy-init the Lighter SignerClient."""
        if self._signer is not None:
            return self._signer
        if self.dry_run:
            return None
        # Audit M6 fix: account_index can legitimately be 0. Use explicit
        # None check instead of truthiness (0 is falsy).
        if not self.private_key or self.account_index is None:
            raise RuntimeError(
                "Lighter credentials missing. Set LIGHTER_API_KEY, "
                "LIGHTER_ACCOUNT_INDEX, LIGHTER_API_KEY_INDEX in .env"
            )
        import lighter
        self._signer = lighter.SignerClient(
            url=LIGHTER_URL,
            account_index=self.account_index,
            api_private_keys={self.api_key_index: self.private_key},
        )
        return self._signer

    def get_mark_price(self, symbol: str) -> Optional[float]:
        """Fetch mark price as mid of best bid/ask via REST.

        Lighter's orderBookOrders endpoint gives top-of-book. We use the
        midpoint as mark. Falls back to last trade price if book is empty.
        """
        import requests

        spec = LIGHTER_MARKETS.get(symbol)
        if not spec:
            return None

        market_id = spec["market_id"]

        try:
            # Primary: midpoint of best bid/ask
            url = f"{LIGHTER_URL}/api/v1/orderBookOrders?market_id={market_id}&limit=1"
            resp = requests.get(url, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                asks = data.get("asks", [])
                bids = data.get("bids", [])
                if asks and bids:
                    best_ask = float(asks[0].get("price", 0))
                    best_bid = float(bids[0].get("price", 0))
                    if best_ask > 0 and best_bid > 0:
                        return (best_ask + best_bid) / 2
                # Fallback: just ask if only one side
                if asks:
                    return float(asks[0].get("price", 0))
                if bids:
                    return float(bids[0].get("price", 0))
        except Exception as e:
            print(f"[lighter] orderBookOrders error: {e}")

        try:
            # Fallback: most recent trade price
            url = f"{LIGHTER_URL}/api/v1/recentTrades?market_id={market_id}&limit=1"
            resp = requests.get(url, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                trades = data.get("trades", [])
                if trades:
                    return float(trades[0].get("price", 0))
        except Exception:
            pass

        return None

    def get_top_of_book(self, symbol: str) -> Optional[tuple[float, float]]:
        """Return (best_bid, best_ask) for this symbol or None."""
        import requests

        spec = LIGHTER_MARKETS.get(symbol)
        if not spec:
            return None
        market_id = spec["market_id"]

        try:
            url = f"{LIGHTER_URL}/api/v1/orderBookOrders?market_id={market_id}&limit=1"
            resp = requests.get(url, timeout=10)
            if resp.status_code != 200:
                return None
            data = resp.json()
            asks = data.get("asks", [])
            bids = data.get("bids", [])
            if not asks or not bids:
                return None
            best_ask = float(asks[0].get("price", 0))
            best_bid = float(bids[0].get("price", 0))
            if best_ask <= 0 or best_bid <= 0:
                return None
            return (best_bid, best_ask)
        except Exception:
            return None

    def get_position(self, symbol: str) -> Optional[PerpPosition]:
        """Fetch current position via REST account endpoint."""
        import requests

        if self.dry_run:
            return None

        try:
            url = f"{LIGHTER_URL}/api/v1/account?by=index&value={self.account_index}"
            resp = requests.get(url, timeout=10)
            if resp.status_code != 200:
                return None

            data = resp.json()
            accounts = data.get("accounts", [])
            if not accounts:
                return None

            for pos in accounts[0].get("positions", []):
                if pos.get("symbol") != symbol:
                    continue
                size = float(pos.get("position", "0"))
                if abs(size) < 10 ** -PERP_SIGN_PRECISION:
                    return None
                sign = pos.get("sign", 1)
                side = "SHORT" if sign == -1 else "LONG"
                return PerpPosition(
                    symbol=symbol,
                    size=abs(size),
                    side=side,
                    entry_price=float(pos.get("avg_entry_price", "0")),
                    unrealized_pnl=float(pos.get("unrealized_pnl", "0")),
                    venue=self.venue,
                )
        except Exception as e:
            print(f"[lighter] get_position error: {e}")
            return None

        return None

    def _place_order_sync(
        self, symbol: str, side: str, size: float,
        urgency: str = PERP_DEFAULT_URGENCY,
    ) -> PerpOrderResult:
        """Synchronous wrapper around the async create_order flow.

        Urgency profile determines chase attempts, wait time, and slippage cap.
        See PERP_URGENCY_PROFILES in config.py.
        """
        spec = LIGHTER_MARKETS.get(symbol)
        if not spec:
            return PerpOrderResult(
                success=False, filled_size=0, avg_price=0,
                venue=self.venue, error=f"Unknown symbol {symbol}",
            )

        profile = PERP_URGENCY_PROFILES.get(urgency, PERP_URGENCY_PROFILES[PERP_DEFAULT_URGENCY])

        if self.dry_run:
            mark = self.get_mark_price(symbol) or 0
            print(f"[lighter DRY_RUN {urgency}] {side} {size} {symbol} @ ~${mark:.4f}")
            return PerpOrderResult(
                success=True, filled_size=size, avg_price=mark, venue=self.venue,
                error="dry_run",
            )

        try:
            return asyncio.run(
                self._async_place_order(symbol, side, size, spec, profile, urgency)
            )
        except Exception as e:
            return PerpOrderResult(
                success=False, filled_size=0, avg_price=0,
                venue=self.venue, error=str(e),
            )

    async def _async_place_order(
        self, symbol: str, side: str, size: float, spec: dict,
        profile: dict, urgency: str,
    ) -> PerpOrderResult:
        """Async order placement with post-only -> market fallback.

        HYPE is mean-reverting so patient limits usually fill. Market
        fallback only fires if limit chase exhausts AND cumulative fills
        (verified by polling account position) stay below 50% of target.

        Audit C3/C4 fix: earlier drafts assumed `create_order` success
        meant the order filled, and the `break` after that assumption made
        the market fallback unreachable. This version polls
        `get_position` after each chase attempt to measure the actual
        signed delta vs a pre-order baseline, so fill accounting reflects
        reality and the market fallback is actually reachable.
        """
        import lighter

        signer = self._get_signer()
        market_id = spec["market_id"]
        price_decimals = spec["price_decimals"]
        size_decimals = spec["size_decimals"]
        tick_size = 10 ** -price_decimals

        chase_attempts = profile["chase_attempts"]
        chase_wait = profile["chase_wait_seconds"]
        max_slippage = profile["market_slippage_pct"]
        limit_offset = profile["limit_offset_ticks"]

        is_ask = (side == "SHORT")
        base_amount = int(size * (10 ** size_decimals))
        if base_amount <= 0:
            return PerpOrderResult(
                success=False, filled_size=0, avg_price=0, venue=self.venue,
                error="size too small for market precision",
            )

        # Get top of book for post-only pricing
        top = self.get_top_of_book(symbol)
        if top is None:
            return PerpOrderResult(
                success=False, filled_size=0, avg_price=0, venue=self.venue,
                error="could not fetch order book",
            )
        best_bid, best_ask = top
        mark = (best_bid + best_ask) / 2

        def _signed_position(pos) -> float:
            """Convert PerpPosition to a signed magnitude (positive=LONG)."""
            if pos is None:
                return 0.0
            return pos.size if pos.side == "LONG" else -pos.size

        # Baseline position snapshot. Our fills are measured as the signed
        # delta from this baseline to the current signed position.
        baseline_signed = _signed_position(self.get_position(symbol))

        def _fill_delta() -> float:
            """Total filled size (positive) in the direction of this order."""
            current = _signed_position(self.get_position(symbol))
            delta = current - baseline_signed
            return -delta if is_ask else delta

        confirmed_filled = 0.0
        total_value = 0.0  # Weighted sum for avg price calculation

        for attempt in range(chase_attempts):
            remaining = size - confirmed_filled
            if remaining < size * 0.01:
                break

            # Refresh top of book each attempt
            fresh = self.get_top_of_book(symbol)
            if fresh:
                best_bid, best_ask = fresh

            # POST-ONLY pricing. limit_offset = 0 means midpoint-ish
            # (just outside the spread so post-only is accepted), higher
            # values chase into the spread more aggressively.
            if is_ask:  # SHORT: sell at bid + offset*tick
                post_price = best_bid + (limit_offset + 1) * tick_size
            else:  # LONG: buy at ask - offset*tick
                post_price = best_ask - (limit_offset + 1) * tick_size

            scaled_price = int(round(post_price * (10 ** price_decimals)))
            self._order_counter += 1
            client_order_id = self._order_counter

            order_accepted = False
            try:
                order, response, error = await signer.create_order(
                    market_index=market_id,
                    client_order_index=client_order_id,
                    base_amount=int(remaining * (10 ** size_decimals)),
                    price=scaled_price,
                    is_ask=is_ask,
                    order_type=lighter.SignerClient.ORDER_TYPE_LIMIT,
                    time_in_force=lighter.SignerClient.ORDER_TIME_IN_FORCE_POST_ONLY,
                    reduce_only=False,
                    trigger_price=0,
                )
                if error:
                    print(f"[lighter] chase attempt {attempt+1}: order error: {error}")
                else:
                    order_accepted = True
            except Exception as e:
                print(f"[lighter] chase attempt {attempt+1}: place exception: {e}")

            if not order_accepted:
                continue

            # Wait for the post-only order to rest and (hopefully) get hit
            await asyncio.sleep(chase_wait)

            # Measure real fill progress by polling the account position
            filled_so_far = _fill_delta()
            new_fill_this_attempt = max(0.0, filled_so_far - confirmed_filled)
            if new_fill_this_attempt > 0:
                # Weight the per-attempt fill by the limit price we posted.
                # This is an approximation; the exchange doesn't expose the
                # exact trade print to us here, but for a post-only order
                # the fill price is our posted price at worst by one tick.
                total_value += new_fill_this_attempt * post_price
                confirmed_filled = filled_so_far

            if confirmed_filled >= size * 0.99:
                break

        # Phase 2: market fallback (only if limits genuinely didn't fill)
        if confirmed_filled < size * 0.5:
            remaining = size - confirmed_filled
            max_slip_dollars = mark * max_slippage
            slip_price = mark + max_slip_dollars if is_ask else mark - max_slip_dollars
            scaled_slip = int(round(slip_price * (10 ** price_decimals)))
            self._order_counter += 1

            try:
                _, _, err = await signer.create_order(
                    market_index=market_id,
                    client_order_index=self._order_counter,
                    base_amount=int(remaining * (10 ** size_decimals)),
                    price=scaled_slip,
                    is_ask=is_ask,
                    order_type=lighter.SignerClient.ORDER_TYPE_MARKET,
                    time_in_force=lighter.SignerClient.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
                    reduce_only=False,
                    trigger_price=0,
                )
                if err:
                    print(f"[lighter] market fallback error: {err}")
                # Give the IOC order a moment to either fill or cancel,
                # then re-query the position to see what actually landed.
                await asyncio.sleep(1.0)
                filled_so_far = _fill_delta()
                new_fill = max(0.0, filled_so_far - confirmed_filled)
                if new_fill > 0:
                    total_value += new_fill * slip_price
                    confirmed_filled = filled_so_far
            except Exception as e:
                print(f"[lighter] market fallback exception: {e}")

        avg_price = total_value / confirmed_filled if confirmed_filled > 0 else 0
        # Success threshold: at least 50% of target filled. Callers that need
        # tighter guarantees should check `filled_size` directly.
        return PerpOrderResult(
            success=confirmed_filled >= size * 0.5,
            filled_size=confirmed_filled,
            avg_price=avg_price,
            venue=self.venue,
            error=(
                None if confirmed_filled >= size * 0.5
                else f"filled {confirmed_filled:.4f} / {size:.4f} after chase + market fallback"
            ),
        )

    def open_short(
        self, symbol: str, size: float, urgency: str = PERP_DEFAULT_URGENCY,
    ) -> PerpOrderResult:
        return self._place_order_sync(symbol, "SHORT", size, urgency)

    def open_long(
        self, symbol: str, size: float, urgency: str = PERP_DEFAULT_URGENCY,
    ) -> PerpOrderResult:
        return self._place_order_sync(symbol, "LONG", size, urgency)

    def close_position(
        self, symbol: str, size: Optional[float] = None,
        urgency: str = PERP_DEFAULT_URGENCY,
    ) -> PerpOrderResult:
        """Close full or partial position.

        Defaults to 'patient' urgency since closing is rarely time-critical.
        Migration close uses 'patient' (40s window); kill-switch emergencies
        should override to 'urgent' explicitly.
        """
        pos = self.get_position(symbol)
        if pos is None:
            return PerpOrderResult(
                success=True, filled_size=0, avg_price=0, venue=self.venue,
                error="no position to close",
            )

        close_size = size if size is not None else pos.size
        close_size = min(close_size, pos.size)

        # To close LONG, sell (open short direction)
        # To close SHORT, buy (open long direction)
        if pos.side == "LONG":
            return self._place_order_sync(symbol, "SHORT", close_size, urgency)
        else:
            return self._place_order_sync(symbol, "LONG", close_size, urgency)


# ---------------------------------------------------------------------------
# Null client (dry run)
# ---------------------------------------------------------------------------

class NoopPerpClient(PerpClient):
    """Paper/dry-run client that logs intent without placing orders."""

    def __init__(self):
        self._positions: dict[str, PerpPosition] = {}

    @property
    def venue(self) -> str:
        return "noop"

    def get_mark_price(self, symbol: str) -> Optional[float]:
        return None

    def get_position(self, symbol: str) -> Optional[PerpPosition]:
        return self._positions.get(symbol)

    def open_short(
        self, symbol: str, size: float, urgency: str = PERP_DEFAULT_URGENCY,
    ) -> PerpOrderResult:
        print(f"[noop {urgency}] SHORT {size} {symbol}")
        self._positions[symbol] = PerpPosition(
            symbol=symbol, size=size, side="SHORT",
            entry_price=0, unrealized_pnl=0, venue="noop",
        )
        return PerpOrderResult(
            success=True, filled_size=size, avg_price=0, venue="noop",
        )

    def open_long(
        self, symbol: str, size: float, urgency: str = PERP_DEFAULT_URGENCY,
    ) -> PerpOrderResult:
        print(f"[noop {urgency}] LONG {size} {symbol}")
        self._positions[symbol] = PerpPosition(
            symbol=symbol, size=size, side="LONG",
            entry_price=0, unrealized_pnl=0, venue="noop",
        )
        return PerpOrderResult(
            success=True, filled_size=size, avg_price=0, venue="noop",
        )

    def close_position(
        self, symbol: str, size: Optional[float] = None,
        urgency: str = PERP_DEFAULT_URGENCY,
    ) -> PerpOrderResult:
        pos = self._positions.get(symbol)
        if pos is None:
            return PerpOrderResult(
                success=True, filled_size=0, avg_price=0, venue="noop",
                error="no position",
            )
        close_size = size if size is not None else pos.size
        print(f"[noop] CLOSE {close_size} {symbol} ({pos.side})")
        if close_size >= pos.size:
            del self._positions[symbol]
        else:
            pos.size -= close_size
        return PerpOrderResult(
            success=True, filled_size=close_size, avg_price=0, venue="noop",
        )


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

_clients: dict[str, PerpClient] = {}


def get_perp_client(underlying: str, dry_run: bool = False) -> PerpClient:
    """Return the configured PerpClient for the given underlying.

    Reads PERP_VENUE from config. Caches client instances per venue
    so the Lighter signer is initialized only once.
    """
    if dry_run:
        return NoopPerpClient()

    venue = PERP_VENUE.get(underlying, "lighter")
    if venue in _clients:
        return _clients[venue]

    if venue == "lighter":
        client = LighterPerpClient()
    elif venue == "noop":
        client = NoopPerpClient()
    else:
        raise ValueError(f"Unknown perp venue: {venue}")

    _clients[venue] = client
    return client
