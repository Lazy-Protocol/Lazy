# USDC Savings Vault

A secure, share-based savings vault for USDC with async withdrawals, protocol fees, timelocked configuration, and formal invariant guarantees.

## Overview

The USDC Savings Vault allows users to deposit USDC and receive vault shares representing their proportional ownership. The vault uses a Net Asset Value (NAV) model where share prices adjust based on total assets under management, enabling yield distribution without token rebasing.

### Key Features

- **Share-Based Accounting**: 1 USDC = 1 share initially, price adjusts with NAV
- **Async Withdrawal Queue**: FIFO processing with configurable cooldown periods
- **Share Escrow**: Withdrawal requests lock shares to prevent double-spend attacks
- **Protocol Fees**: Collected only on profits via share dilution (no USDC transfers)
- **Timelocked Configuration**: Critical parameter changes require waiting periods
- **Two-Step Ownership**: Ownership transfers require explicit acceptance
- **Modular Architecture**: Separate StrategyOracle and RoleManager contracts

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     USDCSavingsVault                        │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │   Deposits  │  │  Withdrawals │  │   Fee Collection  │  │
│  │  (mint)     │  │  (burn)      │  │   (mint to treas) │  │
│  └─────────────┘  └──────────────┘  └───────────────────┘  │
└───────────────────────────┬─────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐   ┌────────────────┐   ┌───────────────┐
│   VaultShare  │   │ StrategyOracle │   │  RoleManager  │
│   (ERC-20)    │   │  (yield only)  │   │   (access)    │
└───────────────┘   └────────────────┘   └───────────────┘
```

### Contracts

| Contract | Description |
|----------|-------------|
| `USDCSavingsVault` | Main vault logic: deposits, withdrawals, fees, timelocks |
| `VaultShare` | ERC-20 share token with vault-only mint/burn, configurable name/symbol |
| `StrategyOracle` | Reports yield from off-chain strategies (not deposits/withdrawals) |
| `RoleManager` | Manages Owner/Operator roles, pause states, two-step ownership |

### NAV Calculation

```
totalAssets = totalDeposited - totalWithdrawn + accumulatedYield
```

- **Deposits/Withdrawals**: Tracked automatically by the vault
- **Yield**: Reported by owner via StrategyOracle (gains or losses from strategies)

This separation ensures fees are only charged on actual yield, not on deposits.

## User Flows

### Deposit

```solidity
// 1. Approve USDC spending
usdc.approve(address(vault), amount);

// 2. Deposit and receive shares
uint256 shares = vault.deposit(usdcAmount);
```

Shares minted = `usdcAmount * PRECISION / sharePrice()`

### Withdrawal (2-step process)

```solidity
// Step 1: Request withdrawal (shares are escrowed)
uint256 requestId = vault.requestWithdrawal(shareAmount);

// Step 2: Wait for cooldown + operator fulfillment
// Operator calls: vault.fulfillWithdrawals(count)
// User receives USDC at current NAV
```

**User Cancellation**: Users can cancel within 1 hour of requesting via `cancelWithdrawal(requestId)`.

## Share Price Calculation

```
sharePrice = totalAssets() / totalShares()
```

Where:
- `totalAssets()` = totalDeposited - totalWithdrawn + accumulatedYield
- `totalShares()` = Total share supply (includes escrowed shares)

### Example

| State | Total Assets | Total Shares | Share Price |
|-------|--------------|--------------|-------------|
| Initial | 1,000 USDC | 1,000 shares | 1.00 USDC |
| After 10% yield | 1,100 USDC | 1,000 shares | 1.10 USDC |
| After 5% loss | 1,045 USDC | 1,000 shares | 1.045 USDC |

## Formal Invariants

The vault enforces five critical invariants:

### I.1 — Conservation of Value
USDC only exits when shares are burned at current NAV. No execution path reduces assets without reducing shares.

### I.2 — Share Escrow Safety
Withdrawal request shares are transferred to the vault and locked until fulfilled or cancelled. Prevents double-spend attacks.

### I.3 — Universal NAV Application
NAV changes apply equally to ALL shares: user-held, escrowed, and treasury shares. No class is excluded from gains or losses.

### I.4 — Fee Isolation
Fees are only on profits (price-based HWM), capped at `MAX_FEE_RATE`, and paid via share minting. No USDC transfers for fees.

### I.5 — Withdrawal Queue Liveness
FIFO processing, never reverts on low liquidity (graceful termination).

## Roles

| Role | Capabilities |
|------|--------------|
| **Owner** | Queue/execute timelocked changes, cancel withdrawals, force process, update caps |
| **Operator** | Fulfill withdrawals, pause operations (cannot unpause) |
| **Multisig** | Receive/return strategy funds |
| **Treasury** | Receives fee shares |

## Configuration

### Immediate Changes (No Timelock)

| Parameter | Function | Description |
|-----------|----------|-------------|
| `perUserCap` | `setPerUserCap()` | Maximum holdings value per user (0 = unlimited) |
| `globalCap` | `setGlobalCap()` | Maximum total AUM (0 = unlimited) |
| `withdrawalBuffer` | `setWithdrawalBuffer()` | USDC to retain for withdrawals |

### Timelocked Changes

| Parameter | Timelock | Queue | Execute | Cancel |
|-----------|----------|-------|---------|--------|
| `feeRate` | 1 day | `queueFeeRate()` | `executeFeeRate()` | `cancelFeeRate()` |
| `cooldownPeriod` | 1 day | `queueCooldown()` | `executeCooldown()` | `cancelCooldown()` |
| `treasury` | 2 days | `queueTreasury()` | `executeTreasury()` | `cancelTreasury()` |
| `multisig` | 3 days | `queueMultisig()` | `executeMultisig()` | `cancelMultisig()` |

**Note**: Constructor values are set immediately during deployment. Timelocks only apply to changes after deployment.

### Monitoring Pending Changes

Users can monitor pending timelocked changes via public state variables:
- `pendingFeeRate` / `pendingFeeRateTimestamp`
- `pendingTreasury` / `pendingTreasuryTimestamp`
- `pendingMultisig` / `pendingMultisigTimestamp`
- `pendingCooldownPeriod` / `pendingCooldownTimestamp`

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_FEE_RATE` | 50% | Maximum allowed fee rate |
| `MIN_COOLDOWN` | 1 day | Minimum withdrawal cooldown |
| `MAX_COOLDOWN` | 30 days | Maximum withdrawal cooldown |
| `CANCELLATION_WINDOW` | 1 hour | User withdrawal cancellation period |
| `MAX_PENDING_PER_USER` | 10 | Maximum pending withdrawal requests per user |
| `INITIAL_SHARE_PRICE` | 1e6 | Initial price (1 USDC = 1 share) |

