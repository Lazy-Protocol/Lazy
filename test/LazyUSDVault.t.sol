// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {LazyUSDVault} from "../src/LazyUSDVault.sol";
import {RoleManager} from "../src/RoleManager.sol";
import {IVault} from "../src/interfaces/IVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract LazyUSDVaultTest is Test {
    LazyUSDVault public vault;
    RoleManager public roleManager;
    MockUSDC public usdc;

    address public owner = address(this);
    address public multisig = makeAddr("multisig");
    address public treasury = makeAddr("treasury");
    address public operator = makeAddr("operator");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");
    address public charlie = makeAddr("charlie");

    uint256 public constant FEE_RATE = 0.2e18; // 20% fee on profits
    uint256 public constant COOLDOWN = 7 days;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant INITIAL_SHARE_PRICE = 1e6; // 1 USDC = 1 share

    event Deposit(address indexed user, uint256 usdcAmount, uint256 sharesMinted);
    event WithdrawalRequested(address indexed user, uint256 shares, uint256 requestId);
    event WithdrawalFulfilled(address indexed user, uint256 shares, uint256 usdcAmount, uint256 requestId);

    function setUp() public {
        usdc = new MockUSDC();

        // Deploy RoleManager first (owner is this contract)
        roleManager = new RoleManager(owner);

        // Deploy Vault (yield tracking is now internal)
        vault = new LazyUSDVault(
            address(usdc),
            address(roleManager),
            multisig,
            treasury,
            FEE_RATE,
            COOLDOWN,
            "USDC Savings Vault Share",
            "svUSDC"
        );

        // Set up operator
        roleManager.setOperator(operator, true);

        // Disable yield bounds for testing (allows arbitrary yield values)
        // Tests can re-enable if specifically testing bounds
        vault.setMaxYieldChangePercent(0);

        // Mint USDC to test users
        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob, 1_000_000e6);
        usdc.mint(charlie, 1_000_000e6);
        usdc.mint(multisig, 10_000_000e6);

        // Approve vault
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(charlie);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(multisig);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ============ Helper Functions ============

    // Convert USDC amount (6 decimals) to expected shares (18 decimals) at 1:1 price
    function toShares(uint256 usdcAmount) internal pure returns (uint256) {
        return (usdcAmount * PRECISION) / INITIAL_SHARE_PRICE;
    }

    // Convert shares (18 decimals) to expected USDC (6 decimals) at 1:1 price
    function toUsdc(uint256 shareAmount) internal pure returns (uint256) {
        return (shareAmount * INITIAL_SHARE_PRICE) / PRECISION;
    }

    // ============ Constructor Tests ============

    function test_constructor() public view {
        assertEq(address(vault.roleManager()), address(roleManager));
        assertEq(vault.multisig(), multisig);
        assertEq(vault.treasury(), treasury);
        assertEq(vault.feeRate(), FEE_RATE);
        assertEq(vault.cooldownPeriod(), COOLDOWN);
        assertEq(vault.sharePrice(), INITIAL_SHARE_PRICE); // 1 USDC = 1 share initially
    }

    function test_constructor_reverts_zeroAddress() public {
        vm.expectRevert(LazyUSDVault.ZeroAddress.selector);
        new LazyUSDVault(address(0), address(roleManager), multisig, treasury, FEE_RATE, COOLDOWN, "Test", "TST");

        vm.expectRevert(LazyUSDVault.ZeroAddress.selector);
        new LazyUSDVault(address(usdc), address(0), multisig, treasury, FEE_RATE, COOLDOWN, "Test", "TST");

        vm.expectRevert(LazyUSDVault.ZeroAddress.selector);
        new LazyUSDVault(address(usdc), address(roleManager), address(0), treasury, FEE_RATE, COOLDOWN, "Test", "TST");
    }

    function test_constructor_reverts_invalidFeeRate() public {
        vm.expectRevert(LazyUSDVault.InvalidFeeRate.selector);
        new LazyUSDVault(address(usdc), address(roleManager), multisig, treasury, 0.6e18, COOLDOWN, "Test", "TST");
    }

    function test_constructor_reverts_invalidCooldown() public {
        vm.expectRevert(LazyUSDVault.InvalidCooldown.selector);
        new LazyUSDVault(address(usdc), address(roleManager), multisig, treasury, FEE_RATE, 0, "Test", "TST");

        vm.expectRevert(LazyUSDVault.InvalidCooldown.selector);
        new LazyUSDVault(address(usdc), address(roleManager), multisig, treasury, FEE_RATE, 31 days, "Test", "TST");
    }

    function test_constructor_shareNameSymbol() public view {
        assertEq(vault.name(), "USDC Savings Vault Share");
        assertEq(vault.symbol(), "svUSDC");
    }

    // ============ Deposit Tests ============

    function test_deposit_basic() public {
        uint256 depositAmount = 100_000e6;

        vm.prank(alice);
        uint256 sharesMinted = vault.deposit(depositAmount);

        // 100k USDC at 1:1 = 100k shares (in 18 decimals = 100_000e18)
        uint256 expectedShares = toShares(depositAmount);
        assertEq(sharesMinted, expectedShares);
        assertEq(vault.balanceOf(alice), expectedShares);
        assertEq(vault.totalDeposited(), depositAmount);
    }

    function test_deposit_emitsEvent() public {
        uint256 depositAmount = 100_000e6;
        uint256 expectedShares = toShares(depositAmount);

        vm.expectEmit(true, true, true, true);
        emit Deposit(alice, depositAmount, expectedShares);

        vm.prank(alice);
        vault.deposit(depositAmount);
    }

    function test_deposit_multipleUsers() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(bob);
        vault.deposit(200_000e6);

        assertEq(vault.balanceOf(alice), toShares(100_000e6));
        assertEq(vault.balanceOf(bob), toShares(200_000e6));
        assertEq(vault.totalShares(), toShares(300_000e6));
    }

    function test_deposit_forwardsToMultisig() public {
        uint256 depositAmount = 100_000e6;
        uint256 multisigBalanceBefore = usdc.balanceOf(multisig);

        vm.prank(alice);
        vault.deposit(depositAmount);

        // With zero buffer, all funds go to multisig
        assertEq(usdc.balanceOf(multisig), multisigBalanceBefore + depositAmount);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_deposit_respectsBuffer() public {
        vault.setWithdrawalBuffer(50_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        // 50k stays in vault, 50k goes to multisig
        assertEq(usdc.balanceOf(address(vault)), 50_000e6);
    }

    function test_deposit_reverts_zeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(LazyUSDVault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_deposit_reverts_whenPaused() public {
        roleManager.pause();

        vm.prank(alice);
        vm.expectRevert(LazyUSDVault.Paused.selector);
        vault.deposit(100_000e6);
    }

    function test_deposit_reverts_whenDepositsPaused() public {
        vm.prank(operator);
        roleManager.pauseDeposits();

        vm.prank(alice);
        vm.expectRevert(LazyUSDVault.DepositsPaused.selector);
        vault.deposit(100_000e6);
    }

    function test_deposit_reverts_exceedsUserCap() public {
        vault.setPerUserCap(50_000e6);

        vm.prank(alice);
        vm.expectRevert(LazyUSDVault.ExceedsUserCap.selector);
        vault.deposit(100_000e6);
    }

    // ============ Share Price & NAV Tests ============

    function test_sharePrice_initial() public view {
        assertEq(vault.sharePrice(), INITIAL_SHARE_PRICE);
    }

    function test_sharePrice_afterDeposit() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        // Share price should still be 1:1 (deposits auto-update NAV)
        assertEq(vault.sharePrice(), INITIAL_SHARE_PRICE);
    }

    function test_sharePrice_afterYield() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        // Report 10% yield (10k on 100k) - fees not collected in this test
        // We need to report without fee collection to test raw price change
        // Use reportYieldAndCollectFees but with 0 fee rate
        vault.queueFeeRate(0);
        vm.warp(block.timestamp + 1 days);
        vault.executeFeeRate();
        vault.reportYieldAndCollectFees(10_000e6);

        // totalAssets = 100k deposited + 10k yield = 110k
        // totalShares = 100k shares (in 18 decimals)
        // sharePrice = 110k * 1e18 / 100k shares = 1.1e6
        assertEq(vault.totalAssets(), 110_000e6);
        assertEq(vault.sharePrice(), 1.1e6);
    }

    function test_sharePrice_afterLoss() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        // Report 10% loss
        vault.reportYieldAndCollectFees(-10_000e6);

        // totalAssets = 100k - 10k = 90k
        assertEq(vault.totalAssets(), 90_000e6);
        assertEq(vault.sharePrice(), 0.9e6);
    }

    function test_deposit_afterYield_sharesCorrect() public {
        // Alice deposits 100k at 1:1
        vm.prank(alice);
        vault.deposit(100_000e6);

        // 8% yield - using atomic fee collection
        // Fee = 20% of 8k profit = 1.6k USDC worth of shares minted to treasury
        vault.reportYieldAndCollectFees(8_000e6);

        // Bob deposits 108k (same as NAV)
        // After fee collection, share price has been diluted
        vm.prank(bob);
        uint256 bobShares = vault.deposit(108_000e6);

        // After fee collection:
        // - feeShares minted to treasury
        // - sharePrice slightly reduced due to dilution
        // Bob gets shares at the post-fee price

        // Verify Bob gets reasonable shares (accounting for fee dilution)
        assertTrue(bobShares > toShares(100_000e6), "Bob should get at least 100k shares");
        assertTrue(bobShares < toShares(102_000e6), "Bob shouldn't get more than 102k shares");

        // Total shares should be Alice's + treasury fees + Bob's
        assertTrue(vault.totalShares() > toShares(200_000e6), "Total should exceed 200k due to fees");
    }

    // ============ Withdrawal Request Tests ============

    function test_requestWithdrawal_basic() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        uint256 withdrawShares = toShares(50_000e6);

        vm.prank(alice);
        uint256 requestId = vault.requestWithdrawal(withdrawShares);

        assertEq(requestId, 0);
        assertEq(vault.pendingWithdrawals(), withdrawShares);
        assertEq(vault.withdrawalQueueLength(), 1);

        // ESCROW: Alice's shares should be transferred to vault
        assertEq(vault.balanceOf(alice), toShares(50_000e6)); // 100k - 50k escrowed
        assertEq(vault.balanceOf(address(vault)), withdrawShares); // Escrowed

        IVault.WithdrawalRequest memory request = vault.getWithdrawalRequest(0);
        assertEq(request.requester, alice);
        assertEq(request.shares, withdrawShares);
        assertEq(request.requestTimestamp, block.timestamp);
    }

    function test_requestWithdrawal_emitsEvent() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        uint256 withdrawShares = toShares(50_000e6);

        vm.expectEmit(true, true, true, true);
        emit WithdrawalRequested(alice, withdrawShares, 0);

        vm.prank(alice);
        vault.requestWithdrawal(withdrawShares);
    }

    function test_requestWithdrawal_reverts_zeroAmount() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vm.expectRevert(LazyUSDVault.ZeroAmount.selector);
        vault.requestWithdrawal(0);
    }

    function test_requestWithdrawal_reverts_insufficientShares() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vm.expectRevert(LazyUSDVault.InsufficientShares.selector);
        vault.requestWithdrawal(toShares(200_000e6));
    }

    // ============ Withdrawal Fulfillment Tests ============

    function test_fulfillWithdrawals_basic() public {
        vault.setWithdrawalBuffer(100_000e6); // Keep all in vault

        vm.prank(alice);
        vault.deposit(100_000e6);

        uint256 withdrawShares = toShares(50_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(withdrawShares);

        // Wait for cooldown
        vm.warp(block.timestamp + COOLDOWN + 1);

        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vm.prank(operator);
        (uint256 processed, uint256 usdcPaid) = vault.fulfillWithdrawals(10);

        assertEq(processed, 1);
        assertEq(usdcPaid, 50_000e6);
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + 50_000e6);
        assertEq(vault.balanceOf(alice), toShares(50_000e6));
    }

    function test_fulfillWithdrawals_fifoOrder() public {
        vault.setWithdrawalBuffer(300_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);
        vm.prank(bob);
        vault.deposit(100_000e6);

        uint256 withdrawShares = toShares(50_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(withdrawShares); // Request 0
        vm.prank(bob);
        vault.requestWithdrawal(withdrawShares); // Request 1

        vm.warp(block.timestamp + COOLDOWN + 1);

        // Process only 1
        vm.prank(operator);
        vault.fulfillWithdrawals(1);

        // Alice should be processed first (FIFO)
        assertEq(vault.balanceOf(alice), toShares(50_000e6));
        assertEq(vault.balanceOf(bob), toShares(50_000e6));
        assertEq(vault.balanceOf(address(vault)), withdrawShares); // Only Bob's escrow remains
    }

    function test_fulfillWithdrawals_respectsCooldown() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(toShares(50_000e6));

        // Try to process before cooldown
        vm.prank(operator);
        (uint256 processed,) = vault.fulfillWithdrawals(10);

        assertEq(processed, 0); // Nothing processed
    }

    function test_fulfillWithdrawals_afterYield() public {
        vault.setWithdrawalBuffer(200_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(toShares(50_000e6));

        // Report 20% yield (fees collected atomically)
        vault.reportYieldAndCollectFees(20_000e6);

        vm.warp(block.timestamp + COOLDOWN + 1);

        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vm.prank(operator);
        vault.fulfillWithdrawals(10);

        // Alice receives more due to yield (minus fees)
        uint256 received = usdc.balanceOf(alice) - aliceUsdcBefore;
        assertTrue(received > 50_000e6);
    }

    function test_fulfillWithdrawals_afterLoss() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(toShares(50_000e6));

        // Report 10% loss
        vault.reportYieldAndCollectFees(-10_000e6);

        vm.warp(block.timestamp + COOLDOWN + 1);

        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vm.prank(operator);
        vault.fulfillWithdrawals(10);

        // Alice receives 50k shares * 0.9 = 45k USDC
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + 45_000e6);
    }

    // ============ Fee Collection Tests ============

    function test_feeCollection_onYield() public {
        vault.setWithdrawalBuffer(200_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        // Report yield - fees are collected atomically
        vault.reportYieldAndCollectFees(20_000e6);

        // Treasury should have received fee shares immediately
        assertTrue(vault.balanceOf(treasury) > 0, "Treasury should receive fees on yield report");
    }

    function test_feeCollection_noFeeOnDeposit() public {
        // Make two deposits
        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(bob);
        vault.deposit(100_000e6);

        // Report zero yield - this is how fees are collected now
        vault.reportYieldAndCollectFees(0);

        // Treasury should NOT receive fees (no yield, only deposits)
        assertEq(vault.balanceOf(treasury), 0);
    }

    function test_feeCollection_noFeeOnLoss() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        // Report loss via atomic function
        vault.reportYieldAndCollectFees(-10_000e6);

        // No fees on loss
        assertEq(vault.balanceOf(treasury), 0);
    }

    function test_reportYieldAndCollectFees_atomic() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        // Use atomic function - reports yield AND collects fees in one tx
        vault.reportYieldAndCollectFees(20_000e6);

        // Yield should be reported
        assertEq(vault.accumulatedYield(), 20_000e6);

        // Fees should be collected immediately (20% of 20_000e6 = 4000e6 worth of shares)
        assertTrue(vault.balanceOf(treasury) > 0);
    }

    function test_reportYieldAndCollectFees_noFeeOnLoss() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        // Report loss atomically
        vault.reportYieldAndCollectFees(-10_000e6);

        // Loss recorded
        assertEq(vault.accumulatedYield(), -10_000e6);

        // No fees minted
        assertEq(vault.balanceOf(treasury), 0);
    }

    function test_reportYieldAndCollectFees_onlyOwner() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        // Non-owner cannot call
        vm.prank(alice);
        vm.expectRevert();
        vault.reportYieldAndCollectFees(1_000e6);
    }

    // ============ FIFO Bug Fix Test (H-2) ============

    function test_fifo_doesNotSkipImmatureRequests() public {
        vault.setWithdrawalBuffer(300_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);
        vm.prank(bob);
        vault.deposit(100_000e6);

        // Alice requests at t=0
        vm.prank(alice);
        vault.requestWithdrawal(toShares(50_000e6));

        // Advance 1 second, Bob requests
        vm.warp(block.timestamp + 1);
        vm.prank(bob);
        vault.requestWithdrawal(toShares(50_000e6));

        // Advance to just before Alice's cooldown ends
        vm.warp(block.timestamp + COOLDOWN - 2);

        // Try to fulfill - should process 0 (Alice not mature, and we don't skip past her)
        vm.prank(operator);
        (uint256 processed,) = vault.fulfillWithdrawals(10);
        assertEq(processed, 0);

        // Now advance past Alice's cooldown
        vm.warp(block.timestamp + 3);

        // Now Alice should be processed
        vm.prank(operator);
        (processed,) = vault.fulfillWithdrawals(1);
        assertEq(processed, 1);

        // Verify Alice's request was processed (not Bob's)
        IVault.WithdrawalRequest memory aliceRequest = vault.getWithdrawalRequest(0);
        IVault.WithdrawalRequest memory bobRequest = vault.getWithdrawalRequest(1);
        assertEq(aliceRequest.shares, 0); // Processed
        assertTrue(bobRequest.shares > 0); // Still pending
    }

    // ============ Role & Permission Tests ============

    function test_operator_canFulfillWithdrawals() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(toShares(50_000e6));

        vm.warp(block.timestamp + COOLDOWN + 1);

        vm.prank(operator);
        vault.fulfillWithdrawals(10); // Should not revert
    }

    function test_nonOperator_cannotFulfillWithdrawals() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(toShares(50_000e6));

        vm.warp(block.timestamp + COOLDOWN + 1);

        vm.prank(alice);
        vm.expectRevert(LazyUSDVault.OnlyOperator.selector);
        vault.fulfillWithdrawals(10);
    }

    // ============ Emergency Override Tests ============

    function test_forceProcessWithdrawal() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(toShares(50_000e6));

        // Force process without waiting for cooldown
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vault.forceProcessWithdrawal(0);

        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + 50_000e6);
    }

    function test_cancelWithdrawal() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        uint256 withdrawShares = toShares(50_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(withdrawShares);

        assertEq(vault.pendingWithdrawals(), withdrawShares);
        assertEq(vault.balanceOf(alice), toShares(50_000e6));

        vault.cancelWithdrawal(0);

        assertEq(vault.pendingWithdrawals(), 0);
        assertEq(vault.balanceOf(alice), toShares(100_000e6)); // All shares returned
    }

    // ============ Zero Shares Fix Test (M-1) ============

    function test_deposit_tinyAmountStillGetsShares() public {
        // First, make share price high by depositing and reporting yield
        vm.prank(alice);
        vault.deposit(1_000_000e6);

        // Report yield to increase price (price = 1e9 = 1000 USDC per share)
        vault.reportYieldAndCollectFees(999_000_000e6);

        // Note: Due to high precision (1e18), even tiny deposits get shares
        // 1 wei USDC * 1e18 / 1e9 = 1e9 shares (not 0)
        // The ZeroShares revert only happens in extreme edge cases
        // that require price > 1e18 (unrealistic in practice)

        // Verify tiny deposit still works and gets some shares
        usdc.mint(bob, 1); // 1 wei of USDC
        vm.prank(bob);
        usdc.approve(address(vault), 1);

        vm.prank(bob);
        uint256 bobShares = vault.deposit(1);
        assertTrue(bobShares > 0, "Even tiny deposit should get some shares");
    }

    // ============ Share Escrow Tests ============

    function test_escrow_preventsDoubleSpend() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        uint256 fullShares = toShares(100_000e6);
        uint256 halfShares = toShares(50_000e6);

        // Alice requests withdrawal of 50k shares -> shares escrowed
        vm.prank(alice);
        vault.requestWithdrawal(halfShares);

        // Alice only has 50k left (50k escrowed in vault)
        assertEq(vault.balanceOf(alice), halfShares);
        assertEq(vault.balanceOf(address(vault)), halfShares);

        // Alice can only transfer her remaining 50k
        vm.prank(alice);
        vault.transfer(bob, halfShares);

        assertEq(vault.balanceOf(alice), 0);
        assertEq(vault.balanceOf(bob), halfShares);

        vm.warp(block.timestamp + COOLDOWN + 1);

        // Process withdrawal - escrowed shares are burned from vault
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vm.prank(operator);
        vault.fulfillWithdrawals(10);

        // Alice receives USDC for her escrowed shares
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + 50_000e6);
        // Bob still has his transferred shares
        assertEq(vault.balanceOf(bob), halfShares);
        // Escrow is now empty
        assertEq(vault.balanceOf(address(vault)), 0);
    }

    // ============ Pause Tests ============

    function test_pause_stopsAllOperations() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        roleManager.pause();

        vm.prank(bob);
        vm.expectRevert(LazyUSDVault.Paused.selector);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vm.expectRevert(LazyUSDVault.Paused.selector);
        vault.requestWithdrawal(toShares(50_000e6));
    }

    function test_unpause_resumesOperations() public {
        roleManager.pause();
        roleManager.unpause();

        vm.prank(alice);
        vault.deposit(100_000e6); // Should work
    }

    // ============ NAV Auto-Tracking Tests ============

    function test_totalAssets_autoTracksDeposits() public {
        assertEq(vault.totalAssets(), 0);

        vm.prank(alice);
        vault.deposit(100_000e6);

        assertEq(vault.totalAssets(), 100_000e6);

        vm.prank(bob);
        vault.deposit(50_000e6);

        assertEq(vault.totalAssets(), 150_000e6);
    }

    function test_totalAssets_autoTracksWithdrawals() public {
        vault.setWithdrawalBuffer(200_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(toShares(50_000e6));

        vm.warp(block.timestamp + COOLDOWN + 1);

        vm.prank(operator);
        vault.fulfillWithdrawals(10);

        // totalAssets should decrease by withdrawal amount
        assertEq(vault.totalWithdrawn(), 50_000e6);
        assertEq(vault.totalAssets(), 50_000e6); // 100k - 50k
    }

    function test_totalAssets_combinesDepositWithdrawYield() public {
        vault.setWithdrawalBuffer(200_000e6);

        // Deposit 100k
        vm.prank(alice);
        vault.deposit(100_000e6);

        // Report 20k yield
        vault.reportYieldAndCollectFees(20_000e6);

        // Note: with 20% fee, totalAssets is still 120k (fees are shares, not USDC)
        assertEq(vault.totalAssets(), 120_000e6);

        // Request and fulfill withdrawal
        vm.prank(alice);
        vault.requestWithdrawal(toShares(25_000e6)); // 25k shares

        vm.warp(block.timestamp + COOLDOWN + 1);

        vm.prank(operator);
        vault.fulfillWithdrawals(10);

        // totalAssets = 100k deposited - withdrawal + 20k yield
        // Note: exact amount depends on fee collection
        assertTrue(vault.totalAssets() > 0);
    }

    // ============ Yield Reporting Tests ============

    function test_yieldReporting_basic() public {
        vault.reportYieldAndCollectFees(1_000_000e6);

        assertEq(vault.accumulatedYield(), 1_000_000e6);
    }

    function test_yieldReporting_negative() public {
        vault.reportYieldAndCollectFees(1_000_000e6);
        // Wait for MIN_REPORT_INTERVAL before second report
        vm.warp(block.timestamp + 1 days);
        vault.reportYieldAndCollectFees(-500_000e6);

        assertEq(vault.accumulatedYield(), 500_000e6);
    }

    function test_yieldReporting_onlyOperatorOrOwnerCanReport() public {
        // Random user cannot report
        vm.prank(alice);
        vm.expectRevert(LazyUSDVault.Unauthorized.selector);
        vault.reportYieldAndCollectFees(1_000_000e6);

        // Operator CAN report (new functionality)
        vm.startPrank(owner);
        vault.setMaxYieldChangePercent(0); // Disable bounds for test
        vm.stopPrank();

        vm.prank(operator);
        vault.reportYieldAndCollectFees(1_000e6);
        assertEq(vault.accumulatedYield(), 1_000e6);
    }

    // ============ Multisig Integration Tests ============

    function test_receiveFundsFromMultisig() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        uint256 vaultBalanceBefore = usdc.balanceOf(address(vault));

        vm.prank(multisig);
        vault.receiveFundsFromMultisig(50_000e6);

        assertEq(usdc.balanceOf(address(vault)), vaultBalanceBefore + 50_000e6);
    }

    function test_receiveFundsFromMultisig_onlyMultisig() public {
        vm.prank(alice);
        vm.expectRevert(LazyUSDVault.OnlyMultisig.selector);
        vault.receiveFundsFromMultisig(50_000e6);
    }
}
