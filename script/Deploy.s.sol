// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LazyUSDVault} from "../src/LazyUSDVault.sol";
import {RoleManager} from "../src/RoleManager.sol";

/**
 * @title DeployScript
 * @notice Deployment script for the LazyUSD Vault system on Ethereum mainnet
 *
 * Deploys:
 * 1. RoleManager - Access control and pause management
 * 2. LazyUSDVault - Main vault contract (with internal yield tracking)
 *
 * Usage:
 * forge script script/Deploy.s.sol:DeployScript --rpc-url mainnet --broadcast --verify
 *
 * Required environment variables:
 * - PRIVATE_KEY: Deployer private key
 * - USDC_ADDRESS: Address of USDC token
 * - MULTISIG_ADDRESS: Address of multisig for strategy funds
 * - TREASURY_ADDRESS: Address of treasury for fees
 * - OWNER_ADDRESS: Address of the owner (governance)
 * - FEE_RATE: Fee rate in 18 decimals (e.g., 200000000000000000 = 20%)
 * - COOLDOWN_PERIOD: Cooldown in seconds (e.g., 86400 = 1 day)
 */
contract DeployScript is Script {
    function run() external {
        // Load configuration from environment
        address usdc = vm.envAddress("USDC_ADDRESS");
        address multisig = vm.envAddress("MULTISIG_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address owner = vm.envAddress("OWNER_ADDRESS");
        uint256 feeRate = vm.envUint("FEE_RATE");
        uint256 cooldownPeriod = vm.envUint("COOLDOWN_PERIOD");
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        console2.log("Deploying to Ethereum mainnet...");
        console2.log("USDC:", usdc);
        console2.log("Multisig:", multisig);
        console2.log("Treasury:", treasury);
        console2.log("Owner:", owner);
        console2.log("Fee Rate:", feeRate);
        console2.log("Cooldown:", cooldownPeriod);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy RoleManager
        RoleManager roleManager = new RoleManager(owner);
        console2.log("RoleManager deployed at:", address(roleManager));

        // 2. Deploy LazyUSD Vault
        LazyUSDVault vault = new LazyUSDVault(
            usdc,
            address(roleManager),
            multisig,
            treasury,
            feeRate,
            cooldownPeriod,
            "LazyUSD",
            "lazyUSD"
        );
        console2.log("LazyUSDVault deployed at:", address(vault));

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== DEPLOYMENT COMPLETE ===");
        console2.log("RoleManager:", address(roleManager));
        console2.log("LazyUSDVault:", address(vault));
    }
}
