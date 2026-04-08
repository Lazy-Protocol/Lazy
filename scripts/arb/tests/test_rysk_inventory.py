"""Unit tests for scripts.arb.rysk_inventory.

These tests load the testnet fixture at
``scripts/arb/tests/fixtures/rysk-testnet-inventory.json`` rather than
hitting the live REST API, so they're hermetic and fast.
"""

import json
from pathlib import Path

import pytest

from scripts.arb.rysk_inventory import (
    INVENTORY_URLS,
    InventoryFetchError,
    Listing,
    NAME_ALIASES,
    Product,
    RyskInventory,
)


FIXTURE_PATH = (
    Path(__file__).parent / "fixtures" / "rysk-testnet-inventory.json"
)


@pytest.fixture
def inv() -> RyskInventory:
    """An inventory pre-loaded from the testnet fixture."""
    raw = json.loads(FIXTURE_PATH.read_text())
    inventory = RyskInventory(env="testnet")
    inventory.load_from_dict(raw)
    return inventory


class TestParse:
    def test_underlyings_present(self, inv):
        names = inv.underlyings()
        assert "BTC" in names
        assert "ETH" in names
        assert "HYPE" in names
        # ZEC is in the snapshot with no listings; should NOT show up
        assert "ZEC" not in names

    def test_listings_nonempty(self, inv):
        all_listings = inv.listings()
        assert len(all_listings) > 0
        # Every listing should have a non-empty products tuple
        assert all(len(l.products) > 0 for l in all_listings)

    def test_listing_dataclass_shape(self, inv):
        listings = inv.listings(underlying="BTC")
        assert len(listings) > 0
        l = listings[0]
        assert isinstance(l, Listing)
        assert l.underlying == "BTC"
        assert l.expiry_ts > 0
        assert l.strike > 0
        assert isinstance(l.is_put, bool)
        for p in l.products:
            assert isinstance(p, Product)
            assert p.asset.startswith("0x")
            assert p.asset == p.asset.lower(), "addresses must be lowercase"
            assert p.collateral_asset == p.collateral_asset.lower()


class TestFilters:
    def test_filter_by_underlying(self, inv):
        eth_listings = inv.listings(underlying="ETH")
        assert len(eth_listings) > 0
        assert all(l.underlying == "ETH" for l in eth_listings)

    def test_filter_by_is_put_true(self, inv):
        puts = inv.listings(underlying="BTC", is_put=True)
        assert all(l.is_put is True for l in puts)

    def test_filter_by_is_put_false(self, inv):
        # In the testnet snapshot only call-style assets (MON, PUMP,
        # PURR, SOL, XRP) have isPut=False entries
        calls = inv.listings(is_put=False)
        if calls:
            assert all(l.is_put is False for l in calls)

    def test_filter_by_expiry(self, inv):
        expiries = inv.expiries("BTC")
        assert len(expiries) > 0
        first = expiries[0]
        listings = inv.listings(underlying="BTC", expiry_ts=first)
        assert all(l.expiry_ts == first for l in listings)

    def test_skip_zero_strike_default(self, inv):
        # MON and PUMP have strike=0 entries (sub-dollar tokens). The
        # default filter should skip them.
        all_listings = inv.listings()
        assert all(l.strike > 0 for l in all_listings)

    def test_skip_zero_strike_override(self, inv):
        all_listings = inv.listings(skip_zero_strike=False)
        assert any(l.strike == 0 for l in all_listings)


class TestNameAliases:
    def test_wbtc_resolves_to_btc(self, inv):
        wbtc_listings = inv.listings(underlying="WBTC")
        btc_listings = inv.listings(underlying="BTC")
        assert len(wbtc_listings) == len(btc_listings)
        assert wbtc_listings == btc_listings

    def test_weth_resolves_to_eth(self, inv):
        weth_listings = inv.listings(underlying="WETH")
        eth_listings = inv.listings(underlying="ETH")
        assert len(weth_listings) == len(eth_listings)

    def test_case_insensitive(self, inv):
        a = inv.listings(underlying="btc")
        b = inv.listings(underlying="BTC")
        assert a == b

    def test_passthrough_unaliased_name(self, inv):
        # HYPE has no alias - should resolve to itself
        hype_listings = inv.listings(underlying="HYPE")
        assert all(l.underlying == "HYPE" for l in hype_listings)

    def test_alias_map_definition(self):
        assert NAME_ALIASES["WBTC"] == "BTC"
        assert NAME_ALIASES["WETH"] == "ETH"


class TestFind:
    def test_find_existing(self, inv):
        # Pick a real strike from the snapshot
        btc_listings = inv.listings(underlying="BTC")
        target = btc_listings[0]
        found = inv.find(
            underlying="BTC",
            strike=target.strike,
            expiry_ts=target.expiry_ts,
        )
        assert found is not None
        assert found == target

    def test_find_missing_returns_none(self, inv):
        result = inv.find(
            underlying="BTC",
            strike=99_999_999,
            expiry_ts=0,
        )
        assert result is None

    def test_find_with_is_put_filter(self, inv):
        btc_puts = inv.listings(underlying="BTC", is_put=True)
        if btc_puts:
            target = btc_puts[0]
            # Should find as a put
            assert inv.find(
                "BTC", target.strike, target.expiry_ts, is_put=True
            ) is not None
            # Should NOT find as a call (testnet inventory only has one
            # direction per (strike, expiry) key, so the wrong direction
            # is silently absent)
            wrong = inv.find(
                "BTC", target.strike, target.expiry_ts, is_put=False
            )
            assert wrong is None


