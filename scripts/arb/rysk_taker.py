"""Rysk V12 taker client (testnet self-testing only).

The official Rysk SDKs (Go CLI, Python, TypeScript) are all maker-only.
Takers normally submit RFQs through the web UI at app.rysk.finance.

For automated self-testing on testnet, we reverse-engineered the taker
protocol by probing `wss://rip-testnet.rysk.finance` directly:

- Endpoint: `wss://rip-testnet.rysk.finance/taker`
- JSON-RPC method: `request`
- Params: the Request struct from the Buyers Club docs
- `quantity` in e18, `strike` in e8

This module implements a minimal async taker client we can use to:
1. Submit randomized RFQs to our own maker bot on testnet
2. Verify the full end-to-end loop works
3. Stress-test edge cases

NOT for mainnet use. On mainnet, takers go through the web UI and
automated taking would require proper onboarding with Rysk.

See `memory/rysk-testnet-protocol-discoveries.md` for the full protocol
reference and error catalog.
"""

import asyncio
import json
import os
import random
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

import websockets


TAKER_ENDPOINT_TESTNET = "wss://rip-testnet.rysk.finance/taker"
# Lowercase canonical. Rysk server does byte-exact compares on the asset
# fields, so every hop (subscription URL, RFQ payload, quote payload) must
# use the same case. We chose lowercase everywhere.
USDC_TESTNET = "0x98d56648c9b7f3cb49531f4135115b5000ab1733"
WETH_TESTNET = "0xb67bfa7b488df4f2efa874f4e59242e9130ae61f"
WBTC_TESTNET = "0x0cb970511c6c3491dc36f1b7774743da3fc4335f"


# ---------------------------------------------------------------------------
# Listed products snapshot
#
# Rysk testnet listings change over time (strikes get added / removed as
# expiries roll). Re-scan with `python -m scripts.arb.cli rysk-scan-products`
# before running tests and update this snapshot. Last refreshed: Apr 7, 2026
# (post-lowercase-fix snapshot, day after expiry rotation).
# ---------------------------------------------------------------------------

# Expiry UTC timestamps (Friday 8am UTC)
EXPIRY_APR10 = 1775808000
EXPIRY_APR17 = 1776412800
EXPIRY_APR24 = 1777017600

LISTED_PRODUCTS_SNAPSHOT = {
    # (asset_name, asset_address, expiry, strike_usd)
    "WETH": {
        EXPIRY_APR10: [1900, 2100, 2300],
        EXPIRY_APR17: [1700, 1800, 1900, 2300, 2400],
        EXPIRY_APR24: [1600, 1700, 2200, 2600],  # 2000 false positive in scanner
    },
    "WBTC": {
        EXPIRY_APR10: [64000, 66000, 72000],
        EXPIRY_APR17: [58000, 60000, 64000, 70000, 76000],
        EXPIRY_APR24: [56000, 58000, 62000, 70000, 74000, 78000],
    },
}

ASSET_ADDRESSES = {
    "WETH": WETH_TESTNET,
    "WBTC": WBTC_TESTNET,
}

# Trade size constraints per asset (testnet, April 2026)
# Values are in HUNDREDTHS of the underlying (i.e. 0.01 increments)
# so the actual quantity is (value_in_hundredths * 1e16)
ASSET_SIZE_LIMITS = {
    # asset_name: (min_hundredths, max_hundredths)
    "WETH": (1, 1000),      # 0.01 to 10.0, step 0.01
    "WBTC": (1, 50),        # 0.01 to 0.5, step 0.01 (2.0 rejected)
}

# Quantity increment base: 0.01 = 10^16 wei-style units (1e18 / 100)
QUANTITY_STEP_E18 = 10 ** 16


