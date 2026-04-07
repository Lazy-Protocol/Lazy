"""Derive mainnet readiness check.

Smoke tests that the ArbDeriveClient + MarkCache + RatioCache pipeline
actually works against live Derive mainnet BEFORE we trust it with real
capital. Each check is independent and reports pass/fail/skip with a
specific reason. Nothing in this module places orders or executes
trades — it's pure read path.

Usage:
    python -m scripts.arb.cli derive-readiness
    python -m scripts.arb.cli derive-readiness --underlying HYPE --verbose
"""

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str = ""
    value: Any = None
    elapsed_s: float = 0.0


@dataclass
class ReadinessReport:
    checks: list[CheckResult] = field(default_factory=list)

    @property
    def passed_count(self) -> int:
        return sum(1 for c in self.checks if c.passed)

    @property
    def failed_count(self) -> int:
        return sum(1 for c in self.checks if not c.passed)

    @property
    def all_passed(self) -> bool:
        return self.failed_count == 0

    def add(self, name: str, fn, *args, **kwargs) -> CheckResult:
        """Run a check function and record the result."""
        import time
        start = time.time()
        try:
            value = fn(*args, **kwargs)
            if isinstance(value, tuple) and len(value) == 2:
                passed, detail = value
                res = CheckResult(
                    name=name, passed=passed, detail=detail,
                    elapsed_s=time.time() - start,
                )
            elif isinstance(value, CheckResult):
                value.elapsed_s = time.time() - start
                res = value
            else:
                res = CheckResult(
                    name=name, passed=True, detail="ok", value=value,
                    elapsed_s=time.time() - start,
                )
        except Exception as e:
            res = CheckResult(
                name=name, passed=False,
                detail=f"{type(e).__name__}: {e}",
                elapsed_s=time.time() - start,
            )
        self.checks.append(res)
        return res

    def print_summary(self, verbose: bool = False):
        print("=" * 72)
        print(f"Derive readiness: {self.passed_count}/{len(self.checks)} checks passed")
        print("=" * 72)
        for c in self.checks:
            mark = "PASS" if c.passed else "FAIL"
            print(f"  [{mark}] {c.name}  ({c.elapsed_s*1000:.0f}ms)")
            if c.detail:
                print(f"         {c.detail}")
            if verbose and c.value is not None:
                val_str = repr(c.value)
                if len(val_str) > 200:
                    val_str = val_str[:200] + "..."
                print(f"         value={val_str}")
        print("=" * 72)
        if self.all_passed:
            print("ALL CHECKS PASSED. Derive client is ready for mainnet use.")
        else:
            print(f"{self.failed_count} CHECK(S) FAILED. Do NOT use in production.")


def _load_dotenv():
    """Load .env from project root into os.environ (only missing keys)."""
    import os
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


