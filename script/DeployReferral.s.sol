// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ReferralRegistry} from "../src/ReferralRegistry.sol";
import {FeeDistributor} from "../src/FeeDistributor.sol";

contract DeployReferral is Script {
    function run() external {
        // Load environment variables
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address owner = vm.envAddress("OWNER_ADDRESS");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address vault = vm.envAddress("VAULT_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy ReferralRegistry
        ReferralRegistry registry = new ReferralRegistry(owner);
        console.log("ReferralRegistry deployed at:", address(registry));

        // 2. Deploy FeeDistributor
        FeeDistributor distributor = new FeeDistributor(
            usdc,
            vault,
            address(registry),
            treasury,
            owner
        );
        console.log("FeeDistributor deployed at:", address(distributor));

        // 3. Set FeeDistributor as registrar on ReferralRegistry
        registry.setRegistrar(address(distributor));
        console.log("FeeDistributor set as registrar");

        vm.stopBroadcast();

        // Output for frontend config
        console.log("\n=== Frontend Config ===");
        console.log("REFERRAL_REGISTRY:", address(registry));
        console.log("FEE_DISTRIBUTOR:", address(distributor));
    }
}
