"""Rysk maker listener loop.

Observes all incoming RFQs (both directions), runs each through our
pricing engine, and optionally submits quotes on the arb direction.

Direction handling (Option B from strategy review):
- isTakerBuy=false (taker sells, we buy): our primary arb direction.
  Run calculate_bid, check limits, submit quote if profitable.
- isTakerBuy=true (taker buys, we sell): log only. We don't have a
  symmetric calculate_ask yet, and RYSK_QUOTE_BOTH_SIDES is False by
  default. Observation data helps us decide later whether the sell
  side is worth building.

Testnet vs mainnet data separation:
- Testnet RFQs are LIKELY self-trades or other-MM tests; not organic flow.
- All testnet observations go to RYSK_TESTNET_OBSERVATIONS_LOG.
- They are NEVER fed into calibration pipelines (trade_logger, feedback,
  tier4-decisions). Testnet validates code; mainnet calibrates strategy.
"""

import json
import os
import signal
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Optional

from scripts.arb.config import (
    MAX_OPTIONS_CAPITAL,
    RYSK_MAINNET_OBSERVATIONS_LOG,
    RYSK_QUOTE_BOTH_SIDES,
    RYSK_TESTNET_OBSERVATIONS_LOG,
)
from scripts.arb.rysk_client import (
    RyskMakerClient,
    RyskQuote,
    RyskRequest,
)


