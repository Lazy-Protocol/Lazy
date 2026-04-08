"""Rysk V12 inventory fetcher.

Replaces the brittle ``rysk-scan-products`` WebSocket scanner with a
single REST call to ``/api/inventory``. The endpoint returns the entire
listing book per environment (testnet or mainnet) in one ~50KB JSON
payload, with no auth required, and includes per-strike metadata that
the WS scanner cannot see: live spot index, delta, bid/ask IV, APY,
and the available collateral options per (strike, expiry).

Discovered 2026-04-07 (Jib pointed it out). See
``memory/rysk-inventory-rest-endpoint.md`` for the full schema notes.

Usage:
    inv = RyskInventory(env="testnet")
    inv.fetch()  # populate the cache (auto if stale)
    btc_listings = inv.listings(underlying="BTC", is_put=True)
    spot = inv.get_spot("BTC")
    listing = inv.find(underlying="BTC", strike=70000, expiry_ts=1776412800)

Testnet quirks observed:
1. The combinations dict is keyed ``"strike-expiry"`` (no isPut), so if
   both a put and a call exist for the same (strike, expiry), only one
   shows up. We saw 4 successful UI call trades on WBTC/WETH while the
   inventory only listed puts for those underlyings. Cross-check
   against actual quote acceptance before declaring a call missing.
2. ``strikes`` arrays per expiry can contain duplicates. We dedupe.
3. Some entries have ``strike: 0`` (sub-dollar tokens like PUMP). These
   slip through unless the caller filters them out.
4. Address fields in the live response are already lowercase, matching
   our wire-side invariant.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Endpoint URLs
# ---------------------------------------------------------------------------

INVENTORY_URLS = {
    "mainnet": "https://v12.rysk.finance/api/inventory",
    "testnet": "https://rip-testnet.rysk.finance/api/inventory",
}

# Map our internal "wrapped" naming to Rysk's canonical naming. The
# Rysk inventory uses the underlying name (BTC, ETH, HYPE) regardless
# of whether the on-chain asset is wrapped (WBTC, WETH on Base Sepolia).
# Callers can pass either form; we resolve via this map.
NAME_ALIASES = {
    "WBTC": "BTC",
    "WETH": "ETH",
}


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Product:
    """One collateral variant for a (strike, expiry) listing.

    A single Listing can have multiple Products when the same option
    is offered against different collateral tokens (e.g. ETH on testnet
    has 3 USDC-like collateral variants).
    """
    asset: str             # underlying token address (lowercase)
    strike_asset: str      # USDC or other (lowercase)
    collateral_asset: str  # what the maker has to lock (lowercase)


@dataclass(frozen=True)
class Listing:
    """One listed option contract on Rysk."""
    underlying: str        # canonical name: BTC, ETH, HYPE, ...
    strike: float
    expiry_ts: int         # unix
    is_put: bool
    delta: float
    bid: float
    ask: float
    bid_iv: float
    ask_iv: float
    index: float           # live spot reference price for the underlying
    apy: float
    timestamp: int         # when this entry was generated server-side
    products: tuple[Product, ...] = field(default_factory=tuple)


# ---------------------------------------------------------------------------
# Fetcher
# ---------------------------------------------------------------------------

class InventoryFetchError(Exception):
    """Raised when the REST fetch fails or the payload is malformed."""


class RyskInventory:
    """In-memory snapshot of the Rysk inventory with TTL caching.

    Network IO only happens on ``fetch()`` (or implicitly via any
    accessor when the cache is stale). All filter helpers are pure
    dict lookups against the cached parse, so they're cheap to call
    on the hot path.

    The default TTL is 60s, which matches the spec's
    ``MAX_CACHE_AGE_SECONDS`` for the Derive mark cache. Inventory
    changes infrequently in practice (strikes rotate weekly at
    Friday expiry) so even a 5-minute TTL would be safe.
    """

    def __init__(
        self,
        env: str = "testnet",
        ttl_seconds: float = 60.0,
        url: Optional[str] = None,
    ):
        if env not in INVENTORY_URLS:
            raise ValueError(f"unknown env={env!r}; expected testnet or mainnet")
        self.env = env
        self.url = url or INVENTORY_URLS[env]
        self.ttl_seconds = ttl_seconds
        self._listings: list[Listing] = []
        self._fetched_at: float = 0.0
        self._raw: Optional[dict] = None

    # ----- Network -----

    def fetch(self, force: bool = False) -> list[Listing]:
        """Fetch the inventory from the REST endpoint and parse it.

        Returns the full flat list of listings. Cached for ``ttl_seconds``
        unless ``force=True``.
        """
        if not force and self._is_fresh():
            return self._listings
        try:
            req = urllib.request.Request(
                self.url,
                headers={
                    "User-Agent": "rysk-arb-inventory/1.0",
                    "Accept": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status != 200:
                    raise InventoryFetchError(
                        f"GET {self.url} returned status {resp.status}"
                    )
                body = resp.read()
        except urllib.error.URLError as e:
            raise InventoryFetchError(f"GET {self.url} failed: {e}") from e
        try:
            data = json.loads(body)
        except json.JSONDecodeError as e:
            raise InventoryFetchError(
                f"GET {self.url} returned invalid JSON: {e}"
            ) from e
        self._raw = data
        self._listings = self._parse(data)
        self._fetched_at = time.time()
        return self._listings

    def _is_fresh(self) -> bool:
        return (
            self._fetched_at > 0
            and (time.time() - self._fetched_at) < self.ttl_seconds
        )

    def _ensure(self) -> None:
        """Fetch if cache is empty or stale. Used by accessors."""
        if not self._is_fresh():
            self.fetch()

    # ----- Parsing -----

    @staticmethod
    def _parse(data: dict) -> list[Listing]:
        """Flatten the nested ``{underlying: {combinations: {key: combo}}}``
        structure into a list of Listing objects."""
        out: list[Listing] = []
        if not isinstance(data, dict):
            raise InventoryFetchError(f"expected dict at top level, got {type(data)}")
        for underlying, asset_data in data.items():
            if not isinstance(asset_data, dict):
                continue
            combinations = asset_data.get("combinations") or {}
            if not isinstance(combinations, dict):
                continue
            for combo_key, combo in combinations.items():
                if not isinstance(combo, dict):
                    continue
                try:
                    listing = Listing(
                        underlying=underlying,
                        strike=float(combo.get("strike", 0)),
                        expiry_ts=int(combo.get("expiration_timestamp", 0)),
                        is_put=bool(combo.get("isPut", False)),
                        delta=float(combo.get("delta", 0)),
                        bid=float(combo.get("bid", 0)),
                        ask=float(combo.get("ask", 0)),
                        bid_iv=float(combo.get("bidIv", 0)),
                        ask_iv=float(combo.get("askIv", 0)),
                        index=float(combo.get("index", 0)),
                        apy=float(combo.get("apy", 0)),
                        timestamp=int(combo.get("timestamp", 0)),
                        products=tuple(
                            Product(
                                asset=str(p.get("asset", "")).lower(),
                                strike_asset=str(p.get("strikeAsset", "")).lower(),
                                collateral_asset=str(p.get("collateralAsset", "")).lower(),
                            )
                            for p in (combo.get("products") or [])
                            if isinstance(p, dict)
                        ),
                    )
                except (TypeError, ValueError):
                    # Skip malformed entries rather than blowing up the
                    # whole snapshot. The strict-parse alternative would
                    # break on any future schema drift.
                    continue
                out.append(listing)
        return out

    # ----- Accessors -----

    @staticmethod
    def _resolve_name(name: str) -> str:
        """Map WBTC/WETH/etc. to Rysk's canonical BTC/ETH naming."""
        return NAME_ALIASES.get(name.upper(), name.upper())

    def listings(
        self,
        underlying: Optional[str] = None,
        is_put: Optional[bool] = None,
        expiry_ts: Optional[int] = None,
        skip_zero_strike: bool = True,
    ) -> list[Listing]:
        """Filter listings by criteria. ``None`` means "any"."""
        self._ensure()
        canonical = self._resolve_name(underlying) if underlying else None
        out = []
        for listing in self._listings:
            if canonical is not None and listing.underlying != canonical:
                continue
            if is_put is not None and listing.is_put != is_put:
                continue
            if expiry_ts is not None and listing.expiry_ts != expiry_ts:
                continue
            if skip_zero_strike and listing.strike == 0:
                continue
            out.append(listing)
        return out

    def find(
        self,
        underlying: str,
        strike: float,
        expiry_ts: int,
        is_put: Optional[bool] = None,
    ) -> Optional[Listing]:
        """Look up a specific listing. Returns None if not found.

        ``is_put=None`` returns the first match regardless of direction
        (matches the inventory's "one entry per (strike, expiry)" quirk).
        """
        self._ensure()
        canonical = self._resolve_name(underlying)
        for listing in self._listings:
            if listing.underlying != canonical:
                continue
            if listing.expiry_ts != expiry_ts:
                continue
            if listing.strike != strike:
                continue
            if is_put is not None and listing.is_put != is_put:
                continue
            return listing
        return None

    def get_spot(self, underlying: str) -> Optional[float]:
        """Latest spot index price for an underlying.

        Pulled from any listing on that underlying (the index field is
        the same across all combinations of the same underlying within
        a single snapshot). Returns None if no listings exist.
        """
        self._ensure()
        canonical = self._resolve_name(underlying)
        for listing in self._listings:
            if listing.underlying == canonical and listing.index > 0:
                return listing.index
        return None

    def underlyings(self) -> list[str]:
        """Sorted list of underlyings that have at least one listing."""
        self._ensure()
        return sorted({l.underlying for l in self._listings})

    def expiries(self, underlying: str) -> list[int]:
        """Sorted list of expiry timestamps for an underlying."""
        self._ensure()
        canonical = self._resolve_name(underlying)
        return sorted({
            l.expiry_ts for l in self._listings if l.underlying == canonical
        })

    def strikes(
        self,
        underlying: str,
        expiry_ts: int,
        is_put: Optional[bool] = None,
    ) -> list[float]:
        """Sorted list of strikes for a (underlying, expiry)."""
        self._ensure()
        canonical = self._resolve_name(underlying)
        out = set()
        for l in self._listings:
            if l.underlying != canonical:
                continue
            if l.expiry_ts != expiry_ts:
                continue
            if is_put is not None and l.is_put != is_put:
                continue
            if l.strike == 0:
                continue
            out.add(l.strike)
        return sorted(out)

    # ----- Test/debug helpers -----

    def load_from_dict(self, data: dict) -> list[Listing]:
        """Bypass the network and load from an in-memory dict.

        Used by tests with the checked-in fixture file. Sets the
        ``_fetched_at`` so subsequent accessors don't try to refresh.
        """
        self._raw = data
        self._listings = self._parse(data)
        self._fetched_at = time.time()
        return self._listings
