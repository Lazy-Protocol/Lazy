// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IStrategyOracle
 * @notice Interface for reporting yield from off-chain strategies
 * @dev Owner reports yield deltas (gains/losses), not total NAV
 *
 * The vault computes totalAssets as:
 *   totalAssets = totalDeposited - totalWithdrawn + accumulatedYield
 *
 * This separation ensures:
 * - Deposits/withdrawals are tracked automatically by the vault
 * - Owner only reports yield from strategy operations
 * - Fees are only charged on actual yield, not deposits
 */
interface IStrategyOracle {
    // ============ Events ============

    event YieldReported(int256 yieldDelta, uint256 newAccumulatedYield, uint256 timestamp);

    // ============ View Functions ============

    /**
     * @notice Get the accumulated yield from strategies
     * @return Net yield in USDC (6 decimals), can be negative if losses exceed gains
     * @dev This value is added to (deposits - withdrawals) to get total NAV
     */
    function accumulatedYield() external view returns (int256);

    /**
     * @notice Get the timestamp of the last yield report
     * @return Unix timestamp
     */
    function lastReportTime() external view returns (uint256);

    // ============ Owner Functions ============

    /**
     * @notice Report yield from strategy operations
     * @param yieldDelta Change in yield (positive for gains, negative for losses)
     * @dev Only callable by owner. This triggers fee collection in the vault.
     */
    function reportYield(int256 yieldDelta) external;
}