## Security Features

### Implemented Protections

1. **Reentrancy Guard**: All state-changing functions protected with custom `nonReentrant` modifier.

2. **Share Escrow**: Withdrawal shares transferred to vault, preventing double-spend.

3. **Price-Based HWM**: Fees only on share price increases (yield), not deposits.

4. **Yield Bounds**: Default 10% `maxYieldChangePercent` prevents accidental misreporting (yield delta cannot exceed 10% of NAV).

5. **Per-User Limits**: Maximum 10 pending withdrawal requests per user prevents queue spam.

6. **Queue Purge**: `purgeProcessedWithdrawals()` reclaims storage (publicly callable).

7. **Orphaned Share Recovery**: `recoverOrphanedShares()` burns shares sent directly to vault.

8. **Two-Step Ownership**: `transferOwnership()` → `acceptOwnership()` prevents accidental transfers.

9. **Auto-Revoke Operator**: Old owner's operator status revoked on ownership transfer.

10. **Contract Verification**: Constructor verifies USDC, StrategyOracle, RoleManager are contracts.

11. **Timelocked Config**: Critical changes require 1-3 day waiting periods.

12. **Invariant Checks**: Runtime assertions verify escrow balance, share burns, fee calculations.

### Invariant Violation Errors

These errors indicate bugs if triggered (should never occur):
- `EscrowBalanceMismatch` - Vault share balance doesn't match pending withdrawal shares
- `SharesNotBurned` - USDC paid out without burning shares
- `FeeExceedsProfit` - Fee calculation error

## Emergency Functions

| Function | Access | Purpose |
|----------|--------|---------|
| `forceProcessWithdrawal()` | Owner | Process specific withdrawal, skips cooldown and FIFO |
| `cancelWithdrawal()` | Owner (anytime) / User (1 hour) | Cancel and return escrowed shares |
| `resetPriceHWM()` | Owner | Reset fee HWM after oracle errors |
| `recoverOrphanedShares()` | Owner | Burn shares accidentally sent to vault |
| `pause()` / `pauseDeposits()` / `pauseWithdrawals()` | Operator | Emergency pause |
| `unpause()` / `unpauseDeposits()` / `unpauseWithdrawals()` | Owner | Resume operations |

## Development

### Build

```bash
forge build
```

### Test

```bash
forge test
```

### Deploy

```bash
forge script script/Deploy.s.sol --rpc-url <RPC_URL> --broadcast
```

### Constructor Parameters

```solidity
constructor(
    address _usdc,              // USDC token address
    address _strategyOracle,    // StrategyOracle contract
    address _roleManager,       // RoleManager contract
    address _multisig,          // Multisig for strategy funds
    address _treasury,          // Treasury for fee shares
    uint256 _feeRate,           // Initial fee rate (18 decimals)
    uint256 _cooldownPeriod,    // Initial cooldown (1-30 days)
    string memory _shareName,   // Share token name (e.g., "USDC Savings Vault Share")
    string memory _shareSymbol  // Share token symbol (e.g., "svUSDC")
)
```

## Audit History

The codebase has undergone security review with the following fixes applied:

| ID | Severity | Issue | Resolution |
|----|----------|-------|------------|
| C-1 | Critical | Fee division edge case | Guard: skip if fee >= NAV |
| H-1 | High | Unrestricted yield reporting | 10% yield bounds (default) |
| H-2 | High | Orphaned shares stuck | `recoverOrphanedShares()` |
| H-3 | High | User can't cancel withdrawal | 1-hour cancellation window |
| M-1 | Medium | Unbounded withdrawal queue | Per-user limit (10) + purge function |
| M-2 | Medium | No timelock on critical changes | 1-3 day timelocks implemented |
| L-1 | Low | Missing MaxYieldChange event | Event added |
| L-2 | Low | Unused userTotalDeposited | Removed |
| L-3 | Low | No contract code checks | Added in constructor |
| L-4 | Low | Cooldown affects existing requests | Documented as expected |
| I-1 | Info | YieldReported masks negative | Fixed to show int256 |
| I-2 | Info | purgeProcessedWithdrawals public | Documented as intentional |
| I-3 | Info | assert() consumes all gas | Replaced with custom errors |

## License

MIT
