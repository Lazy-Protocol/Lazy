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

## USDC Flow & Yield Strategies

### Capital Flow Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CAPITAL FLOW                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────┐      deposit()      ┌─────────────────────────────────────┐  │
│   │   User   │ ──────────────────► │           Vault                     │  │
│   └──────────┘                     │   usdc.balanceOf(vault)             │  │
│        ▲                           │   ─────────────────────             │  │
│        │                           │   Keeps: withdrawalBuffer           │  │
│        │ USDC                      │   (liquidity for withdrawals)       │  │
│        │                           └──────────────┬──────────────────────┘  │
│        │                                          │                         │
│        │                                          │ Excess above buffer     │
│        │                                          │ via _forwardToMultisig()│
│        │                                          ▼                         │
│        │                           ┌─────────────────────────────────────┐  │
│        │                           │          Multisig                   │  │
│        │                           │   (Strategy Execution Wallet)       │  │
│        │                           └──────────────┬──────────────────────┘  │
│        │                                          │                         │
│        │                                          │ Deploys to strategies   │
│        │                                          ▼                         │
│        │                           ┌─────────────────────────────────────┐  │
│        │                           │       Yield Strategies              │  │
│        │                           ├─────────────────────────────────────┤  │
│        │                           │  • Basis Trading                    │  │
│        │                           │  • Funding Rate Farming             │  │
│        │                           │  • Pendle Principal Tokens (PT)     │  │
│        │                           └─────────────────────────────────────┘  │
│        │                                          │                         │
│        │           receiveFundsFromMultisig()     │ Yield accrues           │
│        └──────────────────────────────────────────┘                         │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Yield Strategy Details

| Strategy | Description | Liquidity Profile |
|----------|-------------|-------------------|
| **Basis Trading** | Delta-neutral positions exploiting spot-futures price differences | Variable - requires unwinding positions |
| **Funding Rate Farming** | Collecting funding payments from perpetual futures positions | Variable - positions can be closed, may have timing considerations |
| **Pendle PT** | Purchasing Principal Tokens for fixed yield at maturity | Fixed maturity - early exit may reduce yield |

### How Yield is Reported

1. **Off-chain calculation**: Owner calculates net yield from all strategies
2. **On-chain report**: Owner calls `reportYieldAndCollectFees(yieldDelta)`
3. **NAV updates**: `accumulatedYield += yieldDelta` affects all share prices
4. **Fees collected**: If positive yield, treasury receives fee shares

```
Strategy Returns          Owner Reports             NAV Updates
      │                        │                         │
      ▼                        ▼                         ▼
 Basis: +2.5%    ───►   reportYield(+50k)   ───►   sharePrice ↑
 Funding: +1.2%         (aggregated)               (all holders benefit)
 Pendle: +3.1%
```

### Trust Model for Capital Custody

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TRUST BOUNDARIES                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   TRUSTLESS (enforced by smart contract):                                   │
│   ├─ Share accounting (cannot be manipulated)                               │
│   ├─ NAV calculation formula                                                │
│   ├─ Withdrawal queue FIFO ordering                                         │
│   ├─ Fee rate caps (max 50%)                                                │
│   └─ Escrow mechanics (no double-spend)                                     │
│                                                                              │
│   TRUSTED (relies on off-chain actors):                                     │
│   ├─ Multisig: Must return funds for withdrawal fulfillment                 │
│   ├─ Owner: Must report accurate yield                                      │
│   └─ Operator: Must call fulfillWithdrawals regularly                       │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│   ⚠️  CRITICAL: If multisig does not return funds, withdrawals exceeding    │
│       the vault's USDC buffer cannot be fulfilled. Users trust the          │
│       multisig operators to honor withdrawal requests.                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Withdrawal Liquidity

```
Scenario: Vault has 100k buffer, 900k deployed to strategies

┌─────────────────────────────────────────────────────────┐
│  Pending Withdrawals: 50k USDC                          │
│  ───────────────────────────────────────────────────────│
│  ✓ Fulfilled immediately from buffer                   │
│    Buffer: 100k → 50k                                   │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Pending Withdrawals: 200k USDC                         │
│  ───────────────────────────────────────────────────────│
│  1. First 100k fulfilled from buffer                    │
│  2. fulfillWithdrawals() stops (insufficient liquidity) │
│  3. Multisig must call receiveFundsFromMultisig(100k+)  │
│  4. Operator calls fulfillWithdrawals() again           │
└─────────────────────────────────────────────────────────┘
```

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

