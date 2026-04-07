"""Unit tests for rysk_listener.RyskListener._on_maker_response.

Locks in audit C1 (trade-win path wiring) and C2 (exact-key whitelist
instead of fuzzy substring matching).
"""

from unittest.mock import patch

import pytest

from scripts.arb.pricing import BidResult
from scripts.arb.rysk_client import RyskRequest
from scripts.arb.rysk_listener import RyskListener


def _make_req(rfq_id: str = "rfq-1") -> RyskRequest:
    return RyskRequest(
        request_id=rfq_id,
        asset="0xB67BFA7B488Df4f2EFA874F4E59242e9130ae61F",
        asset_name="WETH",
        chain_id=84532,
        expiry=1777017600,
        is_put=True,
        is_taker_buy=False,
        quantity="1000000000000000000",
        strike="240000000000",
        taker="0xdead",
        usd="0x98d56648c9b7F3cb49531F4135115B5000AB1733",
        collateral_asset="0x98d56648c9b7F3cb49531F4135115B5000AB1733",
    )


def _make_bid() -> BidResult:
    return BidResult(
        max_bid=10.5,
        tier=4,
        tier_value=10.7,
        confidence=0.98,
        fees={},
        hedge_instrument="WETH-TESTNET-NOHEDGE",
        reasoning="test",
    )


@pytest.fixture
def listener():
    """A listener with no side effects from RyskMakerClient.start()."""
    with patch("scripts.arb.rysk_listener.RyskMakerClient") as MockClient:
        MockClient.return_value.wallet = "0x59F4a7a9A33CB62940969CE26e33962f256c1C72"
        MockClient.return_value.on_request = lambda cb: None
        MockClient.return_value.on_response = lambda cb: None
        lst = RyskListener(env="testnet")
    return lst


class TestTradeDetectionFalsePositives:
    """Audit C2: exact key match only, no substring fuzziness."""

    def test_last_trade_price_field_is_not_a_trade(self, listener):
        """Old code would false-positive because 'trade' appears in the
        stringified result dict, even though `last_trade_price` is just
        a market data field."""
        listener._remember_pending_quote(
            "rfq-1", {"request": _make_req(), "bid": _make_bid(), "quote": None},
        )
        listener._on_maker_response({
            "jsonrpc": "2.0",
            "id": "rfq-1",
            "result": {"last_trade_price": "42.5"},
        })
        assert listener.stats["trades_won"] == 0

    def test_trade_history_field_is_not_a_trade(self, listener):
        listener._remember_pending_quote(
            "rfq-1", {"request": _make_req(), "bid": _make_bid(), "quote": None},
        )
        listener._on_maker_response({
            "jsonrpc": "2.0",
            "id": "rfq-1",
            "result": {"trade_history": []},
        })
        assert listener.stats["trades_won"] == 0

    def test_no_trade_found_is_not_a_trade(self, listener):
        listener._remember_pending_quote(
            "rfq-1", {"request": _make_req(), "bid": _make_bid(), "quote": None},
        )
        listener._on_maker_response({
            "jsonrpc": "2.0",
            "id": "rfq-1",
            "result": {"no_trade_found": True},
        })
        assert listener.stats["trades_won"] == 0

    def test_unrelated_result_is_not_a_trade(self, listener):
        listener._remember_pending_quote(
            "rfq-1", {"request": _make_req(), "bid": _make_bid(), "quote": None},
        )
        listener._on_maker_response({
            "jsonrpc": "2.0",
            "id": "rfq-1",
            "result": {"status": "accepted"},
        })
        assert listener.stats["trades_won"] == 0


class TestTradeDetectionPositiveCases:
    """Exact whitelist keys should trigger the trade path."""

    @pytest.mark.parametrize("trade_key", [
        "tradeId",
        "trade_id",
        "filled",
        "filledSize",
        "filled_size",
        "executedPrice",
        "executed_price",
        "fillPrice",
        "fill_price",
    ])
    def test_whitelisted_keys_trigger_win_path(self, listener, trade_key):
        listener._remember_pending_quote(
            "rfq-1", {"request": _make_req(), "bid": _make_bid(), "quote": None},
        )
        listener._on_maker_response({
            "jsonrpc": "2.0",
            "id": "rfq-1",
            "result": {trade_key: "100"},
        })
        assert listener.stats["trades_won"] == 1, (
            f"Whitelist key {trade_key!r} did not trigger trade detection"
        )

    def test_method_trade_triggers_win_path(self, listener):
        listener._remember_pending_quote(
            "rfq-1", {"request": _make_req(), "bid": _make_bid(), "quote": None},
        )
        listener._on_maker_response({
            "jsonrpc": "2.0",
            "id": "rfq-1",
            "method": "trade",
            "params": {"foo": "bar"},
        })
        assert listener.stats["trades_won"] == 1

    def test_unmatched_trade_does_not_fire_hedge(self, listener):
        """A trade notification for an id we don't have pending should
        be logged but not crash, and not fire the hedge path."""
        # NO remember_pending_quote for this id
        listener._on_maker_response({
            "jsonrpc": "2.0",
            "id": "rfq-ghost",
            "result": {"tradeId": "orphan"},
        })
        # Unmatched trade still doesn't trigger a count because the
        # match check requires msg_id in _pending_quotes
        assert listener.stats["trades_won"] == 0


