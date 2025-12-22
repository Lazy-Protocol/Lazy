# Whitehat Security Audit Report - Independent Review

**Auditor:** Claude (Whitehat Security Researcher)
**Date:** 2025-12-22
**Protocol:** USDC Savings Vault
**Scope:** USDCSavingsVault.sol, VaultShare.sol, StrategyOracle.sol, RoleManager.sol
**Commit:** claude/security-protocol-review-rtUwC

---

## Executive Summary

This independent security review identified **1 Critical**, **1 High**, **2 Medium**, and **3 Low** severity findings that were not fully addressed in the prior audit. The most severe finding allows the owner to bypass yield bounds restrictions by making multiple oracle reports in a single block.

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 1 | NEW FINDING |
| High | 1 | NEW FINDING |
| Medium | 2 | Acknowledged Risks |
| Low | 3 | NEW FINDING |
| Informational | 2 | NEW FINDING |

---

## Critical Findings

### C-1: Yield Bounds Bypass via Consecutive Reports (NEW)

**Severity:** Critical
**Location:** `StrategyOracle.sol:113-129`
**Status:** UNMITIGATED

#### Description

The yield bounds check (`maxYieldChangePercent`) can be completely bypassed by making multiple `reportYield()` calls in succession. Each call recalculates the allowed maximum based on the *updated* NAV (which includes previous yield reports), allowing exponential inflation.

#### Technical Details

```solidity
function reportYield(int256 yieldDelta) external onlyOwnerOrVault {
    if (maxYieldChangePercent > 0 && vault != address(0)) {
        uint256 nav = IVaultMinimal(vault).totalAssets(); // Reads CURRENT NAV
        if (nav > 0) {
            uint256 absoluteDelta = yieldDelta >= 0 ? uint256(yieldDelta) : uint256(-yieldDelta);
            uint256 maxAllowed = (nav * maxYieldChangePercent) / 1e18;
            if (absoluteDelta > maxAllowed) revert YieldChangeTooLarge();
        }
    }
    accumulatedYield += yieldDelta; // NAV increases for next call
    // ... no time-based restriction
}
```

**Attack Scenario:**
1. NAV = 1,000,000 USDC, maxYieldChangePercent = 10%
2. Owner calls `reportYield(100,000e6)` - passes (10% of 1M)
3. NAV now = 1,100,000 USDC
4. Owner calls `reportYield(110,000e6)` - passes (10% of 1.1M)
5. NAV now = 1,210,000 USDC
6. After 10 calls in same block: NAV = 1,000,000 * 1.1^10 = **2,593,742 USDC**

The owner can inflate NAV by **159%** in a single block, completely bypassing the intended 10% limit.

#### Impact

- Owner can arbitrarily inflate NAV
- Owner can front-run deposits, extract value from new depositors
- Makes the yield bounds feature essentially useless

#### Proof of Concept

```solidity
function test_CRITICAL_YieldBoundsCompoundBypass() public {
    // Initial deposit
    vm.prank(victim);
    vault.deposit(1_000_000e6);

    uint256 navBefore = vault.totalAssets();

    // Owner makes 10 consecutive yield reports in same block
    for (uint i = 0; i < 10; i++) {
        uint256 currentNav = vault.totalAssets();
        int256 maxYield = int256((currentNav * 10) / 100); // 10%
        strategyOracle.reportYield(maxYield);
    }

    uint256 navAfter = vault.totalAssets();

    // NAV inflated by ~159%
    assertGt(navAfter, navBefore * 25 / 10, "NAV should be 2.5x+ original");
    console2.log("NAV before:", navBefore);
    console2.log("NAV after:", navAfter);
    console2.log("Inflation:", (navAfter - navBefore) * 100 / navBefore, "%");
}
```

#### Recommendation

Add a time-based cooldown between yield reports:

```solidity
uint256 public constant MIN_REPORT_INTERVAL = 1 hours;

function reportYield(int256 yieldDelta) external onlyOwnerOrVault {
    require(block.timestamp >= lastReportTime + MIN_REPORT_INTERVAL, "Report too soon");
    // ... existing logic
}
```

