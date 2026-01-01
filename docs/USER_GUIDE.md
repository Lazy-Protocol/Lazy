# User Guide

## Introduction

The USDC Savings Vault allows you to earn yield on your USDC holdings. When you deposit USDC, you receive vault shares that represent your proportional ownership. As the vault generates yield, your shares become worth more USDC.

## Getting Started

### Prerequisites

- USDC tokens in your wallet
- ETH for gas fees
- A Web3 wallet (MetaMask, etc.)

### Contract Addresses

> Note: Replace with actual deployed addresses

| Contract | Address |
|----------|---------|
| USDCSavingsVault | `0x...` |
| USDC | `0x...` |

## Depositing

### Step 1: Approve USDC

Before depositing, approve the vault to spend your USDC:

```solidity
// Using ethers.js
const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);
await usdc.approve(VAULT_ADDRESS, depositAmount);
```

### Step 2: Deposit

```solidity
const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);
const tx = await vault.deposit(depositAmount);
const receipt = await tx.wait();

// Get shares minted from event
const event = receipt.events.find(e => e.event === 'Deposit');
const sharesMinted = event.args.shares;
```

### Understanding Your Shares

After depositing, you'll receive vault shares. The vault contract IS the ERC20 share token, so to check your share balance:

```solidity
const shareBalance = await vault.balanceOf(yourAddress);
```

To calculate the current USDC value of your shares:

```solidity
const usdcValue = await vault.sharesToUsdc(shareBalance);
```

## Withdrawing

Withdrawals are a 2-step process to ensure security and proper fund management.

### Step 1: Request Withdrawal

Submit a withdrawal request. Your shares will be escrowed (locked) in the vault:

```solidity
const tx = await vault.requestWithdrawal(shareAmount);
const receipt = await tx.wait();

const event = receipt.events.find(e => e.event === 'WithdrawalRequested');
const requestId = event.args.requestId;
```

**Important**: After requesting, your shares are transferred to the vault. They cannot be transferred or used for another withdrawal request.

### Step 2: Wait for Fulfillment

Your withdrawal request enters a queue and must wait for:

1. **Cooldown Period**: Minimum waiting time (typically 1-7 days)
2. **Operator Processing**: An operator must call `fulfillWithdrawals()`
3. **Available Liquidity**: Sufficient USDC must be in the vault

### Checking Request Status

```solidity
const request = await vault.getWithdrawalRequest(requestId);

console.log({
  requester: request.requester,
  shares: request.shares,      // 0 if processed
  requestTime: request.requestTimestamp
});

// Check if past cooldown
const cooldown = await vault.cooldownPeriod();
const canProcess = Date.now()/1000 > request.requestTimestamp + cooldown;
```

### Receiving USDC

When your request is fulfilled:
- Your escrowed shares are burned
- USDC is transferred to your wallet at current NAV
- Event `WithdrawalFulfilled` is emitted

The USDC you receive = `shares × sharePrice()` at fulfillment time.

## Understanding Share Price

The share price changes based on the vault's Net Asset Value (NAV):

```
sharePrice = totalAssets / totalShares
```

### Example Scenarios

**Yield Accumulation:**
- You deposit 1,000 USDC, receive 1,000 shares
- Vault earns 10% yield
- Total assets: 1,100 USDC, Total shares: 1,000
- Share price: 1.10 USDC
- Your 1,000 shares = 1,100 USDC

**Loss Event:**
- After a 5% loss
- Total assets: 1,045 USDC
- Your 1,000 shares = 1,045 USDC

**Important**: Shares in the withdrawal queue also participate in gains AND losses. If you request withdrawal and NAV drops before fulfillment, you receive less USDC.

## Fees

The vault charges fees only on positive yield:

- **When**: Only when positive yield is reported via `reportYieldAndCollectFees()`
- **Rate**: Configurable (check `feeRate()`, max 50%)
- **How**: New shares are minted to treasury, slightly diluting all holders
- **No fee on losses**: If yield is negative, no fees are charged

### Example

- Owner reports 100,000 USDC yield from strategies
- 20% fee rate → 20,000 USDC worth of shares minted to treasury
- Your share of gains: 80,000 USDC (proportional to your share ownership)

## Deposit Limits

The vault may have caps to manage risk:

```solidity
// Check limits
const perUserCap = await vault.perUserCap();   // 0 = unlimited
const globalCap = await vault.globalCap();     // 0 = unlimited
const yourDeposited = await vault.userTotalDeposited(yourAddress);
```

## Pause States

The vault can be paused in emergencies:

| State | Deposits | Withdrawals |
|-------|----------|-------------|
| Normal | ✓ | ✓ |
| Deposits Paused | ✗ | ✓ |
| Withdrawals Paused | ✓ | ✗ |
| Fully Paused | ✗ | ✗ |

Check current state:

```solidity
const isPaused = await roleManager.paused();
const depositsOk = !await roleManager.depositsPaused();
const withdrawalsOk = !await roleManager.withdrawalsPaused();
```

## FAQ

### Why are withdrawals not instant?

The vault invests USDC in off-chain strategies. The cooldown period allows:
1. Time to liquidate positions if needed
2. Protection against flash loan attacks
3. Fair treatment of all users

### What happens if there's not enough USDC for my withdrawal?

The operator will skip your request and continue with others. Your request stays in queue. When more USDC arrives (from strategy returns or new deposits), it can be processed.

### Can I cancel my withdrawal request?

Only the vault owner can cancel requests (emergency function). Contact the protocol team if needed.

### Are my shares safe during withdrawal?

Yes. Your shares are held in escrow by the vault contract itself. They cannot be:
- Transferred by anyone
- Used for another withdrawal
- Lost if fulfillment is delayed

### How do I know the current yield?

Compare current share price to price when you deposited:

```solidity
const currentPrice = await vault.sharePrice();
const gain = (currentPrice - yourEntryPrice) / yourEntryPrice * 100;
```

## Events to Monitor

| Event | Description |
|-------|-------------|
| `Deposit(user, usdc, shares)` | Successful deposit |
| `WithdrawalRequested(user, shares, id)` | Request submitted |
| `WithdrawalFulfilled(user, shares, usdc, id)` | Withdrawal complete |
| `WithdrawalCancelled(user, shares, id)` | Request cancelled |
| `FeeCollected(shares, treasury)` | Fees taken |

## Support

For issues or questions:
- Check the protocol documentation
- Contact the team via official channels
- Review transaction on block explorer for error details
