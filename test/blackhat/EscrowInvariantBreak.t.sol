// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {USDCSavingsVault} from "../../src/USDCSavingsVault.sol";
import {RoleManager} from "../../src/RoleManager.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * @title EscrowInvariantBreak
 * @notice Attempts to break the escrow invariant for double-spend
 * @dev Target: escrowedShares < pendingWithdrawalShares = PROFIT
 */
contract EscrowInvariantBreak is Test {
    USDCSavingsVault vault;
    RoleManager roleManager;
    MockUSDC usdc;

    address owner = address(this);
    address operator = makeAddr("operator");
    address attacker = makeAddr("attacker");

    function setUp() public {
        usdc = new MockUSDC();
        roleManager = new RoleManager(owner);
        vault = new USDCSavingsVault(
            address(usdc),
            address(roleManager),
            makeAddr("multisig"),
            makeAddr("treasury"),
            0,
            1 days,
            "Test Vault",
            "TV"
        );
        roleManager.setOperator(operator, true);
        vault.setWithdrawalBuffer(type(uint256).max);
        vault.setMaxYieldChangePercent(0);

        usdc.mint(attacker, 10_000_000e6);
    }

    function test_EXPLOIT_DirectTransferToVault() public {
        console2.log("=== DIRECT TRANSFER TO VAULT ===");
        console2.log("");
        console2.log("Attack: Try to transfer shares directly to vault");
        console2.log("");

        // Attacker deposits
        vm.startPrank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        uint256 shares = vault.deposit(1_000_000e6);
        console2.log("Attacker deposited, shares:", shares);

        // Try to transfer directly to vault
        console2.log("");
        console2.log("Attempting transfer to vault...");

        vm.expectRevert(USDCSavingsVault.CannotTransferToVault.selector);
        vault.transfer(address(vault), shares);

        console2.log("BLOCKED: CannotTransferToVault");
        console2.log("");
        console2.log("V-2 FIX EFFECTIVE");
        vm.stopPrank();
    }

    function test_EXPLOIT_RaceCondition() public {
        console2.log("=== RACE CONDITION ATTEMPT ===");
        console2.log("");
        console2.log("Attack: Multiple withdrawals from same shares");
        console2.log("");

        // Attacker deposits
        vm.startPrank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        uint256 shares = vault.deposit(1_000_000e6);
        console2.log("Attacker shares:", shares);

        // Request withdrawal (all shares)
        vault.requestWithdrawal(shares);
        console2.log("Requested withdrawal of all shares");

        // Try to request again with same shares
        console2.log("");
        console2.log("Attempting second withdrawal request...");
        vm.expectRevert(USDCSavingsVault.InsufficientShares.selector);
        vault.requestWithdrawal(1);

        console2.log("BLOCKED: InsufficientShares");
        console2.log("Shares are escrowed, cannot double-withdraw");
        console2.log("");
        console2.log("DOUBLE-SPEND PREVENTED");
        vm.stopPrank();
    }

    function test_EXPLOIT_CancelAndWithdraw() public {
        console2.log("=== CANCEL + WITHDRAW RACE ===");
        console2.log("");
        console2.log("Attack: Cancel then immediately request again");
        console2.log("");

        vm.startPrank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        uint256 shares = vault.deposit(1_000_000e6);

        // First withdrawal request
        uint256 requestId = vault.requestWithdrawal(shares);
        console2.log("Request 1 created, id:", requestId);
        console2.log("Attacker shares after escrow:", vault.balanceOf(attacker));

        // Cancel within window
        vault.cancelWithdrawal(requestId);
        console2.log("Request 1 cancelled");
        console2.log("Attacker shares after cancel:", vault.balanceOf(attacker));

        // Request again
        uint256 requestId2 = vault.requestWithdrawal(shares);
        console2.log("Request 2 created, id:", requestId2);

        // Try to fulfill request 1 (already cancelled)
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days + 1);

        console2.log("");
        console2.log("Attempting to fulfill cancelled request...");

        // Queue starts at head=0 (cancelled request), skips it, processes request 1
        vm.prank(operator);
        (uint256 processed, uint256 paid) = vault.fulfillWithdrawals(2);
        console2.log("Fulfill result: processed:", processed, "paid:", paid);

        // Only 1 request should be processed (the second one)
        assertEq(processed, 1, "Should process only 1 request");
        assertEq(paid, 1_000_000e6, "Should pay 1M USDC");

        // Attacker received their original deposit back (no double-claim)
        uint256 attackerBalance = usdc.balanceOf(attacker);
        console2.log("Attacker final USDC:", attackerBalance);

        // Attacker started with 10M, deposited 1M, got 1M back
        assertEq(attackerBalance, 10_000_000e6, "No extra funds extracted");

        console2.log("");
        console2.log("EXPLOIT FAILED: Cancelled requests properly skipped");
        console2.log("Cannot double-claim via cancel");
    }

    function test_EXPLOIT_MultipleSmallRequests() public {
        console2.log("=== QUEUE FLOODING ===");
        console2.log("");
        console2.log("Attack: Max out pending requests per user");
        console2.log("");

        vm.startPrank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000e6);

        uint256 sharePerRequest = vault.balanceOf(attacker) / 11;
        console2.log("Shares per request:", sharePerRequest);

        // Create MAX_PENDING_PER_USER requests
        for (uint256 i = 0; i < 10; i++) {
            vault.requestWithdrawal(sharePerRequest);
        }
        console2.log("Created 10 requests (max)");

        // Try 11th request
        console2.log("");
        console2.log("Attempting 11th request...");
        vm.expectRevert(USDCSavingsVault.TooManyPendingRequests.selector);
        vault.requestWithdrawal(sharePerRequest);

        console2.log("BLOCKED: TooManyPendingRequests");
        console2.log("");
        console2.log("QUEUE SPAM PREVENTED");
        vm.stopPrank();
    }

    function test_INVARIANT_EscrowAlwaysCovers() public {
        console2.log("=== ESCROW INVARIANT CHECK ===");
        console2.log("");

        // Multiple users deposit and withdraw
        address user1 = makeAddr("user1");
        address user2 = makeAddr("user2");
        address user3 = makeAddr("user3");

        usdc.mint(user1, 100_000e6);
        usdc.mint(user2, 200_000e6);
        usdc.mint(user3, 300_000e6);

        // Deposits
        vm.prank(user1);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(user1);
        uint256 shares1 = vault.deposit(100_000e6);

        vm.prank(user2);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(user2);
        uint256 shares2 = vault.deposit(200_000e6);

        vm.prank(user3);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(user3);
        uint256 shares3 = vault.deposit(300_000e6);

        // Interleaved withdrawals and cancellations
        vm.prank(user1);
        uint256 req1 = vault.requestWithdrawal(shares1);

        vm.prank(user2);
        uint256 req2 = vault.requestWithdrawal(shares2 / 2);

        vm.prank(user1);
        vault.cancelWithdrawal(req1); // Cancel user1

        vm.prank(user3);
        vault.requestWithdrawal(shares3);

        vm.prank(user2);
        vault.requestWithdrawal(shares2 / 2); // User2 second half

        // Check invariant
        uint256 escrow = vault.balanceOf(address(vault));
        uint256 pending = vault.pendingWithdrawalShares();

        console2.log("After complex operations:");
        console2.log("  Escrowed shares:", escrow);
        console2.log("  Pending shares:", pending);

        assertGe(escrow, pending, "INVARIANT VIOLATED: escrow < pending");
        console2.log("");
        console2.log("INVARIANT HOLDS: escrow >= pending");

        // Fulfill some
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(operator);
        vault.fulfillWithdrawals(2);

        escrow = vault.balanceOf(address(vault));
        pending = vault.pendingWithdrawalShares();

        console2.log("");
        console2.log("After partial fulfillment:");
        console2.log("  Escrowed shares:", escrow);
        console2.log("  Pending shares:", pending);

        assertGe(escrow, pending, "INVARIANT VIOLATED after fulfillment");
        console2.log("");
        console2.log("INVARIANT STILL HOLDS");
    }
}
