"""Settlement / redemption cycle planner.

Implements the spec Section 9.0 redemption cycle. The module is split
into pure-logic planning (this file) and side-effectful execution
(settlement_executor.py, still to come). Pure logic is exhaustively
unit tested; the executor layer only orchestrates.

Model:
- Rysk settles options at Friday 8:00 AM UTC. The Rysk team triggers
  exercise for all MMs in ONE batch at Friday 9:00 AM UTC.
- The 8-9am window is PREPARATION TIME. Whatever is in the MarginPool
  at the moment of the 9am trigger is what gets processed.
- Long puts that end ITM require us to DELIVER the underlying (WETH /
  WBTC / HYPE) from the MarginPool and we receive strike stablecoin.
- Long calls that end ITM require us to DELIVER strike stablecoin and
  we receive the underlying.
- OTM options expire worthless (nothing to do).

The planner computes what assets we need in the pool by 9am, verifies
we have enough on the EOA, and (if not) plans a bootstrap loop:
  deposit underlying -> withdraw stablecoin -> DEX swap -> redeposit

On testnet we were funded with 1M WETH + 1k WBTC + 1M USDC so bootstrap
is never needed. On mainnet the bootstrap loop is a real concern when
positions exceed EOA underlying buffer.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional


# Rysk settlement time constants (Friday 8:00 AM UTC = expiry)
SETTLEMENT_HOUR_UTC = 8           # Rysk oracle fixes price at 8:00
REDEMPTION_TRIGGER_HOUR_UTC = 9    # Rysk team triggers exercise at 9:00
PREP_WINDOW_MINUTES = 60          # 8:00-9:00 = 60 minutes to prep


# ---------------------------------------------------------------------------
# Trade classification
# ---------------------------------------------------------------------------

def is_itm(option_type: str, strike: float, settlement_spot: float) -> bool:
    """True if the option finishes in-the-money for a BUYER.

    For long puts we win when spot < strike.
    For long calls we win when spot > strike.
    """
    if option_type == "P":
        return settlement_spot < strike
    elif option_type == "C":
        return settlement_spot > strike
    raise ValueError(f"Unknown option_type: {option_type!r}")


def intrinsic_value(
    option_type: str,
    strike: float,
    settlement_spot: float,
    qty: float,
) -> float:
    """Gross payoff to the buyer at expiry, before fees and delivery costs."""
    if option_type == "P":
        return max(0.0, strike - settlement_spot) * qty
    if option_type == "C":
        return max(0.0, settlement_spot - strike) * qty
    raise ValueError(f"Unknown option_type: {option_type!r}")


# ---------------------------------------------------------------------------
# Delivery requirements per expiry
# ---------------------------------------------------------------------------

@dataclass
class DeliveryRequirement:
    """What the bot must have in the MarginPool by 9am to settle one expiry.

    For long puts ITM: deliver `underlying_amount` of the asset, receive
    `stablecoin_received` amount of the strike stablecoin.

    For long calls ITM: deliver `stablecoin_amount` of the strike
    stablecoin, receive `underlying_received` amount of the underlying.

    Quantities are in float units of the asset (not e18/e6 raw).
    """
    underlying: str                        # e.g. "WETH", "WBTC", "HYPE"
    expiry_ts: int
    itm_put_trades: list = field(default_factory=list)
    itm_call_trades: list = field(default_factory=list)

    # What we must DELIVER into the pool
    underlying_to_deliver: float = 0.0     # for ITM puts
    stablecoin_to_deliver: float = 0.0     # for ITM calls

    # What we EXPECT to receive back
    stablecoin_to_receive: float = 0.0     # from ITM puts
    underlying_to_receive: float = 0.0     # from ITM calls

    def net_pnl_at_strike(self) -> float:
        """Rough net gain at settlement (excludes pre-paid Rysk premium).

        For long puts: stablecoin received - (underlying delivered * settlement spot)
        For long calls: underlying received * spot - stablecoin delivered
        The premium we PAID at entry is captured in the PnLTracker trade record;
        this function only computes settlement-time delta.
        """
        # Note: caller must supply spot to evaluate. Without spot we can only
        # report the raw quantity requirements.
        return 0.0  # Placeholder; see compute_settlement_pnl below


def classify_trades_for_expiry(
    trades: list,
    expiry_ts: int,
    settlement_spots: dict[str, float],
) -> dict[str, DeliveryRequirement]:
    """Group open trades by underlying for a given expiry and compute
    delivery requirements.

    `trades` is an iterable of ArbTrade-like objects (needs attributes:
    underlying, option_type, strike, qty, expiry_ts, status).

    `settlement_spots` maps underlying → settlement spot (usually the
    Stork oracle read at 8:00 AM UTC). Missing underlyings are skipped.

    Returns {underlying: DeliveryRequirement}. A requirement entry is
    created for every underlying with at least one open trade at this
    expiry, even if all are OTM (so the report shows them as no-op).
    """
    grouped: dict[str, DeliveryRequirement] = {}
    for t in trades:
        if t.status != "open":
            continue
        if t.expiry_ts != expiry_ts:
            continue

        under = t.underlying
        req = grouped.get(under)
        if req is None:
            req = DeliveryRequirement(underlying=under, expiry_ts=expiry_ts)
            grouped[under] = req

        spot = settlement_spots.get(under)
        if spot is None:
            continue  # Can't classify without the settlement spot

        if not is_itm(t.option_type, t.strike, spot):
            continue

        if t.option_type == "P":
            req.itm_put_trades.append(t)
            req.underlying_to_deliver += t.qty
            req.stablecoin_to_receive += t.strike * t.qty
        elif t.option_type == "C":
            req.itm_call_trades.append(t)
            req.stablecoin_to_deliver += t.strike * t.qty
            req.underlying_to_receive += t.qty

    return grouped


# ---------------------------------------------------------------------------
# EOA balance vs requirement
# ---------------------------------------------------------------------------

@dataclass
class BootstrapPlan:
    """Plan for the 8-9am preparation loop when EOA balance is short.

    The idea (spec Section 9.0): the MarginPool acts like a deposit/
    withdraw pool during the window. If we only have part of the
    required underlying, we can cycle capital:
      1. Deposit what we have
      2. Withdraw stablecoin the pool has accumulated from other MMs'
         deposits (up to what our strike-receive total will be)
      3. Swap stablecoin → underlying on an external DEX
      4. Redeposit the new underlying
      5. Repeat until by 8:59am we have enough in the pool

    Each cycle converts stablecoin at the current DEX price. If spot
    moves during the window the cycle math shifts.

    Fields:
      cycles: how many deposit/withdraw/swap round-trips are needed
      initial_eoa_deposit: amount of underlying we deposit on cycle 1
      stablecoin_withdraw_per_cycle: how much stablecoin we pull each cycle
      dex_swap_amount_per_cycle: stablecoin we swap to underlying each cycle
      expected_underlying_delivered: total underlying that will end up
        in the pool by 9am
      feasible: True if the plan can complete within the 60-minute window
      reason: explanation if not feasible
    """
    cycles: int
    initial_eoa_deposit: float
    stablecoin_withdraw_per_cycle: float
    dex_swap_amount_per_cycle: float
    expected_underlying_delivered: float
    feasible: bool
    reason: str = ""


def plan_bootstrap(
    required_underlying: float,
    eoa_underlying_balance: float,
    eoa_stablecoin_balance: float,
    dex_spot_price: float,
    max_cycles: int = 10,
) -> BootstrapPlan:
    """Plan the deposit/withdraw/swap loop for an underlying shortage.

    If eoa_underlying_balance >= required_underlying, no bootstrap is
    needed (cycles=0). Otherwise, we deposit what we have, loop through
    withdraw + swap + redeposit cycles until we reach the target.

    For simplicity the planner assumes DEX price is constant across the
    window (not realistic but gives a first-pass estimate). A more
    sophisticated version would factor in slippage.
    """
    if eoa_underlying_balance >= required_underlying:
        return BootstrapPlan(
            cycles=0,
            initial_eoa_deposit=required_underlying,
            stablecoin_withdraw_per_cycle=0,
            dex_swap_amount_per_cycle=0,
            expected_underlying_delivered=required_underlying,
            feasible=True,
        )

    short = required_underlying - eoa_underlying_balance
    # Each cycle swaps stablecoin -> underlying at dex_spot_price
    # To cover `short` units of underlying, need `short * dex_spot_price` stablecoin
    stablecoin_needed = short * dex_spot_price

    if dex_spot_price <= 0:
        return BootstrapPlan(
            cycles=0,
            initial_eoa_deposit=eoa_underlying_balance,
            stablecoin_withdraw_per_cycle=0,
            dex_swap_amount_per_cycle=0,
            expected_underlying_delivered=eoa_underlying_balance,
            feasible=False,
            reason="DEX spot price <= 0",
        )

    # How many cycles? Each cycle can withdraw at most the total stablecoin
    # the pool will pay us (stablecoin_to_receive), divided by number of
    # cycles. Simplest model: one big cycle does the full conversion.
    # Real-world constraint: each cycle has tx latency (~15s), so up to
    # 60/0.25 = 240 cycles theoretically fit in an hour, but we cap at 10
    # for safety / simplicity.
    #
    # We use 1 cycle by default (single withdraw + swap + redeposit) if
    # EOA stablecoin alone can cover the gap. Otherwise we need to pull
    # from the pool via withdraw.
    if eoa_stablecoin_balance >= stablecoin_needed:
        # Single swap from EOA stablecoin, no pool withdraw loop
        return BootstrapPlan(
            cycles=1,
            initial_eoa_deposit=eoa_underlying_balance,
            stablecoin_withdraw_per_cycle=0,
            dex_swap_amount_per_cycle=stablecoin_needed,
            expected_underlying_delivered=required_underlying,
            feasible=True,
        )

    # Need to loop: deposit, withdraw pool stablecoin, swap, redeposit
    # Each loop withdraws as much pool stablecoin as we're owed so far.
    # Very rough: assume we can pull enough in max_cycles iterations.
    cycles = 1  # At least the initial deposit
    # Each cycle grows underlying by (pool_withdraw_per_cycle / dex_spot_price)
    # Simpler: just say we need 1-3 cycles to reach target and warn if more
    # would be required.
    est_cycles_needed = max(1, int(stablecoin_needed / max(eoa_stablecoin_balance, 1) + 0.5))
    if est_cycles_needed > max_cycles:
        return BootstrapPlan(
            cycles=est_cycles_needed,
            initial_eoa_deposit=eoa_underlying_balance,
            stablecoin_withdraw_per_cycle=eoa_stablecoin_balance,
            dex_swap_amount_per_cycle=eoa_stablecoin_balance,
            expected_underlying_delivered=eoa_underlying_balance,
            feasible=False,
            reason=(
                f"Need {est_cycles_needed} cycles but cap is {max_cycles}. "
                f"Gap: {short:.4f} {required_underlying} units, "
                f"EOA stablecoin: {eoa_stablecoin_balance:.2f}"
            ),
        )

    return BootstrapPlan(
        cycles=est_cycles_needed,
        initial_eoa_deposit=eoa_underlying_balance,
        stablecoin_withdraw_per_cycle=eoa_stablecoin_balance,
        dex_swap_amount_per_cycle=eoa_stablecoin_balance,
        expected_underlying_delivered=required_underlying,
        feasible=True,
    )


# ---------------------------------------------------------------------------
# Time window checks
# ---------------------------------------------------------------------------

def next_settlement_time(now: datetime) -> datetime:
    """Return the next Friday 8:00 AM UTC.

    If `now` is before Friday 8am this week, returns this Friday's time.
    If `now` is after, returns next Friday's time.
    """
    if now.tzinfo is None:
        raise ValueError("now must be tz-aware (UTC)")
    # Friday = weekday 4
    days_ahead = (4 - now.weekday()) % 7
    candidate = now.replace(hour=SETTLEMENT_HOUR_UTC, minute=0, second=0, microsecond=0)
    candidate = candidate.replace(
        day=now.day  # keep day as-is then add delta
    )
    # Simplest: compute Friday of this week at 8am, then bump by 7 days if past
    from datetime import timedelta
    friday_8am = (now + timedelta(days=days_ahead)).replace(
        hour=SETTLEMENT_HOUR_UTC, minute=0, second=0, microsecond=0
    )
    # If we already passed Friday 9am, target next Friday
    if days_ahead == 0 and now.hour >= REDEMPTION_TRIGGER_HOUR_UTC:
        friday_8am = friday_8am + timedelta(days=7)
    return friday_8am


def is_in_redemption_window(now: datetime) -> bool:
    """True if we're in the Friday 8:00-9:00 UTC prep window."""
    if now.tzinfo is None:
        raise ValueError("now must be tz-aware (UTC)")
    if now.weekday() != 4:  # Not Friday
        return False
    return SETTLEMENT_HOUR_UTC <= now.hour < REDEMPTION_TRIGGER_HOUR_UTC


def minutes_until_trigger(now: datetime) -> float:
    """Minutes until the next Friday 9:00 UTC trigger.

    Returns 0 if we're past it but still on Friday.
    Returns -1 if now is not yet at 8am on a Friday (prep hasn't started).
    """
    if now.tzinfo is None:
        raise ValueError("now must be tz-aware (UTC)")
    if not is_in_redemption_window(now):
        return -1
    trigger = now.replace(
        hour=REDEMPTION_TRIGGER_HOUR_UTC, minute=0, second=0, microsecond=0,
    )
    remaining = (trigger - now).total_seconds() / 60
    return max(0.0, remaining)
