#!/usr/bin/env python3
"""Unified CLI for the options arb infrastructure.

Usage:
  python scripts/arb/cli.py cache      -- Start mark cache, print refreshes
  python scripts/arb/cli.py price      -- Calculate bid for hypothetical RFQ
  python scripts/arb/cli.py margin     -- Show Derive margin health
  python scripts/arb/cli.py positions  -- Show all open positions
  python scripts/arb/cli.py report     -- Full P&L report
  python scripts/arb/cli.py limits     -- Position limits vs current usage
  python scripts/arb/cli.py settle     -- Settle expired trades
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from typing import Optional

# Allow running as `python scripts/arb/cli.py` from project root
_project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from scripts.arb.config import (
    CACHE_REFRESH_INTERVAL,
    DEFAULT_EXEC_RATIO,
    EXECUTION_RATIOS,
    MARGIN_ALERT_RATIO,
    MARGIN_AUTO_CLOSE_RATIO,
    MAX_MARGIN_UTILIZATION,
    MAX_NET_DELTA,
    MAX_OPEN_POSITIONS,
    MAX_OPTIONS_CAPITAL,
    MAX_PER_UNDERLYING,
    MAX_SINGLE_POSITION,
    MAX_UNHEDGED_INVENTORY,
)
from scripts.arb.pricing import (
    MarkCache,
    RatioCache,
    black_scholes_call,
    black_scholes_put,
    calculate_bid,
    check_limits,
)
from scripts.arb.pnl import PnLTracker


def cmd_cache(args):
    """Start mark cache and print refreshes continuously."""
    from scripts.arb.derive_om import ArbDeriveClient

    client = ArbDeriveClient(testnet=args.testnet)
    cache = MarkCache(client)
    underlyings = tuple(args.underlyings.split(","))

    print(f"Starting mark cache for {underlyings}...")
    print(f"Refresh interval: {CACHE_REFRESH_INTERVAL}s")
    print(f"Press Ctrl+C to stop.\n")

    try:
        while True:
            t0 = time.time()
            cache.refresh(underlyings=underlyings)
            elapsed = time.time() - t0

            now = datetime.now(timezone.utc).strftime("%H:%M:%S")
            print(f"[{now}] Refreshed {cache.fresh_count}/{len(cache)} instruments in {elapsed:.1f}s")

            # Print a few sample marks
            for inst in list(cache.instruments)[:5]:
                mark = cache.get(inst)
                if mark:
                    print(
                        f"  {inst:<28} mark=${mark.derive_mark:>8.4f}  "
                        f"bid=${mark.derive_bid:>8.4f}  ask=${mark.derive_ask:>8.4f}  "
                        f"IV={mark.iv:.0%}  IM/ct=${mark.margin_per_contract:.2f}"
                    )
            if len(cache) > 5:
                print(f"  ... and {len(cache) - 5} more")

            time.sleep(CACHE_REFRESH_INTERVAL)
    except KeyboardInterrupt:
        print("\nCache stopped.")


def cmd_price(args):
    """Calculate bid for a hypothetical Rysk RFQ."""
    from scripts.arb.derive_om import ArbDeriveClient

    client = ArbDeriveClient(testnet=args.testnet)
    cache = MarkCache(client)

    print(f"Refreshing cache for {args.underlying}...")
    cache.refresh(underlyings=(args.underlying,))
    spot = cache.get_spot(args.underlying)

    if spot is None:
        print(f"ERROR: Could not get {args.underlying} spot price.")
        sys.exit(1)

    print(f"Spot: ${spot:.2f}")
    print(f"Cached {cache.fresh_count} instruments.")

    # Build ratio cache (per-instrument historical fill ratios)
    print(f"Fetching trade history for ratio calibration...")
    ratio_cache = RatioCache(client)
    t0 = time.time()
    ratio_cache.refresh(cache.instruments)
    print(f"  Cached {ratio_cache.instrument_count} instrument ratios in {time.time() - t0:.1f}s\n")

    # Parse expiry
    expiry_dt = datetime.strptime(args.expiry, "%Y-%m-%d").replace(
        hour=8, tzinfo=timezone.utc
    )
    expiry_ts = int(expiry_dt.timestamp())

    # Calculate bid
    result = calculate_bid(
        cache=cache,
        underlying=args.underlying,
        strike=args.strike,
        expiry_ts=expiry_ts,
        option_type=args.type,
        qty=args.qty,
        ratio_cache=ratio_cache,
    )

    if result is None:
        print("RESULT: PASS (no profitable tier available)")
        print("\nDiagnostics:")
        exact = cache.find_exact_match(args.underlying, args.strike, expiry_ts, args.type)
        if exact:
            er = EXECUTION_RATIOS.get(args.underlying, DEFAULT_EXEC_RATIO)
            print(f"  Exact match found: {exact.instrument}")
            print(f"  Derive mark: ${exact.derive_mark:.4f}")
            print(f"  Expected fill: ${exact.derive_mark * er:.4f} (ratio {er})")
        else:
            print("  No exact match in cache")
            adjs = cache.find_adjacent_strikes(args.underlying, args.strike, expiry_ts, args.type)
            if adjs:
                print(f"  Adjacent strikes: {[a.instrument for a in adjs]}")
            else:
                print("  No adjacent strikes found")
        return

    print("=" * 50)
    print(f"  RESULT: BID ${result.max_bid:.4f}/contract")
    print(f"  Tier:       {result.tier}")
    print(f"  Confidence: {result.confidence:.0%}")
    print(f"  Reasoning:  {result.reasoning}")
    print(f"\n  Fees (for {args.qty} contracts):")
    for k, v in result.fees.items():
        print(f"    {k}: ${v:.2f}")
    print(f"  Hedge on: {result.hedge_instrument}")

    # Check limits
    tracker = PnLTracker()
    current = [
        {
            "underlying": t.underlying,
            "premium_notional": t.premium_notional,
            "capital_deployed": t.capital_deployed,
            "hedge_status": t.hedge_status,
        }
        for t in tracker.get_open_trades()
    ]

    # Account margin: always try to get live values.
    # Fall back to MAX_OPTIONS_CAPITAL (the warmup allocation) if API unavailable.
    account_equity = float(MAX_OPTIONS_CAPITAL)
    account_current_im = 0.0
    try:
        account = client.get_account_margin()
        account_equity = account["equity"]
        account_current_im = account["total_im"]
    except Exception as e:
        print(f"\n  (Account margin unavailable: {e}. Using warmup default ${account_equity:.0f})")

    allowed, reason = check_limits(
        result, args.qty, spot, cache, current,
        underlying=args.underlying,
        account_equity=account_equity,
        account_current_im=account_current_im,
    )
    print(f"\n  Limits check: {'PASS' if allowed else 'BLOCKED'}")
    if not allowed:
        print(f"  Reason: {reason}")
    print("=" * 50)

    # BS reference
    t_years = max(0, (expiry_ts - time.time()) / (365.25 * 86400))
    if args.type == "P":
        bs = black_scholes_put(spot, args.strike, t_years, 1.2)  # Rough IV
    else:
        bs = black_scholes_call(spot, args.strike, t_years, 1.2)
    print(f"\n  BS reference (120% IV): ${bs:.4f}")


def cmd_margin(args):
    """Show Derive margin health."""
    from scripts.arb.derive_om import ArbDeriveClient

    client = ArbDeriveClient(testnet=args.testnet)
    client.print_margin_status()


def cmd_positions(args):
    """Show all open positions from the trade book."""
    tracker = PnLTracker()
    open_trades = tracker.get_open_trades()

    if not open_trades:
        print("No open positions.")
        return

    print("=" * 70)
    print("  OPEN POSITIONS")
    print("=" * 70)
    print(f"\n{'':2}{'ID':<10}{'Underlying':<8}{'Strike':>8}{'Qty':>8}{'Tier':>6}{'Hedge':>14}{'Rysk$':>8}")
    print(f"{'':2}{'-'*62}")
    for t in open_trades:
        print(
            f"{'':2}{t.id:<10}{t.underlying:<8}{t.strike:>8.0f}{t.qty:>8.0f}"
            f"{t.tier:>6}{t.hedge_status:>14}{t.rysk_price:>8.4f}"
        )

    # Expiring soon
    expiring = tracker.get_expiring_trades(hours=24)
    if expiring:
        print(f"\n  EXPIRING WITHIN 24H:")
        for t in expiring:
            hrs = (t.expiry_ts - time.time()) / 3600
            print(f"  {t.id}: {t.rysk_instrument} ({hrs:.0f}h)")

    print(f"\n{'=' * 70}")


def cmd_report(args):
    """Full P&L report."""
    tracker = PnLTracker()

    cache = None
    if not args.offline:
        try:
            from scripts.arb.derive_om import ArbDeriveClient
            client = ArbDeriveClient(testnet=args.testnet)
            cache = MarkCache(client)
            cache.refresh()
        except Exception as e:
            print(f"  (Could not refresh cache: {e}. Showing offline report.)\n")

    tracker.print_report(cache=cache)


def cmd_limits(args):
    """Show position limits vs current usage."""
    tracker = PnLTracker()
    open_trades = tracker.get_open_trades()

    total_capital = sum(t.capital_deployed for t in open_trades)
    by_underlying: dict[str, float] = {}
    unhedged = 0.0
    for t in open_trades:
        by_underlying[t.underlying] = by_underlying.get(t.underlying, 0) + t.premium_notional
        if t.hedge_status in ("unhedged", "perp_backstop"):
            unhedged += t.premium_notional

    print("=" * 60)
    print("  POSITION LIMITS")
    print("=" * 60)

    def row(label, used, limit, unit="$"):
        pct = used / limit * 100 if limit > 0 else 0
        status = "OK" if used <= limit else "EXCEEDED"
        if unit == "$":
            print(f"  {label:<30} {unit}{used:>10,.0f} / {unit}{limit:>10,.0f}  {pct:>5.0f}%  {status}")
        else:
            print(f"  {label:<30} {used:>10.1f} / {limit:>10.1f}  {pct:>5.0f}%  {status}")

    print()
    row("Total capital", total_capital, MAX_OPTIONS_CAPITAL)
    row("Open positions", len(open_trades), MAX_OPEN_POSITIONS, unit="")
    row("Unhedged inventory", unhedged, MAX_UNHEDGED_INVENTORY)

    for u, notional in sorted(by_underlying.items()):
        row(f"  {u} notional", notional, MAX_PER_UNDERLYING)

    # Margin (requires API)
    if not args.offline:
        try:
            from scripts.arb.derive_om import ArbDeriveClient
            client = ArbDeriveClient(testnet=args.testnet)
            account = client.get_account_margin()
            print()
            row("Margin utilization", account["utilization"] * 100, MAX_MARGIN_UTILIZATION * 100, unit="")
            print(f"  {'Margin ratio':<30} {account['im_ratio']:>10.2f}x   "
                  f"(alert: {MARGIN_ALERT_RATIO}x, close: {MARGIN_AUTO_CLOSE_RATIO}x)")
        except Exception as e:
            print(f"\n  (Margin data unavailable: {e})")

    print(f"\n{'=' * 60}")


def cmd_derive_readiness(args):
    """Run the Derive mainnet readiness suite.

    Reads env vars, instantiates ArbDeriveClient on mainnet, and exercises
    every read path we rely on (spot, tickers, instruments, compute_margin,
    account margin, collaterals, trade history, MarkCache, RatioCache).
    Reports pass/fail per check. Pure read path; never sends orders.
    """
    from scripts.arb.derive_readiness import run_readiness

    report = run_readiness(underlying=args.underlying, verbose=args.verbose)
    report.print_summary(verbose=args.verbose)
    sys.exit(0 if report.all_passed else 1)


def cmd_settlement_plan(args):
    """Dry-run the Friday 8-9am settlement preparation loop.

    Classifies open trades expiring at the given timestamp into ITM/OTM,
    computes delivery requirements, queries EOA + MarginPool balances,
    and prints a plan. With --execute, actually runs the deposit + loop.
    """
    from scripts.arb.rysk_client import RyskMakerClient
    from scripts.arb.settlement_executor import SettlementExecutor
    from scripts.arb.config import (
        RYSK_TESTNET_ASSETS,
        RYSK_TESTNET_RPC_URL,
        RYSK_TESTNET_USDC,
    )

    # Parse --spots
    spots = {}
    for piece in args.spots.split(","):
        piece = piece.strip()
        if not piece or "=" not in piece:
            continue
        k, v = piece.split("=", 1)
        try:
            spots[k.strip().upper()] = float(v.strip())
        except ValueError:
            print(f"Bad spot entry: {piece!r}")
            sys.exit(1)

    if not spots:
        print("Need at least one --spots entry")
        sys.exit(1)

    if args.env != "testnet":
        print("settlement-plan currently wired for testnet. Mainnet config follows.")
        sys.exit(1)

    rysk = RyskMakerClient(env="testnet")
    rysk.start(subscribe_assets=[])  # open the /maker channel
    time.sleep(2)

    tracker = PnLTracker()

    executor = SettlementExecutor(
        rysk_client=rysk,
        tracker=tracker,
        rpc_url=RYSK_TESTNET_RPC_URL,
        wallet_address=rysk.wallet,
        asset_addresses=RYSK_TESTNET_ASSETS,
        stablecoin_address=RYSK_TESTNET_USDC,
    )

    plan = executor.plan(expiry_ts=args.expiry, settlement_spots=spots)
    executor.print_plan(plan)

    if args.execute:
        if not plan.feasible:
            print("\nPlan is not feasible. Refusing to execute.")
            rysk.stop()
            sys.exit(1)
        print("\n--- EXECUTING ---")
        result = executor.execute(
            plan,
            dry_run=False,
            force_outside_window=args.force_outside_window,
        )
        print(json.dumps(result, indent=2, default=str))
    else:
        print("\n(dry run only — pass --execute to actually run the loop)")
        # Show what execute WOULD do
        dry_result = executor.execute(
            plan,
            dry_run=True,
            force_outside_window=True,  # dry-run allowed outside window
        )
        print(json.dumps(dry_result, indent=2, default=str))

    rysk.stop()


def cmd_settle(args):
    """Settle expired trades."""
    tracker = PnLTracker()
    expired = [
        t for t in tracker.get_open_trades()
        if t.expiry_ts < time.time()
    ]

    if not expired:
        print("No expired trades to settle.")
        return

    print(f"Found {len(expired)} expired trades:\n")
    for t in expired:
        expiry = datetime.fromtimestamp(t.expiry_ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
        print(f"  {t.id}: {t.rysk_instrument} (expired {expiry} UTC)")
        print(f"    Rysk price: ${t.rysk_price:.4f}, Derive price: ${t.derive_price:.4f}")

        # For now, prompt for settlement values
        if args.auto:
            # Auto-settle OTM as zero
            spot = float(input(f"    Enter settlement spot for {t.underlying}: ") or "0")
            if t.option_type == "P":
                rysk_val = max(0, t.strike - spot) * t.qty
                derive_val = max(0, t.strike - spot) * t.qty
            else:
                rysk_val = max(0, spot - t.strike) * t.qty
                derive_val = max(0, spot - t.strike) * t.qty

            tracker.record_settlement(t.id, rysk_val, derive_val)
            t_settled = tracker.get_trade(t.id)
            print(f"    Settled: Rysk=${rysk_val:.2f}, Derive=${derive_val:.2f}, "
                  f"P&L=${t_settled.realized_pnl:.2f}")
        else:
            print(f"    Run with --auto to settle, or manually call record_settlement()")

    print(f"\nDone. Run 'report' to see updated P&L.")


def cmd_rysk_balance(args):
    """Query USDC balance in Rysk MarginPool."""
    from scripts.arb.rysk_client import RyskMakerClient

    client = RyskMakerClient(env=args.env)
    account = args.account or client.wallet
    if not account:
        print("Error: no account (set RYSK_WALLET in .env or pass --account)")
        sys.exit(1)
    print(f"Querying balance for {account} on {args.env}")

    # Register a callback that prints every response from the maker daemon.
    # Balance responses arrive via the daemon's stdout stream.
    def on_response(data):
        print(f"[maker response] {data}")
    client.on_response(on_response)

    client.start(subscribe_assets=[])
    try:
        result = client.get_balances(account)
        if result.get("stderr"):
            print(f"stderr: {result['stderr']}")
        # Give the daemon time to receive and forward the response
        time.sleep(3)
    finally:
        client.stop()


def cmd_rysk_deposit(args):
    """Deposit an asset into Rysk MarginPool."""
    from scripts.arb.rysk_client import RyskMakerClient
    client = RyskMakerClient(env=args.env)

    # Print maker-channel responses as they arrive
    def on_response(data):
        print(f"[maker response] {data}")
    client.on_response(on_response)

    print(f"Depositing {args.amount} raw units of {args.asset}")
    client.start(subscribe_assets=[])
    try:
        result = client.deposit(asset=args.asset, amount=args.amount)
        if result.get("stderr"):
            print(f"stderr: {result['stderr']}")
        if result.get("stdout"):
            print(f"stdout: {result['stdout']}")
        # Wait for the daemon to relay any responses
        time.sleep(5)
    finally:
        client.stop()


def cmd_rysk_approve(args):
    """Approve strike-asset spending for Rysk MarginPool."""
    from scripts.arb.rysk_client import RyskMakerClient
    client = RyskMakerClient(env=args.env)
    result = client.approve_spending(args.amount)
    print(f"stdout: {result.get('stdout', '')}")
    if result.get("stderr"):
        print(f"stderr: {result['stderr']}")


def cmd_rysk_positions(args):
    """Query oToken positions on Rysk."""
    from scripts.arb.rysk_client import RyskMakerClient
    client = RyskMakerClient(env=args.env)
    account = args.account or client.wallet
    if not account:
        print("Error: no account (set RYSK_WALLET in .env or pass --account)")
        sys.exit(1)
    print(f"Querying positions for {account} on {args.env}")
    client.start(subscribe_assets=[])
    try:
        result = client.get_positions(account)
        print(f"stdout: {result.get('stdout', '')}")
        if result.get("stderr"):
            print(f"stderr: {result['stderr']}")
    finally:
        client.stop()


def cmd_rysk_taker_test(args):
    """Run randomized taker RFQs against testnet for self-testing.

    Our maker bot (run separately in another terminal via `rysk-listen`)
    will receive these RFQs and respond. This verifies the end-to-end loop.

    Do NOT run this on mainnet - it will submit real RFQs.

    By default this pulls listings from the live `/api/inventory`
    endpoint. Pass `--use-snapshot` to fall back to the static
    LISTED_PRODUCTS_SNAPSHOT in rysk_taker.py (older code path, kept
    for offline use only).
    """
    import asyncio
    from scripts.arb.rysk_client import RyskMakerClient
    from scripts.arb.rysk_inventory import RyskInventory, InventoryFetchError
    from scripts.arb.rysk_taker import (
        TakerClient,
        random_listed_request,
        random_listed_request_from_inventory,
        LISTED_PRODUCTS_SNAPSHOT,
    )

    if args.env != "testnet":
        print("ERROR: rysk-taker-test only runs on testnet. Refusing.")
        sys.exit(1)

    # Get taker address (default to RYSK_WALLET)
    rysk = RyskMakerClient(env="testnet")
    taker_addr = args.taker or rysk.wallet
    if not taker_addr:
        print("Error: no taker address (set RYSK_WALLET or pass --taker)")
        sys.exit(1)

    use_snapshot = getattr(args, "use_snapshot", False)
    inventory: Optional[RyskInventory] = None
    if not use_snapshot:
        inventory = RyskInventory(env="testnet")
        try:
            listings = inventory.fetch()
            print(f"Loaded {len(listings)} listings from /api/inventory")
        except InventoryFetchError as e:
            print(f"Inventory fetch failed ({e}), falling back to static snapshot")
            inventory = None
            use_snapshot = True

    print(f"Taker address: {taker_addr}")
    if use_snapshot:
        snap_count = sum(
            len(s) for a in LISTED_PRODUCTS_SNAPSHOT.values() for s in a.values()
        )
        print(f"Listed products (snapshot): {snap_count}")
    print(f"Submitting {args.count} random RFQs, {args.interval}s between each")
    print()

    async def run():
        client = TakerClient(taker_address=taker_addr)

        for i in range(args.count):
            if inventory is not None:
                req = random_listed_request_from_inventory(
                    taker_address=taker_addr,
                    inventory=inventory,
                    underlying=args.underlying,
                    is_put=True,
                )
            else:
                req = random_listed_request(
                    taker_address=taker_addr,
                    underlying=args.underlying,
                )
            direction = "put" if req.is_put else "call"
            print(f"[{i+1}/{args.count}] {req.asset_name} "
                  f"${req.strike_float:.0f} {direction} "
                  f"exp={req.expiry} qty={req.quantity_float:.2f}")

            try:
                await client.connect()
                result = await client.submit_and_wait(req, wait_seconds=args.wait)

                if result["error"]:
                    print(f"  ERROR: {result['error']}")
                elif result["quotes"]:
                    print(f"  QUOTES RECEIVED: {len(result['quotes'])}")
                    for q in result["quotes"][:3]:
                        print(f"    {q}")
                elif result["responses"]:
                    print(f"  Responses: {len(result['responses'])}")
                    for m in result["responses"][:3]:
                        print(f"    {json.dumps(m)[:200]}")
                else:
                    print("  (no responses - no maker listening or no quotes in window)")

                await client.close()
            except Exception as e:
                print(f"  EXCEPTION: {e}")

            if i < args.count - 1:
                await asyncio.sleep(args.interval)

    asyncio.run(run())


def cmd_rysk_scan_products(args):
    """List currently listed products via the /api/inventory REST endpoint.

    Replaces the legacy WS-probe scanner. The endpoint returns the
    full listing book in one call with no auth, so this is faster,
    cheaper, and never misses listings the way the probe scanner did
    (the probe used a fixed step size and a 1.5s timeout heuristic
    that missed strikes outside the grid).
    """
    from scripts.arb.rysk_inventory import RyskInventory, InventoryFetchError

    env = getattr(args, "env", "testnet")
    inventory = RyskInventory(env=env)
    try:
        listings = inventory.fetch()
    except InventoryFetchError as e:
        print(f"Inventory fetch failed: {e}")
        sys.exit(1)

    print(f"Loaded {len(listings)} listings from {inventory.url}")
    print()
    for underlying in inventory.underlyings():
        spot = inventory.get_spot(underlying)
        spot_str = f"${spot:.2f}" if spot else "n/a"
        print(f"=== {underlying} (spot {spot_str}) ===")
        for expiry in inventory.expiries(underlying):
            from datetime import datetime, timezone
            iso = datetime.fromtimestamp(expiry, tz=timezone.utc).strftime("%Y-%m-%d")
            put_strikes = inventory.strikes(underlying, expiry, is_put=True)
            call_strikes = inventory.strikes(underlying, expiry, is_put=False)
            if put_strikes:
                print(f"  {iso} ({expiry}) puts:  {put_strikes}")
            if call_strikes:
                print(f"  {iso} ({expiry}) calls: {call_strikes}")
        print()


def cmd_rysk_inventory(args):
    """Inspect the Rysk inventory snapshot.

    Same data source as ``rysk-scan-products`` but with more output
    options: --json for raw, --underlying to filter, --putstrue/false
    to filter direction, --details to print delta/IV/index per entry.
    """
    from scripts.arb.rysk_inventory import RyskInventory, InventoryFetchError

    env = getattr(args, "env", "testnet")
    inventory = RyskInventory(env=env)
    try:
        listings = inventory.fetch()
    except InventoryFetchError as e:
        print(f"Inventory fetch failed: {e}")
        sys.exit(1)

    is_put = None
    if getattr(args, "puts_only", False):
        is_put = True
    elif getattr(args, "calls_only", False):
        is_put = False

    filtered = inventory.listings(
        underlying=getattr(args, "underlying", None),
        is_put=is_put,
    )

    if getattr(args, "json", False):
        from dataclasses import asdict
        print(json.dumps([asdict(l) for l in filtered], indent=2, default=str))
        return

    print(f"Source: {inventory.url}")
    print(f"Listings: {len(filtered)} (of {len(listings)} total)")
    print()
    if getattr(args, "details", False):
        header = (
            f"{'underlying':<11}{'expiry':<11}{'strike':>10}  "
            f"{'P/C':<4}{'delta':>8}  {'bidIv':>6} {'askIv':>6}  "
            f"{'index':>10}  {'apy%':>8}"
        )
        print(header)
        print("-" * len(header))
        for l in filtered:
            from datetime import datetime, timezone
            iso = datetime.fromtimestamp(l.expiry_ts, tz=timezone.utc).strftime("%y-%m-%d")
            pc = "P" if l.is_put else "C"
            print(
                f"{l.underlying:<11}{iso:<11}{l.strike:>10.2f}  "
                f"{pc:<4}{l.delta:>8.4f}  {l.bid_iv:>6.2f} {l.ask_iv:>6.2f}  "
                f"{l.index:>10.2f}  {l.apy:>8.2f}"
            )
    else:
        for underlying in inventory.underlyings():
            ul_listings = [l for l in filtered if l.underlying == underlying]
            if not ul_listings:
                continue
            spot = inventory.get_spot(underlying)
            spot_str = f"${spot:.2f}" if spot else "n/a"
            print(f"  {underlying:<8} spot={spot_str:<14} listings={len(ul_listings)}")


def cmd_rysk_listen(args):
    """Start the Rysk maker listener (observation + quoting).

    Requires: testnet wallet, assets to subscribe to, SDK installed.
    """
    from scripts.arb.derive_om import ArbDeriveClient
    from scripts.arb.pricing import MarkCache, RatioCache
    from scripts.arb.rysk_listener import RyskListener

    if not args.assets:
        print("Error: --assets required (comma-separated 0x addresses)")
        sys.exit(1)

    assets = [a.strip() for a in args.assets.split(",") if a.strip()]
    if not assets:
        print("Error: no valid assets parsed from --assets")
        sys.exit(1)

    derive_client = None
    cache = None
    ratio_cache = None

    if args.env == "testnet":
        # Testnet pricing uses scripts.arb.testnet_pricer (BS + Coinbase spot).
        # No Derive cache needed (Derive has no Base Sepolia WETH/WBTC options
        # anyway). The listener will branch on env and call calculate_testnet_bid.
        print("Testnet mode: using testnet_pricer (no Derive cache).")
    elif not args.observe_only:
        print("Initializing Derive client + caches...")
        derive_client = ArbDeriveClient()
        cache = MarkCache(derive_client)
        ratio_cache = RatioCache(derive_client)
        underlyings = ("HYPE",)
        cache.refresh(underlyings=underlyings)
        ratio_cache.refresh(cache.instruments)
        print(f"  cached {cache.fresh_count} instruments, {ratio_cache.instrument_count} ratios")

    tracker = PnLTracker()

    listener = RyskListener(
        env=args.env,
        cache=cache,
        ratio_cache=ratio_cache,
        tracker=tracker,
        derive_client=derive_client,
        maker_address=args.maker or "",
    )
    listener.run(assets)


def cmd_migrate(args):
    """Run one Tier 4 migration cycle (check, rebalance, execute)."""
    from scripts.arb.derive_om import ArbDeriveClient
    from scripts.arb.pricing import MarkCache, RatioCache
    from scripts.arb.perp_client import get_perp_client
    from scripts.arb.migration import MigrationMonitor
    from scripts.arb.config import MIGRATION_CHECK_INTERVAL_SECONDS

    client = ArbDeriveClient(testnet=args.testnet)
    cache = MarkCache(client)
    ratio_cache = RatioCache(client)

    trades_file = args.trades_file or "data/arb-trades.json"
    tracker = PnLTracker(trades_file=trades_file)

    # Pick underlying from first Tier 4 trade
    tier4_trades = [
        t for t in tracker.get_open_trades()
        if t.hedge_mode == "tier4_pending_migration"
    ]
    if not tier4_trades:
        print("No Tier 4 trades pending migration.")
        return

    # Refresh cache for all underlyings we have Tier 4 trades in
    underlyings = tuple(set(t.underlying for t in tier4_trades))
    print(f"Refreshing cache for {underlyings}...")
    t0 = time.time()
    cache.refresh(underlyings=underlyings)
    print(f"  {cache.fresh_count} instruments in {time.time() - t0:.1f}s")

    print(f"Refreshing ratio cache...")
    t0 = time.time()
    ratio_cache.refresh(cache.instruments)
    print(f"  {ratio_cache.instrument_count} ratios in {time.time() - t0:.1f}s")

    # Get perp client for first underlying (they should all be HYPE in practice)
    perp_client = get_perp_client(underlyings[0], dry_run=args.dry_run)

    monitor = MigrationMonitor(
        tracker=tracker,
        derive_client=client,
        cache=cache,
        ratio_cache=ratio_cache,
        perp_client=perp_client,
        dry_run=args.dry_run,
    )

    if args.loop:
        import signal
        interval = args.loop if args.loop > 0 else MIGRATION_CHECK_INTERVAL_SECONDS
        print(f"Running migration loop every {interval}s. Ctrl-C to stop.")
        def _sigint(sig, frame):
            print("\nStopped.")
            sys.exit(0)
        signal.signal(signal.SIGINT, _sigint)

        while True:
            result = monitor.run_cycle()
            monitor.print_cycle_report(result)
            print(f"Sleeping {interval}s...")
            time.sleep(interval)
            # Refresh caches between cycles
            cache.refresh(underlyings=underlyings)
            ratio_cache.refresh(cache.instruments)
    else:
        result = monitor.run_cycle()
        monitor.print_cycle_report(result)


def cmd_performance(args):
    """Read settled trades and show tier weight / win rate feedback."""
    from scripts.arb.feedback import (
        PerformanceAnalyzer,
        save_learned_weights,
    )

    trades_file = args.trades_file or "data/arb-trades.json"
    tracker = PnLTracker(trades_file=trades_file)
    analyzer = PerformanceAnalyzer(tracker)
    analyzer.print_report()

    if args.apply:
        recs = analyzer.recommend_tier_weights()
        to_apply = {
            r.tier: r.recommended_weight
            for r in recs
            if r.status == "RECOMMEND_UPDATE"
        }
        if not to_apply:
            print("\n  No tier weight updates to apply.")
            return
        # Merge with existing
        from scripts.arb.feedback import load_learned_weights
        current = load_learned_weights()
        current.update(to_apply)
        save_learned_weights(current)
        print(f"\n  Applied {len(to_apply)} tier weight update(s). See data/tier-weights.json")


def cmd_trade_log(args):
    """Sync our Derive trades and/or show stats."""
    from scripts.arb.derive_om import ArbDeriveClient
    from scripts.arb.trade_logger import (
        TradeLogger,
        calibrate_from_log,
        retune_recommendation,
    )

    client = ArbDeriveClient(testnet=args.testnet)
    logger = TradeLogger(client)

    if args.sync or not args.stats_only:
        print(f"Syncing trades (up to {args.pages} pages)...")
        result = logger.sync(pages=args.pages)
        print(f"  Fetched: {result['fetched']}")
        print(f"  New:     {result['new']}")
        print(f"  Dup:     {result['duplicate']}")
        if result['error']:
            print(f"  Errors:  {result['error']}")
        print()

    logger.print_stats()

    if args.calibrate or args.retune:
        print("\nCALIBRATION FROM OWN FILLS:")
        print("-" * 50)
        result = calibrate_from_log()
        if "error" in result:
            print(f"  {result['error']}")
        else:
            print(f"  Sell/taker trades: n={result['n']}")
            print(f"  Mean:    {result['mean']:.3f}")
            print(f"  Median:  {result['median']:.3f}  (stderr {result.get('stderr', 0):.3f})")
            print(f"  P25:     {result['p25']:.3f}")
            print(f"  P75:     {result['p75']:.3f}")
            print(f"  Range:   [{result['min']:.3f}, {result['max']:.3f}]")
            print()
            print("  Recommendations:")
            for k, v in result["recommendations"].items():
                print(f"    {k:<15} {v:.3f}")

    if args.retune:
        print("\nRETUNE ANALYSIS:")
        print("-" * 50)
        current = EXECUTION_RATIOS.get(args.underlying, DEFAULT_EXEC_RATIO)
        own_fill = calibrate_from_log()
        recommendation = retune_recommendation(own_fill, current, args.underlying)

        print(f"  Underlying:       {recommendation['underlying']}")
        print(f"  Current config:   {recommendation['current']:.3f}")
        if "own_fill_balanced" in recommendation:
            print(f"  Own-fill median:  {recommendation['own_fill_balanced']:.3f}")
            print(f"  Own-fill conservative: {recommendation['own_fill_conservative']:.3f}")
            print(f"  Drift:            {recommendation['drift']:.3f}")
            print(f"  Samples (n):      {recommendation['own_fill_n']}")
            print(f"  Stderr:           {recommendation['stderr']:.3f}")
        print()
        status = recommendation["status"]
        color = {
            "OK": "",
            "NOT_ENOUGH_DATA": "",
            "HIGH_UNCERTAINTY": "",
            "RECOMMEND_RETUNE": "",
            "NO_DATA": "",
        }.get(status, "")
        print(f"  STATUS:  {status}")
        print(f"  Reason:  {recommendation['reason']}")
        print(f"  Action:  {recommendation['action']}")


def cmd_mock_rfq(args):
    """Run a mock RFQ batch through the full pipeline."""
    from scripts.arb.derive_om import ArbDeriveClient
    from scripts.arb.mock_rfq import (
        MockPipeline,
        rysk_screenshots_scenario,
        print_batch_report,
    )

    client = ArbDeriveClient(testnet=args.testnet)

    if args.equity:
        account_equity = float(args.equity)
        print(f"(Using --equity override: ${account_equity:,.0f})")
    else:
        # Try to get live account equity
        account_equity = float(MAX_OPTIONS_CAPITAL)
        try:
            account = client.get_account_margin()
            account_equity = account["equity"]
        except Exception as e:
            print(f"(Using warmup default ${account_equity:.0f}: {e})")

    # Pick scenario
    if args.scenario == "screenshots":
        rfqs = rysk_screenshots_scenario()
    else:
        print(f"Unknown scenario: {args.scenario}")
        sys.exit(1)

    # Reset the mock ledger if requested
    if args.reset:
        import os
        if os.path.exists("data/mock-trades.json"):
            os.remove("data/mock-trades.json")
            print("[mock] Reset mock trade ledger.")

    pipeline = MockPipeline(
        client=client,
        account_equity=account_equity,
        win_rate=args.win_rate,
    )

    results = pipeline.run_batch(rfqs)
    print_batch_report(results, account_equity)

    if args.settle:
        print("\nSimulating settlement...")
        # For Apr 10 expiry, assume HYPE at spot at time of settlement
        spot = pipeline.cache.get_spot("HYPE")
        settled = pipeline.simulate_settlement({"HYPE": spot})
        print(f"Settled {len(settled)} expired trades (assumed spot ${spot:.2f})")


def cmd_calibrate(args):
    """Calibrate execution ratio from Derive trade history."""
    from scripts.arb.derive_om import ArbDeriveClient
    from scripts.arb.calibrate import (
        run_calibration,
        print_calibration_report,
        update_config_file,
    )

    client = ArbDeriveClient(testnet=args.testnet)
    print(f"Calibrating execution ratio for {args.underlying}...")
    print(f"Max instruments to query: {args.max_instruments}")
    print()

    result = run_calibration(
        client=client,
        underlying=args.underlying,
        max_instruments=args.max_instruments,
    )
    print_calibration_report(result)

    if args.apply and "recommendations" in result:
        chosen = result["recommendations"].get(args.strategy)
        if chosen is None or chosen == 0:
            print(f"\n  No valid {args.strategy} recommendation to apply")
            return
        if update_config_file(args.underlying, chosen):
            print(f"\n  Updated EXECUTION_RATIOS['{args.underlying}'] "
                  f"in config.py to {chosen:.2f} ({args.strategy})")
        else:
            print(f"\n  No change applied (ratio unchanged or pattern not found)")


def main():
    parser = argparse.ArgumentParser(
        description="Options cross-venue arb CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--testnet", action="store_true", help="Use Derive testnet")

    sub = parser.add_subparsers(dest="command", help="Command")

    # cache
    p_cache = sub.add_parser("cache", help="Start mark cache, print refreshes")
    p_cache.add_argument("--underlyings", default="HYPE", help="Comma-separated (default: HYPE)")

    # price
    p_price = sub.add_parser("price", help="Calculate bid for hypothetical RFQ")
    p_price.add_argument("--underlying", required=True)
    p_price.add_argument("--strike", type=float, required=True)
    p_price.add_argument("--expiry", required=True, help="YYYY-MM-DD")
    p_price.add_argument("--type", choices=["P", "C"], required=True)
    p_price.add_argument("--qty", type=float, required=True)

    # margin
    sub.add_parser("margin", help="Show Derive margin health")

    # positions
    p_pos = sub.add_parser("positions", help="Show open positions")
    p_pos.add_argument("--offline", action="store_true")

    # report
    p_report = sub.add_parser("report", help="Full P&L report")
    p_report.add_argument("--offline", action="store_true", help="Skip Derive API for unrealized P&L")

    # limits
    p_limits = sub.add_parser("limits", help="Position limits vs current usage")
    p_limits.add_argument("--offline", action="store_true")

    # settle
    p_settle = sub.add_parser("settle", help="Settle expired trades")
    p_settle.add_argument("--auto", action="store_true", help="Auto-settle with spot price input")

    # derive-readiness
    p_dr = sub.add_parser(
        "derive-readiness",
        help="Run Derive mainnet readiness checks (pure read path)",
    )
    p_dr.add_argument("--underlying", default="HYPE",
                      help="Underlying to probe (default HYPE)")
    p_dr.add_argument("--verbose", action="store_true",
                      help="Print check values in addition to pass/fail")

    # settlement-plan: dry-run the Friday 8-9am UTC prep loop for an expiry
    p_splan = sub.add_parser(
        "settlement-plan",
        help="Dry-run the Friday 8-9am settlement preparation loop",
    )
    p_splan.add_argument("--env", default="testnet", choices=["testnet", "mainnet"])
    p_splan.add_argument(
        "--expiry", type=int, required=True,
        help="Expiry unix timestamp (Friday 8:00 UTC)",
    )
    p_splan.add_argument(
        "--spots", required=True,
        help="Comma-separated underlying=spot pairs, e.g. WETH=2100,WBTC=65000",
    )
    p_splan.add_argument(
        "--execute", action="store_true",
        help="Actually execute the plan (default: dry run only)",
    )
    p_splan.add_argument(
        "--force-outside-window", action="store_true",
        help="Allow execution even if not in Friday 8-9am UTC window (dry run always allowed)",
    )

    # rysk-balance
    p_rb = sub.add_parser("rysk-balance", help="Query USDC balance in Rysk MarginPool")
    p_rb.add_argument("--env", default="testnet", choices=["testnet", "mainnet"])
    p_rb.add_argument("--account", default=None, help="Maker wallet address")

    # rysk-deposit
    p_rd = sub.add_parser("rysk-deposit", help="Deposit an asset into Rysk MarginPool")
    p_rd.add_argument("--env", default="testnet", choices=["testnet", "mainnet"])
    p_rd.add_argument("--asset", required=True, help="Asset address to deposit")
    p_rd.add_argument("--amount", required=True, help="Amount (raw integer, e.g. 1000000 for 1 USDC)")

    # rysk-approve
    p_ra = sub.add_parser("rysk-approve", help="Approve strike asset spending")
    p_ra.add_argument("--env", default="testnet", choices=["testnet", "mainnet"])
    p_ra.add_argument("--amount", required=True, help="Approval amount (raw integer)")

    # rysk-positions
    p_rp = sub.add_parser("rysk-positions", help="Query oToken positions on Rysk")
    p_rp.add_argument("--env", default="testnet", choices=["testnet", "mainnet"])
    p_rp.add_argument("--account", default=None, help="Maker wallet address (defaults to RYSK_WALLET)")

    # rysk-taker-test
    p_rtt = sub.add_parser("rysk-taker-test",
                           help="Submit randomized taker RFQs (testnet self-testing)")
    p_rtt.add_argument("--env", default="testnet", choices=["testnet"])
    p_rtt.add_argument("--count", type=int, default=5, help="Number of RFQs to submit")
    p_rtt.add_argument("--interval", type=float, default=5.0, help="Seconds between RFQs")
    p_rtt.add_argument("--wait", type=float, default=8.0,
                       help="Seconds to wait for quote responses per RFQ")
    p_rtt.add_argument("--underlying", default=None,
                       help="Fix the underlying (default: random across inventory)")
    p_rtt.add_argument("--taker", default=None, help="Taker address (default: RYSK_WALLET)")
    p_rtt.add_argument("--use-snapshot", action="store_true",
                       help="Use the static LISTED_PRODUCTS_SNAPSHOT instead of live /api/inventory")

    # rysk-scan-products (REST inventory dump grouped by underlying/expiry)
    p_rsp = sub.add_parser("rysk-scan-products",
                           help="List currently listed products via /api/inventory")
    p_rsp.add_argument("--env", default="testnet", choices=["testnet", "mainnet"])

    # rysk-inventory (filtered/detailed inventory inspection)
    p_rinv = sub.add_parser("rysk-inventory",
                            help="Inspect Rysk /api/inventory with filters and detail flags")
    p_rinv.add_argument("--env", default="testnet", choices=["testnet", "mainnet"])
    p_rinv.add_argument("--underlying", default=None,
                        help="Filter to a single underlying (BTC, ETH, HYPE, ...)")
    p_rinv.add_argument("--puts-only", action="store_true",
                        help="Only show puts")
    p_rinv.add_argument("--calls-only", action="store_true",
                        help="Only show calls")
    p_rinv.add_argument("--details", action="store_true",
                        help="Print delta/IV/index per listing instead of summary")
    p_rinv.add_argument("--json", action="store_true",
                        help="Print raw JSON of all (filtered) listings")

    # rysk-listen
    p_rl = sub.add_parser("rysk-listen", help="Start Rysk maker listener")
    p_rl.add_argument("--env", default="testnet", choices=["testnet", "mainnet"])
    p_rl.add_argument("--assets", required=True,
                      help="Comma-separated asset addresses to subscribe to")
    p_rl.add_argument("--maker", default=None, help="Our maker wallet address")
    p_rl.add_argument("--observe-only", action="store_true",
                      help="Don't initialize Derive/caches, just log RFQs")

    # migrate
    p_mig = sub.add_parser("migrate", help="Run Tier 4 migration cycle (check/rebalance/execute)")
    p_mig.add_argument("--trades-file", default=None)
    p_mig.add_argument("--dry-run", action="store_true", help="Log would-be actions without executing")
    p_mig.add_argument("--testnet", action="store_true", help="Use Derive testnet instead of mainnet")
    p_mig.add_argument("--loop", type=int, nargs="?", const=3600, default=0,
                       help="Run continuously every N seconds (default 3600)")

    # performance
    p_perf = sub.add_parser("performance", help="Tier weight and win rate feedback from settled trades")
    p_perf.add_argument("--trades-file", default=None,
                        help="Trade ledger file (default: data/arb-trades.json)")
    p_perf.add_argument("--apply", action="store_true",
                        help="Write recommended tier weights to data/tier-weights.json")

    # trade-log
    p_tlog = sub.add_parser("trade-log", help="Sync Derive fills and show stats")
    p_tlog.add_argument("--sync", action="store_true", help="Sync new trades from API")
    p_tlog.add_argument("--stats-only", action="store_true", help="Only show stats, skip sync")
    p_tlog.add_argument("--pages", type=int, default=3, help="Pages of trade history to fetch")
    p_tlog.add_argument("--calibrate", action="store_true", help="Show calibration from logged fills")
    p_tlog.add_argument("--retune", action="store_true",
                        help="Check if config execution ratio needs retuning (drift/sample analysis)")
    p_tlog.add_argument("--underlying", default="HYPE",
                        help="Underlying for retune analysis (default: HYPE)")

    # mock-rfq
    p_mock = sub.add_parser("mock-rfq", help="Run mock RFQs through the full pipeline")
    p_mock.add_argument("--scenario", default="screenshots",
                        help="Scenario to run (default: screenshots)")
    p_mock.add_argument("--win-rate", type=float, default=1.0,
                        help="Simulated probability of winning each RFQ (0-1)")
    p_mock.add_argument("--equity", type=float, default=None,
                        help="Override account equity for simulation (default: live)")
    p_mock.add_argument("--reset", action="store_true",
                        help="Delete existing mock trade ledger before running")
    p_mock.add_argument("--settle", action="store_true",
                        help="Simulate settlement at current spot after running")
    p_mock.add_argument("--testnet", action="store_true",
                        help="Use Derive testnet instead of mainnet")

    # calibrate
    p_cal = sub.add_parser("calibrate", help="Calibrate execution ratio from Derive trade history")
    p_cal.add_argument("--underlying", default="HYPE")
    p_cal.add_argument("--max-instruments", type=int, default=20,
                       help="Max instruments to query for trade history")
    p_cal.add_argument("--strategy", choices=["conservative", "balanced", "aggressive"],
                       default="conservative",
                       help="Risk level for recommended ratio when applying")
    p_cal.add_argument("--apply", action="store_true",
                       help="Update config.py with the recommended ratio")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(1)

    commands = {
        "cache": cmd_cache,
        "price": cmd_price,
        "margin": cmd_margin,
        "positions": cmd_positions,
        "report": cmd_report,
        "limits": cmd_limits,
        "settle": cmd_settle,
        "settlement-plan": cmd_settlement_plan,
        "derive-readiness": cmd_derive_readiness,
        "calibrate": cmd_calibrate,
        "mock-rfq": cmd_mock_rfq,
        "trade-log": cmd_trade_log,
        "performance": cmd_performance,
        "migrate": cmd_migrate,
        "rysk-balance": cmd_rysk_balance,
        "rysk-deposit": cmd_rysk_deposit,
        "rysk-approve": cmd_rysk_approve,
        "rysk-positions": cmd_rysk_positions,
        "rysk-listen": cmd_rysk_listen,
        "rysk-taker-test": cmd_rysk_taker_test,
        "rysk-scan-products": cmd_rysk_scan_products,
        "rysk-inventory": cmd_rysk_inventory,
    }

    commands[args.command](args)


if __name__ == "__main__":
    main()
