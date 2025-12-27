// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IVault
 * @notice Interface for the USDC Savings Vault
 * @dev Uses INavOracle for NAV data and IRoleManager for access control
 */
interface IVault {
    // ============ Structs ============

    struct WithdrawalRequest {
        address requester;
        uint256 shares;
        uint256 requestTimestamp;
    }

    // ============ Events ============

    event Deposit(address indexed user, uint256 usdcAmount, uint256 sharesMinted);
    event WithdrawalRequested(address indexed user, uint256 shares, uint256 requestId);
    event WithdrawalFulfilled(address indexed user, uint256 shares, uint256 usdcAmount, uint256 requestId);
    event WithdrawalCancelled(address indexed user, uint256 shares, uint256 requestId);
    event FeeCollected(uint256 feeShares, address indexed treasury);
    event FundsForwardedToMultisig(uint256 amount);
    event FundsReceivedFromMultisig(uint256 amount);
    event MultisigUpdated(address indexed oldMultisig, address indexed newMultisig);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event FeeRateUpdated(uint256 oldRate, uint256 newRate);
    event PerUserCapUpdated(uint256 oldCap, uint256 newCap);
    event GlobalCapUpdated(uint256 oldCap, uint256 newCap);
    event WithdrawalBufferUpdated(uint256 oldBuffer, uint256 newBuffer);
    event CooldownPeriodUpdated(uint256 oldPeriod, uint256 newPeriod);
    event WithdrawalForced(address indexed user, uint256 shares, uint256 usdcAmount, uint256 requestId);
    event OrphanedSharesRecovered(uint256 amount);
    event WithdrawalsPurged(uint256 count);

    // Timelock events
    event FeeRateChangeQueued(uint256 newRate, uint256 executionTime);
    event FeeRateChangeExecuted(uint256 oldRate, uint256 newRate);
    event FeeRateChangeCancelled(uint256 cancelledRate);
    event TreasuryChangeQueued(address newTreasury, uint256 executionTime);
    event TreasuryChangeExecuted(address oldTreasury, address newTreasury);
    event TreasuryChangeCancelled(address cancelledTreasury);
    event MultisigChangeQueued(address newMultisig, uint256 executionTime);
    event MultisigChangeExecuted(address oldMultisig, address newMultisig);
    event MultisigChangeCancelled(address cancelledMultisig);
    event CooldownChangeQueued(uint256 newCooldown, uint256 executionTime);
    event CooldownChangeExecuted(uint256 oldCooldown, uint256 newCooldown);
    event CooldownChangeCancelled(uint256 cancelledCooldown);

    // ============ View Functions ============

    /**
     * @notice Calculate current share price using NavOracle.totalAssets()
     * @return price Share price in USDC (18 decimal precision)
     */
    function sharePrice() external view returns (uint256);

    /**
     * @notice Get total outstanding shares
     * @return Total share supply
     */
    function totalShares() external view returns (uint256);

    /**
     * @notice Get pending withdrawal shares count
     * @return Total shares pending withdrawal
     */
    function pendingWithdrawals() external view returns (uint256);

    /**
     * @notice Get withdrawal queue length
     * @return Queue length
     */
    function withdrawalQueueLength() external view returns (uint256);

    /**
     * @notice Get withdrawal request details
     * @param requestId Request ID
     * @return Withdrawal request struct
     */
    function getWithdrawalRequest(uint256 requestId) external view returns (WithdrawalRequest memory);

    // ============ User Functions ============

    /**
     * @notice Deposit USDC and receive vault shares
     * @param usdcAmount Amount of USDC to deposit
     * @return sharesMinted Number of shares minted
     */
    function deposit(uint256 usdcAmount) external returns (uint256 sharesMinted);

    /**
     * @notice Request a withdrawal of shares
     * @param shares Number of shares to withdraw
     * @return requestId The withdrawal request ID
     */
    function requestWithdrawal(uint256 shares) external returns (uint256 requestId);

    // ============ Operator Functions ============

    /**
     * @notice Fulfill pending withdrawals from the queue (operator only)
     * @param count Maximum number of withdrawals to process
     * @return processed Number of withdrawals processed
     * @return usdcPaid Total USDC paid out
     */
    function fulfillWithdrawals(uint256 count) external returns (uint256 processed, uint256 usdcPaid);

    // ============ Multisig Functions ============

    /**
     * @notice Receive funds from multisig for withdrawal processing
     * @param amount Amount of USDC being sent
     */
    function receiveFundsFromMultisig(uint256 amount) external;

    // ============ Owner Functions ============

    /**
     * @notice Queue a multisig address change (3-day timelock)
     * @param newMultisig New multisig address
     */
    function queueMultisig(address newMultisig) external;

    /**
     * @notice Execute a queued multisig change after timelock expires
     */
    function executeMultisig() external;

    /**
     * @notice Cancel a pending multisig change
     */
    function cancelMultisig() external;

    /**
     * @notice Queue a treasury address change (2-day timelock)
     * @param newTreasury New treasury address
     */
    function queueTreasury(address newTreasury) external;

    /**
     * @notice Execute a queued treasury change after timelock expires
     */
    function executeTreasury() external;

    /**
     * @notice Cancel a pending treasury change
     */
    function cancelTreasury() external;

    /**
     * @notice Queue a fee rate change (1-day timelock)
     * @param newFeeRate New fee rate (18 decimals)
     */
    function queueFeeRate(uint256 newFeeRate) external;

    /**
     * @notice Execute a queued fee rate change after timelock expires
     */
    function executeFeeRate() external;

    /**
     * @notice Cancel a pending fee rate change
     */
    function cancelFeeRate() external;

    /**
     * @notice Update per-user deposit cap
     * @param newCap New cap (0 = unlimited)
     */
    function setPerUserCap(uint256 newCap) external;

    /**
     * @notice Update global AUM cap
     * @param newCap New cap (0 = unlimited)
     */
    function setGlobalCap(uint256 newCap) external;

    /**
     * @notice Update withdrawal buffer
     * @param newBuffer New buffer amount
     */
    function setWithdrawalBuffer(uint256 newBuffer) external;

    /**
     * @notice Queue a cooldown period change (1-day timelock)
     * @param newCooldown New cooldown in seconds
     */
    function queueCooldown(uint256 newCooldown) external;

    /**
     * @notice Execute a queued cooldown change after timelock expires
     */
    function executeCooldown() external;

    /**
     * @notice Cancel a pending cooldown change
     */
    function cancelCooldown() external;

    /**
     * @notice Force fulfill a specific withdrawal (emergency)
     * @param requestId Request ID to process
     */
    function forceProcessWithdrawal(uint256 requestId) external;

    /**
     * @notice Cancel a queued withdrawal (emergency)
     * @param requestId Request ID to cancel
     */
    function cancelWithdrawal(uint256 requestId) external;
}
