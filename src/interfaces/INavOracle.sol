// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title INavOracle
 * @notice Interface for the NAV Oracle that reports total assets
 * @dev Owner reports total assets, vault reads them
 */
interface INavOracle {
    // ============ Events ============

    event TotalAssetsReported(uint256 oldAssets, uint256 newAssets, uint256 timestamp);
    event HighWaterMarkUpdated(uint256 newHighWaterMark);

    // ============ View Functions ============

    /**
     * @notice Get the current total assets value
     * @return Total assets in USDC (6 decimals)
     */
    function totalAssets() external view returns (uint256);

    /**
     * @notice Get the high water mark for fee calculations
     * @return High water mark in USDC (6 decimals)
     */
    function highWaterMark() external view returns (uint256);

    /**
     * @notice Get the timestamp of the last report
     * @return Unix timestamp
     */
    function lastReportTime() external view returns (uint256);

    // ============ Owner Functions ============

    /**
     * @notice Report new total assets value
     * @param newTotalAssets New total assets in USDC
     */
    function reportTotalAssets(uint256 newTotalAssets) external;
}
