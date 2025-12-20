// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IVault} from "./interfaces/IVault.sol";
import {INavOracle} from "./interfaces/INavOracle.sol";
import {IRoleManager} from "./interfaces/IRoleManager.sol";
import {VaultShare} from "./VaultShare.sol";

/**
 * @title USDCSavingsVault
 * @notice A USDC-denominated savings vault with share-based NAV model
 * @dev Uses external INavOracle for NAV data and IRoleManager for access control
 *
 * Architecture:
 * - INavOracle.totalAssets(): Source of truth for NAV
 * - IRoleManager.paused(): Controls pause state
 * - IRoleManager.isOperator(): Controls operator access
 *
 * Key features:
 * - Share-based accounting (1 USDC = 1 share initially)
 * - Async withdrawal queue with FIFO processing
 * - Protocol fees only on positive yield
 * - Operator-only withdrawal fulfillment
 */
contract USDCSavingsVault is IVault {
    // ============ Constants ============

    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_FEE_RATE = 0.5e18; // 50% max fee
    uint256 public constant MIN_COOLDOWN = 1 days;
    uint256 public constant MAX_COOLDOWN = 30 days;

    // ============ Immutables ============

    IERC20 public immutable usdc;
    VaultShare public immutable shares;
    INavOracle public immutable navOracle;
    IRoleManager public immutable roleManager;

    // ============ State ============

    // Addresses
    address public multisig;
    address public treasury;

    // Configuration
    uint256 public feeRate; // Fee rate on profits (18 decimals, e.g., 0.2e18 = 20%)
    uint256 public perUserCap; // Max deposit per user (0 = unlimited)
    uint256 public globalCap; // Max total AUM (0 = unlimited)
    uint256 public withdrawalBuffer; // USDC to retain for withdrawals
    uint256 public cooldownPeriod; // Minimum time before withdrawal fulfillment

    // Fee tracking
    uint256 public lastFeeHighWaterMark; // Local high water mark for fee calculation
    uint256 public accruedFees; // Fees owed to treasury (not yet collected)

    // User tracking
    mapping(address => uint256) public userTotalDeposited; // Cumulative deposits (for cap enforcement)

    // Withdrawal queue
    WithdrawalRequest[] public withdrawalQueue;
    uint256 public withdrawalQueueHead; // Index of next request to process
    uint256 public pendingWithdrawalShares; // Total shares in queue

    // ============ Errors ============

    error OnlyOwner();
    error OnlyOperator();
    error OnlyMultisig();
    error ZeroAddress();
    error ZeroAmount();
    error Paused();
    error DepositsPaused();
    error WithdrawalsPaused();
    error ExceedsUserCap();
    error ExceedsGlobalCap();
    error InsufficientShares();
    error InsufficientLiquidity();
    error InvalidFeeRate();
    error InvalidCooldown();
    error InvalidRequestId();
    error RequestAlreadyProcessed();
    error TransferFailed();

    // ============ Modifiers ============

    modifier onlyOwner() {
        if (msg.sender != roleManager.owner()) revert OnlyOwner();
        _;
    }

    modifier onlyOperator() {
        if (!roleManager.isOperator(msg.sender)) revert OnlyOperator();
        _;
    }

    modifier onlyMultisig() {
        if (msg.sender != multisig) revert OnlyMultisig();
        _;
    }

    modifier whenNotPaused() {
        if (roleManager.paused()) revert Paused();
        _;
    }

    modifier whenDepositsNotPaused() {
        if (roleManager.depositsPaused()) revert DepositsPaused();
        _;
    }

    modifier whenWithdrawalsNotPaused() {
        if (roleManager.withdrawalsPaused()) revert WithdrawalsPaused();
        _;
    }

    // ============ Constructor ============

    /**
     * @notice Initialize the vault
     * @param _usdc USDC token address
     * @param _navOracle NavOracle contract address
     * @param _roleManager RoleManager contract address
     * @param _multisig Multisig address for strategy funds
     * @param _treasury Treasury address for fees
     * @param _feeRate Initial fee rate (18 decimals)
     * @param _cooldownPeriod Initial cooldown period
     */
    constructor(
        address _usdc,
        address _navOracle,
        address _roleManager,
        address _multisig,
        address _treasury,
        uint256 _feeRate,
        uint256 _cooldownPeriod
    ) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_navOracle == address(0)) revert ZeroAddress();
        if (_roleManager == address(0)) revert ZeroAddress();
        if (_multisig == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_feeRate > MAX_FEE_RATE) revert InvalidFeeRate();
        if (_cooldownPeriod < MIN_COOLDOWN || _cooldownPeriod > MAX_COOLDOWN) revert InvalidCooldown();

        usdc = IERC20(_usdc);
        navOracle = INavOracle(_navOracle);
        roleManager = IRoleManager(_roleManager);
        shares = new VaultShare(address(this));

        multisig = _multisig;
        treasury = _treasury;
        feeRate = _feeRate;
        cooldownPeriod = _cooldownPeriod;
    }

    // ============ View Functions ============

    /**
     * @notice Get total assets from NavOracle
     * @return Total assets in USDC (6 decimals)
     */
    function totalAssets() public view returns (uint256) {
        return navOracle.totalAssets();
    }

    /**
     * @notice Calculate current share price using NavOracle.totalAssets()
     * @return price Share price in USDC (18 decimal precision)
     * @dev Returns 1e18 (representing 1 USDC per share) when no shares exist
     */
    function sharePrice() public view returns (uint256) {
        uint256 totalShareSupply = shares.totalSupply();
        if (totalShareSupply == 0) {
            return PRECISION; // 1 USDC = 1 share initially
        }
        // Deduct accrued fees from NAV for accurate share price
        uint256 nav = totalAssets();
        if (accruedFees >= nav) {
            return 0;
        }
        uint256 effectiveNav = nav - accruedFees;
        return (effectiveNav * PRECISION) / totalShareSupply;
    }

    /**
     * @notice Get total outstanding shares
     * @return Total share supply
     */
    function totalShares() external view returns (uint256) {
        return shares.totalSupply();
    }

    /**
     * @notice Get pending withdrawal shares count
     * @return Total shares pending withdrawal
     */
    function pendingWithdrawals() external view returns (uint256) {
        return pendingWithdrawalShares;
    }

    /**
     * @notice Get withdrawal queue length (including processed)
     * @return Queue length
     */
    function withdrawalQueueLength() external view returns (uint256) {
        return withdrawalQueue.length;
    }

    /**
     * @notice Get withdrawal request details
     * @param requestId Request ID
     * @return Withdrawal request struct
     */
    function getWithdrawalRequest(uint256 requestId) external view returns (WithdrawalRequest memory) {
        if (requestId >= withdrawalQueue.length) revert InvalidRequestId();
        return withdrawalQueue[requestId];
    }

    /**
     * @notice Get vault's USDC balance
     * @return Available USDC in vault
     */
    function availableLiquidity() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /**
     * @notice Calculate USDC value of shares
     * @param shareAmount Number of shares
     * @return USDC value
     */
    function sharesToUsdc(uint256 shareAmount) public view returns (uint256) {
        return (shareAmount * sharePrice()) / PRECISION;
    }

    /**
     * @notice Calculate shares for USDC amount
     * @param usdcAmount USDC amount
     * @return Number of shares
     */
    function usdcToShares(uint256 usdcAmount) public view returns (uint256) {
        uint256 price = sharePrice();
        if (price == 0) return 0;
        return (usdcAmount * PRECISION) / price;
    }

    // ============ User Functions ============

    /**
     * @notice Deposit USDC and receive vault shares
     * @param usdcAmount Amount of USDC to deposit
     * @return sharesMinted Number of shares minted
     */
    function deposit(uint256 usdcAmount)
        external
        whenNotPaused
        whenDepositsNotPaused
        returns (uint256 sharesMinted)
    {
        if (usdcAmount == 0) revert ZeroAmount();

        // Check per-user cap
        if (perUserCap > 0) {
            if (userTotalDeposited[msg.sender] + usdcAmount > perUserCap) {
                revert ExceedsUserCap();
            }
        }

        // Check global cap
        uint256 currentAssets = totalAssets();
        if (globalCap > 0) {
            if (currentAssets + usdcAmount > globalCap) {
                revert ExceedsGlobalCap();
            }
        }

        // Calculate shares to mint
        sharesMinted = usdcToShares(usdcAmount);

        // Update user tracking
        userTotalDeposited[msg.sender] += usdcAmount;

        // Mint shares to user
        shares.mint(msg.sender, sharesMinted);

        // Transfer USDC from user
        bool success = usdc.transferFrom(msg.sender, address(this), usdcAmount);
        if (!success) revert TransferFailed();

        // Forward excess to multisig (keep buffer)
        _forwardToMultisig();

        emit Deposit(msg.sender, usdcAmount, sharesMinted);
    }

    /**
     * @notice Request a withdrawal of shares
     * @param shareAmount Number of shares to withdraw
     * @return requestId The withdrawal request ID
     */
    function requestWithdrawal(uint256 shareAmount)
        external
        whenNotPaused
        whenWithdrawalsNotPaused
        returns (uint256 requestId)
    {
        if (shareAmount == 0) revert ZeroAmount();
        if (shares.balanceOf(msg.sender) < shareAmount) revert InsufficientShares();

        requestId = withdrawalQueue.length;

        withdrawalQueue.push(WithdrawalRequest({
            requester: msg.sender,
            shares: shareAmount,
            requestTimestamp: block.timestamp
        }));

        pendingWithdrawalShares += shareAmount;

        emit WithdrawalRequested(msg.sender, shareAmount, requestId);
    }

    // ============ Operator Functions ============

    /**
     * @notice Fulfill pending withdrawals from the queue (operator only)
     * @param count Maximum number of withdrawals to process
     * @return processed Number of withdrawals processed
     * @return usdcPaid Total USDC paid out
     */
    function fulfillWithdrawals(uint256 count)
        external
        onlyOperator
        whenNotPaused
        whenWithdrawalsNotPaused
        returns (uint256 processed, uint256 usdcPaid)
    {
        // Collect any pending fees before processing withdrawals
        _collectFees();

        uint256 available = availableLiquidity();
        uint256 head = withdrawalQueueHead;
        uint256 queueLen = withdrawalQueue.length;

        while (processed < count && head < queueLen && available > 0) {
            WithdrawalRequest storage request = withdrawalQueue[head];

            // Skip if already processed (shares = 0)
            if (request.shares == 0) {
                head++;
                continue;
            }

            // Check cooldown
            if (block.timestamp < request.requestTimestamp + cooldownPeriod) {
                head++;
                continue;
            }

            // Check if requester still has enough shares
            uint256 requesterBalance = shares.balanceOf(request.requester);
            uint256 sharesToBurn = request.shares;
            if (requesterBalance < sharesToBurn) {
                // Shares were transferred, adjust to available balance
                sharesToBurn = requesterBalance;
            }

            if (sharesToBurn == 0) {
                // No shares to burn, mark as processed
                pendingWithdrawalShares -= request.shares;
                request.shares = 0;
                head++;
                continue;
            }

            // Calculate USDC to pay
            uint256 usdcOut = sharesToUsdc(sharesToBurn);

            if (usdcOut > available) {
                // Not enough liquidity, stop processing
                break;
            }

            // Burn shares
            shares.burn(request.requester, sharesToBurn);

            // Update pending shares
            pendingWithdrawalShares -= request.shares;
            request.shares = 0;

            // Transfer USDC
            bool success = usdc.transfer(request.requester, usdcOut);
            if (!success) revert TransferFailed();

            available -= usdcOut;
            usdcPaid += usdcOut;
            processed++;
            head++;

            emit WithdrawalFulfilled(request.requester, sharesToBurn, usdcOut, head - 1);
        }

        withdrawalQueueHead = head;
    }

    // ============ Multisig Functions ============

    /**
     * @notice Receive funds from multisig for withdrawal processing
     * @param amount Amount of USDC being sent
     */
    function receiveFundsFromMultisig(uint256 amount) external onlyMultisig {
        bool success = usdc.transferFrom(msg.sender, address(this), amount);
        if (!success) revert TransferFailed();

        emit FundsReceivedFromMultisig(amount);
    }

    // ============ Owner Functions ============

    /**
     * @notice Update multisig address
     * @param newMultisig New multisig address
     */
    function setMultisig(address newMultisig) external onlyOwner {
        if (newMultisig == address(0)) revert ZeroAddress();
        emit MultisigUpdated(multisig, newMultisig);
        multisig = newMultisig;
    }

    /**
     * @notice Update treasury address
     * @param newTreasury New treasury address
     */
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /**
     * @notice Update fee rate
     * @param newFeeRate New fee rate (18 decimals)
     */
    function setFeeRate(uint256 newFeeRate) external onlyOwner {
        if (newFeeRate > MAX_FEE_RATE) revert InvalidFeeRate();
        emit FeeRateUpdated(feeRate, newFeeRate);
        feeRate = newFeeRate;
    }

    /**
     * @notice Update per-user deposit cap
     * @param newCap New cap (0 = unlimited)
     */
    function setPerUserCap(uint256 newCap) external onlyOwner {
        emit PerUserCapUpdated(perUserCap, newCap);
        perUserCap = newCap;
    }

    /**
     * @notice Update global AUM cap
     * @param newCap New cap (0 = unlimited)
     */
    function setGlobalCap(uint256 newCap) external onlyOwner {
        emit GlobalCapUpdated(globalCap, newCap);
        globalCap = newCap;
    }

    /**
     * @notice Update withdrawal buffer
     * @param newBuffer New buffer amount
     */
    function setWithdrawalBuffer(uint256 newBuffer) external onlyOwner {
        emit WithdrawalBufferUpdated(withdrawalBuffer, newBuffer);
        withdrawalBuffer = newBuffer;
    }

    /**
     * @notice Update cooldown period
     * @param newCooldown New cooldown in seconds
     */
    function setCooldownPeriod(uint256 newCooldown) external onlyOwner {
        if (newCooldown < MIN_COOLDOWN || newCooldown > MAX_COOLDOWN) revert InvalidCooldown();
        emit CooldownPeriodUpdated(cooldownPeriod, newCooldown);
        cooldownPeriod = newCooldown;
    }

    /**
     * @notice Force process a specific withdrawal (emergency)
     * @param requestId Request ID to process
     */
    function forceProcessWithdrawal(uint256 requestId) external onlyOwner {
        if (requestId >= withdrawalQueue.length) revert InvalidRequestId();

        WithdrawalRequest storage request = withdrawalQueue[requestId];
        if (request.shares == 0) revert RequestAlreadyProcessed();

        uint256 requesterBalance = shares.balanceOf(request.requester);
        uint256 sharesToBurn = request.shares;
        if (requesterBalance < sharesToBurn) {
            sharesToBurn = requesterBalance;
        }

        if (sharesToBurn > 0) {
            uint256 usdcOut = sharesToUsdc(sharesToBurn);

            if (usdcOut > availableLiquidity()) revert InsufficientLiquidity();

            shares.burn(request.requester, sharesToBurn);

            bool success = usdc.transfer(request.requester, usdcOut);
            if (!success) revert TransferFailed();

            emit WithdrawalFulfilled(request.requester, sharesToBurn, usdcOut, requestId);
        }

        pendingWithdrawalShares -= request.shares;
        request.shares = 0;
    }

    /**
     * @notice Cancel a queued withdrawal (emergency)
     * @param requestId Request ID to cancel
     */
    function cancelWithdrawal(uint256 requestId) external onlyOwner {
        if (requestId >= withdrawalQueue.length) revert InvalidRequestId();

        WithdrawalRequest storage request = withdrawalQueue[requestId];
        if (request.shares == 0) revert RequestAlreadyProcessed();

        uint256 cancelledShares = request.shares;
        pendingWithdrawalShares -= cancelledShares;
        request.shares = 0;

        emit WithdrawalCancelled(request.requester, cancelledShares, requestId);
    }

    /**
     * @notice Collect accrued fees to treasury
     */
    function collectFees() external onlyOwner {
        _collectFees();
    }

    // ============ Internal Functions ============

    /**
     * @notice Forward excess USDC to multisig, keeping buffer
     */
    function _forwardToMultisig() internal {
        uint256 balance = usdc.balanceOf(address(this));
        if (balance > withdrawalBuffer) {
            uint256 excess = balance - withdrawalBuffer;
            bool success = usdc.transfer(multisig, excess);
            if (!success) revert TransferFailed();
            emit FundsForwardedToMultisig(excess);
        }
    }

    /**
     * @notice Calculate and collect fees on profit
     * @dev Called before withdrawal fulfillment to ensure accurate share price
     */
    function _collectFees() internal {
        if (feeRate == 0) return;

        uint256 currentAssets = totalAssets();
        if (currentAssets <= lastFeeHighWaterMark) return;

        uint256 profit = currentAssets - lastFeeHighWaterMark;
        uint256 fee = (profit * feeRate) / PRECISION;

        if (fee > 0) {
            // Mint fee shares to treasury
            uint256 totalShareSupply = shares.totalSupply();
            if (totalShareSupply > 0) {
                // feeShares = fee * totalShares / (currentAssets - fee)
                uint256 feeShares = (fee * totalShareSupply) / (currentAssets - fee);
                if (feeShares > 0) {
                    shares.mint(treasury, feeShares);
                    emit FeeCollected(feeShares, treasury);
                }
            }
        }

        lastFeeHighWaterMark = currentAssets;
    }
}
