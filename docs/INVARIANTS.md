# Formal Invariants Specification

This document defines the formal invariants that the USDC Savings Vault MUST maintain at all times. These invariants are enforced through code structure, runtime assertions, and fuzz testing.

## Invariant Summary

| ID | Name | One-Line Description |
|----|------|---------------------|
| I.1 | Conservation of Value | USDC exits only when shares are burned at NAV |
| I.2 | Share Escrow Safety | Escrowed shares are locked until fulfilled/cancelled |
| I.3 | Universal NAV Application | NAV changes apply to ALL shares equally |
| I.4 | Fee Isolation | Fees only on profit, only via share minting |
| I.5 | Withdrawal Queue Liveness | FIFO order, graceful degradation |

---

## I.1 — Conservation of Value via Shares (Primary)

### Statement

The protocol SHALL NOT transfer any amount of USDC out of the Vault unless a corresponding amount of shares is irrevocably burned at the current NAV.

### Formal Definition

```
∀ tx ∈ Transactions:
  if USDC_out(tx) > 0 then
    S_burned(tx) = floor(USDC_out(tx) / NAV(tx))
    totalAssets_after(tx) = totalAssets_before(tx) - USDC_out(tx)
    totalShares_after(tx) = totalShares_before(tx) - S_burned(tx)
```

No execution path MAY reduce `totalAssets` without proportionally reducing `totalShares`.

### Enforcement

**Code Structure:**
- `fulfillWithdrawals()` burns shares before transferring USDC
- `forceProcessWithdrawal()` burns shares before transferring USDC
- No other function transfers USDC out (except to multisig for strategy)

**Runtime Assertion:**
```solidity
// In fulfillWithdrawals()
assert(sharesAfter < sharesBefore || usdcPaid == 0);
```

**Fuzz Test:**
```solidity
function invariant_shareValueConservation() public {
    // After any sequence of operations, total value is conserved
}
```

---

## I.2 — Share Escrow Safety

### Statement

Shares submitted for withdrawal SHALL be transferred to the Vault and SHALL NOT be transferable, reusable, or withdrawable until either:
- (a) The withdrawal is fulfilled and shares are burned, OR
- (b) The withdrawal is cancelled and shares are returned to requester

### Formal Definition

```
∀ request ∈ WithdrawalQueue where request.shares > 0:
  vault.balanceOf(vault) ≥ Σ(pendingWithdrawalShares)

  escrowed shares ARE NOT:
    - transferable by requester (they don't hold them)
    - usable for another withdrawal (already escrowed)
    - claimable without fulfillment/cancellation
```

### Enforcement

**Code Structure:**
- `requestWithdrawal()` transfers shares FROM user TO vault
- Vault holds shares until `fulfillWithdrawals()` burns them
- `cancelWithdrawal()` returns shares to original requester

**Runtime Assertion:**
```solidity
// After every withdrawal operation
assert(balanceOf(address(this)) >= pendingWithdrawalShares);

// Strict equality after fulfillment/cancellation
assert(balanceOf(address(this)) == pendingWithdrawalShares);
```

**Fuzz Test:**
```solidity
function invariant_escrowBalanceMatchesPending() public {
    assertEq(
        vault.balanceOf(address(vault)),
        vault.pendingWithdrawalShares()
    );
}
```

### Attack Prevention

This invariant prevents the **double-spend attack**:

```
WITHOUT ESCROW (vulnerable):
1. Alice has 100 shares
2. Alice calls requestWithdrawal(100) → request #1
3. Alice transfers 100 shares to Bob
4. Bob calls requestWithdrawal(100) → request #2
5. Both requests fulfilled → 200 shares worth of USDC paid out

WITH ESCROW (safe):
1. Alice has 100 shares
2. Alice calls requestWithdrawal(100) → shares move to vault
3. Alice has 0 shares, cannot transfer
4. Only 100 shares worth of USDC can ever be paid
```

---

## I.3 — Universal NAV Application

### Statement

Any update to `totalAssets` SHALL apply uniformly to ALL outstanding shares:
- Shares held by users
- Shares held in withdrawal escrow (by vault)
- Shares held by Treasury

