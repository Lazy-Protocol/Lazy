// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

/**
 * @title VaultShare
 * @notice ERC20 token representing shares in the USDC Savings Vault
 * @dev Only the vault can mint and burn shares
 */
contract VaultShare is IERC20 {
    // ============ Storage ============

    string public constant name = "USDC Savings Vault Share";
    string public constant symbol = "svUSDC";
    uint8 public constant decimals = 18; // Standard ERC20 decimals

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public immutable vault;

    // ============ Errors ============

    error OnlyVault();
    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();

    // ============ Modifiers ============

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    // ============ Constructor ============

    constructor(address _vault) {
        if (_vault == address(0)) revert ZeroAddress();
        vault = _vault;
    }

    // ============ External Functions ============

    /**
     * @notice Transfer tokens to a recipient
     * @param to Recipient address
     * @param amount Amount to transfer
     * @return success True if transfer succeeded
     */
    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    /**
     * @notice Approve spender to transfer tokens on behalf of the caller
     * @param spender Address to approve
     * @param amount Amount to approve
     * @return success True if approval succeeded
     */
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /**
     * @notice Transfer tokens from one address to another
     * @param from Source address
     * @param to Destination address
     * @param amount Amount to transfer
     * @return success True if transfer succeeded
     * @dev Vault can transfer without allowance (for escrow operations)
     */
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        // Vault can transfer without allowance (trusted for escrow)
        if (msg.sender != vault) {
            uint256 currentAllowance = allowance[from][msg.sender];
            if (currentAllowance != type(uint256).max) {
                if (currentAllowance < amount) revert InsufficientAllowance();
                unchecked {
                    allowance[from][msg.sender] = currentAllowance - amount;
                }
            }
        }
        return _transfer(from, to, amount);
    }

    /**
     * @notice Mint new shares to an address (only callable by vault)
     * @param to Address to mint to
     * @param amount Amount to mint
     */
    function mint(address to, uint256 amount) external onlyVault {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /**
     * @notice Burn shares from an address (only callable by vault)
     * @param from Address to burn from
     * @param amount Amount to burn
     */
    function burn(address from, uint256 amount) external onlyVault {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] -= amount;
        }
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    // ============ Internal Functions ============

    function _transfer(address from, address to, uint256 amount) internal returns (bool) {
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
