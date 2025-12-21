// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {USDCSavingsVault} from "../src/USDCSavingsVault.sol";
import {VaultShare} from "../src/VaultShare.sol";
import {StrategyOracle} from "../src/StrategyOracle.sol";
import {RoleManager} from "../src/RoleManager.sol";
import {IVault} from "../src/interfaces/IVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract USDCSavingsVaultTest is Test {
    USDCSavingsVault public vault;
    VaultShare public shares;
    StrategyOracle public strategyOracle;
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

        // Deploy StrategyOracle (uses roleManager for owner check)
        strategyOracle = new StrategyOracle(address(roleManager));

        // Deploy Vault
        vault = new USDCSavingsVault(
            address(usdc),
            address(strategyOracle),
            address(roleManager),
            multisig,
            treasury,
            FEE_RATE,
            COOLDOWN
        );
        shares = vault.shares();

        // Set up operator
        roleManager.setOperator(operator, true);

        // Authorize vault to report yield (for atomic yield+fee collection)
        strategyOracle.setVault(address(vault));

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
        assertEq(address(vault.strategyOracle()), address(strategyOracle));
        assertEq(address(vault.roleManager()), address(roleManager));
        assertEq(vault.multisig(), multisig);
        assertEq(vault.treasury(), treasury);
        assertEq(vault.feeRate(), FEE_RATE);
        assertEq(vault.cooldownPeriod(), COOLDOWN);
        assertEq(vault.sharePrice(), INITIAL_SHARE_PRICE); // 1 USDC = 1 share initially
        assertEq(vault.priceHighWaterMark(), INITIAL_SHARE_PRICE);
    }

    function test_constructor_reverts_zeroAddress() public {
        vm.expectRevert(USDCSavingsVault.ZeroAddress.selector);
        new USDCSavingsVault(address(0), address(strategyOracle), address(roleManager), multisig, treasury, FEE_RATE, COOLDOWN);

        vm.expectRevert(USDCSavingsVault.ZeroAddress.selector);
        new USDCSavingsVault(address(usdc), address(0), address(roleManager), multisig, treasury, FEE_RATE, COOLDOWN);

        vm.expectRevert(USDCSavingsVault.ZeroAddress.selector);
        new USDCSavingsVault(address(usdc), address(strategyOracle), address(0), multisig, treasury, FEE_RATE, COOLDOWN);
    }

    function test_constructor_reverts_invalidFeeRate() public {
        vm.expectRevert(USDCSavingsVault.InvalidFeeRate.selector);
        new USDCSavingsVault(address(usdc), address(strategyOracle), address(roleManager), multisig, treasury, 0.6e18, COOLDOWN);
    }

    function test_constructor_reverts_invalidCooldown() public {
        vm.expectRevert(USDCSavingsVault.InvalidCooldown.selector);
        new USDCSavingsVault(address(usdc), address(strategyOracle), address(roleManager), multisig, treasury, FEE_RATE, 0);

        vm.expectRevert(USDCSavingsVault.InvalidCooldown.selector);
        new USDCSavingsVault(address(usdc), address(strategyOracle), address(roleManager), multisig, treasury, FEE_RATE, 31 days);
    }

    // ============ Deposit Tests ============

    function test_deposit_basic() public {
        uint256 depositAmount = 100_000e6;

        vm.prank(alice);
        uint256 sharesMinted = vault.deposit(depositAmount);

        // 100k USDC at 1:1 = 100k shares (in 18 decimals = 100_000e18)
        uint256 expectedShares = toShares(depositAmount);
        assertEq(sharesMinted, expectedShares);
        assertEq(shares.balanceOf(alice), expectedShares);
        assertEq(vault.userTotalDeposited(alice), depositAmount);
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

        assertEq(shares.balanceOf(alice), toShares(100_000e6));
        assertEq(shares.balanceOf(bob), toShares(200_000e6));
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
        vm.expectRevert(USDCSavingsVault.ZeroAmount.selector);
        vault.deposit(0);
    }

    function test_deposit_reverts_whenPaused() public {
        roleManager.pause();

        vm.prank(alice);
        vm.expectRevert(USDCSavingsVault.Paused.selector);
        vault.deposit(100_000e6);
    }

    function test_deposit_reverts_whenDepositsPaused() public {
        vm.prank(operator);
        roleManager.pauseDeposits();

        vm.prank(alice);
        vm.expectRevert(USDCSavingsVault.DepositsPaused.selector);
        vault.deposit(100_000e6);
    }

    function test_deposit_reverts_exceedsUserCap() public {
        vault.setPerUserCap(50_000e6);

        vm.prank(alice);
        vm.expectRevert(USDCSavingsVault.ExceedsUserCap.selector);
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

        // Report 10% yield (10k on 100k)
        strategyOracle.reportYield(10_000e6);

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
        strategyOracle.reportYield(-10_000e6);

        // totalAssets = 100k - 10k = 90k
        assertEq(vault.totalAssets(), 90_000e6);
        assertEq(vault.sharePrice(), 0.9e6);
    }

    function test_deposit_afterYield_sharesCorrect() public {
        // Alice deposits 100k at 1:1
        vm.prank(alice);
        vault.deposit(100_000e6);

        // 8% yield
        strategyOracle.reportYield(8_000e6);

        // Bob deposits 108k (same as NAV)
        vm.prank(bob);
        uint256 bobShares = vault.deposit(108_000e6);

        // Price = 108k / 100k shares = 1.08e6
        // Bob's shares = 108k * 1e18 / 1.08e6 = 100k shares
        assertEq(bobShares, toShares(100_000e6));

        // Total shares = 200k
        assertEq(vault.totalShares(), toShares(200_000e6));
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
        assertEq(shares.balanceOf(alice), toShares(50_000e6)); // 100k - 50k escrowed
        assertEq(shares.balanceOf(address(vault)), withdrawShares); // Escrowed

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
        vm.expectRevert(USDCSavingsVault.ZeroAmount.selector);
        vault.requestWithdrawal(0);
    }

    function test_requestWithdrawal_reverts_insufficientShares() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vm.expectRevert(USDCSavingsVault.InsufficientShares.selector);
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
        assertEq(shares.balanceOf(alice), toShares(50_000e6));
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
        assertEq(shares.balanceOf(alice), toShares(50_000e6));
        assertEq(shares.balanceOf(bob), toShares(50_000e6));
        assertEq(shares.balanceOf(address(vault)), withdrawShares); // Only Bob's escrow remains
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

        // Report 20% yield
        strategyOracle.reportYield(20_000e6);

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
        strategyOracle.reportYield(-10_000e6);

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

        // Report yield
        strategyOracle.reportYield(20_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(toShares(50_000e6));

        vm.warp(block.timestamp + COOLDOWN + 1);

        // Fulfill triggers fee collection
        vm.prank(operator);
        vault.fulfillWithdrawals(10);

        // Treasury should have received fee shares
        assertTrue(shares.balanceOf(treasury) > 0);
    }

    function test_feeCollection_noFeeOnDeposit() public {
        // Make two deposits
        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(bob);
        vault.deposit(100_000e6);

        // Manually collect fees
        vault.collectFees();

        // Treasury should NOT receive fees (no yield, only deposits)
        assertEq(shares.balanceOf(treasury), 0);
    }

    function test_feeCollection_noFeeOnLoss() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        // Report loss
        strategyOracle.reportYield(-10_000e6);

        vault.collectFees();

        // No fees on loss
        assertEq(shares.balanceOf(treasury), 0);
    }

    function test_reportYieldAndCollectFees_atomic() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        // Use atomic function - reports yield AND collects fees in one tx
        vault.reportYieldAndCollectFees(20_000e6);

        // Yield should be reported
        assertEq(strategyOracle.accumulatedYield(), 20_000e6);

        // Fees should be collected immediately
        assertTrue(shares.balanceOf(treasury) > 0);

        // Price HWM should be updated
        assertTrue(vault.priceHighWaterMark() > 1e6);
    }

    function test_reportYieldAndCollectFees_noFeeOnLoss() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        // Report loss atomically
        vault.reportYieldAndCollectFees(-10_000e6);

        // Loss recorded
        assertEq(strategyOracle.accumulatedYield(), -10_000e6);

        // No fees minted
        assertEq(shares.balanceOf(treasury), 0);
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
        vm.expectRevert(USDCSavingsVault.OnlyOperator.selector);
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
        assertEq(shares.balanceOf(alice), toShares(50_000e6));

        vault.cancelWithdrawal(0);

        assertEq(vault.pendingWithdrawals(), 0);
        assertEq(shares.balanceOf(alice), toShares(100_000e6)); // All shares returned
    }

    // ============ Zero Shares Fix Test (M-1) ============

    function test_deposit_reverts_zeroShares() public {
        // First, make share price very high by depositing and reporting massive yield
        vm.prank(alice);
        vault.deposit(1_000_000e6);

        // Report huge yield to make price very high
        strategyOracle.reportYield(999_000_000e6);

        // Now try to deposit a tiny amount that would result in 0 shares
        usdc.mint(bob, 1); // 1 wei of USDC
        vm.prank(bob);
        usdc.approve(address(vault), 1);

        vm.prank(bob);
        vm.expectRevert(USDCSavingsVault.ZeroShares.selector);
        vault.deposit(1);
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
        assertEq(shares.balanceOf(alice), halfShares);
        assertEq(shares.balanceOf(address(vault)), halfShares);

        // Alice can only transfer her remaining 50k
        vm.prank(alice);
        shares.transfer(bob, halfShares);

        assertEq(shares.balanceOf(alice), 0);
        assertEq(shares.balanceOf(bob), halfShares);

        vm.warp(block.timestamp + COOLDOWN + 1);

        // Process withdrawal - escrowed shares are burned from vault
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vm.prank(operator);
        vault.fulfillWithdrawals(10);

        // Alice receives USDC for her escrowed shares
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + 50_000e6);
        // Bob still has his transferred shares
        assertEq(shares.balanceOf(bob), halfShares);
        // Escrow is now empty
        assertEq(shares.balanceOf(address(vault)), 0);
    }

    // ============ Pause Tests ============

    function test_pause_stopsAllOperations() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        roleManager.pause();

        vm.prank(bob);
        vm.expectRevert(USDCSavingsVault.Paused.selector);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vm.expectRevert(USDCSavingsVault.Paused.selector);
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
        strategyOracle.reportYield(20_000e6);

        assertEq(vault.totalAssets(), 120_000e6);

        // Request and fulfill 30k withdrawal
        vm.prank(alice);
        vault.requestWithdrawal(toShares(25_000e6)); // 25k shares at 1.2 price = 30k USDC

        vm.warp(block.timestamp + COOLDOWN + 1);

        vm.prank(operator);
        vault.fulfillWithdrawals(10);

        // totalAssets = 100k deposited - withdrawal + 20k yield
        // Note: exact amount depends on fee collection
        assertTrue(vault.totalAssets() > 0);
    }

    // ============ StrategyOracle Tests ============

    function test_strategyOracle_reportYield() public {
        strategyOracle.reportYield(1_000_000e6);

        assertEq(strategyOracle.accumulatedYield(), 1_000_000e6);
    }

    function test_strategyOracle_reportNegativeYield() public {
        strategyOracle.reportYield(1_000_000e6);
        strategyOracle.reportYield(-500_000e6);

        assertEq(strategyOracle.accumulatedYield(), 500_000e6);
    }

    function test_strategyOracle_onlyOwnerCanReport() public {
        vm.prank(alice);
        vm.expectRevert(StrategyOracle.OnlyOwner.selector);
        strategyOracle.reportYield(1_000_000e6);
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
        vm.expectRevert(USDCSavingsVault.OnlyMultisig.selector);
        vault.receiveFundsFromMultisig(50_000e6);
    }
}
