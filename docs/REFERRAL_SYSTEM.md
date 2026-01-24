# KOL Referral Fee-Sharing System

Whitelist-only referral system that shares protocol fees with KOLs (Key Opinion Leaders) based on yield earned by their referred depositors.

## Overview

- Protocol takes 20% fee on yield
- KOLs earn a percentage of that fee from their referrals
- Weekly automated payouts
- Fully on-chain tracking

### How It Works

1. KOL shares their referral link: `getlazy.xyz?ref=alice`
2. User visits link, referral is stored in browser (30-day expiry)
3. User deposits USDC into vault
4. On deposit, referral is recorded on-chain
5. Weekly distribution calculates yield from referred users
6. KOL receives their share of the protocol fee

## Contracts

| Contract | Description |
|----------|-------------|
| `ReferralRegistry.sol` | KOL registration, referral tracking, handle resolution |
| `FeeDistributor.sol` | Yield calculation, fee distribution, keeper functions |

## Deployment

### 1. Deploy Contracts

```bash
# Set environment variables
export PRIVATE_KEY=your_deployer_private_key
export RPC_URL=https://eth.llamarpc.com

# Deploy (update script with your addresses)
forge script script/DeployReferral.s.sol --rpc-url $RPC_URL --broadcast --verify
```

### 2. Post-Deployment Setup

```solidity
// On ReferralRegistry: authorize FeeDistributor to record earnings
registry.setRegistrar(feeDistributorAddress);

// On FeeDistributor: authorize keeper wallet
feeDistributor.setKeeper(keeperWalletAddress);
```

### 3. Update Frontend

Edit `frontend/src/config/wagmi.ts`:

```typescript
export const CONTRACTS = {
  // ... existing contracts
  referralRegistry: '0xYOUR_REGISTRY_ADDRESS' as `0x${string}`,
  feeDistributor: '0xYOUR_DISTRIBUTOR_ADDRESS' as `0x${string}`,
} as const;
```

## KOL Onboarding

### Register a KOL

Only the contract owner can register KOLs:

```solidity
registry.registerKOL(
    0xKOL_WALLET_ADDRESS,  // KOL's payout address
    "alice",               // URL handle (lowercase, max 32 chars)
    2500                   // Fee share in basis points (2500 = 25%)
);
```

### Fee Share Examples

| Fee Share | KOL Receives | Example |
|-----------|--------------|---------|
| 2500 bps (25%) | 25% of protocol fee | $1000 yield → $200 protocol fee → $50 to KOL |
| 5000 bps (50%) | 50% of protocol fee | $1000 yield → $200 protocol fee → $100 to KOL |

### Update KOL Settings

```solidity
// Change fee share or deactivate
registry.updateKOL(
    0xKOL_WALLET_ADDRESS,
    3000,   // New fee share (30%)
    true    // Active status
);
```

### KOL Dashboard

KOLs can view their stats at `/kol` when connected with their registered wallet:
- Total referrals
- Total AUM from referrals
- Earnings this period
- Historical earnings
- Referral link

## Keeper Setup (GitHub Actions)

The keeper watches for deposits from referred users and updates their records so KOLs earn on subsequent deposits.

### 1. Configure GitHub Secrets

Go to Repository → Settings → Secrets and variables → Actions

**Secrets:**
| Name | Description |
|------|-------------|
| `RPC_URL` | Ethereum RPC endpoint (Alchemy, Infura, etc.) |
| `KEEPER_PRIVATE_KEY` | Private key for keeper wallet (needs ETH for gas) |

**Variables:**
| Name | Value |
|------|-------|
| `VAULT_ADDRESS` | `0xd53B68fB4eb907c3c1E348CD7d7bEDE34f763805` |
| `REGISTRY_ADDRESS` | Your deployed registry address |
| `FEE_DISTRIBUTOR_ADDRESS` | Your deployed distributor address |

### 2. Fund Keeper Wallet