| Entity | Trust Level | What They Control | Risk if Malicious |
|--------|-------------|-------------------|-------------------|
| Owner | High | Yield reports, config changes, emergency functions | Can misreport yield (bounded by 1%/day default), delay withdrawals via cooldown changes |
| Operator | Medium | Withdrawal fulfillment, pause (not unpause) | Can delay fulfillment, cannot steal funds |
| Multisig | **Critical** | USDC deployed to yield strategies | **Can refuse to return funds, blocking withdrawals beyond buffer** |

**Important**: This is a semi-custodial protocol. Users trust the multisig to return funds when needed for withdrawals. The smart contract cannot force the multisig to return funds.

### Attack Vectors & Mitigations

| Attack | Mitigation |
|--------|------------|
| Double-spend withdrawal | Share escrow (I.2) |
| Yield manipulation | Bounds checking + 1-day cooldown |
| Fee extraction | Fees only on positive yield (I.4) |
| Queue starvation | Graceful degradation (I.5) |
| Reentrancy | OpenZeppelin ReentrancyGuard + CEI pattern |

## Roadmap: Fully Autonomous Protocol

### Current State (V1): Semi-Custodial

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         V1: HUMAN-OPERATED                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   User ──► Vault ──► Multisig (humans) ──► Strategies                       │
│                           │                                                  │
│                           └── Trust required here                            │
│                                                                              │
│   Limitations:                                                               │
│   • Multisig operators must manually return funds                           │
│   • Yield reporting requires human intervention                             │
│   • Withdrawal fulfillment depends on operator availability                 │
│   • Strategy execution is off-chain and opaque                              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Future State (V2): Autonomous Agent Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      V2: AGENT-OPERATED (TRUSTLESS)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │                      SECURE ENCLAVE                                   │  │
│   │   ┌─────────────────────────────────────────────────────────────┐    │  │
│   │   │  Agent Keys (TEE-protected, not accessible to operators)    │    │  │
│   │   └─────────────────────────────────────────────────────────────┘    │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                         │
│                                    ▼                                         │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │                     AUTONOMOUS AGENTS                                 │  │
│   │                                                                       │  │
│   │   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐      │  │
│   │   │ Strategy Agent  │  │ Withdrawal Agent│  │  Yield Agent    │      │  │
│   │   │                 │  │                 │  │                 │      │  │
│   │   │ • Deploy to     │  │ • Monitor queue │  │ • Calculate PnL │      │  │
│   │   │   on-chain      │  │ • Auto-fulfill  │  │ • Report yield  │      │  │
│   │   │   protocols     │  │ • Rebalance     │  │ • Collect fees  │      │  │
│   │   │ • Rebalance     │  │   liquidity     │  │                 │      │  │
│   │   │ • Risk manage   │  │                 │  │                 │      │  │
│   │   └─────────────────┘  └─────────────────┘  └─────────────────┘      │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                         │
│                                    ▼                                         │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │                        ON-CHAIN ONLY                                  │  │
│   │                                                                       │  │
│   │   Vault ◄──► Aave / Compound / Pendle / GMX / Hyperliquid            │  │
│   │         (no off-chain positions, fully auditable 24/7)               │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### V2 Benefits

| Aspect | V1 (Current) | V2 (Future) |
|--------|--------------|-------------|
| **Custody** | Semi-custodial (multisig) | Non-custodial (agents + on-chain) |
| **Trust** | Trust multisig operators | Trust code + secure enclave |
| **Withdrawal** | Manual fulfillment | Automatic 24/7 |
| **Yield Reporting** | Manual, 1x daily | Automatic, real-time |
| **Auditability** | Off-chain positions opaque | 100% on-chain, verifiable |
| **Uptime** | Depends on operators | 24/7 autonomous |
| **Decentralization** | Centralized operators | Maximally decentralized |

### Migration Path

1. **V1 (Now)**: Human-operated multisig, proven security model
2. **V1.5**: Add on-chain strategy modules (Aave, Pendle direct integration)
3. **V2**: Deploy autonomous agents with TEE key management
4. **V2.1**: Remove human multisig entirely, full agent control

> The current V1 architecture is intentionally simple to establish security and trust. The modular design (separate RoleManager, external multisig) facilitates the future transition to fully autonomous operation.

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
