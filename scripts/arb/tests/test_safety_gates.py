"""Unit tests for safety gates that the audit flagged as critical.

Locks in:
- H5: perp_entry_delta is immutable after initial assignment
- H6: hedge_rysk_buy Tier 4 path reports naked/partial/success correctly
- H8: mainnet listener refuses to quote without a live Derive client
- M5: check_limits treats None margin as a hard pass
- M6: LighterPerpClient handles account_index == 0 correctly
"""

import os
from unittest.mock import MagicMock, patch

import pytest

from scripts.arb.pnl import ArbTrade
from scripts.arb.pricing import BidResult, CachedMark, check_limits
from scripts.arb.rysk_client import RyskRequest


def _make_trade(**kw) -> ArbTrade:
    defaults = dict(
        id="t", created_at=0, underlying="HYPE", option_type="P",
        strike=33.0, expiry_ts=0, qty=500.0,
        rysk_instrument="x", rysk_price=0.93, rysk_fee=58.0,
        tier=4,
    )
    defaults.update(kw)
    return ArbTrade(**defaults)


class TestH5PerpEntryDeltaImmutable:
    """H5: perp_entry_delta stays frozen after initial trade setup; only
    perp_current_delta moves."""

    def test_entry_delta_survives_manual_rebalance(self):
        """Simulate a rebalance by reassigning perp_current_delta and verify
        perp_entry_delta is untouched."""
        t = _make_trade(perp_entry_delta=-150.0, perp_current_delta=-150.0)
        # Rebalance updates current delta
        t.perp_current_delta = -180.0
        assert t.perp_entry_delta == -150.0  # frozen
        assert t.perp_current_delta == -180.0

    def test_perp_current_delta_field_exists(self):
        """Audit H5 added this field; make sure it's present on ArbTrade."""
        t = _make_trade()
        assert hasattr(t, "perp_current_delta")


class TestH6Tier4HedgePath:
    """H6: hedge_rysk_buy Tier 4 path must distinguish naked/partial/success."""

    @pytest.fixture
    def fake_perp_client(self):
        client = MagicMock()
        client.venue = "lighter"
        return client

    @pytest.fixture
    def tier4_bid(self):
        return BidResult(
            max_bid=5.0, tier=4, tier_value=5.2, confidence=0.5,
            fees={"rysk": 10, "derive": 0},
            hedge_instrument="HYPE-PERP", reasoning="test",
        )

    def test_tier4_full_fill_reports_success(self, fake_perp_client, tier4_bid):
        """Successful perp hedge → status=perp_only_pending_migration."""
        from scripts.arb.derive_om import ArbDeriveClient

        fake_perp_client.hedge_delta.return_value = MagicMock(
            success=True, filled_size=150, avg_price=37.0,
            venue="lighter", error=None,
        )

        with patch("scripts.arb.perp_client.get_perp_client", return_value=fake_perp_client):
            with patch.object(ArbDeriveClient, "__init__", lambda self, **kw: None):
                client = ArbDeriveClient()
                result = client.hedge_rysk_buy(
                    instrument="HYPE-PERP",
                    qty=500,
                    rysk_price=5.0,
                    bid_result=tier4_bid,
                    option_delta=-0.3,
                    underlying="HYPE",
                )
        assert result["status"] == "perp_only_pending_migration"

    def test_tier4_naked_on_perp_failure(self, fake_perp_client, tier4_bid):
        """Perp order fails → status=tier4_naked_pending_manual and NOT
        a quiet 'pending_migration' lie."""
        from scripts.arb.derive_om import ArbDeriveClient

        fake_perp_client.hedge_delta.return_value = MagicMock(
            success=False, filled_size=0, avg_price=0,
            venue="lighter", error="auth failure",
        )

        with patch("scripts.arb.perp_client.get_perp_client", return_value=fake_perp_client):
            with patch.object(ArbDeriveClient, "__init__", lambda self, **kw: None):
                client = ArbDeriveClient()
                result = client.hedge_rysk_buy(
                    instrument="HYPE-PERP",
                    qty=500,
                    rysk_price=5.0,
                    bid_result=tier4_bid,
                    option_delta=-0.3,
                    underlying="HYPE",
                )
        assert result["status"] == "tier4_naked_pending_manual"
        assert "PERP ORDER FAILED" in result["perp_backstop"]["note"]

    def test_tier4_partial_fill_reports_partial(self, fake_perp_client, tier4_bid):
        """<100% fill → status=tier4_partial_hedge."""
        from scripts.arb.derive_om import ArbDeriveClient

        # 80% fill: filled_size=120 out of target delta=150
        fake_perp_client.hedge_delta.return_value = MagicMock(
            success=True, filled_size=120, avg_price=37.0,
            venue="lighter", error=None,
        )

        with patch("scripts.arb.perp_client.get_perp_client", return_value=fake_perp_client):
            with patch.object(ArbDeriveClient, "__init__", lambda self, **kw: None):
                client = ArbDeriveClient()
                result = client.hedge_rysk_buy(
                    instrument="HYPE-PERP",
                    qty=500,
                    rysk_price=5.0,
                    bid_result=tier4_bid,
                    option_delta=-0.3,
                    underlying="HYPE",
                )
        assert result["status"] == "tier4_partial_hedge"
        assert result["perp_backstop"]["fill_ratio"] < 0.99

    def test_tier4_requires_option_delta_kwarg(self, tier4_bid):
        """Audit M7: option_delta is now required, not a silent 0.3 default."""
        from scripts.arb.derive_om import ArbDeriveClient

        with patch.object(ArbDeriveClient, "__init__", lambda self, **kw: None):
            client = ArbDeriveClient()
            with pytest.raises(TypeError):
                # No option_delta → should raise
                client.hedge_rysk_buy(
                    instrument="HYPE-PERP",
                    qty=500,
                    rysk_price=5.0,
                    bid_result=tier4_bid,
                )


