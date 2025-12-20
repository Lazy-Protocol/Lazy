// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {USDCSavingsVault} from "../src/USDCSavingsVault.sol";
import {VaultShare} from "../src/VaultShare.sol";
import {NavOracle} from "../src/NavOracle.sol";
import {RoleManager} from "../src/RoleManager.sol";
import {IVault} from "../src/interfaces/IVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract USDCSavingsVaultTest is Test {
    USDCSavingsVault public vault;
    VaultShare public shares;
    NavOracle public navOracle;
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

    event Deposit(address indexed user, uint256 usdcAmount, uint256 sharesMinted);
    event WithdrawalRequested(address indexed user, uint256 shares, uint256 requestId);
    event WithdrawalFulfilled(address indexed user, uint256 shares, uint256 usdcAmount, uint256 requestId);

    function setUp() public {
        usdc = new MockUSDC();

        // Deploy RoleManager first (owner is this contract)
        roleManager = new RoleManager(owner);

        // Deploy NavOracle (uses roleManager for owner check)
        navOracle = new NavOracle(address(roleManager));

        // Deploy Vault
        vault = new USDCSavingsVault(
            address(usdc),
            address(navOracle),
            address(roleManager),
            multisig,
            treasury,
            FEE_RATE,
            COOLDOWN
        );
        shares = vault.shares();

        // Set up operator
        roleManager.setOperator(operator, true);

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

    // ============ Constructor Tests ============

    function test_constructor() public view {
        assertEq(address(vault.navOracle()), address(navOracle));
        assertEq(address(vault.roleManager()), address(roleManager));
        assertEq(vault.multisig(), multisig);
        assertEq(vault.treasury(), treasury);
        assertEq(vault.feeRate(), FEE_RATE);
        assertEq(vault.cooldownPeriod(), COOLDOWN);
        assertEq(vault.sharePrice(), PRECISION); // 1 USDC = 1 share initially
    }

    function test_constructor_reverts_zeroAddress() public {
        vm.expectRevert(USDCSavingsVault.ZeroAddress.selector);
        new USDCSavingsVault(address(0), address(navOracle), address(roleManager), multisig, treasury, FEE_RATE, COOLDOWN);

        vm.expectRevert(USDCSavingsVault.ZeroAddress.selector);
        new USDCSavingsVault(address(usdc), address(0), address(roleManager), multisig, treasury, FEE_RATE, COOLDOWN);

        vm.expectRevert(USDCSavingsVault.ZeroAddress.selector);
        new USDCSavingsVault(address(usdc), address(navOracle), address(0), multisig, treasury, FEE_RATE, COOLDOWN);
    }

    function test_constructor_reverts_invalidFeeRate() public {
        vm.expectRevert(USDCSavingsVault.InvalidFeeRate.selector);
        new USDCSavingsVault(address(usdc), address(navOracle), address(roleManager), multisig, treasury, 0.6e18, COOLDOWN);
    }

    function test_constructor_reverts_invalidCooldown() public {
        vm.expectRevert(USDCSavingsVault.InvalidCooldown.selector);
        new USDCSavingsVault(address(usdc), address(navOracle), address(roleManager), multisig, treasury, FEE_RATE, 0);

        vm.expectRevert(USDCSavingsVault.InvalidCooldown.selector);
        new USDCSavingsVault(address(usdc), address(navOracle), address(roleManager), multisig, treasury, FEE_RATE, 31 days);
    }

    // ============ Deposit Tests ============

    function test_deposit_basic() public {
        uint256 depositAmount = 100_000e6;

        // First, report initial NAV (simulating deposit going to multisig)
        // For first deposit, NAV should be updated to include the deposit
        vm.prank(alice);
        uint256 sharesMinted = vault.deposit(depositAmount);

        // Initial share price is 1:1
        assertEq(sharesMinted, depositAmount);
        assertEq(shares.balanceOf(alice), depositAmount);
        assertEq(vault.userTotalDeposited(alice), depositAmount);
    }

    function test_deposit_emitsEvent() public {
        uint256 depositAmount = 100_000e6;

        vm.expectEmit(true, true, true, true);
        emit Deposit(alice, depositAmount, depositAmount);

        vm.prank(alice);
        vault.deposit(depositAmount);
    }

    function test_deposit_multipleUsers() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(bob);
        vault.deposit(200_000e6);

        assertEq(shares.balanceOf(alice), 100_000e6);
        assertEq(shares.balanceOf(bob), 200_000e6);
        assertEq(vault.totalShares(), 300_000e6);
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
        assertEq(vault.sharePrice(), PRECISION);
    }

    function test_sharePrice_afterDeposit() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        // Update NAV to reflect deposit
        navOracle.reportTotalAssets(100_000e6);

        // Share price should still be 1:1
        assertEq(vault.sharePrice(), PRECISION);
    }

    function test_sharePrice_afterYield() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        // Report initial NAV
        navOracle.reportTotalAssets(100_000e6);

        // Report NAV with 10% yield
        navOracle.reportTotalAssets(110_000e6);

        // Share price = 110,000 / 100,000 = 1.1 USDC per share
        // (fees are collected on fulfillWithdrawals, not on NAV update)
        assertEq(vault.sharePrice(), 1.1e18);
    }

    function test_sharePrice_afterLoss() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        // Report initial NAV
        navOracle.reportTotalAssets(100_000e6);

        // Report NAV with 10% loss
        navOracle.reportTotalAssets(90_000e6);

        // Share price = 90,000 / 100,000 = 0.9 USDC per share
        assertEq(vault.sharePrice(), 0.9e18);
    }

    function test_deposit_afterYield_sharesCorrect() public {
        // Alice deposits 100k at 1:1
        vm.prank(alice);
        vault.deposit(100_000e6);

        // Report initial NAV and then yield
        navOracle.reportTotalAssets(100_000e6);
        navOracle.reportTotalAssets(108_000e6); // 8% net yield

        // Bob deposits 108k (same as NAV)
        vm.prank(bob);
        uint256 bobShares = vault.deposit(108_000e6);

        // Bob should get 100k shares (108k USDC / 1.08 price)
        assertEq(bobShares, 100_000e6);

        // Total shares = 200k
        assertEq(vault.totalShares(), 200_000e6);
    }

    // ============ Withdrawal Request Tests ============

    function test_requestWithdrawal_basic() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(alice);
        uint256 requestId = vault.requestWithdrawal(50_000e6);

        assertEq(requestId, 0);
        assertEq(vault.pendingWithdrawals(), 50_000e6);
        assertEq(vault.withdrawalQueueLength(), 1);

        IVault.WithdrawalRequest memory request = vault.getWithdrawalRequest(0);
        assertEq(request.requester, alice);
        assertEq(request.shares, 50_000e6);
        assertEq(request.requestTimestamp, block.timestamp);
    }

    function test_requestWithdrawal_emitsEvent() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.expectEmit(true, true, true, true);
        emit WithdrawalRequested(alice, 50_000e6, 0);

        vm.prank(alice);
        vault.requestWithdrawal(50_000e6);
    }

    function test_requestWithdrawal_multipleRequests() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(bob);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(50_000e6);

        vm.prank(bob);
        vault.requestWithdrawal(30_000e6);

        assertEq(vault.withdrawalQueueLength(), 2);
        assertEq(vault.pendingWithdrawals(), 80_000e6);
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
        vault.requestWithdrawal(200_000e6);
    }

    // ============ Withdrawal Fulfillment Tests ============

    function test_fulfillWithdrawals_basic() public {
        vault.setWithdrawalBuffer(100_000e6); // Keep all in vault

        vm.prank(alice);
        vault.deposit(100_000e6);

        // Set NAV
        navOracle.reportTotalAssets(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(50_000e6);

        // Wait for cooldown
        vm.warp(block.timestamp + COOLDOWN + 1);

        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vm.prank(operator);
        (uint256 processed, uint256 usdcPaid) = vault.fulfillWithdrawals(10);

        assertEq(processed, 1);
        assertEq(usdcPaid, 50_000e6);
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + 50_000e6);
        assertEq(shares.balanceOf(alice), 50_000e6);
    }

    function test_fulfillWithdrawals_fifoOrder() public {
        vault.setWithdrawalBuffer(300_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);
        vm.prank(bob);
        vault.deposit(100_000e6);

        // Set NAV
        navOracle.reportTotalAssets(200_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(50_000e6); // Request 0
        vm.prank(bob);
        vault.requestWithdrawal(50_000e6); // Request 1

        vm.warp(block.timestamp + COOLDOWN + 1);

        // Process only 1
        vm.prank(operator);
        vault.fulfillWithdrawals(1);

        // Alice should be processed first (FIFO)
        assertEq(shares.balanceOf(alice), 50_000e6);
        assertEq(shares.balanceOf(bob), 100_000e6); // Bob still has all shares
    }

    function test_fulfillWithdrawals_respectsCooldown() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        navOracle.reportTotalAssets(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(50_000e6);

        // Try to process before cooldown
        vm.prank(operator);
        (uint256 processed,) = vault.fulfillWithdrawals(10);

        assertEq(processed, 0); // Nothing processed
    }

    function test_fulfillWithdrawals_afterNAVIncrease() public {
        vault.setWithdrawalBuffer(200_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        navOracle.reportTotalAssets(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(50_000e6);

        // NAV increases 20%
        navOracle.reportTotalAssets(120_000e6);

        vm.warp(block.timestamp + COOLDOWN + 1);

        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vm.prank(operator);
        vault.fulfillWithdrawals(10);

        // Fee collection happens: 20% of 20k profit = 4k fee
        // Remaining NAV = 116k, so share price should be affected by fee minting
        // Alice receives her share value at current price
        uint256 received = usdc.balanceOf(alice) - aliceUsdcBefore;
        assertTrue(received > 50_000e6); // Should be more than deposited due to yield
    }

    function test_fulfillWithdrawals_afterNAVDecrease() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        navOracle.reportTotalAssets(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(50_000e6);

        // NAV decreases 10%
        navOracle.reportTotalAssets(90_000e6);

        vm.warp(block.timestamp + COOLDOWN + 1);

        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vm.prank(operator);
        vault.fulfillWithdrawals(10);

        // Alice receives 50k shares * 0.9 = 45k USDC
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + 45_000e6);
    }

    // ============ Loss Event Walkthrough (from spec) ============

    function test_lossEvent_specExample() public {
        // Initial State: NAV = 10M, totalShares = 10M, sharePrice = 1.0
        vault.setWithdrawalBuffer(10_000_000e6);

        vm.prank(alice);
        vault.deposit(5_000_000e6);
        vm.prank(bob);
        vault.deposit(5_000_000e6);

        navOracle.reportTotalAssets(10_000_000e6);

        assertEq(vault.totalShares(), 10_000_000e6);
        assertEq(vault.sharePrice(), PRECISION);

        // User A queues withdrawal before loss
        vm.prank(alice);
        vault.requestWithdrawal(2_500_000e6);

        // Strategy loses 10%
        navOracle.reportTotalAssets(9_000_000e6);

        assertEq(vault.sharePrice(), 0.9e18);

        // User B queues withdrawal after loss
        vm.prank(bob);
        vault.requestWithdrawal(2_500_000e6);

        vm.warp(block.timestamp + COOLDOWN + 1);

        // Process both withdrawals
        uint256 aliceBalanceBefore = usdc.balanceOf(alice);
        uint256 bobBalanceBefore = usdc.balanceOf(bob);

        vm.prank(operator);
        vault.fulfillWithdrawals(10);

        // Both users redeem at 0.9 USDC per share - loss is borne equally
        assertEq(usdc.balanceOf(alice) - aliceBalanceBefore, 2_250_000e6); // 2.5M * 0.9
        assertEq(usdc.balanceOf(bob) - bobBalanceBefore, 2_250_000e6);     // 2.5M * 0.9
    }

    // ============ Role & Permission Tests ============

    function test_operator_canFulfillWithdrawals() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        navOracle.reportTotalAssets(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(50_000e6);

        vm.warp(block.timestamp + COOLDOWN + 1);

        vm.prank(operator);
        vault.fulfillWithdrawals(10); // Should not revert
    }

    function test_nonOperator_cannotFulfillWithdrawals() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(50_000e6);

        vm.warp(block.timestamp + COOLDOWN + 1);

        vm.prank(alice);
        vm.expectRevert(USDCSavingsVault.OnlyOperator.selector);
        vault.fulfillWithdrawals(10);
    }

    function test_owner_canSetOperator() public {
        address newOperator = makeAddr("newOperator");
        roleManager.setOperator(newOperator, true);

        assertTrue(roleManager.isOperator(newOperator));
    }

    function test_nonOwner_cannotSetOperator() public {
        address newOperator = makeAddr("newOperator");

        vm.prank(alice);
        vm.expectRevert(RoleManager.OnlyOwner.selector);
        roleManager.setOperator(newOperator, true);
    }

    // ============ NavOracle Tests ============

    function test_navOracle_reportTotalAssets() public {
        navOracle.reportTotalAssets(1_000_000e6);

        assertEq(navOracle.totalAssets(), 1_000_000e6);
        assertEq(navOracle.highWaterMark(), 1_000_000e6);
    }

    function test_navOracle_onlyOwnerCanReport() public {
        vm.prank(alice);
        vm.expectRevert(NavOracle.OnlyOwner.selector);
        navOracle.reportTotalAssets(1_000_000e6);
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
        vault.requestWithdrawal(50_000e6);
    }

    function test_unpause_resumesOperations() public {
        roleManager.pause();
        roleManager.unpause();

        vm.prank(alice);
        vault.deposit(100_000e6); // Should work
    }

    function test_operator_canPause() public {
        vm.prank(operator);
        roleManager.pause();

        assertTrue(roleManager.paused());
    }

    function test_operator_cannotUnpause() public {
        roleManager.pause();

        vm.prank(operator);
        vm.expectRevert(RoleManager.OnlyOwner.selector);
        roleManager.unpause();
    }

    // ============ Emergency Override Tests ============

    function test_forceProcessWithdrawal() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        navOracle.reportTotalAssets(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(50_000e6);

        // Force process without waiting for cooldown
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);

        vault.forceProcessWithdrawal(0);

        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + 50_000e6);
    }

    function test_cancelWithdrawal() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(alice);
        vault.requestWithdrawal(50_000e6);

        assertEq(vault.pendingWithdrawals(), 50_000e6);

        vault.cancelWithdrawal(0);

        assertEq(vault.pendingWithdrawals(), 0);

        // Alice still has all shares
        assertEq(shares.balanceOf(alice), 100_000e6);
    }

    // ============ Share Transfer Tests ============

    function test_shares_transferable() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        vm.prank(alice);
        shares.transfer(bob, 50_000e6);

        assertEq(shares.balanceOf(alice), 50_000e6);
        assertEq(shares.balanceOf(bob), 50_000e6);
    }

    function test_withdrawalRights_followShareOwnership() public {
        vault.setWithdrawalBuffer(100_000e6);

        vm.prank(alice);
        vault.deposit(100_000e6);

        navOracle.reportTotalAssets(100_000e6);

        // Alice requests withdrawal
        vm.prank(alice);
        vault.requestWithdrawal(50_000e6);

        // Alice transfers shares to Bob before fulfillment
        vm.prank(alice);
        shares.transfer(bob, 100_000e6);

        vm.warp(block.timestamp + COOLDOWN + 1);

        // Process withdrawal - but Alice has no shares now
        vm.prank(operator);
        vault.fulfillWithdrawals(10);

        // Request was processed but with 0 shares burned (Alice has none)
        assertEq(shares.balanceOf(alice), 0);
        assertEq(shares.balanceOf(bob), 100_000e6);
    }

    // ============ RoleManager Ownership Tests ============

    function test_transferOwnership() public {
        address newOwner = makeAddr("newOwner");

        roleManager.transferOwnership(newOwner);

        vm.prank(newOwner);
        roleManager.acceptOwnership();

        assertEq(roleManager.owner(), newOwner);
    }

    function test_transferOwnership_requiresAcceptance() public {
        address newOwner = makeAddr("newOwner");

        roleManager.transferOwnership(newOwner);

        // Owner still unchanged until accepted
        assertEq(roleManager.owner(), owner);

        // Random address cannot accept
        vm.prank(alice);
        vm.expectRevert(RoleManager.NotPendingOwner.selector);
        roleManager.acceptOwnership();
    }

    // ============ Configuration Tests ============

    function test_setPerUserCap() public {
        vault.setPerUserCap(500_000e6);
        assertEq(vault.perUserCap(), 500_000e6);
    }

    function test_setGlobalCap() public {
        vault.setGlobalCap(10_000_000e6);
        assertEq(vault.globalCap(), 10_000_000e6);
    }

    function test_setWithdrawalBuffer() public {
        vault.setWithdrawalBuffer(1_000_000e6);
        assertEq(vault.withdrawalBuffer(), 1_000_000e6);
    }

    function test_setCooldownPeriod() public {
        vault.setCooldownPeriod(14 days);
        assertEq(vault.cooldownPeriod(), 14 days);
    }

    function test_setFeeRate() public {
        vault.setFeeRate(0.1e18); // 10%
        assertEq(vault.feeRate(), 0.1e18);
    }

    // ============ View Function Tests ============

    function test_sharesToUsdc() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        navOracle.reportTotalAssets(100_000e6);

        // At 1:1, 50k shares = 50k USDC
        assertEq(vault.sharesToUsdc(50_000e6), 50_000e6);

        // After yield
        navOracle.reportTotalAssets(110_000e6);
        // Price = 1.1

        assertEq(vault.sharesToUsdc(50_000e6), 55_000e6);
    }

    function test_usdcToShares() public {
        vm.prank(alice);
        vault.deposit(100_000e6);

        navOracle.reportTotalAssets(100_000e6);

        // At 1:1, 50k USDC = 50k shares
        assertEq(vault.usdcToShares(50_000e6), 50_000e6);

        // After yield
        navOracle.reportTotalAssets(110_000e6);
        // Price = 1.1

        // 55k USDC = 50k shares (at 1.1 price)
        assertEq(vault.usdcToShares(55_000e6), 50_000e6);
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
