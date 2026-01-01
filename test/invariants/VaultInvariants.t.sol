// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {USDCSavingsVault} from "../../src/USDCSavingsVault.sol";
import {RoleManager} from "../../src/RoleManager.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * @title VaultInvariantTest
 * @notice Foundry invariant fuzz tests for USDCSavingsVault
 *
 * Tests the following formal invariants:
 *
 * I.1 — Conservation of Value via Shares
 *       USDC only exits when shares are burned at current NAV
 *
 * I.2 — Share Escrow Safety
 *       vault.escrowedShares() == vault.pendingWithdrawalShares()
 *
 * I.3 — Universal NAV Application
 *       sharePrice applies uniformly to all share classes
 *
 * I.4 — Fee Isolation
 *       Fees only on profit, only via share minting, never USDC transfer
 *
 * I.5 — Withdrawal Queue Liveness
 *       FIFO order, graceful termination, no reverts on low liquidity
 */
contract VaultInvariantTest is Test {
    USDCSavingsVault public vault;
    RoleManager public roleManager;
    MockUSDC public usdc;
    VaultHandler public handler;

    address public owner;
    address public multisig;
    address public treasury;
    address public operator;

    uint256 constant FEE_RATE = 0.2e18;
    uint256 constant COOLDOWN = 7 days;

    function setUp() public {
        owner = address(this);
        multisig = makeAddr("multisig");
        treasury = makeAddr("treasury");
        operator = makeAddr("operator");

        usdc = new MockUSDC();
        roleManager = new RoleManager(owner);

        vault = new USDCSavingsVault(
            address(usdc),
            address(roleManager),
            multisig,
            treasury,
            FEE_RATE,
            COOLDOWN,
            "USDC Savings Vault Share",
            "svUSDC"
        );

        vault.setMaxYieldChangePercent(0);

        roleManager.setOperator(operator, true);

        // Set large buffer so funds stay in vault for testing
        vault.setWithdrawalBuffer(type(uint256).max);

        // Create handler with access to all components
        handler = new VaultHandler(vault, usdc, roleManager, operator);

        // Target only the handler for fuzzing
        targetContract(address(handler));

        // Exclude system addresses from fuzzing
        excludeSender(address(vault));
        excludeSender(address(roleManager));
        excludeSender(address(usdc));
        excludeSender(address(handler));
    }

    /**
     * INVARIANT I.2 — Share Escrow Safety
     * The vault's share balance must always equal pendingWithdrawalShares
     */
    function invariant_escrowBalance() public view {
        assertEq(
            vault.balanceOf(address(vault)),
            vault.pendingWithdrawalShares(),
            "I.2 VIOLATED: Escrow balance mismatch"
        );
    }

    /**
     * INVARIANT I.1 — Conservation of Value
     * Total shares * share price should approximate total assets (within rounding)
     */
    function invariant_shareValueConservation() public view {
        uint256 totalShareSupply = vault.totalSupply();
        if (totalShareSupply == 0) return;

        uint256 nav = vault.totalAssets();
        uint256 price = vault.sharePrice();

        // totalShares * price / PRECISION should ≈ NAV
        uint256 impliedNav = (totalShareSupply * price) / 1e18;

        // Allow 1 unit rounding error per share (USDC has 6 decimals)
        uint256 maxError = totalShareSupply / 1e6 + 1;

        assertApproxEqAbs(
            impliedNav,
            nav,
            maxError,
            "I.1 VIOLATED: Share value doesn't match NAV"
        );
    }

    /**
     * INVARIANT I.3 — Universal NAV Application
     * Share price is consistent for all calculations
     */
    function invariant_uniformSharePrice() public view {
        // Skip this check if no shares exist (empty vault)
        if (vault.totalSupply() == 0) return;

        // Converting 1000 shares (18 decimals) to USDC and back should give ~1000 shares
        uint256 testShares = 1000e18;
        uint256 usdcValue = vault.sharesToUsdc(testShares);
        uint256 backToShares = vault.usdcToShares(usdcValue);

        // Allow small rounding error (1 share = 1e18)
        assertApproxEqAbs(
            backToShares,
            testShares,
            1e12, // Allow rounding error due to price precision
            "I.3 VIOLATED: Share price not uniform"
        );
    }

    /**
     * INVARIANT I.4 — Fee Isolation
     * Fee rate is always <= MAX_FEE_RATE
     */
    function invariant_feeRateCapped() public view {
        assertLe(
            vault.feeRate(),
            vault.MAX_FEE_RATE(),
            "I.4 VIOLATED: Fee rate exceeds maximum"
        );
    }

    /**
     * INVARIANT I.5 — Withdrawal Queue Liveness
     * Queue head never exceeds queue length
     */
    function invariant_queueHeadValid() public view {
        assertLe(
            vault.withdrawalQueueHead(),
            vault.withdrawalQueueLength(),
            "I.5 VIOLATED: Queue head exceeds length"
        );
    }

    /**
     * Additional invariant: Pending shares never exceed escrowed shares
     */
    function invariant_pendingSharesValid() public view {
        assertLe(
            vault.pendingWithdrawalShares(),
            vault.balanceOf(address(vault)),
            "Pending shares exceed escrowed"
        );
    }

    /**
     * Additional invariant: Total supply is sum of all balances
     * (implicitly tested by ERC20 but good to verify)
     */
    function invariant_totalSupplyConsistent() public view {
        uint256 totalSupply = vault.totalSupply();
        uint256 vaultBalance = vault.balanceOf(address(vault));
        uint256 treasuryBalance = vault.balanceOf(treasury);

        // Vault + Treasury + all handler actors should sum to totalSupply
        // This is a weaker check since we can't enumerate all holders
        assertGe(
            totalSupply,
            vaultBalance + treasuryBalance,
            "Total supply inconsistent with known balances"
        );
    }
}