@dataclass
class TakerRequest:
    """A randomized taker RFQ for testnet self-testing."""
    asset: str
    asset_name: str
    chain_id: int
    expiry: int
    is_put: bool
    is_taker_buy: bool
    quantity_e18: str
    strike_e8: str
    taker: str
    usd: str
    collateral_asset: str

    def to_params(self) -> dict:
        # All address fields lowercased before transit. Rysk server stores
        # RFQs with the exact case the taker submitted, and a maker quote
        # has to match that case byte-for-byte or gets -32011 "asset
        # mismatch". Our maker always lowercases (per Jib, 2026-04-07),
        # so taker must lowercase too for the two sides to agree.
        return {
            "asset": self.asset.lower(),
            "assetName": self.asset_name,
            "chainId": self.chain_id,
            "expiry": self.expiry,
            "isPut": self.is_put,
            "isTakerBuy": self.is_taker_buy,
            "quantity": self.quantity_e18,
            "strike": self.strike_e8,
            "taker": self.taker.lower(),
            "usd": self.usd.lower(),
            "collateralAsset": self.collateral_asset.lower(),
        }

    @property
    def strike_float(self) -> float:
        return float(self.strike_e8) / 1e8

    @property
    def quantity_float(self) -> float:
        return float(self.quantity_e18) / 1e18

    @property
    def option_type(self) -> str:
        """P or C - lets this type duck-type as a RyskRequest for pricers."""
        return "P" if self.is_put else "C"

    @property
    def request_id(self) -> str:
        """Placeholder so downstream code can log a stable id."""
        return f"taker-{self.asset_name}-{self.strike_float:.0f}-{self.expiry}"


class TakerClient:
    """Minimal async WebSocket taker for testnet self-testing.

    Usage:
        client = TakerClient(taker_address="0x...")
        await client.connect()
        await client.submit(request)
        responses = await client.listen(timeout=10)
        await client.close()
    """

    def __init__(
        self,
        taker_address: str,
        endpoint: str = TAKER_ENDPOINT_TESTNET,
    ):
        self.taker_address = taker_address
        self.endpoint = endpoint
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._id_counter = 0

    def _next_id(self) -> str:
        self._id_counter += 1
        return f"taker-{int(time.time()*1000)}-{self._id_counter}"

    async def connect(self):
        self._ws = await websockets.connect(self.endpoint, open_timeout=5)

    async def close(self):
        if self._ws is not None:
            await self._ws.close()
            self._ws = None

    async def submit(self, req: TakerRequest) -> str:
        """Send an RFQ request. Returns the JSON-RPC id."""
        if self._ws is None:
            raise RuntimeError("Not connected")
        req_id = self._next_id()
        payload = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "request",
            "params": req.to_params(),
        }
        await self._ws.send(json.dumps(payload))
        return req_id

    async def listen(self, timeout: float = 10) -> list[dict]:
        """Collect messages for up to `timeout` seconds."""
        if self._ws is None:
            raise RuntimeError("Not connected")
        messages = []
        try:
            async with asyncio.timeout(timeout):
                while True:
                    msg = await self._ws.recv()
                    try:
                        messages.append(json.loads(msg))
                    except json.JSONDecodeError:
                        messages.append({"raw": msg})
        except asyncio.TimeoutError:
            pass
        return messages

    # --- Convenience: send + wait for quotes ---

    async def submit_and_wait(
        self, req: TakerRequest, wait_seconds: float = 10,
    ) -> dict:
        """Submit an RFQ and collect all responses in the window.

        Returns dict with:
          request_id: the JSON-RPC id of our request
          responses: list of messages received
          quotes: filtered list of quote notifications (if any)
          error: first error message (if any)
        """
        req_id = await self.submit(req)
        messages = await self.listen(timeout=wait_seconds)

        quotes = []
        error = None
        for m in messages:
            if isinstance(m, dict):
                if m.get("error") and error is None:
                    error = m["error"]
                # Quote notifications contain 'quote' or 'price' info
                if "quote" in str(m).lower() or "price" in m.get("result", {}) if isinstance(m.get("result"), dict) else False:
                    quotes.append(m)

        return {
            "request_id": req_id,
            "responses": messages,
            "quotes": quotes,
            "error": error,
        }

    # --- Product discovery ---

    async def scan_products(
        self,
        asset_name: str,
        expiries: list[int],
        strike_range_usd: tuple[int, int, int],  # (start, stop, step)
    ) -> list[tuple[int, int]]:
        """Scan strikes across expiries to find valid listings.

        Returns list of (expiry, strike_usd) tuples that were accepted.
        """
        asset_addr = ASSET_ADDRESSES.get(asset_name)
        if not asset_addr:
            return []

        start, stop, step = strike_range_usd
        listings = []

        for expiry in expiries:
            for strike in range(start, stop, step):
                req = TakerRequest(
                    asset=asset_addr,
                    asset_name=asset_name,
                    chain_id=84532,
                    expiry=expiry,
                    is_put=True,
                    is_taker_buy=False,
                    quantity_e18="1000000000000000000",
                    strike_e8=str(int(strike * 1e8)),
                    taker=self.taker_address,
                    usd=USDC_TESTNET,
                    collateral_asset=USDC_TESTNET,
                )
                # Open a one-shot connection per probe (clean state)
                try:
                    async with websockets.connect(self.endpoint, open_timeout=3) as ws:
                        await ws.send(json.dumps({
                            "jsonrpc": "2.0",
                            "id": f"scan-{strike}",
                            "method": "request",
                            "params": req.to_params(),
                        }))
                        try:
                            async with asyncio.timeout(1.5):
                                msg = await ws.recv()
                                data = json.loads(msg)
                                if "error" in data:
                                    continue  # Not listed
                        except asyncio.TimeoutError:
                            # No error received = request accepted + aggregation started
                            listings.append((expiry, strike))
                except Exception:
                    continue

        return listings


