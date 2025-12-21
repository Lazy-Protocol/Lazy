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
    event PriceHWMUpdated(uint256 oldHWM, uint256 newHWM);
    event WithdrawalForced(address indexed user, uint256 shares, uint256 usdcAmount, uint256 requestId);
    event OrphanedSharesRecovered(uint256 amount);

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

    /**
     * @notice Get user's cumulative deposits
     * @param user User address
     * @return Total deposited
     */
    function userTotalDeposited(address user) external view returns (uint256);

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
     * @notice Update multisig address
     * @param newMultisig New multisig address
     */
    function setMultisig(address newMultisig) external;

    /**
     * @notice Update treasury address
     * @param newTreasury New treasury address
     */
    function setTreasury(address newTreasury) external;

    /**
     * @notice Update fee rate
     * @param newFeeRate New fee rate (18 decimals)
     */
    function setFeeRate(uint256 newFeeRate) external;

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
     * @notice Update cooldown period
     * @param newCooldown New cooldown in seconds
     */
    function setCooldownPeriod(uint256 newCooldown) external;

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