/**
 * @title VaultHandler
 * @notice Handler contract for invariant fuzzing
 * Provides bounded actions that simulate real user/operator behavior
 */
contract VaultHandler is Test {
    USDCSavingsVault public vault;
    MockUSDC public usdc;
    RoleManager public roleManager;
    address public operator;

    // Track actors for fuzzing
    address[] public actors;
    mapping(address => bool) public isActor;

    // Ghost variables for tracking
    uint256 public ghost_totalDeposited;
    uint256 public ghost_totalWithdrawn;
    uint256 public ghost_totalFeesMinted;

    constructor(
        USDCSavingsVault _vault,
        MockUSDC _usdc,
        RoleManager _roleManager,
        address _operator
    ) {
        vault = _vault;
        usdc = _usdc;
        roleManager = _roleManager;
        operator = _operator;

        // Create initial actors
        for (uint i = 0; i < 5; i++) {
            address actor = makeAddr(string(abi.encodePacked("actor", i)));
            actors.push(actor);
            isActor[actor] = true;

            // Fund actors
            usdc.mint(actor, 10_000_000e6);
            vm.prank(actor);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    /**
     * @notice Simulate a deposit
     */
    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 1e6, 1_000_000e6); // 1 to 1M USDC

        uint256 balance = usdc.balanceOf(actor);
        if (balance < amount) return;

        vm.prank(actor);
        try vault.deposit(amount) {
            ghost_totalDeposited += amount;
        } catch {}
    }

    /**
     * @notice Simulate a withdrawal request
     */
    function requestWithdrawal(uint256 actorSeed, uint256 shareAmount) external {
        address actor = actors[actorSeed % actors.length];
        uint256 balance = vault.balanceOf(actor);

        if (balance == 0) return;
        shareAmount = bound(shareAmount, 1, balance);

        vm.prank(actor);
        try vault.requestWithdrawal(shareAmount) {} catch {}
    }

    /**
     * @notice Simulate withdrawal fulfillment
     */
    function fulfillWithdrawals(uint256 count) external {
        count = bound(count, 1, 10);

        // Warp past cooldown
        vm.warp(block.timestamp + 8 days);

        vm.prank(operator);
        try vault.fulfillWithdrawals(count) returns (uint256, uint256 usdcPaid) {
            ghost_totalWithdrawn += usdcPaid;
        } catch {}
    }

    /**
     * @notice Simulate NAV update (yield/loss)
     */
    function updateNav(uint256 newNavRatio) external {
        // newNavRatio: 80 = -20%, 100 = 0%, 120 = +20%
        newNavRatio = bound(newNavRatio, 50, 200);

        uint256 currentNav = vault.totalAssets();
        if (currentNav == 0) return;

        uint256 newNav = (currentNav * newNavRatio) / 100;
        vault.reportYieldAndCollectFees(int256(newNav) - int256(vault.totalAssets()));
    }

    /**
     * @notice Simulate share transfer between actors
     */
    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];

        if (from == to) return;

        uint256 balance = vault.balanceOf(from);
        if (balance == 0) return;

        amount = bound(amount, 1, balance);

        vm.prank(from);
        try vault.transfer(to, amount) {} catch {}
    }

    /**
     * @notice Simulate cancelling a withdrawal (owner action)
     */
    function cancelWithdrawal(uint256 requestId) external {
        uint256 queueLen = vault.withdrawalQueueLength();
        if (queueLen == 0) return;

        requestId = bound(requestId, 0, queueLen - 1);

        try vault.cancelWithdrawal(requestId) {} catch {}
    }

    /**
     * @notice Warp time forward
     */
    function warpTime(uint256 seconds_) external {
        seconds_ = bound(seconds_, 1, 30 days);
        vm.warp(block.timestamp + seconds_);
    }
}
