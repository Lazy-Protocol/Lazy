# Architecture

## System Overview

The USDC Savings Vault is a streamlined DeFi protocol consisting of two contracts that work together to provide secure, yield-bearing USDC deposits.

```
                                    ┌──────────────┐
                                    │    Users     │
                                    └──────┬───────┘
                                           │
                              deposit() / requestWithdrawal()
                                           │
                                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                        USDCSavingsVault                          │
│                         (inherits ERC20)                         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                      Core Functions                        │  │
│  │  • deposit(usdcAmount) → shares                           │  │
│  │  • requestWithdrawal(shares) → requestId                  │  │
│  │  • fulfillWithdrawals(count) [operator]                   │  │
│  │  • reportYieldAndCollectFees(delta) [owner]               │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    State Management                        │  │
│  │  • ERC20 balances - share ownership (vault IS the token)  │  │
│  │  • withdrawalQueue[] - pending withdrawal requests         │  │
│  │  • pendingWithdrawalShares - total escrowed shares        │  │
│  │  • accumulatedYield - net yield from strategies           │  │
│  │  • totalDeposited / totalWithdrawn - flow tracking        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────┬────────────────────────────┘
                                      │
                                      ▼
                              ┌───────────────┐
                              │  RoleManager  │
                              │               │
                              │ isOperator()  │
                              │ paused()      │
                              │ owner()       │
                              └───────────────┘
```

## Contract Responsibilities

### USDCSavingsVault

The main contract handling all user-facing operations, yield tracking, share token, and core logic. The vault inherits from OpenZeppelin's ERC20, so the vault contract IS the share token.

**Responsibilities:**
- Accept USDC deposits and mint proportional shares (to self)
- Provide standard ERC-20 functionality for shares (transfer, approve, etc.)
- Manage async withdrawal queue with share escrow
- Track yield internally via `accumulatedYield` state
- Enforce deposit caps (per-user and global)
- Forward excess USDC to multisig for strategy deployment
- Collect protocol fees via share dilution (on positive yield only)

**Key Design Decisions:**
- Vault IS the ERC20 share token (inherits OpenZeppelin ERC20)
- Yield tracking is internal (no external oracle) for simplicity and gas efficiency
- NAV = totalDeposited - totalWithdrawn + accumulatedYield
- Shares are escrowed (transferred to vault address) on withdrawal request
- Fees are minted as new shares to treasury, never transferred as USDC
- Withdrawal queue uses FIFO with graceful degradation on low liquidity
- Yield reports have safety bounds (max % change) and cooldown (1 day minimum)
- 18 decimal precision for shares

### RoleManager

Centralized access control and pause management.

**Responsibilities:**
- Define Owner role (governance)
- Manage Operator set (day-to-day operations)
- Control pause states (global, deposits-only, withdrawals-only)

**Key Design Decisions:**
- Operators can pause but only owner can unpause
- Three granular pause states for flexibility
- Ownership transfer with 2-step acceptance pattern

## Data Flow

### Deposit Flow

```
User                    Vault (ERC20)
  │                       │
  │── approve(USDC) ────►│
  │                       │
  │── deposit(amount) ──►│
  │                       │── totalAssets() (internal calc)
  │                       │── _mint(user, shares)
  │                       │── transferFrom(USDC) from user
  │                       │── transfer(USDC) to multisig
  │◄── shares ───────────│
```

### Withdrawal Flow

```
User                    Vault (ERC20)                    Operator
  │                       │                                  │
  │── requestWithdrawal ►│                                  │
  │                       │── _transfer(user→vault escrow)  │
  │◄── requestId ────────│                                  │
  │                       │                                  │
  │        ... cooldown period passes ...                   │
  │                       │                                  │
  │                       │◄── fulfillWithdrawals ──────────│
  │                       │── _burn(vault, shares)          │
  │◄── USDC ─────────────│                                  │
```

## Storage Layout

### USDCSavingsVault

| Variable | Type | Description |
|----------|------|-------------|
| multisig | address | Strategy funds recipient |
| treasury | address | Fee recipient |
| feeRate | uint256 | Fee percentage (18 dec) |
| perUserCap | uint256 | Max deposit per user |
| globalCap | uint256 | Max total AUM |
| withdrawalBuffer | uint256 | USDC to retain |
| cooldownPeriod | uint256 | Withdrawal delay |
| totalDeposited | uint256 | Cumulative deposits |
| totalWithdrawn | uint256 | Cumulative withdrawals |
| accumulatedYield | int256 | Net yield (can be negative) |
| lastYieldReportTime | uint256 | Last yield report timestamp |
| maxYieldChangePercent | uint256 | Safety bound for yield reports |
| userTotalDeposited | mapping | User → deposited |
| withdrawalQueue | array | Pending requests |
| withdrawalQueueHead | uint256 | Queue pointer |
| pendingWithdrawalShares | uint256 | Escrowed shares |

## Security Model

### Trust Assumptions

| Entity | Trust Level | Justification |
|--------|-------------|---------------|
| Owner | High | Can pause, cancel withdrawals, report yield, update parameters |
| Operator | Medium | Can fulfill withdrawals, pause (not unpause) |
| Multisig | Medium | Holds strategy funds; cannot affect share accounting |

### Attack Vectors & Mitigations

| Attack | Mitigation |
|--------|------------|
| Double-spend withdrawal | Share escrow (I.2) |
| Yield manipulation | Bounds checking + 1-day cooldown |
| Fee extraction | Fees only on positive yield (I.4) |
| Queue starvation | Graceful degradation (I.5) |
| Reentrancy | OpenZeppelin ReentrancyGuard + CEI pattern |

## Upgrade Path

The architecture supports future upgrades:

1. **RoleManager**: Can add timelock, DAO governance, or multi-sig requirements
2. **Vault**: Immutable core; new versions would require migration
3. **Yield Source**: External yield reporting can be automated via keeper or oracle integration

## OpenZeppelin Usage

The protocol deliberately uses OpenZeppelin only for **mechanical safety guarantees**:

| Component | OZ Module | Rationale |
|-----------|-----------|-----------|
| USDCSavingsVault | ERC20 | Vault IS the share token (battle-tested mechanics) |
| USDCSavingsVault | ReentrancyGuard | Cross-function reentrancy protection |
| USDCSavingsVault | IERC20 | Standard interface for USDC interaction |

**Not using OpenZeppelin Ownable/Pausable** - Authority is delegated to external RoleManager to:
- Support multi-role governance (Owner, Operator)
- Enable governance upgrades without redeploying the Vault
- Provide three-state pause (global, deposits, withdrawals)
- Allow asymmetric pause/unpause (operators pause, only owner unpause)

This separation ensures the Vault focuses on asset custody while governance remains modular.

## Gas Optimization

- Vault IS the ERC20 token (internal calls instead of external contract calls)
- Withdrawal queue uses `head` pointer instead of array shifting
- Processed requests set `shares = 0` rather than deletion
- Batch fulfillment in single transaction
- Minimal storage reads via local variable caching
