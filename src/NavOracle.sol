// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {INavOracle} from "./interfaces/INavOracle.sol";
import {IRoleManager} from "./interfaces/IRoleManager.sol";

/**
 * @title NavOracle
 * @notice Oracle contract for reporting total assets (NAV)
 * @dev Owner reports total assets from off-chain strategy positions
 *
 * The oracle tracks:
 * - Current total assets (authoritative source for NAV)
 * - High water mark (informational only - Vault.feeHighWaterMark is canonical for fees)
 * - Last report timestamp
 *
 * DESIGN NOTE: The highWaterMark in this contract is for informational/monitoring
 * purposes only. The canonical high-water mark for fee calculations is stored in
 * USDCSavingsVault.feeHighWaterMark. This separation ensures fee accounting authority
 * remains within the vault contract.
 */
contract NavOracle is INavOracle {
    // ============ Storage ============

    IRoleManager public immutable roleManager;

    uint256 public totalAssets;
    uint256 public highWaterMark;
    uint256 public lastReportTime;

    // ============ Errors ============

    error OnlyOwner();

    // ============ Constructor ============

    /**
     * @notice Initialize the NavOracle
     * @param _roleManager Address of the RoleManager contract
     */
    constructor(address _roleManager) {
        require(_roleManager != address(0), "Zero address");
        roleManager = IRoleManager(_roleManager);
    }

    // ============ Modifiers ============

    modifier onlyOwner() {
        if (msg.sender != roleManager.owner()) revert OnlyOwner();
        _;
    }

    // ============ Owner Functions ============

    /**
     * @notice Report new total assets value
     * @param newTotalAssets New total assets in USDC (6 decimals)
     * @dev Only callable by owner. Updates high water mark if new value exceeds it.
     */
    function reportTotalAssets(uint256 newTotalAssets) external onlyOwner {
        uint256 oldAssets = totalAssets;

        totalAssets = newTotalAssets;
        lastReportTime = block.timestamp;

        // Update high water mark if we've exceeded it
        if (newTotalAssets > highWaterMark) {
            highWaterMark = newTotalAssets;
            emit HighWaterMarkUpdated(newTotalAssets);
        }

        emit TotalAssetsReported(oldAssets, newTotalAssets, block.timestamp);
    }
}
