// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {LazyUSDVault} from "../../src/LazyUSDVault.sol";
import {RoleManager} from "../../src/RoleManager.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * @title YieldSandwichAttack
 * @notice Attempts to sandwich yield reports for profit
 * @dev Tests if attacker can front-run positive yield to extract value
 */
contract YieldSandwichAttack is Test {
    LazyUSDVault vault;
    RoleManager roleManager;
    MockUSDC usdc;

    address owner = address(this);
    address operator = makeAddr("operator");
    address attacker = makeAddr("attacker");
    address victim = makeAddr("victim");
    address treasury = makeAddr("treasury");

    function setUp() public {
        usdc = new MockUSDC();
        roleManager = new RoleManager(owner);
        vault = new LazyUSDVault(
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
        vault.setMaxYieldChangePercent(1e18); // Allow 100% for test

        // Victim already has shares
        usdc.mint(victim, 1_000_000e6);
        vm.prank(victim);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(victim);
        vault.deposit(1_000_000e6);

        // Attacker has capital
        usdc.mint(attacker, 500_000e6);
    }

    function test_EXPLOIT_YieldSandwich() public {
        console2.log("=== YIELD SANDWICH ATTACK ===");
        console2.log("");

        uint256 priceBeforeAttack = vault.sharePrice();
        console2.log("Initial state:");
        console2.log("  Share price:", priceBeforeAttack);
        console2.log("  Total assets:", vault.totalAssets());
        console2.log("  Victim shares:", vault.balanceOf(victim));

        // Attack scenario:
        // 1. Attacker sees +100k yield report in mempool
        // 2. Attacker front-runs with deposit
        // 3. Yield is reported
        // 4. Attacker tries to withdraw for profit

        console2.log("");
        console2.log("Step 1: Attacker front-runs with 500k deposit");
        vm.startPrank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        uint256 attackerShares = vault.deposit(500_000e6);
        console2.log("  Attacker shares:", attackerShares);
        console2.log("  Price at deposit:", vault.sharePrice());
        vm.stopPrank();

        // Yield report happens (attacker couldn't prevent this)
        console2.log("");
        console2.log("Step 2: Yield +100k reported");
        vm.warp(block.timestamp + 1 days + 1);
        vault.reportYieldAndCollectFees(100_000e6);

        uint256 priceAfterYield = vault.sharePrice();
        console2.log("  Price after yield:", priceAfterYield);
        console2.log("  Attacker share value:", vault.sharesToUsdc(attackerShares));

        // Attacker tries to exit
        console2.log("");
        console2.log("Step 3: Attacker requests withdrawal");
        vm.prank(attacker);
        vault.requestWithdrawal(attackerShares);
        console2.log("  Shares escrowed");

        // Wait for cooldown
        console2.log("");
        console2.log("Step 4: Wait for 1 day cooldown...");
        vm.warp(block.timestamp + 1 days + 1);

        // But now negative yield hits!
        console2.log("");
        console2.log("Step 5: PLOT TWIST - Loss of 50k during cooldown!");
        vault.reportYieldAndCollectFees(-50_000e6);

        uint256 priceAtFulfillment = vault.sharePrice();
        console2.log("  Price at fulfillment:", priceAtFulfillment);

        // Fulfill
        console2.log("");
        console2.log("Step 6: Withdrawal fulfilled");
        vm.prank(operator);
        (uint256 processed, uint256 paid) = vault.fulfillWithdrawals(1);
        console2.log("  USDC received:", paid);

        // Analyze profit/loss
        console2.log("");
        console2.log("=== ATTACK ANALYSIS ===");
        console2.log("Attacker invested: 500,000 USDC");
        console2.log("Attacker received:", paid);

        if (paid > 500_000e6) {
            uint256 profit = paid - 500_000e6;
            console2.log("PROFIT:", profit);
            console2.log("EXPLOIT STATUS: SUCCESS");
        } else if (paid < 500_000e6) {
            uint256 loss = 500_000e6 - paid;
            console2.log("LOSS:", loss);
            console2.log("EXPLOIT STATUS: FAILED - Attacker lost money!");
            console2.log("");
            console2.log("ROOT CAUSE: Cooldown period exposes attacker to price risk");
            console2.log("Cannot instantly exit after front-running");
        } else {
            console2.log("Break even");
        }
    }

    function test_EXPLOIT_YieldSandwich_BestCase() public {
        console2.log("=== YIELD SANDWICH - BEST CASE SCENARIO ===");
        console2.log("");
        console2.log("Attacker has perfect foresight:");
        console2.log("  - Knows +100k yield coming");
        console2.log("  - Knows NO loss during cooldown");
        console2.log("");

        // Attacker front-runs
        vm.startPrank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        uint256 attackerShares = vault.deposit(500_000e6);
        vm.stopPrank();

        console2.log("Attacker deposited 500k, shares:", attackerShares);

        // Yield report
        vm.warp(block.timestamp + 1 days + 1);
        vault.reportYieldAndCollectFees(100_000e6);
        console2.log("Yield +100k reported");

        // Attacker share value now
        uint256 attackerValue = vault.sharesToUsdc(attackerShares);
        console2.log("Attacker value after yield:", attackerValue);

        // Request withdrawal
        vm.prank(attacker);
        vault.requestWithdrawal(attackerShares);

        // Wait for cooldown (no more yield changes)
        vm.warp(block.timestamp + 1 days + 1);

        // Fulfill
        vm.prank(operator);
        (, uint256 paid) = vault.fulfillWithdrawals(1);

        console2.log("");
        console2.log("=== BEST CASE RESULTS ===");
        console2.log("Invested: 500,000 USDC");
        console2.log("Received:", paid);

        if (paid > 500_000e6) {
            uint256 profit = paid - 500_000e6;
            uint256 profitBps = (profit * 10000) / 500_000e6;
            console2.log("Gross profit:", profit);
            console2.log("Profit bps:", profitBps);

            // Calculate what attacker's "fair share" of yield should be
            // Attacker had 500k of 1.5M total = 33.3%
            // Net yield after 20% fee = 80k
            // Attacker's share = 80k * 33.3% = 26.6k
            console2.log("");
            console2.log("This profit is LEGITIMATE:");
            console2.log("  Attacker risked capital for 1+ days");
            console2.log("  Received proportional share of yield");
            console2.log("  NOT an exploit - just market timing");
        }
    }
}