Or calculate bounds based on a snapshot NAV that doesn't update mid-block.

---

## High Severity Findings

### H-1: Owner Front-Running Attack Vector (NEW)

**Severity:** High
**Location:** `USDCSavingsVault.sol:428-478`, `StrategyOracle.sol:113-129`
**Status:** UNMITIGATED

#### Description

The owner can monitor the mempool for pending deposits and front-run them with favorable yield reports. This allows systematic value extraction from depositors.

#### Attack Scenario

1. Owner monitors mempool, sees Alice's 100,000 USDC deposit pending
2. Owner front-runs with `reportYield(+10%)` to inflate share price
3. Alice's deposit executes at inflated price, receiving fewer shares
4. Owner reports negative yield or withdraws via treasury shares

#### Impact

- Depositors systematically receive fewer shares than fair value
- Owner can extract MEV from every deposit
- Undermines trust in protocol

#### Recommendation

1. Use commit-reveal scheme for yield reports
2. Add minimum delay between yield report and it taking effect
3. Consider using a time-weighted average price (TWAP) for deposits

---

## Medium Severity Findings

### M-1: Cooldown Retroactive Application

**Severity:** Medium
**Location:** `USDCSavingsVault.sol:769-798`
**Status:** Acknowledged (Documented)

#### Description

When the owner queues and executes a cooldown increase, it affects ALL pending withdrawals, including those already in the queue. Users who expected their withdrawal to be fulfilled based on the old cooldown may be delayed.

```solidity
// fulfillWithdrawals checks cooldown against CURRENT cooldownPeriod
if (block.timestamp < request.requestTimestamp + cooldownPeriod) {
    break; // Uses new cooldown, not cooldown at time of request
}
```

#### Impact

- Users with pending withdrawals can have their wait time extended unexpectedly
- Could be used to grief users during volatile periods

#### Recommendation

Store the cooldown period with each withdrawal request at request time.

### M-2: Per-User Cap Bypass via Share Transfers

**Severity:** Medium
**Location:** `USDCSavingsVault.sol:442-447`
**Status:** UNMITIGATED

#### Description

The per-user cap can be easily bypassed by transferring shares between wallets:

```solidity
// Check is based on CURRENT holdings, not cumulative
if (perUserCap > 0) {
    uint256 currentHoldingsValue = sharesToUsdc(shares.balanceOf(msg.sender));
    if (currentHoldingsValue + usdcAmount > perUserCap) {
        revert ExceedsUserCap();
    }
}
```

#### Attack Steps

1. Deposit up to perUserCap
2. Transfer shares to a second wallet
3. Deposit again (now under cap)
4. Transfer shares back
5. Repeat indefinitely

#### Impact

- Anti-whale mechanism is ineffective
- Single entity can accumulate unlimited shares

#### Recommendation

If per-user cap is important for governance/security, track cumulative deposits per address or use KYC/whitelist.

---

## Low Severity Findings

### L-1: lastReportTime Not Utilized

**Severity:** Low
**Location:** `StrategyOracle.sol:33`, `StrategyOracle.sol:126`

The `lastReportTime` variable is updated but never read or enforced. This is dead code that may mislead auditors into thinking a time restriction exists.

### L-2: purgeProcessedWithdrawals Inefficient Loop

**Severity:** Low
**Location:** `USDCSavingsVault.sol:945-960`

The purge function loops backwards from `withdrawalQueueHead`, which could iterate over already-purged entries:

```solidity
for (uint256 i = head - toPurge; i < head && purged < count; i++) {
    if (withdrawalQueue[i].requester != address(0)) { // Already purged entries skip
```

Consider tracking last purged index to avoid re-checking.

### L-3: Orphaned Shares Temporary Dilution

**Severity:** Low
**Location:** `USDCSavingsVault.sol:922-930`

If shares are accidentally sent to the vault (not via `requestWithdrawal`), they temporarily affect share price calculations until `recoverOrphanedShares()` is called. The vault's share balance is used in escrow validation but orphaned shares could cause slight pricing discrepancies.

---

## Informational Findings

### I-1: Missing Events for Cap Updates