class TestNonTradeNotifications:
    """Error, skill_issue, and unknown shapes should not fire trade path."""

    def test_error_response_increments_error_counter(self, listener):
        listener._on_maker_response({
            "jsonrpc": "2.0",
            "id": "rfq-1",
            "error": {"code": -32003, "message": "Internal Error"},
        })
        assert listener.stats["trades_won"] == 0
        assert listener.stats["errors"] == 1

    def test_skill_issue_is_not_a_trade(self, listener):
        listener._on_maker_response({
            "jsonrpc": "2.0",
            "id": "rfq-1",
            "method": "skill_issue",
            "params": {"newBest": "11.2", "yours": "10.5"},
        })
        assert listener.stats["trades_won"] == 0

    def test_unknown_shape_is_silently_ignored(self, listener):
        """Defensive: server might push unknown message types; don't crash."""
        listener._on_maker_response({"jsonrpc": "2.0", "garbage": 42})
        listener._on_maker_response("not a dict")
        listener._on_maker_response(None)
        assert listener.stats["trades_won"] == 0


class TestTestnetHedgeSkip:
    """On testnet, trade win path should skip hedge_rysk_buy (no Derive)."""

    def test_testnet_trade_win_skips_hedge(self, listener):
        assert listener.env == "testnet"
        listener._remember_pending_quote(
            "rfq-1", {"request": _make_req(), "bid": _make_bid(), "quote": None},
        )
        listener._on_maker_response({
            "jsonrpc": "2.0",
            "id": "rfq-1",
            "result": {"tradeId": "abc", "fillPrice": "10500000000000000000"},
        })
        assert listener.stats["trades_won"] == 1
        assert listener.stats["hedges_skipped_testnet"] == 1
        assert listener.stats["hedges_attempted"] == 0


