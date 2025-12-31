// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IVault
 * @notice Interface for the USDC Savings Vault
 * @dev Uses internal yield tracking and IRoleManager for access control
 */
interface IVault {
    // ============ Structs ============

    /// @notice Represents a pending withdrawal request in the queue
    /// @dev Stored in append-only array; processed entries have shares=0
    struct WithdrawalRequest {
        /// @notice Address that requested the withdrawal
        address requester;
        /// @notice Number of shares to be burned upon fulfillment
        uint256 shares;
        /// @notice Block timestamp when request was created (for cooldown)
        uint256 requestTimestamp;
    }

    // ============ Events ============

    /// @notice Emitted when a user deposits USDC and receives shares
    /// @param user Address of the depositor
    /// @param usdcAmount Amount of USDC deposited (6 decimals)
    /// @param sharesMinted Number of shares minted to user (18 decimals)
    event Deposit(address indexed user, uint256 usdcAmount, uint256 sharesMinted);
    /// @notice Emitted when a user requests a withdrawal
    /// @param user Address requesting withdrawal
    /// @param shares Number of shares escrowed for withdrawal
    /// @param requestId Index in the withdrawal queue
    event WithdrawalRequested(address indexed user, uint256 shares, uint256 requestId);
    /// @notice Emitted when a withdrawal is fulfilled
    /// @param user Address receiving USDC
    /// @param shares Number of shares burned
    /// @param usdcAmount Amount of USDC paid out
    /// @param requestId Index in the withdrawal queue
    event WithdrawalFulfilled(address indexed user, uint256 shares, uint256 usdcAmount, uint256 requestId);
    /// @notice Emitted when a withdrawal request is cancelled
    /// @param user Address whose withdrawal was cancelled
    /// @param shares Number of shares returned from escrow
    /// @param requestId Index in the withdrawal queue
    event WithdrawalCancelled(address indexed user, uint256 shares, uint256 requestId);
    /// @notice Emitted when protocol fees are collected
    /// @param feeShares Number of shares minted as fee
    /// @param treasury Address receiving the fee shares
    event FeeCollected(uint256 feeShares, address indexed treasury);
    /// @notice Emitted when excess USDC is forwarded to multisig
    /// @param amount Amount of USDC transferred
    event FundsForwardedToMultisig(uint256 amount);
    /// @notice Emitted when multisig returns USDC for withdrawals
    /// @param amount Amount of USDC received
    event FundsReceivedFromMultisig(uint256 amount);
    /// @notice Emitted when multisig address is updated
    event MultisigUpdated(address indexed oldMultisig, address indexed newMultisig);
    /// @notice Emitted when treasury address is updated
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    /// @notice Emitted when fee rate is updated
    event FeeRateUpdated(uint256 oldRate, uint256 newRate);
    /// @notice Emitted when per-user cap is updated
    event PerUserCapUpdated(uint256 oldCap, uint256 newCap);
    /// @notice Emitted when global cap is updated
    event GlobalCapUpdated(uint256 oldCap, uint256 newCap);
    /// @notice Emitted when withdrawal buffer is updated
    event WithdrawalBufferUpdated(uint256 oldBuffer, uint256 newBuffer);
    /// @notice Emitted when cooldown period is updated
    event CooldownPeriodUpdated(uint256 oldPeriod, uint256 newPeriod);
    /// @notice Emitted when a withdrawal is force-processed (emergency)
    event WithdrawalForced(address indexed user, uint256 shares, uint256 usdcAmount, uint256 requestId);
    /// @notice Emitted when orphaned shares are recovered from vault
    event OrphanedSharesRecovered(uint256 amount);
    /// @notice Emitted when processed withdrawal entries are purged
    event WithdrawalsPurged(uint256 count);

    // Timelock events
    /// @notice Emitted when a fee rate change is queued
    event FeeRateChangeQueued(uint256 newRate, uint256 executionTime);
    /// @notice Emitted when a queued fee rate change is executed
    event FeeRateChangeExecuted(uint256 oldRate, uint256 newRate);
    /// @notice Emitted when a queued fee rate change is cancelled
    event FeeRateChangeCancelled(uint256 cancelledRate);
    /// @notice Emitted when a treasury change is queued
    event TreasuryChangeQueued(address newTreasury, uint256 executionTime);
    /// @notice Emitted when a queued treasury change is executed
    event TreasuryChangeExecuted(address oldTreasury, address newTreasury);
    /// @notice Emitted when a queued treasury change is cancelled
    event TreasuryChangeCancelled(address cancelledTreasury);
    /// @notice Emitted when a multisig change is queued
    event MultisigChangeQueued(address newMultisig, uint256 executionTime);
    /// @notice Emitted when a queued multisig change is executed
    event MultisigChangeExecuted(address oldMultisig, address newMultisig);
    /// @notice Emitted when a queued multisig change is cancelled
    event MultisigChangeCancelled(address cancelledMultisig);
    /// @notice Emitted when a cooldown change is queued
    event CooldownChangeQueued(uint256 newCooldown, uint256 executionTime);
    /// @notice Emitted when a queued cooldown change is executed
    event CooldownChangeExecuted(uint256 oldCooldown, uint256 newCooldown);
    /// @notice Emitted when a queued cooldown change is cancelled
    event CooldownChangeCancelled(uint256 cancelledCooldown);

    // Yield tracking events
    /// @notice Emitted when yield is reported
    /// @param yieldDelta Change in yield (positive or negative)
    /// @param newAccumulatedYield Updated cumulative yield
    /// @param timestamp Block timestamp of the report
    event YieldReported(int256 yieldDelta, int256 newAccumulatedYield, uint256 timestamp);
    /// @notice Emitted when max yield change percentage is updated
    /// @param oldValue Previous max percentage
    /// @param newValue New max percentage
    event MaxYieldChangeUpdated(uint256 oldValue, uint256 newValue);

    // ============ View Functions ============

    /**
     * @notice Calculate current share price
     * @return price Share price in USDC (18 decimal precision)
     */
    function sharePrice() external view returns (uint256);

    /**
     * @notice Get total outstanding shares
     * @return Total share supply
     */
    function totalShares() external view returns (uint256);

    /**
     * @notice Get accumulated yield from strategies
     * @return Net yield in USDC (6 decimals), can be negative
     */
    function accumulatedYield() external view returns (int256);

    /**
     * @notice Get timestamp of last yield report
     * @return Unix timestamp
     */
    function lastYieldReportTime() external view returns (uint256);

    /**
     * @notice Get maximum yield change percentage
     * @return Max percentage (18 decimals)
     */
    function maxYieldChangePercent() external view returns (uint256);

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

    /**
     * @notice Report yield and collect fees atomically
     * @param yieldDelta Change in yield (positive for gains, negative for losses)
     */
    function reportYieldAndCollectFees(int256 yieldDelta) external;

    /**
     * @notice Set maximum yield change percentage (safety bounds)
     * @param _maxPercent Maximum yield change as percentage of NAV (18 decimals)
     */
    function setMaxYieldChangePercent(uint256 _maxPercent) external;
}
