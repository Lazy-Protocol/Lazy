// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IVault} from "./interfaces/IVault.sol";
import {IStrategyOracle} from "./interfaces/IStrategyOracle.sol";
import {IRoleManager} from "./interfaces/IRoleManager.sol";
import {VaultShare} from "./VaultShare.sol";

/**
 * @title ReentrancyGuard
 * @notice Minimal reentrancy protection (follows OpenZeppelin pattern)
 */
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    constructor() {
        _status = _NOT_ENTERED;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

/**
 * @title USDCSavingsVault
 * @notice A USDC-denominated savings vault with share-based NAV model
 * @dev Uses external IStrategyOracle for yield reporting and IRoleManager for access control
 *
 * Architecture:
 * - Vault tracks deposits/withdrawals automatically (totalDeposited, totalWithdrawn)
 * - IStrategyOracle.accumulatedYield(): Yield from off-chain strategies (owner-reported)
 * - totalAssets = totalDeposited - totalWithdrawn + accumulatedYield
 * - IRoleManager: Controls pause state and operator access
 *
 * Key features:
 * - Share-based accounting (1 USDC = 1 share initially)
 * - Async withdrawal queue with FIFO processing
 * - Share escrow on withdrawal request (prevents double-spend)
 * - Protocol fees only on yield (via share minting, price-based HWM)
 * - Operator-only withdrawal fulfillment
 * - Reentrancy protection on state-changing functions
 *
 * =============================================================================
 * FORMAL INVARIANT SPECIFICATION
 * =============================================================================
 *
 * INVARIANT I.1 — Conservation of Value via Shares (Primary)
 * ----------------------------------------------------------------------------
 * The protocol SHALL NOT transfer any amount of USDC out of the Vault unless
 * a corresponding amount of shares is irrevocably burned at the current NAV.
 *
 * Formal: S_burned = floor(A_out / NAV)
 *         totalAssets_after = totalAssets_before - A_out
 *         totalShares_after = totalShares_before - S_burned
 *
 * No execution path MAY reduce totalAssets without reducing totalShares.
 *
 * INVARIANT I.2 — Share Escrow Safety
 * ----------------------------------------------------------------------------
 * Shares submitted for withdrawal SHALL be transferred to the Vault and
 * SHALL NOT be transferable, reusable, or withdrawable until either:
 *   a) The withdrawal is fulfilled and shares are burned, OR
 *   b) The withdrawal is cancelled and shares are returned to requester
 *
 * This prevents duplicate claims and double-withdraw attacks.
 *
 * INVARIANT I.3 — Universal NAV Application
 * ----------------------------------------------------------------------------
 * Any update to totalAssets SHALL apply uniformly to ALL outstanding shares:
 *   - Shares held by users
 *   - Shares held in withdrawal escrow (by vault)
 *   - Shares held by Treasury
 *
 * No class of shares SHALL be excluded from gains or losses.
 *
 * INVARIANT I.4 — Fee Isolation
 * ----------------------------------------------------------------------------
 * Protocol fees SHALL:
 *   - Be assessed only on share price increases (yield, not deposits)
 *   - Be capped by MAX_FEE_RATE
 *   - Be paid exclusively via minting new shares to Treasury
 *
 * Fees SHALL NEVER cause a transfer of USDC from the Vault.
 *
 * INVARIANT I.5 — Withdrawal Queue Liveness
 * ----------------------------------------------------------------------------
 * The withdrawal fulfillment mechanism SHALL:
 *   - Process requests in FIFO order
 *   - Never revert due to insufficient USDC balance
 *   - Terminate gracefully if available liquidity is insufficient
 *
 * =============================================================================
 * EXPLICIT DESIGN STATEMENTS
 * =============================================================================
 *
 * STATEMENT D.1 — Emergency Scope Declaration
 * ----------------------------------------------------------------------------
 * Emergency overrides (forceProcessWithdrawal, cancelWithdrawal) exist to
 * restore liveness or user safety for individual withdrawals, not to rebalance
 * protocol state globally. These functions preserve invariants I.1 and I.2.
 *
 * STATEMENT D.2 — Oracle Trust Assumption
 * ----------------------------------------------------------------------------
 * Yield reports are trusted inputs controlled by governance. The protocol does
 * not attempt to algorithmically defend against oracle manipulation. Deposits
 * and withdrawals are tracked automatically; only yield requires reporting.
 *
 * STATEMENT D.3 — Fee Accounting Rule
 * ----------------------------------------------------------------------------
 * Protocol fees are assessed on share PRICE increases, not NAV increases.
 * This ensures fees are only charged on yield, not on deposits.
 * Fee shares are minted immediately when yield is reported via collectFees().
 *
 * STATEMENT D.4 — Queue Append-Only Design
 * ----------------------------------------------------------------------------
 * The withdrawal queue is append-only. Processed entries are marked with
 * shares=0 and skipped via withdrawalQueueHead cursor. Entries are never
 * deleted. This is intentional to preserve FIFO ordering, maintain requestId
 * stability, and avoid costly array shifts.
 *
 * =============================================================================
 * SINGLE-LINE SUMMARY
 * =============================================================================
 * The only way value exits the system is by destroying shares at current NAV;
 * all shares, regardless of state, rise and fall together.
 * =============================================================================
 */
contract USDCSavingsVault is IVault, ReentrancyGuard {
    // ============ Constants ============

    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_FEE_RATE = 0.5e18; // 50% max fee
    uint256 public constant MIN_COOLDOWN = 1 days;
    uint256 public constant MAX_COOLDOWN = 30 days;

    // Initial share price: 1 USDC (6 decimals) = 1 share (18 decimals)
    // Price is scaled to 18 decimals: 1e6 means 1 USDC per share
    uint256 public constant INITIAL_SHARE_PRICE = 1e6;

    // ============ Immutables ============

    IERC20 public immutable usdc;
    VaultShare public immutable shares;
    IStrategyOracle public immutable strategyOracle;
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

    // NAV tracking (deposits and withdrawals tracked automatically)
    uint256 public totalDeposited; // Cumulative USDC deposited
    uint256 public totalWithdrawn; // Cumulative USDC withdrawn

    // Fee tracking (price-based high water mark)
    uint256 public priceHighWaterMark; // HWM for fee calculation (18 decimals)

    // User tracking
    mapping(address => uint256) public userTotalDeposited; // Cumulative deposits (for cap enforcement)

    // Withdrawal queue
    WithdrawalRequest[] public withdrawalQueue;
    uint256 public withdrawalQueueHead; // Index of next request to process
    uint256 public pendingWithdrawalShares; // Total shares escrowed in queue

    // ============ Errors ============

    error OnlyOwner();
    error OnlyOperator();
    error OnlyMultisig();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroShares();
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
    error InvariantViolation();

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
     * @param _strategyOracle StrategyOracle contract address
     * @param _roleManager RoleManager contract address
     * @param _multisig Multisig address for strategy funds
     * @param _treasury Treasury address for fees
     * @param _feeRate Initial fee rate (18 decimals)
     * @param _cooldownPeriod Initial cooldown period
     */
    constructor(
        address _usdc,
        address _strategyOracle,
        address _roleManager,
        address _multisig,
        address _treasury,
        uint256 _feeRate,
        uint256 _cooldownPeriod
    ) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_strategyOracle == address(0)) revert ZeroAddress();
        if (_roleManager == address(0)) revert ZeroAddress();
        if (_multisig == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_feeRate > MAX_FEE_RATE) revert InvalidFeeRate();
        if (_cooldownPeriod < MIN_COOLDOWN || _cooldownPeriod > MAX_COOLDOWN) revert InvalidCooldown();

        usdc = IERC20(_usdc);
        strategyOracle = IStrategyOracle(_strategyOracle);
        roleManager = IRoleManager(_roleManager);
        shares = new VaultShare(address(this));

        multisig = _multisig;
        treasury = _treasury;
        feeRate = _feeRate;
        cooldownPeriod = _cooldownPeriod;

        // Initialize price HWM to 1:1 (1 USDC = 1 share)
        priceHighWaterMark = INITIAL_SHARE_PRICE;
    }

    // ============ View Functions ============

    /**
     * @notice Get total assets (NAV) computed from deposits, withdrawals, and yield
     * @return Total assets in USDC (6 decimals)
     * @dev totalAssets = totalDeposited - totalWithdrawn + accumulatedYield
     * @dev Invariant I.3: This value applies uniformly to all shares
     */
    function totalAssets() public view returns (uint256) {
        int256 yield = strategyOracle.accumulatedYield();
        int256 nav = int256(totalDeposited) - int256(totalWithdrawn) + yield;

        // NAV cannot be negative (would mean more withdrawn than deposited + yield)
        // In practice this shouldn't happen, but we protect against it
        return nav > 0 ? uint256(nav) : 0;
    }

    /**
     * @notice Calculate current share price
     * @return price Share price scaled to 18 decimals
     * @dev Returns INITIAL_SHARE_PRICE (1e6) when no shares exist, meaning 1 USDC = 1 share
     * @dev With 18 decimal shares and 6 decimal USDC: price = (NAV * 1e18) / totalShares
     * @dev Invariant I.3: Price applies to ALL shares equally (user, escrowed, treasury)
     */
    function sharePrice() public view returns (uint256) {
        uint256 totalShareSupply = shares.totalSupply();
        if (totalShareSupply == 0) {
            return INITIAL_SHARE_PRICE; // 1 USDC = 1 share initially
        }
        uint256 nav = totalAssets();
        return (nav * PRECISION) / totalShareSupply;
    }

    /**
     * @notice Get total outstanding shares
     * @return Total share supply (includes escrowed shares)
     * @dev Invariant I.3: Escrowed shares are still part of totalSupply
     */
    function totalShares() external view returns (uint256) {
        return shares.totalSupply();
    }

    /**
     * @notice Get pending withdrawal shares count (escrowed in vault)
     * @return Total shares held in escrow for pending withdrawals
     * @dev Invariant I.2: These shares are locked until fulfilled or cancelled
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
     * @notice Get vault's USDC balance (available for withdrawals)
     * @return Available USDC in vault
     */
    function availableLiquidity() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /**
     * @notice Calculate USDC value of shares at current NAV
     * @param shareAmount Number of shares
     * @return USDC value
     * @dev Invariant I.1: This is the amount that would be paid out for burning shares
     */
    function sharesToUsdc(uint256 shareAmount) public view returns (uint256) {
        return (shareAmount * sharePrice()) / PRECISION;
    }

    /**
     * @notice Calculate shares for USDC amount at current NAV
     * @param usdcAmount USDC amount
     * @return Number of shares
     */
    function usdcToShares(uint256 usdcAmount) public view returns (uint256) {
        uint256 price = sharePrice();
        if (price == 0) return 0;
        return (usdcAmount * PRECISION) / price;
    }

    /**
     * @notice Get shares held in escrow by vault (for pending withdrawals)
     * @return Escrowed share balance
     */
    function escrowedShares() public view returns (uint256) {
        return shares.balanceOf(address(this));
    }

    // ============ User Functions ============

    /**
     * @notice Deposit USDC and receive vault shares
     * @param usdcAmount Amount of USDC to deposit
     * @return sharesMinted Number of shares minted
     * @dev Invariant I.1: Shares minted = usdcAmount / sharePrice
     * @dev Deposits auto-update totalAssets via totalDeposited tracking
     */
    function deposit(uint256 usdcAmount)
        external
        nonReentrant
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

        // Calculate shares to mint BEFORE updating totalDeposited
        // This ensures the price used is the pre-deposit price
        sharesMinted = usdcToShares(usdcAmount);

        // M-1 Fix: Ensure user receives at least 1 share
        if (sharesMinted == 0) revert ZeroShares();

        // Update deposit tracking (auto-updates NAV via totalAssets())
        totalDeposited += usdcAmount;

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
     * @dev Invariant I.2: Shares are transferred to vault (escrowed) immediately
     * @dev This prevents double-spending - shares cannot be transferred or used again
     */
    function requestWithdrawal(uint256 shareAmount)
        external
        nonReentrant
        whenNotPaused
        whenWithdrawalsNotPaused
        returns (uint256 requestId)
    {
        if (shareAmount == 0) revert ZeroAmount();
        if (shares.balanceOf(msg.sender) < shareAmount) revert InsufficientShares();

        // INVARIANT I.2: Escrow shares into vault
        // Shares are transferred FROM user TO vault, preventing double-spend
        shares.transferFrom(msg.sender, address(this), shareAmount);

        requestId = withdrawalQueue.length;

        withdrawalQueue.push(WithdrawalRequest({
            requester: msg.sender,
            shares: shareAmount,
            requestTimestamp: block.timestamp
        }));

        pendingWithdrawalShares += shareAmount;

        // ASSERT I.2: Verify escrow invariant
        assert(shares.balanceOf(address(this)) >= pendingWithdrawalShares);

        emit WithdrawalRequested(msg.sender, shareAmount, requestId);
    }

    // ============ Operator Functions ============

    /**
     * @notice Fulfill pending withdrawals from the queue (operator only)
     * @param count Maximum number of withdrawals to process
     * @return processed Number of withdrawals processed
     * @return usdcPaid Total USDC paid out
     * @dev Invariant I.1: Each fulfillment burns shares at current NAV
     * @dev Invariant I.5: FIFO order, graceful termination on low liquidity
     */
    function fulfillWithdrawals(uint256 count)
        external
        nonReentrant
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

        // Snapshot for invariant check
        uint256 sharesBefore = shares.totalSupply();

        while (processed < count && head < queueLen) {
            WithdrawalRequest storage request = withdrawalQueue[head];

            // Skip if already processed (shares = 0)
            if (request.shares == 0) {
                head++;
                continue;
            }

            // H-2 Fix: If cooldown not met, stop processing (maintain FIFO)
            // Don't skip past immature requests - they should be processed first
            if (block.timestamp < request.requestTimestamp + cooldownPeriod) {
                break; // Stop here, wait for this request to mature
            }

            uint256 sharesToBurn = request.shares;

            // Calculate USDC to pay at current NAV
            // INVARIANT I.1: usdcOut = sharesToBurn * NAV / totalShares
            uint256 usdcOut = sharesToUsdc(sharesToBurn);

            // INVARIANT I.5: Graceful termination if insufficient liquidity
            if (usdcOut > available) {
                break; // Stop processing, don't revert
            }

            // INVARIANT I.1: Burn escrowed shares from vault
            shares.burn(address(this), sharesToBurn);

            // Update state
            pendingWithdrawalShares -= sharesToBurn;
            request.shares = 0;

            // Track withdrawal for NAV calculation
            totalWithdrawn += usdcOut;

            // Transfer USDC to requester
            // INVARIANT I.1: USDC only exits when shares are burned
            bool success = usdc.transfer(request.requester, usdcOut);
            if (!success) revert TransferFailed();

            available -= usdcOut;
            usdcPaid += usdcOut;
            processed++;
            head++;

            emit WithdrawalFulfilled(request.requester, sharesToBurn, usdcOut, head - 1);
        }

        withdrawalQueueHead = head;

        // ASSERT I.1: Conservation of value
        // If shares were burned, totalShares decreased proportionally to USDC paid
        if (processed > 0) {
            uint256 sharesAfter = shares.totalSupply();
            // Verify: shares decreased when USDC exited
            assert(sharesAfter < sharesBefore || usdcPaid == 0);
        }

        // ASSERT I.2: Escrow balance matches pending shares
        assert(shares.balanceOf(address(this)) == pendingWithdrawalShares);
    }

    // ============ Multisig Functions ============

    /**
     * @notice Receive funds from multisig for withdrawal processing
     * @param amount Amount of USDC being sent
     */
    function receiveFundsFromMultisig(uint256 amount) external nonReentrant onlyMultisig {
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
     * @dev Invariant I.4: Fee rate capped at MAX_FEE_RATE
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
     * @notice Force process a specific withdrawal (emergency, skips cooldown)
     * @param requestId Request ID to process
     * @dev Invariant I.1: Still burns shares at current NAV
     * @dev WARNING: Skips FIFO order - use only in emergencies
     */
    function forceProcessWithdrawal(uint256 requestId) external nonReentrant onlyOwner {
        if (requestId >= withdrawalQueue.length) revert InvalidRequestId();

        WithdrawalRequest storage request = withdrawalQueue[requestId];
        if (request.shares == 0) revert RequestAlreadyProcessed();

        // Collect fees before processing
        _collectFees();

        uint256 sharesToBurn = request.shares;
        uint256 usdcOut = sharesToUsdc(sharesToBurn);

        if (usdcOut > availableLiquidity()) revert InsufficientLiquidity();

        // Burn escrowed shares from vault
        shares.burn(address(this), sharesToBurn);

        // Update state
        pendingWithdrawalShares -= sharesToBurn;
        request.shares = 0;

        // Track withdrawal for NAV calculation
        totalWithdrawn += usdcOut;

        // Transfer USDC
        bool success = usdc.transfer(request.requester, usdcOut);
        if (!success) revert TransferFailed();

        // ASSERT I.2: Escrow invariant maintained
        assert(shares.balanceOf(address(this)) == pendingWithdrawalShares);

        emit WithdrawalFulfilled(request.requester, sharesToBurn, usdcOut, requestId);
    }

    /**
     * @notice Cancel a queued withdrawal (emergency)
     * @param requestId Request ID to cancel
     * @dev Invariant I.2: Returns escrowed shares to original requester
     */
    function cancelWithdrawal(uint256 requestId) external nonReentrant onlyOwner {
        if (requestId >= withdrawalQueue.length) revert InvalidRequestId();

        WithdrawalRequest storage request = withdrawalQueue[requestId];
        if (request.shares == 0) revert RequestAlreadyProcessed();

        uint256 sharesToReturn = request.shares;
        address requester = request.requester;

        // Update state first
        pendingWithdrawalShares -= sharesToReturn;
        request.shares = 0;

        // Return escrowed shares to requester
        bool success = shares.transfer(requester, sharesToReturn);
        if (!success) revert TransferFailed();

        // ASSERT I.2: Escrow invariant maintained
        assert(shares.balanceOf(address(this)) == pendingWithdrawalShares);

        emit WithdrawalCancelled(requester, sharesToReturn, requestId);
    }

    /**
     * @notice Manually trigger fee collection
     * @dev Invariant I.4: Fees paid via share minting only
     * @dev Should be called after yield is reported to StrategyOracle
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
     * @notice Calculate and collect fees on yield via share minting
     * @dev Invariant I.4: Fees are ONLY collected on share price increases
     * @dev Invariant I.4: Fees are ONLY paid via minting shares to treasury
     * @dev Invariant I.4: No USDC is transferred for fees
     *
     * Fee calculation uses price-based HWM:
     * - Deposits: NAV ↑, shares ↑, price unchanged → no fees
     * - Withdrawals: NAV ↓, shares ↓, price unchanged → no fees
     * - Yield: NAV ↑, shares unchanged, price ↑ → FEES
     */
    function _collectFees() internal {
        if (feeRate == 0) return;

        uint256 totalShareSupply = shares.totalSupply();
        if (totalShareSupply == 0) return;

        uint256 currentPrice = sharePrice();

        // INVARIANT I.4: Only assess fees on price increases (yield)
        if (currentPrice <= priceHighWaterMark) return;

        // Calculate price gain and corresponding profit
        uint256 priceGain = currentPrice - priceHighWaterMark;

        // Profit in USDC = priceGain * totalShares / PRECISION
        // (priceGain is in 18 decimals, shares in 6 decimals)
        uint256 profit = (priceGain * totalShareSupply) / PRECISION;

        // Fee is percentage of profit
        uint256 fee = (profit * feeRate) / PRECISION;

        // ASSERT I.4: Fee cannot exceed profit
        assert(fee <= profit);

        if (fee > 0) {
            // INVARIANT I.4: Pay fee by minting shares to treasury
            // feeShares = fee / currentPrice (in proper decimals)
            // This dilutes existing holders proportionally
            uint256 currentNav = totalAssets();
            if (currentNav > fee) {
                uint256 feeShares = (fee * totalShareSupply) / (currentNav - fee);
                if (feeShares > 0) {
                    shares.mint(treasury, feeShares);
                    emit FeeCollected(feeShares, treasury);
                }
            }
        }

        // Update HWM to POST-dilution price
        // This ensures next cycle only fees NEW gains
        priceHighWaterMark = sharePrice();
    }
}
