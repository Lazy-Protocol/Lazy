"""All tunable constants for the options arb strategy.

Source of truth: docs/OPTIONS_ARB_STRATEGY.md
"""

# --- Execution ratios (Derive mark -> expected RFQ fill) ---
# Calibrated from live Derive trade history (n=14 taker-sell RFQs at
# 500-999 contract size). Median 0.833, mean 0.895. Using 0.85 as a
# balance. Recalibrate weekly from actual maker-side fills.
EXECUTION_RATIOS = {
    "HYPE": 0.85,  # Calibrated from Derive trade history, Apr 2026
    "ETH": 0.97,   # Deep liquidity, marks accurate (not calibrated)
    "BTC": 0.95,   # Estimate, calibrate from live data
    "SOL": 0.85,   # Estimate, calibrate from live data
}

# --- Tier confidence weights ---
# Applied to tier value as a discount for execution uncertainty.
TIER_WEIGHTS = {
    1: 0.95,  # High confidence in Derive fill
    2: 0.80,  # Bounded risk, moderate confidence
    3: 0.70,  # Gap/roll risk, lower confidence
    4: 0.50,  # Hedging cost uncertain
}

# --- Minimum spread thresholds (per contract) ---
MIN_SPREADS = {
    "HYPE": 0.10,
    "ETH": 1.00,
    "BTC": 5.00,
    "SOL": 0.50,
}

# --- Position limits ---
MAX_OPTIONS_CAPITAL = 100_000      # Initial warmup allocation
MAX_SINGLE_POSITION = 10_000       # Premium notional (contracts * premium paid)
MAX_PER_UNDERLYING = 20_000        # Premium notional
MAX_OPEN_POSITIONS = 10            # Across both venues
MAX_SINGLE_VENUE_PCT = 0.70        # Max 70% of options capital on one venue
MAX_UNHEDGED_INVENTORY = 5_000     # Premium notional, stop quoting if exceeded

# Net delta limits per underlying.
# Audit L2 verified: BTC 0.5 is intentional, not a typo. At $65k spot that
# is ~$32.5k notional, which is ~32% of MAX_OPTIONS_CAPITAL. Loose relative
# to HYPE/ETH/SOL (~7-10%) but tight in absolute BTC units; raising to 5.0
# would allow $325k BTC notional, >3x total deployable capital.
MAX_NET_DELTA = {
    "HYPE": 200,
    "ETH": 5,
    "BTC": 0.5,
    "SOL": 50,
}

# --- Margin (cross-margin, account-level) ---
# Derive uses cross-margin: all positions share account collateral.
# Ratios below are account-wide (total equity / total IM), not per-position.
MARGIN_ALERT_RATIO = 1.5           # Alert when account equity/IM drops below this
MARGIN_AUTO_CLOSE_RATIO = 1.25     # Auto-close positions when account ratio below this
MAX_MARGIN_UTILIZATION = 0.50      # Max 50% of Derive collateral deployed as IM
                                   # (equivalent to 2.0x starting margin ratio)

# --- Cache ---
MAX_CACHE_AGE_SECONDS = 30         # Mark cache stale if older than this
CACHE_REFRESH_INTERVAL = 7         # Seconds between Derive mark polls
MARK_CACHE_MAX_WORKERS = 10        # Concurrent HTTP workers for mark cache refresh

# --- Ratio cache (per-instrument execution ratio learning) ---
RATIO_CACHE_MAX_AGE = 600          # Refresh instrument ratios every 10 minutes
RATIO_CACHE_MAX_WORKERS = 10       # Concurrent HTTP workers for trade history fetch
RATIO_MIN_SAMPLES = 5              # Minimum samples for per-instrument ratio
RATIO_DTE_MIN_SAMPLES = 5          # Minimum samples for DTE-bucket ratio
RATIO_BUFFER = 0.01                # Subtract from computed ratios (post-trade mark adjustment)
RATIO_UNRELIABLE_THRESHOLD = 0.75  # Below this, treat as noise and fall through
MIN_EXEC_RATIO = 0.70              # Floor clamp for computed ratios
MAX_EXEC_RATIO = 0.99              # Ceiling clamp for computed ratios
DEFAULT_EXEC_RATIO = 0.85          # Fallback when no data available