No class of shares SHALL be excluded from gains or losses.

### Formal Definition

```
sharePrice = totalAssets() / totalShares()

∀ holder ∈ {users, vault_escrow, treasury}:
  value(holder) = shares(holder) × sharePrice
```

### Enforcement

**Code Structure:**
- Single `sharePrice()` function used everywhere
- Escrowed shares remain in `totalSupply()`
- NAV update affects price for all shares equally

**Design Verification:**
- Withdrawal requests receive NAV at fulfillment time, not request time
- If NAV increases after request, user benefits
- If NAV decreases after request, user bears loss

---

## I.4 — Fee Isolation

### Statement

Protocol fees SHALL:
1. Be assessed only on positive yield reports
2. Be capped by `MAX_FEE_RATE` (50%)
3. Be paid exclusively via minting new shares to Treasury

Fees SHALL NEVER cause a direct transfer of USDC from the Vault.

### Formal Definition

```
fee_collected IF AND ONLY IF:
  yieldDelta > 0 in reportYieldAndCollectFees()

fee_amount ≤ yieldDelta × feeRate
feeRate ≤ MAX_FEE_RATE

fee_payment:
  ONLY via _mint(treasury, feeShares)
  NEVER via usdc.transfer(treasury, amount)
```

### Enforcement

**Code Structure:**
```solidity
function reportYieldAndCollectFees(int256 yieldDelta) external onlyOwner {
    // Update accumulated yield
    accumulatedYield += yieldDelta;

    // Only collect fees on positive yield
    if (yieldDelta > 0) {
        uint256 fee = (uint256(yieldDelta) * feeRate) / PRECISION;
        // Fee paid via minting, NOT transfer
        _mint(treasury, feeShares);
    }
}
```

**Runtime Assertion:**
```solidity
// Fee only collected when yieldDelta > 0
```

**Fuzz Test:**
```solidity
function invariant_feeRateCapped() public {
    assertLe(vault.feeRate(), vault.MAX_FEE_RATE());
}
```

---

## I.5 — Withdrawal Queue Liveness

### Statement

The withdrawal fulfillment mechanism SHALL:
1. Process requests in FIFO order
2. Never revert due to insufficient USDC balance
3. Terminate gracefully if available liquidity is insufficient

### Formal Definition

```
∀ fulfillWithdrawals(count) execution:

  FIFO:
    processed_requests ordered by requestId ascending

  NO REVERT on low liquidity:
    if usdcRequired > availableLiquidity:
      break (stop processing)
      DO NOT revert

  GRACEFUL termination:
    return (processed_count, usdc_paid)
    remaining requests stay in queue
```

### Enforcement

**Code Structure:**
```solidity
function fulfillWithdrawals(uint256 count) external returns (uint256 processed, uint256 usdcPaid) {
    while (processed < count && head < queueLen) {
        // ...

        // GRACEFUL: Don't revert, just stop
        if (usdcOut > available) {
            break;
        }

        // Process withdrawal...
    }

    return (processed, usdcPaid);
}
```

**FIFO Guarantee:**
- `withdrawalQueueHead` pointer only moves forward
- Requests processed in order of `requestId`
- Skipped requests (cooldown not met) are revisited next call

---

## Verification Matrix

| Invariant | NatSpec | assert() | Fuzz Test | Unit Test |
|-----------|---------|----------|-----------|-----------|
| I.1 | ✓ | ✓ | ✓ | ✓ |
| I.2 | ✓ | ✓ | ✓ | ✓ |
| I.3 | ✓ | - | ✓ | ✓ |
| I.4 | ✓ | ✓ | ✓ | ✓ |
| I.5 | ✓ | - | ✓ | ✓ |

---

## Threat Model

| Threat | Violated Invariant | Mitigation |
|--------|-------------------|------------|
| Double-spend withdrawal | I.2 | Share escrow |
| Unauthorized USDC drain | I.1 | Share-burn requirement |
| Fee extraction attack | I.4 | Fees only on positive yield |
| Selective NAV manipulation | I.3 | Uniform share price |
| Yield manipulation | I.4 | Bounds checking + 1-day cooldown |
| Queue DoS | I.5 | Graceful degradation |
