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

    // ============ Errors ============

    error OnlyOwner();
    error OnlyOwnerOrVault();
    error ZeroAddress();

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
        vault = _vault;
        emit VaultSet(_vault);
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
     */
    function reportYield(int256 yieldDelta) external onlyOwnerOrVault {
        accumulatedYield += yieldDelta;
        lastReportTime = block.timestamp;

        emit YieldReported(yieldDelta, uint256(accumulatedYield > 0 ? accumulatedYield : int256(0)), block.timestamp);
    }
}
