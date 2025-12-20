// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IRoleManager
 * @notice Interface for role management and pause control
 * @dev Centralizes access control for the vault ecosystem
 */
interface IRoleManager {
    // ============ Events ============

    event OperatorUpdated(address indexed operator, bool status);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event DepositsPaused(address indexed by);
    event DepositsUnpaused(address indexed by);
    event WithdrawalsPaused(address indexed by);
    event WithdrawalsUnpaused(address indexed by);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ============ View Functions ============

    /**
     * @notice Check if the system is fully paused
     * @return True if paused
     */
    function paused() external view returns (bool);

    /**
     * @notice Check if deposits are paused
     * @return True if deposits paused
     */
    function depositsPaused() external view returns (bool);

    /**
     * @notice Check if withdrawals are paused
     * @return True if withdrawals paused
     */
    function withdrawalsPaused() external view returns (bool);

    /**
     * @notice Check if an address is an operator
     * @param account Address to check
     * @return True if operator
     */
    function isOperator(address account) external view returns (bool);

    /**
     * @notice Get the owner address
     * @return Owner address
     */
    function owner() external view returns (address);

    // ============ Operator Functions ============

    /**
     * @notice Pause all operations (operator or owner)
     */
    function pause() external;

    /**
     * @notice Pause deposits only (operator or owner)
     */
    function pauseDeposits() external;

    /**
     * @notice Pause withdrawals only (operator or owner)
     */
    function pauseWithdrawals() external;

    // ============ Owner Functions ============

    /**
     * @notice Unpause all operations (owner only)
     */
    function unpause() external;

    /**
     * @notice Unpause deposits (owner only)
     */
    function unpauseDeposits() external;

    /**
     * @notice Unpause withdrawals (owner only)
     */
    function unpauseWithdrawals() external;

    /**
     * @notice Set operator status for an address
     * @param operator Address to update
     * @param status New operator status
     */
    function setOperator(address operator, bool status) external;

    /**
     * @notice Start ownership transfer
     * @param newOwner New owner address
     */
    function transferOwnership(address newOwner) external;

    /**
     * @notice Accept ownership transfer
     */
    function acceptOwnership() external;
}