# ---------------------------------------------------------------------------
# Random RFQ generation
# ---------------------------------------------------------------------------

def random_listed_request(
    taker_address: str,
    underlying: Optional[str] = None,
) -> TakerRequest:
    """Pick a random listed product and build a TakerRequest.

    Quantity is computed via INTEGER arithmetic to avoid float precision
    errors (e.g. `int(4.43 * 1e18)` returns 4429999999999999488, which the
    server rejects as "trade increment is wrong").

    Sizes respect per-asset min/max from ASSET_SIZE_LIMITS in 0.01 steps.

    underlying: "WETH" | "WBTC" | None (random pick)
    """
    if underlying is None:
        underlying = random.choice(list(LISTED_PRODUCTS_SNAPSHOT.keys()))

    products = LISTED_PRODUCTS_SNAPSHOT.get(underlying, {})
    if not products:
        raise ValueError(f"No listed products for {underlying}")

    # Flatten to list of (expiry, strike) tuples
    all_products = [
        (exp, strike)
        for exp, strikes in products.items()
        for strike in strikes
    ]
    expiry, strike_usd = random.choice(all_products)

    # Pick a quantity in 0.01 increments within the asset's size window
    min_h, max_h = ASSET_SIZE_LIMITS[underlying]
    hundredths = random.randint(min_h, max_h)
    quantity_e18 = str(hundredths * QUANTITY_STEP_E18)  # Integer math: no float noise
    strike_e8 = str(int(strike_usd * 1e8))

    return TakerRequest(
        asset=ASSET_ADDRESSES[underlying],
        asset_name=underlying,
        chain_id=84532,
        expiry=expiry,
        is_put=True,  # Testnet is puts-only
        is_taker_buy=False,  # Testnet only supports taker-sell / maker-buy
        quantity_e18=quantity_e18,
        strike_e8=strike_e8,
        taker=taker_address,
        usd=USDC_TESTNET,
        collateral_asset=USDC_TESTNET,
    )