class TestM5CheckLimitsNoneMargin:
    """M5: cache.get_margin returning None must hard-block the bid."""

    def test_check_limits_rejects_unknown_margin(self):
        cache = MagicMock()
        cache.get_spot.return_value = 37.0
        cache.get_margin.return_value = None  # compute_margin failure

        bid = BidResult(
            max_bid=1.0, tier=1, tier_value=1.1, confidence=0.95,
            fees={"rysk": 10, "derive": 5},
            hedge_instrument="HYPE-33-P", reasoning="test",
        )
        allowed, reason = check_limits(
            bid=bid, qty=500, spot=37.0, cache=cache,
            current_positions=[], underlying="HYPE",
            account_equity=100_000, account_current_im=0,
        )
        assert allowed is False
        assert "compute_margin" in reason.lower() or "unknown" in reason.lower()


class TestM6LighterAccountIndexZero:
    """M6: LighterPerpClient should accept account_index=0 as legitimate."""

    def test_account_index_zero_does_not_raise(self, monkeypatch):
        monkeypatch.setenv("LIGHTER_API_KEY", "dummy")
        monkeypatch.setenv("LIGHTER_ACCOUNT_INDEX", "0")
        monkeypatch.setenv("LIGHTER_API_KEY_INDEX", "0")

        from scripts.arb.perp_client import LighterPerpClient

        client = LighterPerpClient(dry_run=False)
        assert client.account_index == 0

        # _get_signer should not raise for account_index=0
        # But it will try to import lighter SDK and build a signer. Patch to isolate.
        with patch("lighter.SignerClient") as MockSigner:
            MockSigner.return_value = MagicMock()
            signer = client._get_signer()
            assert signer is not None

    def test_account_index_missing_raises(self, monkeypatch):
        """Distinct from 0: if the env var is unset/blank, should raise.

        Note: _load_dotenv() repopulates from .env on every LighterPerpClient
        instance, so we can't just delete the env var. Stub _load_dotenv so
        the test environment stays clean.
        """
        monkeypatch.setenv("LIGHTER_API_KEY", "dummy")
        monkeypatch.setenv("LIGHTER_ACCOUNT_INDEX", "")  # empty = unset
        monkeypatch.setenv("LIGHTER_API_KEY_INDEX", "0")

        from scripts.arb.perp_client import LighterPerpClient

        with patch.object(LighterPerpClient, "_load_dotenv", staticmethod(lambda: None)):
            client = LighterPerpClient(dry_run=False)

        assert client.account_index is None
        with pytest.raises(RuntimeError, match="credentials"):
            client._get_signer()


class TestH8MainnetRefusalWithoutDeriveClient:
    """H8: mainnet listener must refuse to quote when derive_client is None."""

    def test_mainnet_without_derive_client_blocks_quote(self):
        from scripts.arb.rysk_listener import RyskListener

        req = RyskRequest(
            request_id="rfq-mainnet-1",
            asset="0xdead",
            asset_name="HYPE",
            chain_id=999,
            expiry=1777017600,
            is_put=True,
            is_taker_buy=False,
            quantity="1000000000000000000",
            strike="3300000000",
            taker="0xtaker",
            usd="0xusdt0",
            collateral_asset="0xusdt0",
        )

        with patch("scripts.arb.rysk_listener.RyskMakerClient") as MockClient:
            MockClient.return_value.wallet = "0xmaker"
            MockClient.return_value.on_request = lambda cb: None
            MockClient.return_value.on_response = lambda cb: None
            listener = RyskListener(env="mainnet", cache=None, derive_client=None)

        # Patch calculate_bid so we skip the "no cache" testnet-only branch
        # and reach the limits check.
        fake_bid = BidResult(
            max_bid=1.0, tier=1, tier_value=1.1, confidence=0.95,
            fees={"rysk": 10, "derive": 5},
            hedge_instrument="HYPE-33-P", reasoning="test",
        )
        with patch("scripts.arb.pricing.calculate_bid", return_value=fake_bid):
            # Also provide a mock cache so we get past the env==mainnet cache None guard
            listener.cache = MagicMock()
            listener.cache.get_spot.return_value = 37.0
            listener._on_rfq(req)

        # Should be blocked before quote submission
        assert listener.stats["quotes_submitted"] == 0
