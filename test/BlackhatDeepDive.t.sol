// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {USDCSavingsVault} from "../src/USDCSavingsVault.sol";
import {VaultShare} from "../src/VaultShare.sol";
import {RoleManager} from "../src/RoleManager.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/**
 * @title BlackhatDeepDive
 * @notice Deep investigation of potential vulnerabilities
 */
contract BlackhatDeepDive is Test {
    USDCSavingsVault public vault;
    VaultShare public shares;
    RoleManager public roleManager;
    MockUSDC public usdc;

    address public owner = address(this);
    address public multisig = makeAddr("multisig");
    address public treasury = makeAddr("treasury");
    address public operator = makeAddr("operator");

    address public attacker = makeAddr("attacker");
    address public victim = makeAddr("victim");

    uint256 public constant FEE_RATE = 0.2e18;
    uint256 public constant COOLDOWN = 1 days;

    function setUp() public {
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
        shares = vault.shares();
        roleManager.setOperator(operator, true);
        vault.setMaxYieldChangePercent(0);
        vault.setWithdrawalBuffer(type(uint256).max);

        usdc.mint(attacker, 100_000_000e6);
        usdc.mint(victim, 100_000_000e6);
        usdc.mint(multisig, 100_000_000e6);

        vm.prank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(victim);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(multisig);
        usdc.approve(address(vault), type(uint256).max);
    }

    /**
     * @notice DEEP DIVE: Is sandwich attack actually profitable vs just holding?
     * @dev Compare: Attacker who sandwiches vs Attacker who was already holding
     */
    function test_DEEPDIVE_SandwichVsHolding() public {
        console2.log("=== DEEP DIVE: Sandwich vs Holding Comparison ===");
        console2.log("");

        // Scenario A: Victim deposits, then YIELD, then attacker deposits (no sandwich)
        // Scenario B: Victim deposits, attacker FRONT-RUNS yield, then yield

        // ========== SCENARIO A: Attacker deposits AFTER yield (baseline) ==========
        console2.log("--- Scenario A: Attacker deposits AFTER yield ---");

        vm.prank(victim);
        vault.deposit(1_000_000e6);
        console2.log("Victim deposited 1M");

        // Yield reported
        vm.warp(block.timestamp + 1 days);
        vault.reportYieldAndCollectFees(200_000e6);
        console2.log("Yield of 200k reported");

        // Now attacker deposits at NEW (higher) price
        uint256 priceAfterYield = vault.sharePrice();
        console2.log("Price after yield:", priceAfterYield);

        vm.prank(attacker);
        uint256 attackerSharesA = vault.deposit(1_000_000e6);
        console2.log("Attacker shares (Scenario A):", attackerSharesA);

        uint256 attackerValueA = vault.sharesToUsdc(attackerSharesA);
        console2.log("Attacker value immediately:", attackerValueA);
        console2.log("");

        // ========== RESET FOR SCENARIO B ==========
        // Redeploy fresh
        usdc = new MockUSDC();
        roleManager = new RoleManager(owner);
        vault = new USDCSavingsVault(
            address(usdc), address(roleManager),
            multisig, treasury, FEE_RATE, COOLDOWN, "USDC Savings Vault Share", "svUSDC"
        );
        shares = vault.shares();
        roleManager.setOperator(operator, true);
        vault.setMaxYieldChangePercent(0);
        vault.setWithdrawalBuffer(type(uint256).max);
        usdc.mint(attacker, 100_000_000e6);
        usdc.mint(victim, 100_000_000e6);
        vm.prank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(victim);
        usdc.approve(address(vault), type(uint256).max);

        // ========== SCENARIO B: Attacker FRONT-RUNS yield (sandwich) ==========
        console2.log("--- Scenario B: Attacker FRONT-RUNS yield (sandwich) ---");

        vm.prank(victim);
        vault.deposit(1_000_000e6);
        console2.log("Victim deposited 1M");

        // Attacker front-runs the yield report
        vm.prank(attacker);
        uint256 attackerSharesB = vault.deposit(1_000_000e6);
        console2.log("Attacker front-runs with 1M");
        console2.log("Attacker shares (Scenario B):", attackerSharesB);

        // Yield reported AFTER attacker deposit
        vm.warp(block.timestamp + 1 days);
        vault.reportYieldAndCollectFees(200_000e6);
        console2.log("Yield of 200k reported");

        uint256 attackerValueB = vault.sharesToUsdc(attackerSharesB);
        console2.log("Attacker value after yield:", attackerValueB);
        console2.log("");

        // ========== COMPARISON ==========
        console2.log("=== COMPARISON ===");
        console2.log("Scenario A (no sandwich): Attacker value =", attackerValueA);
        console2.log("Scenario B (sandwich):    Attacker value =", attackerValueB);

        if (attackerValueB > attackerValueA) {
            uint256 advantage = attackerValueB - attackerValueA;
            console2.log("Sandwich ADVANTAGE:", advantage);
            console2.log("");
            console2.log("VULNERABILITY CONFIRMED: Front-running yield is profitable");
        } else {
            console2.log("No sandwich advantage detected");
        }
    }

    /**
     * @notice DEEP DIVE: Can owner front-run deposits with yield to extract value?
     * @dev This is the H-1 finding
     */
    function test_DEEPDIVE_OwnerFrontRunsDeposit() public {
        console2.log("=== DEEP DIVE: Owner Front-Runs User Deposit ===");
        console2.log("");

        // Initial state: Vault has some deposits
        vm.prank(victim);
        vault.deposit(1_000_000e6);
        console2.log("Initial victim deposit: 1M");

        uint256 priceBefore = vault.sharePrice();
        console2.log("Price before owner action:", priceBefore);

        // Owner sees user's deposit TX in mempool (1M USDC)
        // Owner front-runs with positive yield report

        vm.warp(block.timestamp + 1 days);
        vault.reportYieldAndCollectFees(100_000e6); // 10% yield
        console2.log("Owner reports 100k yield BEFORE user deposit");

        uint256 priceAfterYield = vault.sharePrice();
        console2.log("Price after yield:", priceAfterYield);

        // Now user's deposit executes at INFLATED price
        address newUser = makeAddr("newUser");
        usdc.mint(newUser, 1_000_000e6);
        vm.startPrank(newUser);
        usdc.approve(address(vault), type(uint256).max);
        uint256 newUserShares = vault.deposit(1_000_000e6);
        vm.stopPrank();

        console2.log("New user deposited 1M, got shares:", newUserShares);

        // Fair shares at original price would be 1M
        uint256 fairShares = 1_000_000e18;
        console2.log("Fair shares (no frontrun):", fairShares);

        if (newUserShares < fairShares) {
            uint256 lostShares = fairShares - newUserShares;
            uint256 lostValue = vault.sharesToUsdc(lostShares);
            console2.log("");
            console2.log("VULNERABILITY: User lost shares to front-run!");
            console2.log("Lost shares:", lostShares);
            console2.log("Lost value in USDC:", lostValue);

            // Where did this value go?
            uint256 victimValue = vault.sharesToUsdc(shares.balanceOf(victim));
            console2.log("");
            console2.log("Original victim value:", victimValue);
            console2.log("(They benefited from yield before new deposit)");
        }
    }

    /**
     * @notice DEEP DIVE: Negative yield front-run (owner buys cheap)
     */
    function test_DEEPDIVE_NegativeYieldFrontRun() public {
        console2.log("=== DEEP DIVE: Owner Buys Cheap via Negative Yield ===");
        console2.log("");

        // Initial deposits
        vm.prank(victim);
        vault.deposit(1_000_000e6);

        uint256 priceBefore = vault.sharePrice();
        console2.log("Initial price:", priceBefore);

        // Owner reports NEGATIVE yield (deflates price)
        vm.warp(block.timestamp + 1 days);
        vault.reportYieldAndCollectFees(-200_000e6); // -20% loss

        uint256 priceAfterLoss = vault.sharePrice();
        console2.log("Price after loss:", priceAfterLoss);

        // Owner deposits at deflated price
        usdc.mint(owner, 1_000_000e6);
        usdc.approve(address(vault), type(uint256).max);
        uint256 ownerShares = vault.deposit(1_000_000e6);
        console2.log("Owner deposited 1M, got shares:", ownerShares);

        // Wait and report positive yield to restore price
        vm.warp(block.timestamp + 1 days);
        vault.reportYieldAndCollectFees(400_000e6); // +40% to compensate

        uint256 priceAfterRestore = vault.sharePrice();
        console2.log("Price after restore:", priceAfterRestore);

        uint256 ownerValue = vault.sharesToUsdc(ownerShares);
        console2.log("Owner value now:", ownerValue);

        if (ownerValue > 1_100_000e6) {
            console2.log("");
            console2.log("VULNERABILITY: Owner profited from yield manipulation!");
            console2.log("Profit:", ownerValue - 1_000_000e6);
        }
    }

    /**
     * @notice DEEP DIVE: Time-based yield report constraints
     */
    function test_DEEPDIVE_MinReportInterval() public {
        console2.log("=== DEEP DIVE: MIN_REPORT_INTERVAL Effectiveness ===");
        console2.log("");

        vm.prank(victim);
        vault.deposit(1_000_000e6);

        // Report yield
        vault.reportYieldAndCollectFees(100_000e6);
        console2.log("First yield report succeeded");

        // Try immediate second report (should fail)
        try vault.reportYieldAndCollectFees(100_000e6) {
            console2.log("VULNERABILITY: Second immediate report succeeded!");
        } catch {
            console2.log("Second immediate report BLOCKED (ReportTooSoon)");
        }

        // Wait and try again
        vm.warp(block.timestamp + 1 days);
        vault.reportYieldAndCollectFees(100_000e6);
        console2.log("Report after 1 day succeeded");

        console2.log("");
        console2.log("MIN_REPORT_INTERVAL prevents rapid yield manipulation");
    }
}