# --- Retune (automated drift detection) ---
RETUNE_MIN_SAMPLES = 20            # Below this, keep existing config unchanged
RETUNE_DRIFT_THRESHOLD = 0.03      # Alert when |own_fill - config| exceeds this
RETUNE_STDERR_THRESHOLD = 0.02     # High-uncertainty threshold; wait for more data

# --- Performance feedback (tier weight learning from settled trades) ---
TIER_WEIGHT_MIN_TRADES = 10        # Below this, don't suggest tier weight updates
TIER_WEIGHT_LEARNING_RATE = 0.3    # EWMA rate: new = old * (1 - lr) + target * lr
MIN_WIN_RATE = 0.20                # Below this, bids too tight (underbidding)
MAX_WIN_RATE = 0.60                # Above this, bids too loose (overbidding)

# --- Kill switch ---
MAX_WEEKLY_LOSS = 2_000            # Cumulative realized, stop all activity
MAX_CONSECUTIVE_UNHEDGED_WINS = 3  # Rysk wins with no Derive fill
MAX_SETTLEMENT_MISMATCH = 100      # Expected vs actual P&L

# --- Strike selection ---
MIN_OTM_PCT = 0.06                 # 6% minimum OTM
TARGET_OTM_PCT = (0.15, 0.22)      # Sweet spot range
MAX_OTM_PCT = 0.30                 # Beyond this, premiums too small

# --- Expiry selection ---
RYSK_EXPIRY_DAYS = (7, 14)         # Preferred Rysk buy range
DERIVE_EXPIRY_DAYS = (14, 28)      # Preferred Derive sell range
MAX_EXPIRY_DAYS = 28               # Capital locked too long beyond this

# --- Fee parameters ---
RYSK_FEE_SPOT_FACTOR = 0.01       # 1% of spot
RYSK_FEE_PREMIUM_FACTOR = 0.125   # 12.5% of option price
DERIVE_TAKER_BASE_FEE = 0.50      # $0.50 per trade
DERIVE_TAKER_NOTIONAL_PCT = 0.0003  # 0.03% of notional
DERIVE_TAKER_MAX_PCT = 0.125      # Capped at 12.5% of premium
DERIVE_MAKER_NOTIONAL_PCT = 0.0001  # 0.01% of notional
HL_PERP_FEE_PCT = 0.00035         # 0.035% per side (Hyperliquid default, unused if we use Lighter)
LIGHTER_PERP_FEE_PCT = 0.0        # Zero-fee on standard accounts

# --- Tier 2/3 thresholds ---
TIER2_MAX_DEBIT_PCT = 0.25        # Net debit < 25% of strike gap width
TIER3_MIN_PREMIUM_RATIO = 2.0     # Net premium > 2x single leg cost

# Tier 4 threshold: Rysk price must be at or below this fraction of BS fair.
# PROVISIONAL - starts strict (0.75 = 25% below fair). Will be recalibrated
# by performance feedback once we have 20+ Tier 4 outcomes. Every Tier 4
# decision logs to data/tier4-decisions.jsonl to build the dataset.
TIER4_MIN_BS_DISCOUNT = 0.75

# --- Tier 4 migration (tier 4 -> tier 1/2/3 upgrade monitor) ---
MIGRATION_CHECK_INTERVAL_SECONDS = 3600   # Hourly scan of open Tier 4 positions
MIGRATION_MIN_BENEFIT = 50.0              # Don't migrate for < $50 expected gain
MIGRATION_RFQ_TIMEOUT_SECONDS = 20        # Max wait for Derive quotes during migration
MIGRATION_MAX_SPREAD_MULTIPLIER = 3.0     # Defer if target spread > 3x median
                                          # (reserved for rolling median impl; not wired yet)
MIGRATION_MAX_SPREAD_PCT = 0.10           # Interim absolute cap on target spread (spread/mid)
MIGRATION_DELTA_DRIFT_THRESHOLD = 0.05    # Rebalance perp if |delta drift| > 5%
TIER4_DECISIONS_LOG = "data/tier4-decisions.jsonl"

# --- Black-Scholes ---
BS_RISK_FREE_RATE = 0.05

# --- Perp backstop ---
HYPE_PERP_BACKSTOP_DELTA_PCT = 0.50  # Hedge 50% of delta immediately for HYPE