The keeper wallet needs ETH for gas. Estimated costs:
- ~50k gas per batch of 50 depositors
- At 20 gwei: ~0.001 ETH per batch
- Fund with 0.1 ETH to start

### 3. Schedule

The GitHub Action runs every 6 hours by default. To change, edit `.github/workflows/referral-keeper.yml`:

```yaml
schedule:
  - cron: '0 */6 * * *'  # Every 6 hours
```

### 4. Manual Trigger

You can manually run the keeper from GitHub Actions tab with custom lookback blocks.

## Weekly Distribution

### Automated Flow

1. **Keeper runs** (every 6 hours): Updates depositor records when referred users make additional deposits

2. **Distribution** (weekly): Call these functions to pay out KOLs

```solidity
// Get all KOLs
address[] memory kols = registry.getAllKOLs();

// Distribute to KOLs in batches of 20
feeDistributor.distributeBatch(kols[0:20]);
feeDistributor.distributeBatch(kols[20:40]);
// ... continue for all KOLs

// Finalize epoch (sends remainder to treasury)
feeDistributor.finalizeEpoch();
```

### Distribution Requirements

- Must wait `distributionInterval` (7 days) between epochs
- FeeDistributor must have USDC balance (from protocol fees)
- Call `finalizeEpoch()` to close the period

### Preview Earnings

```solidity
// Check what a KOL will earn this period
uint256 earnings = feeDistributor.previewKOLEarnings(kolAddress);

// Check total yield from KOL's referrals
uint256 yield = feeDistributor.previewKOLReferralYield(kolAddress);

// Check KOL's total AUM
uint256 aum = feeDistributor.getKOLTotalAUM(kolAddress);
```

## Security Considerations

### Transfer Attack Prevention

The system tracks yield via share price changes, not absolute asset values. This prevents:
- Whale transferring shares to inflate KOL rewards
- Users gaming the system by moving funds around

### Yield Calculation

```
effectiveShares = min(recorded_shares, current_shares)
yield = effectiveShares × (current_price - entry_price)
```

- If user sells shares: only remaining shares count
- If user buys more: keeper updates record with weighted average entry price

### Pagination

Distribution is paginated to prevent DoS:
- Max 100 referrals processed per KOL per call
- Max 20 KOLs per batch distribution

## Contract Addresses

| Contract | Address |
|----------|---------|
| Vault | `0xd53B68fB4eb907c3c1E348CD7d7bEDE34f763805` |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| ReferralRegistry | TBD (deploy) |
| FeeDistributor | TBD (deploy) |

## File Locations

```
src/
├── FeeDistributor.sol        # Fee distribution logic
├── ReferralRegistry.sol      # KOL & referral tracking
└── interfaces/
    └── IReferralRegistry.sol # Interface

script/
└── DeployReferral.s.sol      # Deployment script

scripts/
└── referral-keeper.js        # Keeper script

.github/workflows/
└── referral-keeper.yml       # GitHub Action

frontend/src/
├── config/abis.ts            # Contract ABIs
├── config/wagmi.ts           # Contract addresses
├── hooks/useReferral.ts      # Referral capture hook
├── hooks/useKOL.ts           # KOL dashboard hooks
└── pages/KOL.tsx             # KOL dashboard page
```

## Troubleshooting

### Keeper not running
- Check GitHub Actions logs
- Verify secrets are set correctly
- Ensure keeper wallet has ETH

### KOL not receiving payouts
- Verify KOL is active: `registry.isKOL(address)`
- Check referrals exist: `registry.getReferralCount(kol)`
- Verify depositors are initialized: `feeDistributor.depositorRecords(depositor)`
- Ensure FeeDistributor has USDC balance

### Referral not recorded
- Check referral was captured (localStorage)
- Verify KOL handle exists: `registry.handleToAddress(handle)`
- Ensure KOL is active
- User cannot self-refer

### Distribution fails
- Wait for `distributionInterval` to pass
- Check `feeDistributor.canDistribute()`
- Ensure not exceeding batch limits (20 KOLs, 100 referrals)
