// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStrategyOracle} from "./interfaces/IStrategyOracle.sol";
import {IRoleManager} from "./interfaces/IRoleManager.sol";

/**
 * @title StrategyOracle
 * @notice Oracle contract for reporting yield from off-chain strategies
 * @dev Owner or authorized vault reports yield deltas, vault uses this to compute total NAV
 *
 * Architecture:
 * - Vault tracks deposits/withdrawals automatically
 * - This oracle ONLY tracks yield from strategy operations
 * - totalAssets (in vault) = deposits - withdrawals + accumulatedYield
 *
 * This design ensures:
 * - No manual NAV updates needed after deposits/withdrawals
 * - Fees are only charged on actual yield
 * - Clear separation between principal and yield
 */
contract StrategyOracle is IStrategyOracle {
    // ============ Storage ============

    IRoleManager public immutable roleManager;

    int256 public accumulatedYield;
    uint256 public lastReportTime;
    address public vault;

    // H-1: Optional yield bounds to prevent accidental misreporting
    // If set to 0, no bounds are enforced (default for backward compatibility)
    uint256 public maxYieldChangePerReport;

    // ============ Errors ============

    error OnlyOwner();
    error OnlyOwnerOrVault();
    error ZeroAddress();
    error NotAContract();
    error YieldChangeTooLarge();

    // ============ Constructor ============

    /**
     * @notice Initialize the StrategyOracle
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

    modifier onlyOwnerOrVault() {
        if (msg.sender != roleManager.owner() && msg.sender != vault) revert OnlyOwnerOrVault();
        _;
    }

    // ============ Owner Functions ============

    /**
     * @notice Set the authorized vault address
     * @param _vault Address of the vault that can report yield
     * @dev Only callable by owner. The vault can then call reportYield
     *      to atomically report yield and collect fees.
     */
    function setVault(address _vault) external onlyOwner {
        if (_vault == address(0)) revert ZeroAddress();
        if (_vault.code.length == 0) revert NotAContract();
        vault = _vault;
        emit VaultSet(_vault);
    }

    /**
     * @notice Set maximum yield change per report (H-1 safety bounds)
     * @param _maxChange Maximum absolute yield change allowed per report (in USDC, 6 decimals)
     * @dev Set to 0 to disable bounds checking. Only callable by owner.
     *      Recommended: Set to expected max daily yield * safety factor
     */
    function setMaxYieldChange(uint256 _maxChange) external onlyOwner {
        emit MaxYieldChangeUpdated(maxYieldChangePerReport, _maxChange);
        maxYieldChangePerReport = _maxChange;
    }

    /**
     * @notice Report yield from strategy operations
     * @param yieldDelta Change in yield (positive for gains, negative for losses)
     * @dev Callable by owner or authorized vault.
     *
     * Examples:
     * - Strategy earned 1000 USDC: reportYield(1000e6)
     * - Strategy lost 500 USDC: reportYield(-500e6)
     *
     * When called by the vault via reportYieldAndCollectFees(), fees are
     * collected atomically in the same transaction.
     *
     * H-1: If maxYieldChangePerReport is set, enforces bounds to prevent misreporting.
     */
    function reportYield(int256 yieldDelta) external onlyOwnerOrVault {
        // H-1: Check yield bounds if enabled
        if (maxYieldChangePerReport > 0) {
            uint256 absoluteDelta = yieldDelta >= 0 ? uint256(yieldDelta) : uint256(-yieldDelta);
            if (absoluteDelta > maxYieldChangePerReport) revert YieldChangeTooLarge();
        }

        accumulatedYield += yieldDelta;
        lastReportTime = block.timestamp;

        emit YieldReported(yieldDelta, accumulatedYield, block.timestamp);
    }
}