class TestRealRyskTradeShape:
    """Lock in the actual Rysk trade-win shape observed on Base Sepolia
    on 2026-04-07 (txHash 0x06453d27...). Server sends id='trade' (literal
    string, not the rfq_id) with result containing txHash and quoteNonce.
    Match by quoteNonce against our stored quote nonces.
    """

    def _make_real_trade_msg(self, quote_nonce: str = "1775567151394328"):
        return {
            "jsonrpc": "2.0",
            "id": "trade",
            "result": {
                "maker": "0x59f4a7a9a33cb62940969ce26e33962f256c1c72",
                "taker": "0x59f4a7a9a33cb62940969ce26e33962f256c1c72",
                "assetAddress": "0x0cb970511c6c3491dc36f1b7774743da3fc4335f",
                "chainId": 84532,
                "expiry": 1777017600,
                "isPut": False,
                "isTakerBuy": False,
                "nonce": "1775567155572",
                "price": "1436212569057799438336",
                "quantity": "1000000000000000000",
                "quoteNonce": quote_nonce,
                "quoteValidUntil": 1775567181,
                "quoteSignature": "0x926f031db454c482f01982ee161dad7a4f50ed0b95",
                "strike": "7800000000000",
                "signature": "0x1410a3bf5d4fe52d874123480d31ffbe400fc5564",
                "validUntil": 1775567181,
                "usd": "0x98d56648c9b7f3cb49531f4135115b5000ab1733",
                "createdAt": 1775567159,
                "apr": 45.59,
                "mark": "68534888891650014000000",
                "txHash": "0x06453d27bf4ed1b4943252f166b0fb91b16b030a20fa6b3a09be38aa1e3efe6e",
                "fees": "179526571",
                "status": "",
                "collateralAsset": "0x0cb970511c6c3491dc36f1b7774743da3fc4335f",
                "gasFee": "0",
                "collateralAmount": "100000000",
                "isEIP1271": False,
            },
        }

    def test_real_trade_shape_with_quote_nonce_match(self, listener):
        """Trade with id='trade' + matching quoteNonce should fire win path."""
        # Build a fake quote object with nonce attribute (matches RyskQuote API)
        from types import SimpleNamespace
        quote = SimpleNamespace(nonce="1775567151394328")
        listener._remember_pending_quote(
            "rfq-real",
            {"request": _make_req("rfq-real"), "bid": _make_bid(), "quote": quote},
        )
        listener._on_maker_response(self._make_real_trade_msg())
        assert listener.stats["trades_won"] == 1
        # Pending quote should have been popped
        assert "rfq-real" not in listener._pending_quotes
        assert "1775567151394328" not in listener._pending_by_nonce

    def test_real_trade_shape_with_unknown_nonce_still_counts(self, listener):
        """Trade with id='trade' but no matching pending quote: still
        counts as a trade (someone won), but no pending entry to match."""
        listener._on_maker_response(self._make_real_trade_msg("9999999999"))
        assert listener.stats["trades_won"] == 1

    def test_real_trade_shape_without_txhash_or_nonce_is_not_trade(self, listener):
        """id='trade' alone (no txHash or quoteNonce) is suspicious - skip."""
        listener._on_maker_response({
            "jsonrpc": "2.0",
            "id": "trade",
            "result": {"random": "field"},
        })
        assert listener.stats["trades_won"] == 0

    def test_nonce_index_evicts_with_lru(self, listener):
        """When _pending_quotes grows past max, the nonce index should
        also evict oldest entries to avoid leaking memory."""
        from types import SimpleNamespace
        listener._pending_quotes_max = 3
        for i in range(5):
            quote = SimpleNamespace(nonce=f"nonce-{i}")
            listener._remember_pending_quote(
                f"rfq-{i}",
                {"request": _make_req(f"rfq-{i}"), "bid": _make_bid(), "quote": quote},
            )
        # Only the last 3 should remain in both maps
        assert len(listener._pending_quotes) == 3
        assert len(listener._pending_by_nonce) == 3
        assert "nonce-0" not in listener._pending_by_nonce
        assert "nonce-1" not in listener._pending_by_nonce
        assert "nonce-4" in listener._pending_by_nonce

    def test_int_nonce_normalizes_to_str_on_storage(self, listener):
        """Defensive: if RyskQuote.nonce is ever populated as an int
        (instead of the current str), the index must still be lookup-able
        via the wire-side string nonce. The index keys both ends as str().
        """
        from types import SimpleNamespace
        # Quote with INT nonce (simulating a future dataclass change)
        quote = SimpleNamespace(nonce=1775567151394328)
        listener._remember_pending_quote(
            "rfq-int",
            {"request": _make_req("rfq-int"), "bid": _make_bid(), "quote": quote},
        )
        # Index must be reachable via the string form
        assert "1775567151394328" in listener._pending_by_nonce
        # Trade arrives with string quoteNonce (the wire format)
        listener._on_maker_response(
            self._make_real_trade_msg("1775567151394328")
        )
        assert listener.stats["trades_won"] == 1
        # Pending entry should be popped (matched, not unmatched)
        assert "rfq-int" not in listener._pending_quotes
        assert "1775567151394328" not in listener._pending_by_nonce

    def test_lru_eviction_with_int_nonce_clears_index(self, listener):
        """LRU eviction must also normalize to str() to avoid leaking
        the index entry when nonce is int."""
        from types import SimpleNamespace
        listener._pending_quotes_max = 2
        for i in range(3):
            quote = SimpleNamespace(nonce=1000 + i)  # int nonces
            listener._remember_pending_quote(
                f"rfq-{i}",
                {"request": _make_req(f"rfq-{i}"), "bid": _make_bid(), "quote": quote},
            )
        # Oldest (nonce=1000) should have been evicted from BOTH maps
        assert "rfq-0" not in listener._pending_quotes
        assert "1000" not in listener._pending_by_nonce
        assert len(listener._pending_by_nonce) == 2

    def test_unmatched_trade_does_not_leak_lookup_nonce(self, listener):
        """If _pending_by_nonce and _pending_quotes desync (e.g., a stale
        index entry whose pending was popped elsewhere), an unmatched
        trade must NOT leak the nonce key. The cleanup that always pops
        the lookup nonce after a trade detection ensures this."""
        # Manually create a desync: index says rfq-ghost lives at this nonce,
        # but _pending_quotes is empty.
        listener._pending_by_nonce["1775567151394328"] = "rfq-ghost"
        assert "1775567151394328" in listener._pending_by_nonce

        # Trade arrives referencing that nonce
        listener._on_maker_response(self._make_real_trade_msg())
        assert listener.stats["trades_won"] == 1
        # The orphaned index entry MUST be cleaned up (no leak)
        assert "1775567151394328" not in listener._pending_by_nonce

    def test_unmatched_trade_with_no_index_entry_does_not_crash(self, listener):
        """Trade with quoteNonce that was never in the index: pop returns
        None gracefully, no leak, no crash."""
        listener._on_maker_response(self._make_real_trade_msg("never-stored"))
        assert listener.stats["trades_won"] == 1
        assert "never-stored" not in listener._pending_by_nonce
