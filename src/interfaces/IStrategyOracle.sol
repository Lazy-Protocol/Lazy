// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IStrategyOracle
 * @notice Interface for reporting yield from off-chain strategies
 * @dev Owner or authorized vault reports yield deltas (gains/losses), not total NAV
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

    event YieldReported(int256 yieldDelta, int256 newAccumulatedYield, uint256 timestamp);
    event VaultSet(address indexed vault);
    event MaxYieldChangeUpdated(uint256 oldValue, uint256 newValue);

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

    /**
     * @notice Get the authorized vault address
     * @return Vault address that can report yield
     */
    function vault() external view returns (address);

    /**
     * @notice Get the maximum yield change percentage
     * @return Max yield change as percentage of NAV (18 decimals, default 0.1e18 = 10%)
     */
    function maxYieldChangePercent() external view returns (uint256);

    // ============ Owner Functions ============

    /**
     * @notice Report yield from strategy operations
     * @param yieldDelta Change in yield (positive for gains, negative for losses)
     * @dev Callable by owner or authorized vault
     */
    function reportYield(int256 yieldDelta) external;

    /**
     * @notice Set the authorized vault address
     * @param _vault Address of the vault that can report yield
     * @dev Only callable by owner
     */
    function setVault(address _vault) external;

    /**
     * @notice Set maximum yield change percentage
     * @param _maxPercent Max yield change as percentage of NAV (18 decimals, e.g., 0.1e18 = 10%)
     * @dev Set to 0 to disable bounds checking. Only callable by owner.
     */
    function setMaxYieldChangePercent(uint256 _maxPercent) external;
}