# --- Perp venue mapping (zero-fee where possible) ---
# Lighter has zero trading fees on standard accounts and deep-enough HYPE
# liquidity for our hedge sizes. Fallback to Hyperliquid for venues where
# Lighter lacks listings.
PERP_VENUE = {
    "HYPE": "lighter",
    "ETH": "lighter",
    "BTC": "lighter",
    "SOL": "lighter",
}

# Perp execution parameters - urgency-aware
# HYPE is mean-reverting so patient limits usually fill without market.
# Use URGENT only when speed is critical (e.g., Rysk post-win 15s window).
# Use PATIENT for migration close, routine rebalance, kill-switch exits.
PERP_URGENCY_PROFILES = {
    "urgent": {
        "chase_attempts": 3,
        "chase_wait_seconds": 2.0,
        "market_slippage_pct": 0.001,  # 0.1%
        "limit_offset_ticks": 1,        # Post-only 1 tick inside spread
    },
    "patient": {
        "chase_attempts": 4,
        "chase_wait_seconds": 10.0,     # 40s total before market fallback
        "market_slippage_pct": 0.0005,  # 0.05% - tighter since we're patient
        "limit_offset_ticks": 0,        # Start at inside (midpoint-ish)
    },
    "routine": {
        "chase_attempts": 6,
        "chase_wait_seconds": 15.0,     # 90s total, very patient
        "market_slippage_pct": 0.0003,  # 0.03% - very tight
        "limit_offset_ticks": 0,
    },
}
PERP_DEFAULT_URGENCY = "patient"
PERP_SIGN_PRECISION = 6             # Position size precision for zero-check

# --- Derive API ---
DERIVE_API_BASE = "https://api.lyra.finance"
DERIVE_WS_URL = "wss://api.lyra.finance/ws"

# --- Rysk V12 ---
# Environment: "testnet" (Base Sepolia) or "mainnet" (HyperEVM)
# Testnet is REQUIRED before any mainnet deployment. Rysk team observes
# our error handling on testnet before granting mainnet access.
RYSK_ENV = "testnet"

# Mainnet config (HyperEVM, chain 999)
RYSK_MAINNET_CHAIN_ID = 999
RYSK_MAINNET_WS_BASE = "wss://v12.rysk.finance"

# Testnet config (Base Sepolia, chain 84532)
RYSK_TESTNET_CHAIN_ID = 84532
RYSK_TESTNET_WS_BASE = "wss://rip-testnet.rysk.finance"
RYSK_TESTNET_RPC_URL = "https://sepolia.base.org"

# Path to the ryskV12 Go CLI binary. The Python SDK spawns this as a subprocess.
# Download from https://github.com/rysk-finance/ryskV12-cli/releases/latest
# Default to project-root relative; override via RYSK_CLI_PATH env var.
RYSK_CLI_PATH = "./ryskV12"

# Testnet asset addresses on Base Sepolia (confirmed from Rysk team, Apr 2026).
# These are the asset addresses we subscribe to via /rfqs/<asset_address>.
# Stored LOWERCASE: the Rysk server routes the WebSocket subscription channel
# and the RFQ asset-match check as exact byte-compares, so any case mismatch
# between subscription URL, RFQ payload, and quote payload causes either a
# missed broadcast or -32011 "asset mismatch". Per Jib 2026-04-07.
RYSK_TESTNET_ASSETS = {
    "WETH": "0xb67bfa7b488df4f2efa874f4e59242e9130ae61f",
    "WBTC": "0x0cb970511c6c3491dc36f1b7774743da3fc4335f",
}
# Testnet stablecoin (the `usd` field value we expect in RFQs on Base Sepolia)
RYSK_TESTNET_USDC = "0x98d56648c9b7f3cb49531f4135115b5000ab1733"

# Strategy-level direction filter
# For Phase 1 our arb is one-directional (buy on Rysk, sell on Derive).
# We observe both sides but only SUBMIT quotes on isTakerBuy=false.
# Flip RYSK_QUOTE_BOTH_SIDES to True once we have data justifying the sell side.
RYSK_QUOTE_BOTH_SIDES = False

# Observation logs (separated from calibration to avoid self-trade pollution)
RYSK_TESTNET_OBSERVATIONS_LOG = "data/testnet-rfq-observations.jsonl"
RYSK_MAINNET_OBSERVATIONS_LOG = "data/mainnet-rfq-observations.jsonl"

# --- Data paths ---
TRADES_FILE = "data/arb-trades.json"
