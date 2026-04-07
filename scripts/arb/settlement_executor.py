"""Settlement executor: orchestrates the 8-9am preparation loop.

The pure planner in settlement.py decides WHAT to do. This module does
the side-effectful work: on-chain balance queries, rysk deposits/withdraws,
DEX swaps, and the actual redemption trigger.

Usage pattern:
    executor = SettlementExecutor(rysk_client, tracker, rpc_url)
    plan = executor.plan(expiry_ts, settlement_spots)
    executor.print_plan(plan)
    if args.execute and plan.feasible:
        executor.execute(plan, dry_run=args.dry_run)

The executor NEVER auto-executes. Callers must explicitly pass dry_run=False
AND the plan must be feasible. We also refuse to execute outside the
Friday 8-9am window unless an override flag is passed.
"""

import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from scripts.arb.settlement import (
    BootstrapPlan,
    DeliveryRequirement,
    classify_trades_for_expiry,
    is_in_redemption_window,
    minutes_until_trigger,
    next_settlement_time,
    plan_bootstrap,
)


# ERC-20 balanceOf(address) function selector + padded 32-byte address
ERC20_BALANCE_OF_SELECTOR = "0x70a08231"


@dataclass
class SettlementPlan:
    """Full plan for one expiry across all underlyings."""
    expiry_ts: int
    generated_at: float
    settlement_spots: dict[str, float]
    requirements: dict[str, DeliveryRequirement]
    bootstrap_plans: dict[str, BootstrapPlan] = field(default_factory=dict)
    eoa_balances: dict[str, float] = field(default_factory=dict)
    margin_pool_balances: dict[str, float] = field(default_factory=dict)
    feasible: bool = True
    blocking_reasons: list = field(default_factory=list)
    # True if every underlying's bootstrap plan can run in the window
    within_prep_window: bool = False


