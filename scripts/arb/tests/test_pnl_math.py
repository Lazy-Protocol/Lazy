"""Unit tests for pnl.ArbTrade P&L math.

Locks in the audit C5 fix: compute_gross_spread must always include
-(rysk_price * qty) so Tier 4 trades don't report phantom profit.
"""

import pytest

from scripts.arb.pnl import ArbTrade


def _make_trade(**overrides) -> ArbTrade:
    defaults = dict(
        id="t1",
        created_at=1_000_000,
        underlying="HYPE",
        option_type="P",
        strike=33.0,
        expiry_ts=2_000_000,
        qty=500.0,
        rysk_instrument="HYPE-33-P",
        rysk_price=0.93,
        rysk_fee=58.10,
    )
    defaults.update(overrides)
    return ArbTrade(**defaults)


class TestTier1Hedged:
    """Tier 1: Rysk long + Derive short at matching strike, perfect hedge."""

    def test_gross_spread_is_derive_minus_rysk(self):
        t = _make_trade(
            derive_instrument="HYPE-33-P",
            derive_price=1.28,
            derive_fee=6.05,
            tier=1,
            hedge_status="hedged",
        )
        t.compute_gross_spread()
        # 500 * (1.28 - 0.93) = 175.00
        assert t.gross_spread == pytest.approx(175.0, rel=1e-6)

    def test_settled_realized_pnl_with_perfect_hedge(self):
        t = _make_trade(
            derive_instrument="HYPE-33-P",
            derive_price=1.28,
            derive_fee=6.05,
            tier=1,
            hedge_status="hedged",
            status="settled",
            rysk_settlement=0.0,  # Both legs offset
            derive_settlement=0.0,
            settlement_pnl=0.0,
        )
        t.compute_realized_pnl()
        # gross - fees = 175 - 58.10 - 6.05 = 110.85
        assert t.realized_pnl == pytest.approx(110.85, rel=1e-6)


class TestTier4Loser:
    """Tier 4: no Derive hedge, option expires OTM, pure premium loss."""

    def test_gross_spread_is_negative_rysk_cost(self):
        """Audit C5: Tier 4 gross_spread must be -(rysk_price * qty)."""
        t = _make_trade(tier=4, hedge_status="perp_backstop")
        t.compute_gross_spread()
        # 0 - 0.93 * 500 = -465
        assert t.gross_spread == pytest.approx(-465.0, rel=1e-6)

    def test_settled_otm_loses_premium(self):
        t = _make_trade(
            tier=4,
            hedge_status="perp_backstop",
            status="settled",
            rysk_settlement=0.0,  # OTM put pays nothing
            derive_settlement=0.0,
            settlement_pnl=0.0,
            perp_pnl=10.0,  # Small perp gain
            perp_fee=0.0,
        )
        t.compute_realized_pnl()
        # -465 + 0 + 10 - 58.10 = -513.10
        assert t.realized_pnl == pytest.approx(-513.10, rel=1e-6)

    def test_tier4_never_reports_phantom_profit(self):
        """Before the audit fix, Tier 4 P&L omitted the Rysk premium and
        reported only `-fees + settlement + perp_pnl`. For an OTM expiry
        that would be -58.10 + 0 + 0 = -58.10 (a small loss) when the
        actual loss should be the full premium: -465 - 58.10 = -523.10."""
        t = _make_trade(
            tier=4,
            hedge_status="unhedged",
            status="settled",
            rysk_settlement=0.0,
            derive_settlement=0.0,
            settlement_pnl=0.0,
            perp_pnl=0.0,
            perp_fee=0.0,
        )
        t.compute_realized_pnl()
        # MUST be approximately -523, not -58
        assert t.realized_pnl < -500, (
            f"Expected ~-523 (full premium loss), got {t.realized_pnl}. "
            "This is the audit C5 regression."
        )


class TestTier4Winner:
    """Tier 4: no Derive hedge, option expires ITM, collects intrinsic."""

    def test_settled_itm_captures_spread_above_premium(self):
        t = _make_trade(
            tier=4,
            hedge_status="perp_backstop",
            status="settled",
            # HYPE settled at $30, put payoff = (33 - 30) * 500 = 1500
            rysk_settlement=1500.0,
            derive_settlement=0.0,
            settlement_pnl=1500.0,
            perp_pnl=-30.0,  # Perp hedge slightly negative
            perp_fee=0.0,
        )
        t.compute_realized_pnl()
        # -465 (premium) + 1500 (settlement) - 30 (perp) - 58.10 (rysk fee) = 946.90
        assert t.realized_pnl == pytest.approx(946.90, rel=1e-6)

    def test_tier4_closed_early_realizes_premium_cost(self):
        t = _make_trade(
            tier=4,
            hedge_status="perp_backstop",
            status="closed_early",
            perp_pnl=100.0,  # Perp gain when position closed early
            perp_fee=0.0,
        )
        t.compute_realized_pnl()
        # -465 - 58.10 + 100 = -423.10
        assert t.realized_pnl == pytest.approx(-423.10, rel=1e-6)


class TestGrossSpreadFormula:
    """Direct tests of the compute_gross_spread formula."""

    @pytest.mark.parametrize(
        "rysk_price,derive_price,qty,expected",
        [
            (0.93, 1.28, 500, 175.0),     # Tier 1 profitable
            (0.93, 0.00, 500, -465.0),    # Tier 4 (no Derive leg)
            (1.50, 1.00, 100, -50.0),     # Loss (paid more on Rysk than Derive)
            (0.00, 0.00, 500, 0.0),       # Degenerate
            (2.00, 2.00, 500, 0.0),       # Zero spread
        ],
    )
    def test_formula(self, rysk_price, derive_price, qty, expected):
        t = _make_trade(
            qty=qty, rysk_price=rysk_price,
            derive_price=derive_price,
        )
        t.compute_gross_spread()
        assert t.gross_spread == pytest.approx(expected, abs=1e-9)
