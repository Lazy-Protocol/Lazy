// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {USDCSavingsVault} from "../src/USDCSavingsVault.sol";
import {RoleManager} from "../src/RoleManager.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/**
 * @title BankRunSimulation
 * @notice Simulates bank run under loss scenario to verify fair loss distribution
 *
 * SCENARIO:
 * 1. User A and B both deposit 500k USDC each (50% shares each)
 * 2. User A queues withdrawal (shares escrowed to vault)
 * 3. 20% loss is reported
 * 4. User B queues withdrawal (shares escrowed to vault)
 * 5. Both withdrawals fulfilled
 *
 * QUESTION: Does User A get paid more than fair share of remaining 80%?
 *
 * EXPECTED (Invariant I.3 - Universal NAV Application):
 * - Both users should receive 50% of remaining assets (400k each)
 * - Escrowed shares MUST participate in loss
 * - Total payout = 800k USDC (80% of 1M)
 */
contract BankRunSimulation is Test {
    USDCSavingsVault public vault;
    RoleManager public roleManager;
    MockUSDC public usdc;

    address public owner = address(this);
    address public multisig = makeAddr("multisig");
    address public treasury = makeAddr("treasury");
    address public operator = makeAddr("operator");

    address public userA = makeAddr("userA");
    address public userB = makeAddr("userB");

    uint256 public constant COOLDOWN = 1 days;

    function setUp() public {
        usdc = new MockUSDC();
        roleManager = new RoleManager(owner);

        vault = new USDCSavingsVault(
            address(usdc),
            address(roleManager),
            multisig,
            treasury,
            0, // No fees for clarity
            COOLDOWN,
            "USDC Savings Vault Share",
            "svUSDC"
        );

        roleManager.setOperator(operator, true);
        vault.setMaxYieldChangePercent(1e18); // Allow large yield changes for test
        vault.setWithdrawalBuffer(type(uint256).max); // Keep all USDC in vault

        // Fund users
        usdc.mint(userA, 500_000e6);
        usdc.mint(userB, 500_000e6);

        vm.prank(userA);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(userB);
        usdc.approve(address(vault), type(uint256).max);
    }

    function test_BankRun_UnderLoss_FairDistribution() public {
        console2.log("==========================================================");
        console2.log("BANK RUN UNDER LOSS SIMULATION");
        console2.log("==========================================================");

        // ============ STEP 1: Initial Deposits ============
        console2.log("");
        console2.log("STEP 1: Initial Deposits");

        vm.prank(userA);
        uint256 sharesA = vault.deposit(500_000e6);
        vm.prank(userB);
        uint256 sharesB = vault.deposit(500_000e6);

        console2.log("User A deposited 500,000 USDC, shares:", sharesA);
        console2.log("User B deposited 500,000 USDC, shares:", sharesB);
        console2.log("Total Assets:", vault.totalAssets());
        console2.log("Share Price:", vault.sharePrice());

        // ============ STEP 2: User A Queues Withdrawal ============
        console2.log("");
        console2.log("STEP 2: User A Queues Withdrawal (BEFORE loss)");

        vm.prank(userA);
        vault.requestWithdrawal(sharesA);

        console2.log("User A's shares escrowed to vault");
        console2.log("User A escrow value:", vault.sharesToUsdc(sharesA));

        // ============ STEP 3: 20% Loss Reported ============
        console2.log("");
        console2.log("STEP 3: 20% Loss Reported");

        vm.warp(block.timestamp + 1 days + 1);
        vault.reportYieldAndCollectFees(-200_000e6);

        console2.log("Loss: -200,000 USDC");
        console2.log("Total Assets after loss:", vault.totalAssets());
        console2.log("New Share Price:", vault.sharePrice());
        console2.log("");
        console2.log("User A escrowed value NOW:", vault.sharesToUsdc(sharesA));
        console2.log("User B held value NOW:", vault.sharesToUsdc(sharesB));

        // ============ STEP 4: User B Queues Withdrawal ============
        console2.log("");
        console2.log("STEP 4: User B Queues Withdrawal (AFTER loss)");

        vm.prank(userB);
        vault.requestWithdrawal(sharesB);

        console2.log("User B's shares escrowed to vault");

        // ============ STEP 5: Fulfill Both Withdrawals ============
        console2.log("");
        console2.log("STEP 5: Fulfill Both Withdrawals");

        uint256 userABefore = usdc.balanceOf(userA);
        uint256 userBBefore = usdc.balanceOf(userB);

        vm.warp(block.timestamp + COOLDOWN + 1);
        vm.prank(operator);
        (uint256 processed, uint256 totalPaid) = vault.fulfillWithdrawals(2);

        uint256 userAReceived = usdc.balanceOf(userA) - userABefore;
        uint256 userBReceived = usdc.balanceOf(userB) - userBBefore;

        console2.log("Processed:", processed);
        console2.log("Total Paid:", totalPaid);

        // ============ FINAL RESULTS ============
        console2.log("");
        console2.log("==========================================================");
        console2.log("FINAL RESULTS");
        console2.log("==========================================================");
        console2.log("User A received:", userAReceived, "USDC");
        console2.log("User B received:", userBReceived, "USDC");
        console2.log("Total:", userAReceived + userBReceived, "USDC");

        // ============ FAIRNESS CHECK ============
        console2.log("");
        console2.log("==========================================================");
        console2.log("FAIRNESS ANALYSIS");
        console2.log("==========================================================");

        uint256 expectedPerUser = 400_000e6;
        console2.log("Expected per user (50% of 800k):", expectedPerUser);

        if (userAReceived == userBReceived) {
            console2.log("");
            console2.log("SUCCESS: Both users received EQUAL payouts");
            console2.log("Escrowed shares participated in loss correctly");
        } else {
            console2.log("");
            console2.log("FAILURE: Unequal payouts detected!");
        }

        // Assertions
        assertEq(userAReceived, userBReceived, "Both users must receive equal payout");
        assertEq(userAReceived, expectedPerUser, "User A gets 400k");
        assertEq(userBReceived, expectedPerUser, "User B gets 400k");
        assertEq(totalPaid, 800_000e6, "Total payout is 800k");

        console2.log("");
        console2.log("INVARIANT I.3 VERIFIED: Universal NAV Application");
        console2.log("==========================================================");
    }

    /**
     * @notice Trace the exact math step by step
     */
    function test_BankRun_MathTrace() public {
        console2.log("==========================================================");
        console2.log("DETAILED MATH TRACE");
        console2.log("==========================================================");

        // Deposits
        vm.prank(userA);
        uint256 sharesA = vault.deposit(500_000e6);
        vm.prank(userB);
        uint256 sharesB = vault.deposit(500_000e6);

        console2.log("");
        console2.log("INITIAL STATE:");
        console2.log("  totalDeposited = 1,000,000 USDC");
        console2.log("  totalShares    =", vault.totalSupply());
        console2.log("  sharePrice     =", vault.sharePrice());

        // User A escrows
        vm.prank(userA);
        vault.requestWithdrawal(sharesA);

        console2.log("");
        console2.log("AFTER USER A ESCROW:");
        console2.log("  User A balance = 0 (transferred to vault)");
        console2.log("  Vault balance  =", vault.balanceOf(address(vault)));
        console2.log("  totalShares    =", vault.totalSupply(), "(UNCHANGED!)");
        console2.log("  sharePrice     =", vault.sharePrice(), "(UNCHANGED!)");
        console2.log("");
        console2.log("  KEY INSIGHT: Escrowed shares still count in totalSupply");

        // Loss
        vm.warp(block.timestamp + 1 days + 1);
        vault.reportYieldAndCollectFees(-200_000e6);

        console2.log("");
        console2.log("AFTER 20% LOSS:");
        console2.log("  accumulatedYield = -200,000");
        console2.log("  totalAssets = 1M - 0 + (-200k) = 800,000");
        console2.log("  totalShares =", vault.totalSupply(), "(UNCHANGED!)");
        console2.log("");
        console2.log("  NEW sharePrice = 800,000 * 1e18 / totalShares");
        console2.log("                 =", vault.sharePrice());
        console2.log("");
        console2.log("  User A value =", vault.sharesToUsdc(sharesA));
        console2.log("  User B value =", vault.sharesToUsdc(sharesB));

        // User B escrows
        vm.prank(userB);
        vault.requestWithdrawal(sharesB);

        // Fulfill
        vm.warp(block.timestamp + COOLDOWN + 1);

        console2.log("");
        console2.log("AT FULFILLMENT:");
        console2.log("  sharePrice =", vault.sharePrice());

        uint256 price = vault.sharePrice();
        console2.log("");
        console2.log("  User A payout = sharesA * price / 1e18");
        console2.log("                =", (sharesA * price) / 1e18);
        console2.log("");
        console2.log("  User B payout = sharesB * price / 1e18");
        console2.log("                =", (sharesB * price) / 1e18);

        vm.prank(operator);
        vault.fulfillWithdrawals(2);

        console2.log("");
        console2.log("ACTUAL PAYOUTS:");
        console2.log("  User A:", usdc.balanceOf(userA));
        console2.log("  User B:", usdc.balanceOf(userB));

        assertEq(usdc.balanceOf(userA), usdc.balanceOf(userB));
        assertEq(usdc.balanceOf(userA), 400_000e6);
    }
}
