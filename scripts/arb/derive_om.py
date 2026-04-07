"""Derive order management for the options arb.

Extends DeriveClient with margin monitoring, hedge execution, and auto-close.
"""

import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scripts.arb.config import (
    HYPE_PERP_BACKSTOP_DELTA_PCT,
    MARGIN_ALERT_RATIO,
    MARGIN_AUTO_CLOSE_RATIO,
    MAX_MARGIN_UTILIZATION,
)
from scripts.arb.pricing import BidResult, MarkCache


def _import_derive_client():
    """Import DeriveClient from derive-puts.py (module with hyphen in name)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "derive_puts",
        os.path.join(os.path.dirname(__file__), "..", "derive-puts.py"),
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.DeriveClient


DeriveClient = _import_derive_client()


class ArbDeriveClient(DeriveClient):
    """Extended Derive client for arb operations.

    Adds margin monitoring, compute_margin queries, hedge execution,
    and position close (buy-back) for kill switch / early exit.
    """

    def __init__(self, testnet=False):
        # Load .env before parent reads os.environ
        self._load_dotenv()
        super().__init__(testnet=testnet)

    @staticmethod
    def _load_dotenv():
        """Load .env from project root into os.environ."""
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

    # --- Index price (multi-underlying) ---

    def get_index_price(self, underlying: str = "HYPE") -> float:
        """Get spot price for any underlying (base class hardcodes HYPE-PERP)."""
        ticker = self._public("get_ticker", {"instrument_name": f"{underlying}-PERP"})
        return float(ticker["index_price"])

    # --- Margin queries ---

    def query_margin(self, instrument: str, qty: float) -> dict:
        """Query Derive private/get_margin for the marginal IM/MM impact
        of opening a short position.

        Derive's `/private/get_margin` endpoint returns PRE- and POST-
        trade IM/MM SURPLUS values. The required IM for the new position
        is the surplus delta: `pre_initial_margin - post_initial_margin`.

        Key protocol details (verified empirically on mainnet, April 2026):
        - Endpoint: `/private/get_margin` (NOT `compute_margin`)
        - Parameter: `simulated_position_changes` (NOT `simulated_positions`)
        - Amount is SIGNED: negative for sells/shorts, positive for buys/longs
        - Response fields are named pre/post_initial_margin and
          pre/post_maintenance_margin. These are SURPLUS, not required.

        DO NOT use formulas. The Derive docs formula is wrong for HYPE
        (predicts ~$2/contract, actual is ~$7 for deep OTM, ~$14 ATM).
        """
        result = self._private("get_margin", {
            "subaccount_id": self.subaccount_id,
            "simulated_position_changes": [{
                "instrument_name": instrument,
                "amount": str(-abs(float(qty))),  # negative = short
            }],
        })

        pre_im = float(result.get("pre_initial_margin", 0))
        post_im = float(result.get("post_initial_margin", 0))
        pre_mm = float(result.get("pre_maintenance_margin", 0))
        post_mm = float(result.get("post_maintenance_margin", 0))

        # Surplus consumed by the new position = how much additional IM
        # it requires. If delta is negative, something's off (position would
        # free up margin), clamp to 0.
        im = max(0.0, pre_im - post_im)
        mm = max(0.0, pre_mm - post_mm)

        return {
            "initial_margin": im,
            "maintenance_margin": mm,
            "im_per_contract": im / qty if qty > 0 else 0,
            "mm_per_contract": mm / qty if qty > 0 else 0,
            "pre_im_surplus": pre_im,
            "post_im_surplus": post_im,
            "is_valid_trade": result.get("is_valid_trade", False),
        }

    def get_account_margin(self) -> dict:
        """Get current account-level margin status.

        Derive UI shows IM/MM as SURPLUS values:
          IM surplus = Portfolio Value - Required IM
          MM surplus = Portfolio Value - Required MM
        """
        collaterals_resp = self.get_collaterals()
        positions_resp = self.get_positions()

        # API returns {"collaterals": [...]} and {"positions": [...]}
        collateral_list = collaterals_resp.get("collaterals", collaterals_resp) if isinstance(collaterals_resp, dict) else collaterals_resp
        position_list = positions_resp.get("positions", positions_resp) if isinstance(positions_resp, dict) else positions_resp

        # Sum collateral values
        total_collateral = sum(
            float(c.get("mark_value", c.get("amount", 0))) for c in collateral_list
        )

        # Sum position margins
        total_im = 0.0
        total_mm = 0.0
        position_details = []

        for pos in position_list:
            amount = float(pos.get("amount", 0))
            if amount == 0:
                continue
            im = abs(float(pos.get("initial_margin", 0)))
            mm = abs(float(pos.get("maintenance_margin", 0)))
            mark = float(pos.get("mark_price", 0))
            instrument = pos.get("instrument_name", "")

            total_im += im
            total_mm += mm

            position_details.append({
                "instrument": instrument,
                "amount": amount,
                "mark": mark,
                "im": im,
                "mm": mm,
                "im_per_contract": im / abs(amount) if amount != 0 else 0,
            })

        # Equity includes unrealized P&L
        equity = total_collateral  # Collateral value already includes unrealized

        im_ratio = equity / total_im if total_im > 0 else float("inf")
        mm_ratio = equity / total_mm if total_mm > 0 else float("inf")
        utilization = total_im / equity if equity > 0 else float("inf")

        return {
            "equity": equity,
            "total_im": total_im,
            "total_mm": total_mm,
            "im_ratio": im_ratio,
            "mm_ratio": mm_ratio,
            "utilization": utilization,
            "im_surplus": equity - total_im,
            "mm_surplus": equity - total_mm,
            "positions": position_details,
        }

    def get_margin_health(self) -> list[dict]:
        """Per-position margin ratios for all open positions."""
        account = self.get_account_margin()
        results = []
        for pos in account["positions"]:
            # Per-position ratio is not directly computable from account-level equity.
            # Use account-level ratio as proxy.
            results.append({
                "instrument": pos["instrument"],
                "amount": pos["amount"],
                "mark": pos["mark"],
                "im": pos["im"],
                "im_per_contract": pos["im_per_contract"],
                "account_im_ratio": account["im_ratio"],
            })
        return results

    def monitor_margin(self) -> list[dict]:
        """Check margin and return alerts.

        Returns list of alerts:
          - ALERT: ratio below 1.5x (warning)
          - AUTO_CLOSE: ratio below 1.25x (must close)
        """
        account = self.get_account_margin()
        alerts = []

        if account["im_ratio"] < MARGIN_AUTO_CLOSE_RATIO:
            alerts.append({
                "level": "AUTO_CLOSE",
                "ratio": account["im_ratio"],
                "message": f"Margin ratio {account['im_ratio']:.2f}x below auto-close threshold {MARGIN_AUTO_CLOSE_RATIO}x",
                "equity": account["equity"],
                "required_im": account["total_im"],
            })
        elif account["im_ratio"] < MARGIN_ALERT_RATIO:
            alerts.append({
                "level": "ALERT",
                "ratio": account["im_ratio"],
                "message": f"Margin ratio {account['im_ratio']:.2f}x below alert threshold {MARGIN_ALERT_RATIO}x",
                "equity": account["equity"],
                "required_im": account["total_im"],
            })

        if account["utilization"] > MAX_MARGIN_UTILIZATION:
            alerts.append({
                "level": "ALERT",
                "ratio": account["utilization"],
                "message": f"Margin utilization {account['utilization']:.0%} exceeds {MAX_MARGIN_UTILIZATION:.0%} limit",
            })

        return alerts

    # --- Position close ---

    def auto_close_position(self, instrument: str) -> dict:
        """Buy back a short position at market via RFQ.

        Used by kill switch and auto-close when margin breaches 1.25x.
        """
        # Get current position size
        positions_resp = self.get_positions()
        positions = positions_resp.get("positions", positions_resp) if isinstance(positions_resp, dict) else positions_resp
        target = None
        for pos in positions:
            if pos.get("instrument_name") == instrument:
                target = pos
                break

        if target is None:
            return {"status": "no_position", "instrument": instrument}

        amount = abs(float(target.get("amount", 0)))
        if amount == 0:
            return {"status": "zero_amount", "instrument": instrument}

        # Send RFQ to buy back (close short)
        rfq = self.send_rfq(instrument, "buy", amount)
        rfq_id = rfq.get("rfq_id")

        if not rfq_id:
            return {"status": "rfq_failed", "instrument": instrument, "error": str(rfq)}

        # Wait for quotes (up to 20 seconds)
        best_quote = None
        for _ in range(10):
            time.sleep(2)
            quotes = self.poll_quotes(rfq_id)
            if quotes and isinstance(quotes, list):
                for q in quotes:
                    price = float(q.get("price", 0))
                    if best_quote is None or price < best_quote.get("price", float("inf")):
                        best_quote = {
                            "quote_id": q.get("quote_id"),
                            "price": price,
                            "direction": q.get("direction"),
                        }
            if best_quote:
                break

        if not best_quote:
            return {"status": "no_quotes", "instrument": instrument, "rfq_id": rfq_id}

        # Execute the best quote
        result = self.execute_quote(
            rfq_id=rfq_id,
            quote_id=best_quote["quote_id"],
            quote_direction=best_quote["direction"],
            legs_with_prices=[{
                "instrument_name": instrument,
                "direction": "buy",
                "price": best_quote["price"],
                "amount": amount,
            }],
        )

        return {
            "status": "closed",
            "instrument": instrument,
            "price": best_quote["price"],
            "amount": amount,
            "result": result,
        }

    # --- Expiring positions ---

    def get_expiring_positions(self, hours: float = 24) -> list[dict]:
        """Get positions that expire within the given time window."""
        positions_resp = self.get_positions()
        positions = positions_resp.get("positions", positions_resp) if isinstance(positions_resp, dict) else positions_resp
        cutoff = time.time() + hours * 3600
        expiring = []

        for pos in positions:
            instrument = pos.get("instrument_name", "")
            # Parse expiry from instrument name (e.g. HYPE-20260424-33-P)
            parts = instrument.split("-")
            if len(parts) >= 4 and parts[0] not in ("", "PERP"):
                try:
                    from datetime import datetime, timezone
                    expiry_str = parts[1]
                    expiry_dt = datetime.strptime(expiry_str, "%Y%m%d").replace(
                        hour=8, tzinfo=timezone.utc  # 8 AM UTC settlement
                    )
                    expiry_ts = expiry_dt.timestamp()
                    if expiry_ts <= cutoff:
                        expiring.append({
                            "instrument": instrument,
                            "amount": float(pos.get("amount", 0)),
                            "mark": float(pos.get("mark_price", 0)),
                            "expiry_ts": expiry_ts,
                            "hours_until": (expiry_ts - time.time()) / 3600,
                        })
                except (ValueError, IndexError):
                    continue

        return sorted(expiring, key=lambda p: p["expiry_ts"])

    # --- Hedge execution ---

    def hedge_rysk_buy(
        self,
        instrument: str,
        qty: float,
        rysk_price: float,
        bid_result: BidResult,
        option_delta: float,
        underlying: str = "HYPE",
        dry_run: bool = False,
    ) -> dict:
        """Orchestrate Derive hedge after winning a Rysk RFQ.

        For HYPE (thin liquidity): simultaneously RFQ on Derive + perp backstop.
        For ETH/BTC (deep liquidity): RFQ only, no backstop.
        Uses calibrated per-instrument ratios if ratio_cache available.

        option_delta: per-contract delta at current spot (required, signed:
            negative for long puts, positive for long calls). Caller must
            fetch from the Derive ticker or compute via BS. Audit M7 made
            this parameter REQUIRED: earlier drafts defaulted to 0.3 which
            silently mis-sized hedges for deep-OTM or near-ATM options.
        dry_run: if True, use NoopPerpClient (logs intent, no real orders).

        Returns dict with hedge status and details.
        """
        from scripts.arb.perp_client import get_perp_client

        result = {
            "status": "pending",
            "derive_fill": None,
            "perp_backstop": None,
            "tier": bid_result.tier,
        }

        hedge_instrument = bid_result.hedge_instrument
        perp_client = get_perp_client(underlying, dry_run=dry_run)

        # Delta notional of the option position. We just bought a Rysk option,
        # so the position delta is +qty * option_delta. To hedge:
        #   long put -> negative delta (spot falls profits us) -> LONG perp
        #   long call -> positive delta -> SHORT perp
        # Rysk gives us the Greek sign via option_delta (negative for puts,
        # positive for calls). We pass this in from the caller.
        total_delta = option_delta * qty

        # For Tier 4, hedge is entirely via perps (no Derive hedge yet).
        # The trade will be flagged as tier4_pending_migration by the caller
        # (mock_rfq, future production runner) so the migration monitor
        # will try to upgrade to Tier 1/2/3 later.
        #
        # Invariant (spec Section 4.5): never leave an unhedged window. If
        # the perp order fails or only partially fills, we must either
        # retry, escalate, or mark the position as NAKED_PENDING_MANUAL
        # so the operator sees it. We do NOT silently return success.
        if bid_result.tier == 4:
            perp_result = perp_client.hedge_delta(underlying, total_delta, urgency="urgent")
            result["perp_backstop"] = {
                "venue": perp_client.venue,
                "symbol": underlying,
                "delta": total_delta,
                "size": perp_result.filled_size,
                "avg_price": perp_result.avg_price,
                "success": perp_result.success,
                "error": perp_result.error,
            }
            result["perp_entry_delta"] = total_delta

            if not perp_result.success:
                # Perp order failed entirely (auth error, outage, precision,
                # etc). The Rysk long is NAKED. Alert loudly. Caller must
                # decide whether to close the Rysk leg early, retry the
                # perp manually, or accept directional exposure.
                result["status"] = "tier4_naked_pending_manual"
                result["initial_hedge_mode"] = "tier4_naked_pending_manual"
                result["perp_backstop"]["note"] = (
                    "PERP ORDER FAILED. Rysk long is NAKED. "
                    f"error={perp_result.error!r}"
                )
                print(f"[hedge] CRITICAL: Tier 4 perp failed, position NAKED: {perp_result.error}")
                return result

            # Partial-fill: success=True in the perp client means >=50% filled.
            # For the arb we need full delta coverage. If we have less than
            # the target, flag as partial so the operator / migration monitor
            # can schedule a top-up.
            fill_ratio = (
                perp_result.filled_size / abs(total_delta)
                if total_delta else 1.0
            )
            if fill_ratio < 0.99:
                result["status"] = "tier4_partial_hedge"
                result["initial_hedge_mode"] = "tier4_pending_migration"
                result["perp_backstop"]["fill_ratio"] = fill_ratio
                result["perp_backstop"]["note"] = (
                    f"Partial perp fill ({fill_ratio:.1%}). "
                    "Migration monitor will top up on next rebalance cycle."
                )
                print(
                    f"[hedge] WARN: Tier 4 perp partial fill "
                    f"{perp_result.filled_size:.4f} / {abs(total_delta):.4f}"
                )
                return result

            result["status"] = "perp_only_pending_migration"
            result["initial_hedge_mode"] = "tier4_pending_migration"
            result["perp_backstop"]["note"] = (
                f"Tier 4 pending migration via {perp_client.venue}"
            )
            return result

        # For Tiers 1-3: try Derive RFQ
        is_hype = underlying == "HYPE"

        # Step 1: Send Derive RFQ
        try:
            rfq = self.send_rfq(hedge_instrument, "sell", qty)
            rfq_id = rfq.get("rfq_id")
        except Exception as e:
            result["status"] = "rfq_error"
            result["error"] = str(e)
            if is_hype:
                # Full delta hedge as fallback
                perp_result = perp_client.hedge_delta(underlying, total_delta, urgency="urgent")
                result["perp_backstop"] = {
                    "venue": perp_client.venue,
                    "symbol": underlying,
                    "delta": total_delta,
                    "size": perp_result.filled_size,
                    "avg_price": perp_result.avg_price,
                    "success": perp_result.success,
                    "note": "RFQ failed, full delta perp hedge opened",
                }
            return result

        # Step 2 (HYPE only): Open perp backstop at 50% delta
        if is_hype:
            backstop_delta = total_delta * HYPE_PERP_BACKSTOP_DELTA_PCT
            perp_result = perp_client.hedge_delta(underlying, backstop_delta, urgency="urgent")
            result["perp_backstop"] = {
                "venue": perp_client.venue,
                "symbol": underlying,
                "delta": backstop_delta,
                "size": perp_result.filled_size,
                "avg_price": perp_result.avg_price,
                "success": perp_result.success,
                "note": f"{HYPE_PERP_BACKSTOP_DELTA_PCT:.0%} delta backstop via {perp_client.venue}",
            }

        # Step 3: Wait for Derive quotes
        best_quote = None
        for _ in range(8):  # 16 seconds total
            time.sleep(2)
            try:
                quotes = self.poll_quotes(rfq_id)
                if quotes and isinstance(quotes, list):
                    for q in quotes:
                        price = float(q.get("price", 0))
                        if best_quote is None or price > best_quote.get("price", 0):
                            best_quote = {
                                "quote_id": q.get("quote_id"),
                                "price": price,
                                "direction": q.get("direction"),
                            }
            except Exception:
                continue
            if best_quote:
                break

        if not best_quote:
            result["status"] = "no_derive_quotes"
            # Scale perp hedge to cover the full delta.
            # For HYPE we already opened a partial backstop, add the missing slice.
            # For non-HYPE we had no backstop, open the full hedge now.
            already_hedged = 0.0
            if is_hype and result.get("perp_backstop"):
                already_hedged = result["perp_backstop"].get("delta", 0)
            remaining_delta = total_delta - already_hedged
            top_up = perp_client.hedge_delta(underlying, remaining_delta, urgency="urgent")
            result["perp_backstop"] = {
                "venue": perp_client.venue,
                "symbol": underlying,
                "delta": total_delta,
                "size": (result["perp_backstop"].get("size", 0)
                         if result.get("perp_backstop") else 0) + top_up.filled_size,
                "avg_price": top_up.avg_price,
                "success": top_up.success,
                "note": "No Derive quotes. Full delta perp hedge.",
            }
            return result

        # Step 4: Evaluate and execute
        total_fees = (bid_result.fees.get("rysk", 0) + bid_result.fees.get("derive", 0)) / qty
        if best_quote["price"] > rysk_price + total_fees:
            # Profitable. Execute.
            try:
                exec_result = self.execute_quote(
                    rfq_id=rfq_id,
                    quote_id=best_quote["quote_id"],
                    quote_direction=best_quote["direction"],
                    legs_with_prices=[{
                        "instrument_name": hedge_instrument,
                        "direction": "sell",
                        "price": best_quote["price"],
                        "amount": qty,
                    }],
                )
                result["status"] = "hedged"
                result["derive_fill"] = {
                    "instrument": hedge_instrument,
                    "price": best_quote["price"],
                    "amount": qty,
                    "result": exec_result,
                }
                # If HYPE backstop was opened, close it now that Derive filled
                if is_hype and result.get("perp_backstop"):
                    close_result = perp_client.close_position(underlying)
                    result["perp_backstop"]["closed"] = close_result.success
                    result["perp_backstop"]["close_size"] = close_result.filled_size
                    result["perp_backstop"]["note"] = "Derive filled, perp backstop closed"
            except Exception as e:
                result["status"] = "execute_error"
                result["error"] = str(e)
        elif best_quote["price"] > rysk_price:
            # Reduced profit, still better than unhedged. Execute.
            try:
                exec_result = self.execute_quote(
                    rfq_id=rfq_id,
                    quote_id=best_quote["quote_id"],
                    quote_direction=best_quote["direction"],
                    legs_with_prices=[{
                        "instrument_name": hedge_instrument,
                        "direction": "sell",
                        "price": best_quote["price"],
                        "amount": qty,
                    }],
                )
                result["status"] = "hedged_reduced_profit"
                result["derive_fill"] = {
                    "instrument": hedge_instrument,
                    "price": best_quote["price"],
                    "amount": qty,
                    "result": exec_result,
                }
                if is_hype and result.get("perp_backstop"):
                    close_result = perp_client.close_position(underlying)
                    result["perp_backstop"]["closed"] = close_result.success
                    result["perp_backstop"]["close_size"] = close_result.filled_size
                    result["perp_backstop"]["note"] = "Derive filled (reduced profit), perp closed"
            except Exception as e:
                result["status"] = "execute_error"
                result["error"] = str(e)
        else:
            # Quote too low. Scale perp hedge to full delta and post limit on Derive.
            result["status"] = "limit_posted"
            result["derive_fill"] = {
                "instrument": hedge_instrument,
                "action": "post_limit_sell",
                "price": best_quote["price"],
                "note": "Quote too low. Posted limit sell on Derive orderbook.",
            }
            already_hedged = (result["perp_backstop"].get("delta", 0)
                              if result.get("perp_backstop") else 0)
            remaining_delta = total_delta - already_hedged
            if abs(remaining_delta) > 0:
                top_up = perp_client.hedge_delta(underlying, remaining_delta, urgency="urgent")
                result["perp_backstop"] = {
                    "venue": perp_client.venue,
                    "symbol": underlying,
                    "delta": total_delta,
                    "size": ((result["perp_backstop"].get("size", 0)
                              if result.get("perp_backstop") else 0) + top_up.filled_size),
                    "avg_price": top_up.avg_price,
                    "success": top_up.success,
                    "note": "Derive quote too low. Scaled perp to full delta.",
                }

        return result

    # --- Sell on orderbook ---

    def sell_on_orderbook(self, instrument: str, qty: float, price: float) -> dict:
        """Place a sell limit order on Derive orderbook.

        Pre-flight checks:
        1. Margin available
        2. Position limits
        """
        # Check margin first
        margin = self.query_margin(instrument, qty)
        account = self.get_account_margin()

        if account["utilization"] + (margin["initial_margin"] / account["equity"]) > MAX_MARGIN_UTILIZATION:
            return {
                "status": "margin_exceeded",
                "required": margin["initial_margin"],
                "available": account["equity"] * MAX_MARGIN_UTILIZATION - account["total_im"],
            }

        # Place order
        result = self.place_order(
            instrument_name=instrument,
            direction="sell",
            amount=qty,
            price=price,
            order_type="limit",
            time_in_force="gtc",
        )

        return {
            "status": "placed",
            "instrument": instrument,
            "qty": qty,
            "price": price,
            "margin_used": margin["initial_margin"],
            "result": result,
        }

    # --- Print margin status ---

    def print_margin_status(self):
        """Console output of current margin health."""
        account = self.get_account_margin()

        print("=" * 60)
        print("  DERIVE MARGIN STATUS")
        print("=" * 60)
        print(f"\n  Equity:              ${account['equity']:>12,.2f}")
        print(f"  Required IM:         ${account['total_im']:>12,.2f}")
        print(f"  Required MM:         ${account['total_mm']:>12,.2f}")
        print(f"  IM Surplus:          ${account['im_surplus']:>12,.2f}")
        print(f"  MM Surplus:          ${account['mm_surplus']:>12,.2f}")
        print(f"  IM Ratio:            {account['im_ratio']:>12.2f}x")
        print(f"  MM Ratio:            {account['mm_ratio']:>12.2f}x")
        print(f"  Utilization:         {account['utilization']:>11.0%}")

        # Thresholds
        status = "OK"
        if account["im_ratio"] < MARGIN_AUTO_CLOSE_RATIO:
            status = "AUTO-CLOSE"
        elif account["im_ratio"] < MARGIN_ALERT_RATIO:
            status = "WARNING"
        elif account["utilization"] > MAX_MARGIN_UTILIZATION:
            status = "OVER-UTILIZED"
        print(f"  Status:              {status:>12}")

        if account["positions"]:
            print(f"\n{'':2}{'Instrument':<28}{'Amt':>8}{'Mark':>8}{'IM':>10}{'IM/ct':>8}")
            print(f"{'':2}{'-'*62}")
            for p in account["positions"]:
                inst = p["instrument"][:26]
                print(
                    f"{'':2}{inst:<28}{p['amount']:>8.0f}"
                    f"{p['mark']:>8.2f}{p['im']:>10.2f}{p['im_per_contract']:>8.2f}"
                )

        # Alerts
        alerts = self.monitor_margin()
        if alerts:
            print(f"\n  ALERTS:")
            for a in alerts:
                print(f"  [{a['level']}] {a['message']}")

        print(f"\n{'=' * 60}")