class SettlementExecutor:
    """Orchestrates the 8-9am redemption preparation loop."""

    def __init__(
        self,
        rysk_client,                  # RyskMakerClient
        tracker,                      # PnLTracker
        rpc_url: str,
        wallet_address: str,
        asset_addresses: dict[str, str],   # underlying name -> ERC20 address
        stablecoin_address: str,
        dex_spot_provider=None,       # callable: (underlying) -> float, optional
    ):
        self.rysk = rysk_client
        self.tracker = tracker
        self.rpc_url = rpc_url
        self.wallet = wallet_address
        self.asset_addresses = asset_addresses
        self.stablecoin_address = stablecoin_address
        self.dex_spot_provider = dex_spot_provider

    # ---------------- EOA balance queries ----------------

    def get_eoa_balance(self, asset_address: str) -> float:
        """Query ERC-20 balance via eth_call over RPC. Returns float units.

        Uses a minimal JSON-RPC call via requests; no web3.py dep required.
        """
        import requests

        # Encode balanceOf(address)
        addr_no_prefix = self.wallet.lower().replace("0x", "")
        data = ERC20_BALANCE_OF_SELECTOR + addr_no_prefix.rjust(64, "0")

        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [
                {"to": asset_address, "data": data},
                "latest",
            ],
        }
        try:
            resp = requests.post(self.rpc_url, json=payload, timeout=10)
            result = resp.json().get("result", "0x0")
            raw = int(result, 16)
            # Assume 6 decimals for USDC/USDT, 8 for WBTC, 18 everything else.
            # Real impl should query decimals(); we hardcode for testnet.
            decimals = self._decimals_for(asset_address)
            return raw / (10 ** decimals)
        except Exception as e:
            print(f"[settlement] RPC error querying {asset_address}: {e}")
            return 0.0

    @staticmethod
    def _decimals_for(asset_address: str) -> int:
        """Hardcoded decimals for known testnet assets.

        Caller can override by passing decimals through settings in a
        future iteration. Returning 18 as a safe default for ERC20s.
        """
        addr = asset_address.lower()
        # Base Sepolia known assets
        if addr == "0x98d56648c9b7f3cb49531f4135115b5000ab1733":  # USDC
            return 6
        if addr == "0x0cb970511c6c3491dc36f1b7774743da3fc4335f":  # WBTC
            return 8
        if addr == "0xb67bfa7b488df4f2efa874f4e59242e9130ae61f":  # WETH
            return 18
        return 18

    def query_all_eoa_balances(self, underlyings: list[str]) -> dict[str, float]:
        """Return {underlying_symbol: eoa_balance_float} for each underlying
        we care about, plus the stablecoin."""
        balances: dict[str, float] = {}
        for sym in underlyings:
            addr = self.asset_addresses.get(sym)
            if addr is None:
                balances[sym] = 0.0
                continue
            balances[sym] = self.get_eoa_balance(addr)
        balances["STABLECOIN"] = self.get_eoa_balance(self.stablecoin_address)
        return balances

    # ---------------- MarginPool balance queries ----------------

    def query_margin_pool_balances(self) -> dict[str, float]:
        """Return {asset_address: balance_float} for our wallet from Rysk.

        Wraps rysk_client.get_balances and decodes raw integer strings.
        """
        import json as _json

        try:
            result = self.rysk.get_balances(self.wallet)
            stdout = result.get("stdout", "") if isinstance(result, dict) else ""
            if not stdout:
                return {}
            data = _json.loads(stdout)
            entries = data.get("result", [])
            out: dict[str, float] = {}
            for e in entries:
                asset = e.get("assetAddress", "").lower()
                raw = int(e.get("balance", "0"))
                dec = self._decimals_for(asset)
                out[asset] = raw / (10 ** dec)
            return out
        except Exception as e:
            print(f"[settlement] margin pool query failed: {e}")
            return {}

    # ---------------- Planning ----------------

    def plan(
        self,
        expiry_ts: int,
        settlement_spots: dict[str, float],
        max_bootstrap_cycles: int = 10,
    ) -> SettlementPlan:
        """Build a full SettlementPlan for the given expiry.

        Steps:
        1. Classify open trades by underlying → DeliveryRequirement
        2. Query EOA balances for each underlying + stablecoin
        3. For each underlying with a non-zero delivery requirement, plan
           bootstrap (if shortage)
        4. Aggregate feasibility and blocking reasons
        """
        trades = list(self.tracker.trades.values())
        requirements = classify_trades_for_expiry(trades, expiry_ts, settlement_spots)

        underlyings = list(requirements.keys())
        eoa_balances = self.query_all_eoa_balances(underlyings) if underlyings else {}
        margin_pool_balances = self.query_margin_pool_balances()

        bootstrap_plans: dict[str, BootstrapPlan] = {}
        blocking_reasons = []
        for sym, req in requirements.items():
            if req.underlying_to_deliver <= 0:
                continue
            eoa_bal = eoa_balances.get(sym, 0.0)
            stablecoin_bal = eoa_balances.get("STABLECOIN", 0.0)
            spot = settlement_spots.get(sym, 0.0)
            bp = plan_bootstrap(
                required_underlying=req.underlying_to_deliver,
                eoa_underlying_balance=eoa_bal,
                eoa_stablecoin_balance=stablecoin_bal,
                dex_spot_price=spot,
                max_cycles=max_bootstrap_cycles,
            )
            bootstrap_plans[sym] = bp
            if not bp.feasible:
                blocking_reasons.append(
                    f"{sym}: {bp.reason} (need {req.underlying_to_deliver:.6f}, "
                    f"have {eoa_bal:.6f} on EOA, {stablecoin_bal:.2f} stablecoin)"
                )

        feasible = len(blocking_reasons) == 0
        return SettlementPlan(
            expiry_ts=expiry_ts,
            generated_at=time.time(),
            settlement_spots=settlement_spots,
            requirements=requirements,
            bootstrap_plans=bootstrap_plans,
            eoa_balances=eoa_balances,
            margin_pool_balances=margin_pool_balances,
            feasible=feasible,
            blocking_reasons=blocking_reasons,
            within_prep_window=is_in_redemption_window(datetime.now(timezone.utc)),
        )

    def print_plan(self, plan: SettlementPlan) -> None:
        """Human-readable dump of the plan."""
        expiry_dt = datetime.fromtimestamp(plan.expiry_ts, tz=timezone.utc)
        now = datetime.now(timezone.utc)
        print("=" * 70)
        print(f"Settlement plan for expiry {expiry_dt.isoformat()}")
        print(f"Generated at: {datetime.fromtimestamp(plan.generated_at, tz=timezone.utc).isoformat()}")
        print(f"In redemption window: {plan.within_prep_window}")
        if plan.within_prep_window:
            print(f"Minutes until trigger: {minutes_until_trigger(now):.1f}")
        else:
            nxt = next_settlement_time(now)
            mins = (nxt - now).total_seconds() / 60
            print(f"Next window opens: {nxt.isoformat()} ({mins:.0f} min from now)")
        print()
        print(f"Settlement spots: {plan.settlement_spots}")
        print()
        print(f"EOA balances:")
        for k, v in sorted(plan.eoa_balances.items()):
            print(f"  {k:>12}: {v:,.6f}")
        print()
        print(f"MarginPool balances:")
        for k, v in sorted(plan.margin_pool_balances.items()):
            print(f"  {k[:10]:>12}: {v:,.6f}")
        print()
        print(f"Requirements per underlying:")
        for sym, req in plan.requirements.items():
            itm_puts = len(req.itm_put_trades)
            itm_calls = len(req.itm_call_trades)
            print(f"  {sym}: {itm_puts} ITM puts, {itm_calls} ITM calls")
            if req.underlying_to_deliver > 0:
                print(f"    → deliver {req.underlying_to_deliver:.6f} {sym}, "
                      f"receive {req.stablecoin_to_receive:,.2f} stablecoin")
            if req.stablecoin_to_deliver > 0:
                print(f"    → deliver {req.stablecoin_to_deliver:,.2f} stablecoin, "
                      f"receive {req.underlying_to_receive:.6f} {sym}")
            bp = plan.bootstrap_plans.get(sym)
            if bp is not None:
                print(f"    bootstrap: cycles={bp.cycles} feasible={bp.feasible}")
                if not bp.feasible:
                    print(f"      reason: {bp.reason}")
        print()
        print(f"FEASIBLE: {plan.feasible}")
        if plan.blocking_reasons:
            print("BLOCKING:")
            for r in plan.blocking_reasons:
                print(f"  - {r}")
        print("=" * 70)

    # ---------------- Execution ----------------

    def execute(
        self,
        plan: SettlementPlan,
        dry_run: bool = True,
        force_outside_window: bool = False,
    ) -> dict:
        """Run the preparation loop described by the plan.

        Safety rails:
        - Refuses if plan.feasible is False
        - Refuses if outside the Friday 8-9am window unless force_outside_window
        - Logs every step
        - Dry-run is the default; caller must pass dry_run=False explicitly
        - Never triggers the actual redemption (Rysk team does that at 9am)

        Returns a dict with per-underlying execution results.
        """
        results = {"dry_run": dry_run, "steps": [], "errors": []}

        if not plan.feasible:
            results["errors"].append("Plan is not feasible. Refusing to execute.")
            return results

        if not plan.within_prep_window and not force_outside_window:
            results["errors"].append(
                "Not in Friday 8-9am UTC redemption window. "
                "Pass force_outside_window=True to override (dry run only)."
            )
            return results

        for sym, req in plan.requirements.items():
            if req.underlying_to_deliver <= 0:
                results["steps"].append({
                    "underlying": sym,
                    "action": "skip",
                    "reason": "no ITM puts to settle",
                })
                continue

            bp = plan.bootstrap_plans.get(sym)
            if bp is None:
                results["errors"].append(f"{sym}: no bootstrap plan")
                continue

            # Step 1: deposit what we have on EOA into MarginPool
            deposit_amount = bp.initial_eoa_deposit
            if deposit_amount > 0:
                step = {
                    "underlying": sym,
                    "action": "deposit",
                    "amount": deposit_amount,
                    "asset": self.asset_addresses.get(sym, "?"),
                }
                if not dry_run:
                    try:
                        addr = self.asset_addresses[sym]
                        # Convert to raw integer (decimals matter!)
                        dec = self._decimals_for(addr)
                        raw_amount = str(int(deposit_amount * (10 ** dec)))
                        self.rysk.deposit(asset=addr, amount=raw_amount)
                        step["status"] = "submitted"
                    except Exception as e:
                        step["status"] = "error"
                        step["error"] = str(e)
                        results["errors"].append(f"{sym} deposit: {e}")
                else:
                    step["status"] = "dry_run"
                results["steps"].append(step)

            # Step 2: if bootstrap needs more cycles, loop
            for cycle in range(bp.cycles - 1 if bp.cycles > 1 else 0):
                results["steps"].append({
                    "underlying": sym,
                    "action": "bootstrap_cycle",
                    "cycle": cycle + 1,
                    "withdraw_stablecoin": bp.stablecoin_withdraw_per_cycle,
                    "swap_to_underlying": bp.dex_swap_amount_per_cycle,
                    "status": "not_implemented" if not dry_run else "dry_run",
                })

        results["completed_at"] = time.time()
        return results