class RyskListener:
    """Production observation loop for Rysk RFQs.

    Composed from: Rysk maker client (message pump), MarkCache / RatioCache
    (pricing inputs), PnLTracker (record wins), Derive client (margin check).
    """

    def __init__(
        self,
        env: str = "testnet",
        cache=None,
        ratio_cache=None,
        tracker=None,
        derive_client=None,
        maker_address: str = "",
    ):
        self.env = env
        self.cache = cache
        self.ratio_cache = ratio_cache
        self.tracker = tracker
        self.derive_client = derive_client
        self.maker_address = maker_address

        self.rysk = RyskMakerClient(env=env)
        self.rysk.on_request(self._on_rfq)
        self.rysk.on_response(self._on_maker_response)

        # Fall back to the client's resolved wallet if the caller didn't pass one
        if not self.maker_address and self.rysk.wallet:
            self.maker_address = self.rysk.wallet

        self.log_file = (
            RYSK_TESTNET_OBSERVATIONS_LOG
            if env == "testnet"
            else RYSK_MAINNET_OBSERVATIONS_LOG
        )
        self._ensure_log_dir()

        # Runtime counters
        self.stats = {
            "rfqs_seen": 0,
            "buy_direction": 0,   # isTakerBuy=false
            "sell_direction": 0,  # isTakerBuy=true
            "bids_computed": 0,
            "quotes_submitted": 0,
            "quotes_skipped_direction": 0,
            "quotes_skipped_limits": 0,
            "quotes_skipped_unprofitable": 0,
            "trades_won": 0,
            "hedges_attempted": 0,
            "hedges_skipped_testnet": 0,
            "errors": 0,
        }

        # Pending quotes: rfq_id -> { request, bid, quote, submit_ts }
        # We need this to correlate an incoming trade notification back to
        # the original Rysk RFQ + our bid so PnLTracker.record_rysk_buy can
        # be called with the full context (tier, expected Derive price,
        # tier confidence). A fixed-size dict keeps memory bounded; unmatched
        # entries age out naturally after each RFQ's 60s validity window.
        self._pending_quotes: dict[str, dict] = {}
        self._pending_quotes_max = 200
        # Parallel index: quote_nonce -> rfq_id. Server trade notifications
        # arrive with `id="trade"` (not the rfq_id) and reference our quote
        # by `quoteNonce`. We need to look up the original RFQ context by
        # the nonce we generated when we signed the quote. Confirmed against
        # a real Base Sepolia trade tx 0x06453d27... on 2026-04-07.
        self._pending_by_nonce: dict[str, str] = {}

    def _remember_pending_quote(self, rfq_id: str, entry: dict):
        """Store a just-submitted quote so we can match it to a trade later.

        The nonce index is keyed by str(nonce) on both write and read sides.
        RyskQuote.nonce is a string today, but the wire-side `quoteNonce`
        in trade notifications is also delivered as a string by Rysk. We
        coerce both ends to str() defensively so a future int-typed nonce
        can't silently break trade matching (would degrade to "unmatched
        trade notification" logs while real fills go untracked).
        """
        if len(self._pending_quotes) >= self._pending_quotes_max:
            # Drop the oldest entry (dict insertion order = chronological)
            oldest_rfq_id = next(iter(self._pending_quotes))
            oldest_entry = self._pending_quotes.pop(oldest_rfq_id, None)
            # Also evict from the nonce index so it doesn't grow unbounded
            if oldest_entry is not None:
                oldest_quote = oldest_entry.get("quote")
                oldest_nonce = getattr(oldest_quote, "nonce", None)
                if oldest_nonce is not None:
                    self._pending_by_nonce.pop(str(oldest_nonce), None)
        entry["submit_ts"] = time.time()
        self._pending_quotes[rfq_id] = entry
        quote = entry.get("quote")
        nonce = getattr(quote, "nonce", None)
        if nonce is not None:
            self._pending_by_nonce[str(nonce)] = rfq_id

    def _ensure_log_dir(self):
        os.makedirs(os.path.dirname(self.log_file) or ".", exist_ok=True)

    def _write_observation(self, entry: dict):
        entry["timestamp"] = time.time()
        entry["iso"] = datetime.now(timezone.utc).isoformat()
        entry["env"] = self.env
        with open(self.log_file, "a") as f:
            f.write(json.dumps(entry) + "\n")

    # --- RFQ handling ---

    def _on_rfq(self, req: RyskRequest):
        self.stats["rfqs_seen"] += 1
        if req.is_taker_buy:
            self.stats["sell_direction"] += 1
        else:
            self.stats["buy_direction"] += 1

        base_obs = {
            "event": "rfq_received",
            "request_id": req.request_id,
            "asset": req.asset,
            "asset_name": req.asset_name,
            "chain_id": req.chain_id,
            "expiry_ts": req.expiry,
            "is_put": req.is_put,
            "is_taker_buy": req.is_taker_buy,
            "direction_label": req.direction_label,
            "strike": req.strike,
            "strike_float": req.strike_float,
            "quantity": req.quantity,
            "quantity_float": req.quantity_float,
            "taker": req.taker,
            "usd": req.usd,
            "collateral_asset": req.collateral_asset,
        }

        print(
            f"[rfq] {req.asset_name} {req.option_type} "
            f"strike=${req.strike_float:.2f} qty={req.quantity_float:.2f} "
            f"direction={req.direction_label}"
        )

        # Route on direction
        if req.is_taker_buy:
            # We would be selling. Not implemented in Phase 1 arb.
            obs = dict(base_obs)
            obs["decision"] = "skipped_direction"
            obs["reason"] = "sell side (isTakerBuy=true) not implemented in Phase 1"
            self._write_observation(obs)
            self.stats["quotes_skipped_direction"] += 1

            # But we DO compute a notional ask value for observation/data
            # (future calculate_ask work can use this to validate the reverse)
            if self.cache is not None:
                obs["observation_note"] = (
                    "Sell-side math not implemented. Would need calculate_ask"
                    " and Derive buy-side fills."
                )
                self._write_observation(obs)

            if not RYSK_QUOTE_BOTH_SIDES:
                return

        # Buy direction (our arb). Compute bid.
        #
        # Pricing path depends on env:
        # - testnet (Base Sepolia): no Derive marks exist for WETH/WBTC options
        #   on this chain, so calculate_bid would always return None. Use the
        #   testnet_pricer (BS-based, Coinbase spot, conservative discount).
        # - mainnet (HyperEVM): full Derive-backed pricing via MarkCache.
        if self.env == "testnet":
            from scripts.arb.testnet_pricer import calculate_testnet_bid

            try:
                bid = calculate_testnet_bid(request=req)
            except Exception as e:
                obs = dict(base_obs)
                obs["decision"] = "error_calculate_testnet_bid"
                obs["error"] = str(e)
                self._write_observation(obs)
                self.stats["errors"] += 1
                return
        else:
            if self.cache is None:
                obs = dict(base_obs)
                obs["decision"] = "skipped_no_cache"
                obs["reason"] = "MarkCache not injected; listener running in observe-only mode"
                self._write_observation(obs)
                return

            from scripts.arb.pricing import calculate_bid

            try:
                bid = calculate_bid(
                    cache=self.cache,
                    underlying=req.asset_name,
                    strike=req.strike_float,
                    expiry_ts=req.expiry,
                    option_type=req.option_type,
                    qty=req.quantity_float,
                    ratio_cache=self.ratio_cache,
                )
            except Exception as e:
                obs = dict(base_obs)
                obs["decision"] = "error_calculate_bid"
                obs["error"] = str(e)
                self._write_observation(obs)
                self.stats["errors"] += 1
                return

        if bid is None:
            obs = dict(base_obs)
            obs["decision"] = "pass_no_profitable_tier"
            self._write_observation(obs)
            self.stats["quotes_skipped_unprofitable"] += 1
            return

        self.stats["bids_computed"] += 1

        # Attach bid details to observation
        base_obs["bid_max"] = bid.max_bid
        base_obs["bid_tier"] = bid.tier
        base_obs["bid_confidence"] = bid.confidence
        base_obs["bid_reasoning"] = bid.reasoning
        base_obs["bid_hedge_instrument"] = bid.hedge_instrument
        base_obs["bid_fees"] = bid.fees

        # Limits check.
        #
        # On mainnet, full cross-venue position limits via pricing.check_limits.
        # On testnet, skip: we have no MarkCache (required for cache.get_spot),
        # testnet capital is synthetic and effectively unlimited, and the goal
        # is to exercise code paths under real Rysk protocol pressure rather
        # than enforce capital discipline. Exercising the limits logic itself
        # is covered by unit tests, not the live testnet loop.
        #
        # Audit M9: this skip is deliberately paired with the testnet
        # pricer's TESTNET_BID_DISCOUNT = 0.50 (50% of BS fair). That
        # posture is genuinely uncompetitive by design, so even without
        # a limits gate the bot almost never wins quotes and never
        # accumulates meaningful testnet inventory.
        if self.env == "testnet":
            base_obs["limits_ok"] = True
            base_obs["limits_reason"] = "testnet: limits check skipped"
        else:
            # Audit H8 fix: on mainnet we MUST have a live Derive client to
            # produce a real account_equity figure. Earlier drafts would
            # fall back to MAX_OPTIONS_CAPITAL as a fake equity, which
            # made check_limits rubber-stamp every bid because projected
            # utilization ≈ 0. Refuse to submit when we cannot see real
            # cross-venue state.
            if self.derive_client is None:
                base_obs["decision"] = "blocked_no_derive_client"
                base_obs["reason"] = (
                    "mainnet requires a live ArbDeriveClient for check_limits; "
                    "refusing to bid without cross-venue equity visibility"
                )
                self._write_observation(base_obs)
                self.stats["quotes_skipped_limits"] += 1
                print("[quote] REFUSED: mainnet bid requires Derive client for limits")
                return

            from scripts.arb.pricing import check_limits

            try:
                account = self.derive_client.get_account_margin()
                account_equity = float(account["equity"])
                account_current_im = float(account["total_im"])
            except Exception as e:
                base_obs["decision"] = "error_derive_margin"
                base_obs["error"] = str(e)
                self._write_observation(base_obs)
                self.stats["errors"] += 1
                print(f"[quote] ERROR fetching Derive margin: {e}")
                return

            current_positions = []
            if self.tracker is not None:
                current_positions = [
                    {
                        "underlying": t.underlying,
                        "premium_notional": t.premium_notional,
                        "capital_deployed": t.capital_deployed,
                        "hedge_status": t.hedge_status,
                    }
                    for t in self.tracker.get_open_trades()
                ]

            try:
                allowed, reason = check_limits(
                    bid=bid,
                    qty=req.quantity_float,
                    spot=self.cache.get_spot(req.asset_name) or 0,
                    cache=self.cache,
                    current_positions=current_positions,
                    underlying=req.asset_name,
                    account_equity=account_equity,
                    account_current_im=account_current_im,
                )
            except Exception as e:
                obs = dict(base_obs)
                obs["decision"] = "error_check_limits"
                obs["error"] = str(e)
                self._write_observation(obs)
                self.stats["errors"] += 1
                return

            base_obs["limits_ok"] = allowed
            base_obs["limits_reason"] = reason

            if not allowed:
                base_obs["decision"] = "blocked_limits"
                self._write_observation(base_obs)
                self.stats["quotes_skipped_limits"] += 1
                return

        # All checks passed: submit the quote
        quote = RyskQuote(
            asset_address=req.asset,
            chain_id=req.chain_id,
            expiry=req.expiry,
            is_put=req.is_put,
            is_taker_buy=req.is_taker_buy,
            maker=self.maker_address,
            nonce=str(int(time.time() * 1_000_000)),  # microsecond unique
            price=str(int(bid.max_bid * 1e18)),
            quantity=req.quantity,
            strike=req.strike,
            valid_until=int(time.time()) + 30,
            usd=req.usd,
            collateral_asset=req.collateral_asset,
        )

        try:
            submission = self.rysk.submit_quote(quote, req.request_id)
            stderr_out = submission.get("stderr", "") or ""
            base_obs["submission_stdout"] = submission.get("stdout", "")
            base_obs["submission_stderr"] = stderr_out

            # The Go CLI writes errors to stderr without setting a non-zero
            # exit status in some cases (e.g. "invalid hex character 'x' in
            # private key"), so we must inspect stderr ourselves. Anything
            # with visible content that doesn't look like a timestamp-only
            # INFO line is treated as a submission failure.
            error_like = any(
                token in stderr_out.lower()
                for token in ["error", "invalid", "failed", "refused", "panic"]
            )
            if error_like:
                base_obs["decision"] = "error_submit"
                self._write_observation(base_obs)
                self.stats["errors"] += 1
                print(
                    f"[quote] CLI stderr rejected ${bid.max_bid:.4f} "
                    f"for {req.asset_name} {req.option_type} "
                    f"${req.strike_float:.2f}: {stderr_out.strip()}"
                )
            else:
                base_obs["decision"] = "submitted"
                self._write_observation(base_obs)
                self.stats["quotes_submitted"] += 1
                # Remember this quote so we can correlate an incoming trade
                # notification back to the RFQ + bid context.
                self._remember_pending_quote(
                    req.request_id,
                    {
                        "request": req,
                        "bid": bid,
                        "quote": quote,
                    },
                )
                print(
                    f"[quote] Submitted ${bid.max_bid:.4f} tier={bid.tier} "
                    f"for {req.asset_name} {req.option_type} ${req.strike_float:.2f}"
                )
        except Exception as e:
            base_obs["decision"] = "error_submit"
            base_obs["error"] = str(e)
            self._write_observation(base_obs)
            self.stats["errors"] += 1
            print(f"[quote] ERROR submitting: {e}")

    def _on_maker_response(self, data: dict):
        """Handle /maker channel responses (OK, skill_issue, trade, errors).

        The Rysk server streams several message types on /maker:
        1. Server-side error responses to quotes/transfers we submitted
        2. "skill_issue" (a.k.a. outbid) notifications
        3. QuoteNotification (someone quoted better) - not yet used
        4. Trade notifications when our quote WINS and a trade is matched

        Category 4 is the one we care about for wiring the hedge path. The
        exact shape of a win notification is not documented in the public
        Go CLI or TS SDK (they define Request / Quote / QuoteNotification
        but no Trade type) so we parse defensively: look for an "id" that
        matches a pending quote AND a "result" payload containing price
        or fill fields. When matched, record the trade and call the hedge
        orchestrator (mainnet only).
        """
        entry = {
            "event": "maker_response",
            "raw": data,
        }
        self._write_observation(entry)

        # Server-side error response to a quote/transfer we submitted
        if isinstance(data, dict) and data.get("error"):
            err = data.get("error", {})
            code = err.get("code")
            message = err.get("message")
            self.stats["errors"] += 1
            print(
                f"[maker error] code={code} msg={message!r} "
                f"id={data.get('id', '')}"
            )
            return

        # Check for explicit method field (JSON-RPC notification from server)
        method = data.get("method", "") if isinstance(data, dict) else ""
        result = data.get("result") if isinstance(data, dict) else None
        msg_id = data.get("id") if isinstance(data, dict) else None

        # skill_issue = outbid by another maker
        if method == "skill_issue":
            print(f"[outbid] {json.dumps(data)[:300]}")
            return

        # Trade/win detection.
        #
        # Confirmed shape from a real Base Sepolia trade on 2026-04-07
        # (txHash 0x06453d27bf4ed1b4943252f166b0fb91b16b030a20fa6b3a09be38aa1e3efe6e):
        # the server sends a JSON-RPC response with `id="trade"` (literal
        # string, NOT the rfq_id) and `result` containing the full trade
        # struct: maker, taker, price, quantity, strike, txHash, mark,
        # quoteNonce, quoteSignature, fees, etc. Match by `quoteNonce`
        # which references the nonce we generated when we signed.
        #
        # Speculative whitelist (the older theoretical shapes) is kept
        # so unit tests in test_trade_detection.py still cover defensive
        # parsing of unknown variants.
        TRADE_KEY_WHITELIST = {
            "tradeId", "trade_id",
            "filled", "filledSize", "filled_size",
            "executedPrice", "executed_price",
            "fillPrice", "fill_price",
        }
        is_trade = False
        match_rfq_id = None
        quote_nonce = None  # Hoisted: needed for unconditional index cleanup
        # Primary: real Rysk shape - id=="trade" with txHash or quoteNonce
        if (
            isinstance(result, dict)
            and msg_id == "trade"
            and ("txHash" in result or "quoteNonce" in result)
        ):
            is_trade = True
            quote_nonce = result.get("quoteNonce")
            if quote_nonce is not None:
                match_rfq_id = self._pending_by_nonce.get(str(quote_nonce))
        # Defensive fallbacks (older speculative shapes; unit tests cover these)
        elif method == "trade":
            is_trade = True
            match_rfq_id = msg_id if msg_id in self._pending_quotes else None
        elif isinstance(result, dict) and msg_id and msg_id in self._pending_quotes:
            if TRADE_KEY_WHITELIST & set(result.keys()):
                is_trade = True
                match_rfq_id = msg_id
            else:
                # Log partial-match candidates so we can tune the whitelist
                # once we see new shapes. Any response for a pending quote
                # id that isn't a trade is still interesting.
                print(
                    f"[maker] unknown response for pending quote id={msg_id}: "
                    f"keys={list(result.keys())}"
                )

        if not is_trade:
            # Unknown message shape - log and move on. Seeing this in the
            # observation log helps us learn what non-error /maker traffic
            # actually looks like during live runs.
            return

        self.stats["trades_won"] += 1
        tx_hash = result.get("txHash") if isinstance(result, dict) else None
        print(
            f"[trade] WON id={msg_id} "
            f"{'tx=' + tx_hash + ' ' if tx_hash else ''}"
            f"{json.dumps(data)[:400]}"
        )

        # Correlate back to the original RFQ + bid context
        pending = None
        if match_rfq_id is not None:
            pending = self._pending_quotes.pop(match_rfq_id, None)
            # Cleanup: pop the nonce we used to find this match. Idempotent
            # via .pop(..., None). The pending entry's own quote.nonce is
            # also popped below (defensive: in pathological desync cases
            # the stored nonce may differ from the lookup nonce). Coerce
            # to str() to mirror how the index was populated and tolerate
            # any future int-typed nonce.
            if pending is not None:
                pq = pending.get("quote")
                pq_nonce = getattr(pq, "nonce", None)
                if pq_nonce is not None:
                    self._pending_by_nonce.pop(str(pq_nonce), None)
        # Always clean the quote_nonce we used for the lookup, even if the
        # _pending_quotes pop returned None. This prevents the index from
        # leaking on a desync between the two maps (e.g., manual cleanup
        # elsewhere, or a race in a future threaded variant).
        if quote_nonce is not None:
            self._pending_by_nonce.pop(str(quote_nonce), None)
        if pending is None:
            # We saw a trade we can't match to our pending book. Log loudly.
            print(
                f"[trade] WARNING: unmatched trade notification id={msg_id} "
                f"quoteNonce={quote_nonce}"
            )
            return

        req = pending["request"]
        bid = pending["bid"]
        quote = pending["quote"]

        # Extract fill price from the trade notification if present, otherwise
        # fall back to the bid we submitted (the price we said we'd pay).
        fill_price = bid.max_bid
        if isinstance(result, dict):
            for k in ("price", "fill_price", "executedPrice", "filled_price"):
                if k in result:
                    try:
                        raw_price = float(result[k])
                        # Rysk uses e18 for prices - if the number looks e18-scaled,
                        # normalize it. A real per-contract price is typically <$1000,
                        # so anything over 1e10 is almost certainly e18 encoded.
                        fill_price = raw_price / 1e18 if raw_price > 1e10 else raw_price
                    except (TypeError, ValueError):
                        pass
                    break

        # Record the Rysk buy leg in the P&L tracker (mainnet only - testnet
        # should never pollute the mainnet calibration pipelines)
        if self.tracker is not None and self.env == "mainnet":
            try:
                spot = (
                    self.cache.get_spot(req.asset_name)
                    if self.cache is not None else 0.0
                ) or 0.0
                trade_record = self.tracker.record_rysk_buy(
                    underlying=req.asset_name,
                    option_type=req.option_type,
                    strike=req.strike_float,
                    expiry_ts=req.expiry,
                    qty=req.quantity_float,
                    rysk_instrument=bid.hedge_instrument or "",
                    rysk_price=fill_price,
                    spot=spot,
                    tier=bid.tier,
                    expected_derive_price=bid.tier_value,
                    tier_confidence=bid.confidence,
                )
                print(
                    f"[trade] recorded trade_id={trade_record.id} "
                    f"{req.asset_name} {req.option_type} ${req.strike_float:.2f}"
                )
            except Exception as e:
                print(f"[trade] PnLTracker record failed: {e}")
                self.stats["errors"] += 1

        # Trigger hedge orchestration (mainnet only). Testnet has no Derive
        # on Base Sepolia, so there is nothing to hedge against.
        if self.env == "testnet":
            self.stats["hedges_skipped_testnet"] += 1
            print("[trade] testnet: skipping hedge_rysk_buy (no Derive on Base Sepolia)")
            return

        if self.derive_client is None:
            print("[trade] no derive_client injected; hedge path not triggered")
            return

        # Fetch the live option delta from the Derive ticker so hedge
        # sizing matches the actual position Greek, not a hardcoded guess.
        # If we can't get delta, we cannot safely size the perp hedge.
        option_delta = self._fetch_option_delta(req, bid)
        if option_delta is None:
            print(
                "[trade] cannot determine option delta; skipping hedge. "
                "Position is NAKED pending manual intervention."
            )
            self.stats["errors"] += 1
            return

        self.stats["hedges_attempted"] += 1
        try:
            hedge_result = self.derive_client.hedge_rysk_buy(
                instrument=bid.hedge_instrument or "",
                qty=req.quantity_float,
                rysk_price=fill_price,
                bid_result=bid,
                option_delta=option_delta,
                underlying=req.asset_name,
                dry_run=False,
            )
            print(
                f"[trade] hedge_rysk_buy status={hedge_result.get('status')} "
                f"tier={hedge_result.get('tier')}"
            )
            # Note: record_derive_hedge / record_perp_hedge plumbing is a
            # separate follow-up. Leaving minimal for now so we can iterate
            # once we observe a real trade notification from the server.
        except Exception as e:
            print(f"[trade] hedge_rysk_buy FAILED: {e}")
            self.stats["errors"] += 1

    def _fetch_option_delta(self, req, bid) -> Optional[float]:
        """Compute the per-contract signed option delta.

        Used by the trade-win hedge path so the perp sizing matches the
        real Greek (negative for long puts, positive for long calls).
        Tries cache.find_exact_match.iv first, then falls back to a
        tight-range BS estimate. Returns None if no data is available;
        the caller must refuse to hedge in that case rather than guess.
        """
        if self.cache is None:
            return None
        spot = self.cache.get_spot(req.asset_name)
        if spot is None or spot <= 0:
            return None

        exact = self.cache.find_exact_match(
            req.asset_name, req.strike_float, req.expiry, req.option_type,
        )
        if exact is None or exact.iv <= 0:
            return None

        from scripts.arb.pricing import normal_cdf
        import math
        t_years = max(1e-6, (req.expiry - time.time()) / (365.25 * 86400))
        d1 = (
            math.log(spot / req.strike_float) + (0.05 + exact.iv ** 2 / 2) * t_years
        ) / (exact.iv * math.sqrt(t_years))
        if req.option_type == "P":
            return normal_cdf(d1) - 1  # negative for puts
        return normal_cdf(d1)  # positive for calls

    # --- Runtime ---

    def run(self, assets: list[str]):
        """Start the listener and block until SIGINT."""
        print(f"[listener] env={self.env}, subscribing to {len(assets)} assets")
        print(f"[listener] log: {self.log_file}")

        def _shutdown(sig, frame):
            print("\n[listener] shutting down")
            self.rysk.stop()
            self._print_summary()
            sys.exit(0)

        signal.signal(signal.SIGINT, _shutdown)
        signal.signal(signal.SIGTERM, _shutdown)

        self.rysk.start(subscribe_assets=assets)
        print("[listener] running. Ctrl-C to stop.")

        try:
            while True:
                time.sleep(60)
                # Periodic heartbeat stats
                print(f"[heartbeat] {self.stats}")
        except KeyboardInterrupt:
            _shutdown(None, None)

    def _print_summary(self):
        print("\n[listener] final stats:")
        for k, v in self.stats.items():
            print(f"  {k}: {v}")