def run_readiness(underlying: str = "HYPE", verbose: bool = False) -> ReadinessReport:
    """Run the full readiness suite against live Derive mainnet."""
    import os
    import time
    _load_dotenv()

    from scripts.arb.derive_om import ArbDeriveClient
    from scripts.arb.pricing import MarkCache, RatioCache

    report = ReadinessReport()

    # --- 0. Environment ---
    def check_env():
        missing = []
        for var in ("DERIVE_WALLET", "DERIVE_SESSION_KEY", "DERIVE_SUBACCOUNT_ID"):
            if not os.environ.get(var):
                missing.append(var)
        if missing:
            return False, f"Missing env vars: {', '.join(missing)}"
        return True, "DERIVE_WALLET, DERIVE_SESSION_KEY, DERIVE_SUBACCOUNT_ID set"

    report.add("env vars present", check_env)

    # If env is missing, short-circuit
    if not report.checks[-1].passed:
        return report

    # --- 1. Client instantiation ---
    client: Optional[ArbDeriveClient] = None

    def check_init():
        nonlocal client
        client = ArbDeriveClient(testnet=False)
        return True, f"subaccount_id={client.subaccount_id}"

    report.add("client init", check_init)
    if client is None:
        return report

    # --- 2. Index (spot) price ---
    def check_spot():
        spot = client.get_index_price(underlying)
        if spot is None or spot <= 0:
            return False, f"invalid spot: {spot}"
        return True, f"${spot:.2f}"

    report.add(f"{underlying} spot price", check_spot)

    # --- 3. Perp ticker ---
    def check_perp():
        ticker = client.get_ticker(f"{underlying}-PERP")
        idx = float(ticker.get("index_price", 0))
        mark = float(ticker.get("mark_price", 0))
        if idx <= 0 or mark <= 0:
            return False, f"perp ticker empty: idx={idx} mark={mark}"
        return True, f"idx=${idx:.2f} mark=${mark:.2f}"

    report.add(f"{underlying}-PERP ticker", check_perp)

    # --- 4. Active instruments (options list) ---
    instruments_cache = []

    def check_instruments():
        nonlocal instruments_cache
        resp = client.get_instruments(currency=underlying, expired=False)
        # API sometimes returns {"instruments":[...]}
        if isinstance(resp, dict):
            instruments_cache = resp.get("instruments", resp.get("result", []))
        else:
            instruments_cache = resp
        # Filter to options (ignore perp)
        opts = [
            i for i in instruments_cache
            if isinstance(i, dict)
            and i.get("instrument_type", "").lower() == "option"
        ]
        if not opts:
            return False, f"no option instruments found (got {len(instruments_cache)} total)"
        instruments_cache = opts
        return True, f"{len(opts)} active {underlying} options"

    report.add(f"{underlying} instruments list", check_instruments)

    # --- 5. Pick a representative near-ATM, moderate-DTE option and query ticker ---
    sample_option = None

    def check_option_ticker():
        nonlocal sample_option
        if not instruments_cache:
            return False, "no instruments to sample from"

        # Need spot for moneyness calc — use the one from check_spot
        try:
            spot = client.get_index_price(underlying)
        except Exception:
            spot = 0

        from scripts.arb.pricing import parse_instrument_name
        from datetime import datetime, timezone

        # Score each option by (moneyness, DTE) and pick the best
        now_ts = time.time()
        best = None
        best_score = float("inf")
        for inst in instruments_cache:
            name = inst.get("instrument_name", "")
            if not name:
                continue
            parsed = parse_instrument_name(name)
            if not parsed:
                continue
            try:
                exp_str = parsed["expiry_str"]
                expiry_ts = datetime.strptime(exp_str, "%Y%m%d").replace(
                    hour=8, tzinfo=timezone.utc,
                ).timestamp()
            except Exception:
                continue
            dte = (expiry_ts - now_ts) / 86400
            if dte < 5 or dte > 30:
                continue  # Avoid too-near or too-far
            strike = parsed["strike"]
            if spot > 0:
                moneyness = abs(strike - spot) / spot
            else:
                moneyness = 1.0
            if moneyness > 0.25:
                continue  # Keep to within 25% of spot
            # Lower score is better: prefer close-to-ATM, then mid-DTE
            score = moneyness * 10 + abs(dte - 14) / 14
            if score < best_score:
                best_score = score
                best = name

        if best is None:
            return False, "no suitable near-ATM moderate-DTE option in instruments list"
        sample_option = best

        ticker = client.get_ticker(sample_option)
        mark = float(ticker.get("mark_price", 0))
        opt_pricing = ticker.get("option_pricing") or {}
        iv = float(opt_pricing.get("iv", 0) or 0)
        if mark <= 0:
            return False, f"{sample_option} has zero mark"
        return True, f"{sample_option} mark=${mark:.4f} iv={iv:.0%}"

    report.add("option ticker", check_option_ticker)

    # --- 6. get_margin API (Derive's naming for compute-margin) ---
    def check_compute_margin():
        if sample_option is None:
            return False, "no sample option"
        # Use 10 contracts so the IM delta is meaningfully non-zero.
        # 1 contract rounds to ~0 surplus delta.
        margin = client.query_margin(sample_option, 10.0)
        im = margin.get("initial_margin", 0)
        if im <= 0:
            return False, f"get_margin returned IM={im} for 10 contracts"
        if not margin.get("is_valid_trade"):
            return False, f"trade flagged invalid by Derive: {margin}"
        return True, (
            f"im=${im:.2f} mm=${margin.get('maintenance_margin', 0):.2f} "
            f"im_per_contract=${margin.get('im_per_contract', 0):.2f} "
            f"valid_trade={margin.get('is_valid_trade')}"
        )

    report.add("get_margin API", check_compute_margin)

    # --- 7. Account margin / positions ---
    def check_account_margin():
        acc = client.get_account_margin()
        equity = acc.get("equity", 0)
        total_im = acc.get("total_im", 0)
        positions = acc.get("positions", [])
        return True, (
            f"equity=${equity:,.2f} total_im=${total_im:,.2f} "
            f"positions={len(positions)}"
        )

    report.add("account margin", check_account_margin)

    # --- 8. Collaterals (raw) ---
    def check_collaterals():
        resp = client.get_collaterals()
        collaterals = resp.get("collaterals", resp) if isinstance(resp, dict) else resp
        return True, f"{len(collaterals)} collateral entries"

    report.add("collaterals query", check_collaterals)

    # --- 9. Trade history (for RatioCache) ---
    def check_trade_history():
        if sample_option is None:
            return False, "no sample option"
        try:
            result = client._public("get_trade_history", {
                "instrument_name": sample_option,
                "page_size": 20,
            })
            trades = result.get("trades", []) if isinstance(result, dict) else []
            return True, f"{len(trades)} recent trades on {sample_option}"
        except Exception as e:
            return False, f"trade history query failed: {e}"

    report.add("trade history", check_trade_history)

    # --- 10. MarkCache.refresh ---
    mark_cache = MarkCache(client)

    def check_mark_cache():
        mark_cache.refresh(underlyings=(underlying,))
        fresh = getattr(mark_cache, "fresh_count", 0)
        if fresh <= 0:
            return False, f"refresh produced 0 fresh marks"
        return True, f"{fresh} instruments cached"

    report.add("MarkCache.refresh", check_mark_cache)

    # --- 11. RatioCache.refresh (optional, costly) ---
    def check_ratio_cache():
        rc = RatioCache(client)
        # Pull a small subset to avoid hammering the API
        sample_instruments = list(mark_cache._marks.keys())[:5] if mark_cache._marks else []
        if not sample_instruments:
            return False, "no instruments in mark cache to sample"
        rc.refresh(sample_instruments)
        inst_count = rc.instrument_count
        return True, f"{inst_count} instruments with ratios (sampled {len(sample_instruments)})"

    report.add("RatioCache.refresh", check_ratio_cache)

    # --- 12. Mark cache freshness and sanity ---
    def check_mark_freshness():
        if not mark_cache._marks:
            return False, "mark cache empty"
        any_mark = next(iter(mark_cache._marks.values()))
        if any_mark.is_stale:
            return False, "just-refreshed mark is already stale"
        if any_mark.spot <= 0:
            return False, f"mark has zero spot: {any_mark.spot}"
        return True, (
            f"sample={any_mark.instrument} mark=${any_mark.derive_mark:.4f} "
            f"spot=${any_mark.spot:.2f} iv={any_mark.iv:.0%}"
        )

    report.add("mark cache sanity", check_mark_freshness)

    return report
