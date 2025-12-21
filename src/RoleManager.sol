// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRoleManager} from "./interfaces/IRoleManager.sol";

/**
 * @title RoleManager
 * @notice Centralized role management and pause control for the vault ecosystem
 * @dev Manages Owner, Operator roles and pause states
 *
 * Role hierarchy:
 * - Owner: Full governance control, can unpause, set operators, transfer ownership
 * - Operator: Day-to-day operations, can pause (not unpause), fulfill withdrawals
 */
contract RoleManager is IRoleManager {
    // ============ Storage ============

    address public owner;
    address public pendingOwner;

    mapping(address => bool) public operators;

    bool public paused;
    bool public depositsPaused;
    bool public withdrawalsPaused;

    // ============ Errors ============

    error OnlyOwner();
    error OnlyOperator();
    error ZeroAddress();
    error NotPendingOwner();

    // ============ Constructor ============

    /**
     * @notice Initialize the RoleManager
     * @param _owner Initial owner address
     */
    constructor(address _owner) {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;

        // Owner is also an operator by default
        operators[_owner] = true;
        emit OperatorUpdated(_owner, true);
    }

    // ============ Modifiers ============

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender] && msg.sender != owner) revert OnlyOperator();
        _;
    }

    // ============ View Functions ============

    /**
     * @notice Check if an address is an operator
     * @param account Address to check
     * @return True if operator
     */
    function isOperator(address account) external view returns (bool) {
        return operators[account] || account == owner;
    }

    // ============ Operator Functions ============

    /**
     * @notice Pause all operations
     * @dev Callable by operator or owner for fast response
     */
    function pause() external onlyOperator {
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Pause deposits only
     * @dev Callable by operator or owner
     */
    function pauseDeposits() external onlyOperator {
        depositsPaused = true;
        emit DepositsPaused(msg.sender);
    }

    /**
     * @notice Pause withdrawals only
     * @dev Callable by operator or owner
     */
    function pauseWithdrawals() external onlyOperator {
        withdrawalsPaused = true;
        emit WithdrawalsPaused(msg.sender);
    }

    // ============ Owner Functions ============

    /**
     * @notice Unpause all operations
     * @dev Only owner can unpause to prevent operator abuse
     */
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Unpause deposits
     * @dev Only owner can unpause
     */
    function unpauseDeposits() external onlyOwner {
        depositsPaused = false;
        emit DepositsUnpaused(msg.sender);
    }

    /**
     * @notice Unpause withdrawals
     * @dev Only owner can unpause
     */
    function unpauseWithdrawals() external onlyOwner {
        withdrawalsPaused = false;
        emit WithdrawalsUnpaused(msg.sender);
    }

    /**
     * @notice Set operator status for an address
     * @param operator Address to update
     * @param status New operator status
     */
    function setOperator(address operator, bool status) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        operators[operator] = status;
        emit OperatorUpdated(operator, status);
    }

    /**
     * @notice Start two-step ownership transfer
     * @param newOwner Address of the new owner
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /**
     * @notice Accept ownership transfer
     * @dev Must be called by the pending owner
     * @dev Automatically revokes old owner's explicit operator status for security
     */
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();

        address oldOwner = owner;

        // Revoke old owner's explicit operator status (security: prevents lingering access)
        if (operators[oldOwner]) {
            operators[oldOwner] = false;
            emit OperatorUpdated(oldOwner, false);
        }

        emit OwnershipTransferred(oldOwner, msg.sender);

        owner = msg.sender;
        pendingOwner = address(0);
    }
}
