// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {USDCSavingsVault} from "../../src/USDCSavingsVault.sol";
import {VaultShare} from "../../src/VaultShare.sol";
import {RoleManager} from "../../src/RoleManager.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * @title HalmosChecks
 * @notice Halmos-compatible formal verification tests
 * @dev Run with: halmos --contract HalmosChecks
 */
contract HalmosChecks is Test {
    USDCSavingsVault public vault;
    VaultShare public shares;
    RoleManager public roleManager;
    MockUSDC public usdc;

    address public owner;
    address public multisig;
    address public treasury;
    address public operator;

    function setUp() public {
        owner = address(this);
        multisig = address(0x1);
        treasury = address(0x2);
        operator = address(0x3);

        usdc = new MockUSDC();
        roleManager = new RoleManager(owner);

        vault = new USDCSavingsVault(
            address(usdc),
            address(roleManager),
            multisig,
            treasury,
            0.2e18,
            1 days,
            "USDC Savings Vault Share",
            "svUSDC"
        );
        shares = vault.shares();
        roleManager.setOperator(operator, true);
        vault.setMaxYieldChangePercent(0);
        vault.setWithdrawalBuffer(type(uint256).max);
    }

    // ============ Halmos-compatible checks ============

    /**
     * @notice Check: Deposit increases shares correctly
     */
    function check_deposit_increases_shares(uint256 amount) public {
        // Bound to valid range (Halmos doesn't support vm.assume the same way)
        if (amount == 0 || amount > 1_000_000_000e6) return;

        address user = address(0x1000);
        usdc.mint(user, amount);
        vm.startPrank(user);
        usdc.approve(address(vault), amount);

        uint256 sharesBefore = shares.totalSupply();
        uint256 minted = vault.deposit(amount);
        uint256 sharesAfter = shares.totalSupply();

        // PROVE: Shares increased by exactly minted amount
        assert(sharesAfter == sharesBefore + minted);
        // PROVE: User received shares
        assert(shares.balanceOf(user) == minted);
        vm.stopPrank();
    }

    /**
     * @notice Check: Share price is always positive when shares exist
     */
    function check_share_price_positive(uint256 amount) public {
        if (amount == 0 || amount > 1_000_000_000e6) return;

        address user = address(0x1000);
        usdc.mint(user, amount);
        vm.prank(user);
        usdc.approve(address(vault), amount);
        vm.prank(user);
        vault.deposit(amount);

        // PROVE: Share price is positive when shares exist
        uint256 price = vault.sharePrice();
        assert(price > 0);
    }

    /**
     * @notice Check: Escrow balance covers pending withdrawals
     */
    function check_escrow_covers_pending(uint256 amount) public {
        if (amount < 1e6 || amount > 1_000_000_000e6) return;

        address user = address(0x1000);
        usdc.mint(user, amount);
        vm.prank(user);
        usdc.approve(address(vault), amount);
        vm.prank(user);
        uint256 userShares = vault.deposit(amount);

        // Request withdrawal
        vm.prank(user);
        vault.requestWithdrawal(userShares);

        // PROVE: Escrow balance always >= pending shares
        uint256 escrowBalance = shares.balanceOf(address(vault));
        uint256 pendingShares = vault.pendingWithdrawalShares();
        assert(escrowBalance >= pendingShares);
    }

    /**
     * @notice Check: Fee rate is always bounded
     */
    function check_fee_rate_bounded() public {
        uint256 maxFee = vault.MAX_FEE_RATE();
        uint256 currentFee = vault.feeRate();

        // PROVE: Fee rate is bounded
        assert(currentFee <= maxFee);
    }

    /**
     * @notice Check: NAV computation is consistent
     */
    function check_nav_consistent(uint256 amount) public {
        if (amount == 0 || amount > 1_000_000_000e6) return;

        address user = address(0x1000);
        usdc.mint(user, amount);
        vm.prank(user);
        usdc.approve(address(vault), amount);
        vm.prank(user);
        vault.deposit(amount);

        // PROVE: Total assets should be approximately equal to deposited amount
        uint256 nav = vault.totalAssets();
        assert(nav >= amount - 1); // Allow for minor rounding
        assert(nav <= amount + 1);
    }
}
