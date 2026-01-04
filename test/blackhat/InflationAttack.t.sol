// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {LazyUSDVault} from "../../src/LazyUSDVault.sol";
import {RoleManager} from "../../src/RoleManager.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * @title BlackhatInflationAttack
 * @notice Attempts classic ERC4626 first-depositor inflation attack
 */
contract BlackhatInflationAttack is Test {
    LazyUSDVault vault;
    RoleManager roleManager;
    MockUSDC usdc;

    address attacker = makeAddr("attacker");
    address victim = makeAddr("victim");

    function setUp() public {
        usdc = new MockUSDC();
        roleManager = new RoleManager(address(this));
        vault = new LazyUSDVault(
            address(usdc),
            address(roleManager),
            makeAddr("multisig"),
            makeAddr("treasury"),
            0.2e18,
            1 days,
            "Test Vault",
            "TV"
        );
        vault.setWithdrawalBuffer(type(uint256).max);

        usdc.mint(attacker, 1000e6);
        usdc.mint(victim, 100e6);
    }

    function test_EXPLOIT_InflationAttack() public {
        console2.log("=== INFLATION ATTACK ATTEMPT ===");
        console2.log("");

        // Step 1: Attacker deposits minimal amount
        vm.startPrank(attacker);
        usdc.approve(address(vault), type(uint256).max);
        uint256 attackerShares = vault.deposit(1); // 1 wei USDC
        console2.log("Step 1: Attacker deposited 1 wei USDC");
        console2.log("  Attacker shares:", attackerShares);
        vm.stopPrank();

        // Step 2: Attacker donates USDC directly to inflate price
        vm.prank(attacker);
        usdc.transfer(address(vault), 100e6); // Donate 100 USDC
        console2.log("");
        console2.log("Step 2: Attacker donated 100 USDC directly");

        // Check if price inflated
        uint256 priceAfterDonation = vault.sharePrice();
        uint256 navAfterDonation = vault.totalAssets();
        uint256 vaultBalance = usdc.balanceOf(address(vault));
        console2.log("  Share price:", priceAfterDonation);
        console2.log("  Total assets (NAV):", navAfterDonation);
        console2.log("  Actual USDC balance:", vaultBalance);

        // Step 3: Victim deposits
        console2.log("");
        console2.log("Step 3: Victim deposits 99 USDC");
        vm.startPrank(victim);
        usdc.approve(address(vault), type(uint256).max);
        uint256 victimShares = vault.deposit(99e6);
        console2.log("  Victim shares:", victimShares);
        vm.stopPrank();

        // Calculate victim's value
        uint256 victimValue = vault.sharesToUsdc(victimShares);

        // Final analysis
        console2.log("");
        console2.log("=== ATTACK ANALYSIS ===");
        console2.log("Attacker shares:", attackerShares);
        console2.log("Victim shares:", victimShares);
        console2.log("Victim deposited: 99,000,000 (99 USDC)");
        console2.log("Victim share value:", victimValue);

        console2.log("");
        if (victimShares == 0) {
            console2.log("CRITICAL: Victim got ZERO shares!");
            console2.log("EXPLOIT STATUS: SUCCESS");
        } else if (victimValue < 90e6) {
            console2.log("Victim lost significant value!");
            console2.log("EXPLOIT STATUS: PARTIAL SUCCESS");
        } else {
            console2.log("Victim received fair value");
            console2.log("EXPLOIT STATUS: FAILED");
            console2.log("");
            console2.log("ROOT CAUSE: NAV uses internal accounting");
            console2.log("Direct USDC donations do NOT affect share price");
        }

        // Assertions
        assertGt(victimShares, 0, "Victim should get shares");
        assertGe(victimValue, 98e6, "Victim should get ~99 USDC value");
    }
}