class TestSpotAndExpiries:
    def test_get_spot_btc(self, inv):
        spot = inv.get_spot("BTC")
        assert spot is not None
        assert spot > 0
        # BTC spot should be in a reasonable testnet range
        assert 10_000 < spot < 1_000_000

    def test_get_spot_via_alias(self, inv):
        a = inv.get_spot("WBTC")
        b = inv.get_spot("BTC")
        assert a == b

    def test_get_spot_unknown_underlying(self, inv):
        assert inv.get_spot("DOESNOTEXIST") is None

    def test_expiries_sorted(self, inv):
        expiries = inv.expiries("BTC")
        assert expiries == sorted(expiries)
        assert len(expiries) >= 2  # snapshot has at least 2 expiries

    def test_expiries_via_alias(self, inv):
        a = inv.expiries("WETH")
        b = inv.expiries("ETH")
        assert a == b

    def test_strikes_dedupes_and_sorts(self, inv):
        # HYPE in the snapshot has duplicate strikes within an expiry
        # (e.g. [32, 33, 34, 35, 36, 36, 38, 39]). The strikes() helper
        # must dedupe them.
        for expiry in inv.expiries("HYPE"):
            strikes = inv.strikes("HYPE", expiry)
            assert strikes == sorted(set(strikes))
            assert len(strikes) == len(set(strikes))


class TestCacheBehavior:
    def test_load_from_dict_marks_fresh(self, inv):
        # After load_from_dict, cache should be considered fresh
        assert inv._is_fresh()

    def test_listings_does_not_refetch_when_fresh(self, monkeypatch):
        raw = json.loads(FIXTURE_PATH.read_text())
        inv = RyskInventory(env="testnet", ttl_seconds=3600)
        inv.load_from_dict(raw)

        # If anything tries to hit the network, fail loudly
        def boom(*a, **kw):
            raise AssertionError("network call should not happen on fresh cache")
        monkeypatch.setattr(
            "scripts.arb.rysk_inventory.urllib.request.urlopen", boom
        )
        # Hot path accessors must not trigger a fetch
        _ = inv.listings()
        _ = inv.get_spot("BTC")
        _ = inv.find("BTC", 70000, inv.expiries("BTC")[0])

    def test_stale_cache_triggers_refetch(self, monkeypatch):
        raw = json.loads(FIXTURE_PATH.read_text())
        inv = RyskInventory(env="testnet", ttl_seconds=0.0001)
        inv.load_from_dict(raw)
        import time
        time.sleep(0.001)
        assert not inv._is_fresh()

        # Stub the network so we can detect that fetch was called
        called = {"count": 0}
        class FakeResp:
            status = 200
            def read(self):
                return json.dumps(raw).encode()
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass
        def fake_urlopen(req, timeout=10):
            called["count"] += 1
            return FakeResp()
        monkeypatch.setattr(
            "scripts.arb.rysk_inventory.urllib.request.urlopen", fake_urlopen
        )
        _ = inv.listings()
        assert called["count"] == 1

    def test_unknown_env_raises(self):
        with pytest.raises(ValueError, match="unknown env"):
            RyskInventory(env="bogus")


class TestParseRobustness:
    def test_empty_dict(self):
        inv = RyskInventory(env="testnet")
        inv.load_from_dict({})
        assert inv.listings() == []
        assert inv.underlyings() == []

    def test_underlying_with_no_combinations(self):
        inv = RyskInventory(env="testnet")
        inv.load_from_dict({"BTC": {"strikes": {}, "expiries": []}})
        assert inv.listings() == []

    def test_skips_malformed_combo(self):
        inv = RyskInventory(env="testnet")
        inv.load_from_dict({
            "BTC": {
                "combinations": {
                    "good-1": {
                        "strike": 70000,
                        "expiration_timestamp": 1776412800,
                        "isPut": True,
                        "delta": -0.5,
                        "bid": 0,
                        "ask": 0,
                        "bidIv": 60,
                        "askIv": 65,
                        "index": 70000,
                        "apy": 10,
                        "timestamp": 0,
                        "products": [{
                            "asset": "0xAAA",
                            "strikeAsset": "0xBBB",
                            "collateralAsset": "0xBBB",
                        }],
                    },
                    "bad": "not a dict",
                    "junk-strike": {"strike": "not a number"},
                }
            }
        })
        listings = inv.listings()
        assert len(listings) == 1
        assert listings[0].strike == 70000

    def test_addresses_lowercased_on_parse(self):
        inv = RyskInventory(env="testnet")
        inv.load_from_dict({
            "BTC": {
                "combinations": {
                    "70000-1": {
                        "strike": 70000,
                        "expiration_timestamp": 1776412800,
                        "isPut": True,
                        "delta": -0.5,
                        "bid": 0,
                        "ask": 0,
                        "bidIv": 60,
                        "askIv": 65,
                        "index": 70000,
                        "apy": 10,
                        "timestamp": 0,
                        "products": [{
                            "asset": "0xAaBbCcDd",
                            "strikeAsset": "0xEeFf0011",
                            "collateralAsset": "0xEeFf0011",
                        }],
                    },
                }
            }
        })
        l = inv.listings()[0]
        assert l.products[0].asset == "0xaabbccdd"
        assert l.products[0].strike_asset == "0xeeff0011"
        assert l.products[0].collateral_asset == "0xeeff0011"


class TestUrlsConstants:
    def test_both_envs_have_urls(self):
        assert "mainnet" in INVENTORY_URLS
        assert "testnet" in INVENTORY_URLS
        assert INVENTORY_URLS["mainnet"].startswith("https://")
        assert INVENTORY_URLS["testnet"].startswith("https://")
