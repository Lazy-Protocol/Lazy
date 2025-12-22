// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStrategyOracle} from "./interfaces/IStrategyOracle.sol";
import {IRoleManager} from "./interfaces/IRoleManager.sol";

/// @dev Minimal interface to avoid circular dependency
interface IVaultMinimal {
    function totalAssets() external view returns (uint256);
}

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

    // H-1: Percentage-based yield bounds to prevent accidental misreporting
    // Default 10% (0.1e18). Set to 0 to disable bounds checking.
    // Yield delta cannot exceed this percentage of the vault's current NAV.
    uint256 public maxYieldChangePercent = 0.1e18;

    // C-1 Fix: Minimum interval between yield reports to prevent compounding bypass
    uint256 public constant MIN_REPORT_INTERVAL = 7 days;

    // ============ Errors ============

    error OnlyOwner();
    error OnlyOwnerOrVault();
    error ZeroAddress();
    error NotAContract();
    error YieldChangeTooLarge();
    error ReportTooSoon();

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
     * @notice Set maximum yield change percentage (H-1 safety bounds)
     * @param _maxPercent Maximum yield change as percentage of NAV (18 decimals, e.g., 0.1e18 = 10%)
     * @dev Set to 0 to disable bounds checking. Only callable by owner.
     *      Default is 10% (0.1e18). Yield deltas exceeding this % of vault NAV will revert.
     */
    function setMaxYieldChangePercent(uint256 _maxPercent) external onlyOwner {
        emit MaxYieldChangeUpdated(maxYieldChangePercent, _maxPercent);
        maxYieldChangePercent = _maxPercent;
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
     * H-1: If maxYieldChangePercent is set (default 10%), enforces bounds to prevent misreporting.
     *      Yield delta cannot exceed maxYieldChangePercent of vault's current NAV.
     *
     * C-1 Fix: Enforces MIN_REPORT_INTERVAL (7 days) between reports to prevent
     *          compounding bypass of the yield bounds.
     */
    function reportYield(int256 yieldDelta) external onlyOwnerOrVault {
        // C-1 Fix: Enforce minimum interval between reports
        if (lastReportTime > 0 && block.timestamp < lastReportTime + MIN_REPORT_INTERVAL) {
            revert ReportTooSoon();
        }

        // H-1: Check yield bounds if enabled and vault is set
        if (maxYieldChangePercent > 0 && vault != address(0)) {
            uint256 nav = IVaultMinimal(vault).totalAssets();
            // Only enforce if vault has assets (skip on first deposit or empty vault)
            if (nav > 0) {
                uint256 absoluteDelta = yieldDelta >= 0 ? uint256(yieldDelta) : uint256(-yieldDelta);
                uint256 maxAllowed = (nav * maxYieldChangePercent) / 1e18;
                if (absoluteDelta > maxAllowed) revert YieldChangeTooLarge();
            }
        }

        accumulatedYield += yieldDelta;
        lastReportTime = block.timestamp;

        emit YieldReported(yieldDelta, accumulatedYield, block.timestamp);
    }
}
