// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {USDCSavingsVault} from "../src/USDCSavingsVault.sol";
import {RoleManager} from "../src/RoleManager.sol";

/**
 * @title DeployScript
 * @notice Deployment script for the USDC Savings Vault system
 *
 * Deploys:
 * 1. RoleManager - Access control and pause management
 * 2. USDCSavingsVault - Main vault contract (with internal yield tracking)
 *
 * Usage:
 * forge script script/Deploy.s.sol:DeployScript --rpc-url <RPC_URL> --broadcast --verify
 *
 * Required environment variables:
 * - USDC_ADDRESS: Address of USDC token
 * - MULTISIG_ADDRESS: Address of multisig for strategy funds
 * - TREASURY_ADDRESS: Address of treasury for fees
 * - OWNER_ADDRESS: Address of the owner (governance)
 * - FEE_RATE: Fee rate in 18 decimals (e.g., 0.2e18 = 20%)
 * - COOLDOWN_PERIOD: Cooldown in seconds (e.g., 604800 = 7 days)
 */
contract DeployScript {
    struct DeployedContracts {
        RoleManager roleManager;
        USDCSavingsVault vault;
    }

    function run() external returns (DeployedContracts memory deployed) {
        // Load configuration from environment
        address usdc = vm.envAddress("USDC_ADDRESS");
        address multisig = vm.envAddress("MULTISIG_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address owner = vm.envAddress("OWNER_ADDRESS");
        uint256 feeRate = vm.envUint("FEE_RATE");
        uint256 cooldownPeriod = vm.envUint("COOLDOWN_PERIOD");

        vm.startBroadcast();

        // 1. Deploy RoleManager
        deployed.roleManager = new RoleManager(owner);

        // 2. Deploy Vault (yield tracking is now internal)
        deployed.vault = new USDCSavingsVault(
            usdc,
            address(deployed.roleManager),
            multisig,
            treasury,
            feeRate,
            cooldownPeriod,
            "USDC Savings Vault Share",
            "svUSDC"
        );

        vm.stopBroadcast();

        return deployed;
    }

    // Forge VM interface for environment variables
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}

interface Vm {
    function envAddress(string calldata key) external view returns (address);
    function envUint(string calldata key) external view returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
}