`setPerUserCap` and `setGlobalCap` emit events, but the event is emitted before the state change. Consider emitting after for consistency with other setters.

### I-2: Centralization Risks Remain High

The protocol's security model relies heavily on owner trust:
- Owner can manipulate NAV via oracle (with C-1, even the bounds are bypassable)
- Owner can front-run users
- Owner can reset HWM to skip fees
- Owner can force process any withdrawal

This is documented but should be prominently disclosed to users.

---

## Proof of Concept Tests

The following test file demonstrates the critical findings:

```solidity
// test/CriticalExploitPoC.t.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {USDCSavingsVault} from "../src/USDCSavingsVault.sol";
import {VaultShare} from "../src/VaultShare.sol";
import {StrategyOracle} from "../src/StrategyOracle.sol";
import {RoleManager} from "../src/RoleManager.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract CriticalExploitPoC is Test {
    USDCSavingsVault public vault;
    StrategyOracle public strategyOracle;
    RoleManager public roleManager;
    MockUSDC public usdc;

    address public owner = address(this);
    address public victim = makeAddr("victim");

    function setUp() public {
        usdc = new MockUSDC();
        roleManager = new RoleManager(owner);
        strategyOracle = new StrategyOracle(address(roleManager));

        vault = new USDCSavingsVault(
            address(usdc),
            address(strategyOracle),
            address(roleManager),
            makeAddr("multisig"),
            makeAddr("treasury"),
            0.2e18,
            1 days,
            "Test Share",
            "tSHR"
        );
        strategyOracle.setVault(address(vault));
        vault.setWithdrawalBuffer(type(uint256).max);

        usdc.mint(victim, 1_000_000e6);
        vm.prank(victim);
        usdc.approve(address(vault), type(uint256).max);
    }

    function test_C1_YieldBoundsCompoundBypass() public {
        vm.prank(victim);
        vault.deposit(1_000_000e6);

        uint256 navBefore = vault.totalAssets();
        console2.log("NAV before attack:", navBefore);

        // Owner makes 10 consecutive 10% yield reports
        for (uint i = 0; i < 10; i++) {
            uint256 currentNav = vault.totalAssets();
            int256 yieldAmount = int256((currentNav * 10) / 100);
            strategyOracle.reportYield(yieldAmount);
            console2.log("Report", i + 1, "- NAV now:", vault.totalAssets());
        }

        uint256 navAfter = vault.totalAssets();
        uint256 inflationPercent = ((navAfter - navBefore) * 100) / navBefore;

        console2.log("NAV after attack:", navAfter);
        console2.log("Total inflation:", inflationPercent, "%");

        // Assert inflation is WAY more than the intended 10% limit
        assertGt(inflationPercent, 150, "Should inflate >150% bypassing 10% limit");
    }
}
```

---

## Summary of Recommendations

| ID | Finding | Recommendation | Priority |
|----|---------|----------------|----------|
| C-1 | Yield Bounds Bypass | Add time-based cooldown between reports | CRITICAL |
| H-1 | Owner Front-Running | Commit-reveal or TWAP for deposits | HIGH |
| M-1 | Retroactive Cooldown | Store cooldown at request time | MEDIUM |
| M-2 | Cap Bypass | Track cumulative deposits | MEDIUM |
| L-1 | Unused lastReportTime | Remove or implement cooldown | LOW |
| L-2 | Inefficient Purge | Track last purged index | LOW |
| L-3 | Orphaned Share Dilution | Auto-recover or document | LOW |

---

## Conclusion

The USDC Savings Vault has solid fundamentals for common DeFi attacks (donation, reentrancy, first depositor). However, the yield bounds mechanism (H-1 from prior audit) is ineffective due to the ability to compound multiple reports. This should be treated as Critical priority.

The protocol's security model is heavily dependent on owner trust. While this is documented, the C-1 finding shows that even the "safety bounds" meant to limit trusted owner actions can be bypassed.

**Recommendation:** Do not deploy to mainnet until C-1 is fixed. Consider additional decentralization of oracle reporting (multisig, timelock on yield reports).

---

*Report generated by independent whitehat security review*
