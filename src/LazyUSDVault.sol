// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVault} from "./interfaces/IVault.sol";
import {IRoleManager} from "./interfaces/IRoleManager.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title LazyUSDVault
 * @notice A USDC-denominated savings vault with share-based NAV model
 * @dev Uses internal yield tracking and IRoleManager for access control
 *
 * Architecture:
 * - Vault tracks deposits/withdrawals automatically (totalDeposited, totalWithdrawn)
 * - Yield from external on-chain strategies is reported via reportYieldAndCollectFees()
 * - totalAssets = totalDeposited - totalWithdrawn + accumulatedYield
 * - IRoleManager: Controls pause state and operator access
 *
 * Key features:
 * - Share-based accounting (1 USDC = 1 share initially)
 * - Async withdrawal queue with FIFO processing
 * - Share escrow on withdrawal request (prevents double-spend)
 * - Protocol fees on positive yield (via share minting to treasury)
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
 * Protocol fees are calculated as a percentage of positive yield at report time.
 * When reportYieldAndCollectFees() is called with positive yield:
 *   fee = yield * feeRate / PRECISION
 * Fee shares are minted directly to treasury. No USDC is transferred for fees.
 *
 * STATEMENT D.4 — Queue Append-Only Design
 * ----------------------------------------------------------------------------
 * The withdrawal queue is append-only. Processed entries are marked with
 * shares=0 and skipped via withdrawalQueueHead cursor. Entries are never
 * deleted. This is intentional to preserve FIFO ordering, maintain requestId
 * stability, and avoid costly array shifts.
 *
 * STATEMENT D.5 — Governance Delegation Pattern
 * ----------------------------------------------------------------------------
 * This Vault deliberately does NOT use OpenZeppelin's Ownable or Pausable.
 * Authority and emergency control are delegated to an external RoleManager
 * contract to:
 *
 *   1. Allow multi-role governance (Owner, Operator, Guardian)
 *   2. Enable future governance upgrades without redeploying the Vault
 *   3. Avoid hard-coding authority assumptions into the asset custody layer
 *
 * OpenZeppelin components are used ONLY where they provide pure mechanical
 * safety guarantees and do not encode governance semantics:
 *   - ReentrancyGuard: Prevents cross-function reentrancy (mechanical safety)
 *   - ERC20: Standard token mechanics (vault IS the share token)
 *
 * This separation ensures the Vault focuses solely on asset custody and
 * accounting, while governance logic remains modular and upgradeable.
 *
 * =============================================================================
 * SINGLE-LINE SUMMARY
 * =============================================================================
 * The only way value exits the system is by destroying shares at current NAV;
 * all shares, regardless of state, rise and fall together.
 * =============================================================================
 */
contract LazyUSDVault is IVault, ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Constants ============

    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_FEE_RATE = 0.5e18; // 50% max fee
    uint256 public constant MIN_COOLDOWN = 1 days;
    uint256 public constant MAX_COOLDOWN = 30 days;
    uint256 public constant CANCELLATION_WINDOW = 1 hours; // H-3: User can cancel within this window
    uint256 public constant MAX_PENDING_PER_USER = 10; // M-1: Limit pending requests per user

    // Timelock durations for critical configuration changes
    uint256 public constant TIMELOCK_FEE_RATE = 1 days;
    uint256 public constant TIMELOCK_TREASURY = 2 days;
    uint256 public constant TIMELOCK_MULTISIG = 3 days;
    uint256 public constant TIMELOCK_COOLDOWN = 1 days;

    // Initial share price: 1 USDC (6 decimals) = 1 share (18 decimals)
    // Price is scaled to 18 decimals: 1e6 means 1 USDC per share
    uint256 public constant INITIAL_SHARE_PRICE = 1e6;

    // Yield reporting constraints
    uint256 public constant MIN_YIELD_REPORT_INTERVAL = 1 days;

    // ============ Immutables ============

    IERC20 public immutable usdc;
    IRoleManager public immutable roleManager;

    // ============ State ============

    // Addresses
    address public multisig;
    address public treasury;

    // Configuration
    uint256 public feeRate; // Fee rate on profits (18 decimals, e.g., 0.2e18 = 20%)
    uint256 public globalCap; // Max total AUM (0 = unlimited)
    uint256 public withdrawalBuffer; // USDC to retain for withdrawals
    uint256 public cooldownPeriod; // Minimum time before withdrawal fulfillment

    // NAV tracking (deposits and withdrawals tracked automatically)
    uint256 public totalDeposited; // Cumulative USDC deposited
    uint256 public totalWithdrawn; // Cumulative USDC withdrawn

    // Yield tracking (previously in StrategyOracle)
    /// @notice Cumulative yield from external strategies (can be negative for losses)
    /// @dev Used in NAV calculation: totalAssets = deposits - withdrawals + accumulatedYield
    int256 public accumulatedYield;
    /// @notice Timestamp of the last yield report
    /// @dev Used to enforce MIN_YIELD_REPORT_INTERVAL between reports
    uint256 public lastYieldReportTime;
    /// @notice Maximum allowed yield change as percentage of NAV (18 decimals)
    /// @dev Safety bound: prevents accidental misreporting (e.g., wrong decimals).
    ///      Default 0.5% (0.005e18). Set to 0 to disable bounds checking.
    uint256 public maxYieldChangePercent = 0.005e18;

    // Withdrawal queue (append-only design - see STATEMENT D.4)
    /// @notice Array of all withdrawal requests (processed entries have shares=0)
    WithdrawalRequest[] public withdrawalQueue;
    /// @notice Cursor pointing to next unprocessed request (FIFO ordering)
    uint256 public withdrawalQueueHead;
    /// @notice Total shares currently held in escrow for pending withdrawals
    /// @dev Must always equal balanceOf(address(this)) minus any orphaned shares
    uint256 public pendingWithdrawalShares;
    /// @notice Count of pending withdrawal requests per user (prevents queue spam)
    /// @dev Enforces MAX_PENDING_PER_USER limit per address
    mapping(address => uint256) public userPendingRequests;

    // Timelock pending changes
    // Each config change requires: queue -> wait timelock -> execute
    // Value of 0 means no pending change; timestamp of 0 means not queued
    /// @notice Pending fee rate value awaiting timelock expiry
    uint256 public pendingFeeRate;
    /// @notice Timestamp when pendingFeeRate can be executed (0 = not queued)
    uint256 public pendingFeeRateTimestamp;
    /// @notice Pending treasury address awaiting timelock expiry
    address public pendingTreasury;
    /// @notice Timestamp when pendingTreasury can be executed (0 = not queued)
    uint256 public pendingTreasuryTimestamp;
    /// @notice Pending multisig address awaiting timelock expiry
    address public pendingMultisig;
    /// @notice Timestamp when pendingMultisig can be executed (0 = not queued)
    uint256 public pendingMultisigTimestamp;
    /// @notice Pending cooldown period awaiting timelock expiry
    uint256 public pendingCooldownPeriod;
    /// @notice Timestamp when pendingCooldownPeriod can be executed (0 = not queued)
    uint256 public pendingCooldownTimestamp;

    // ============ Errors ============

    error OnlyOwner();
    error OnlyOperator();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroShares();
    error Paused();
    error DepositsPaused();
    error WithdrawalsPaused();
    error ExceedsGlobalCap();
    error InsufficientShares();
    error InsufficientLiquidity();
    error InvalidFeeRate();
    error InvalidCooldown();
    error InvalidRequestId();
    error RequestAlreadyProcessed();
    error Unauthorized();
    error TooManyPendingRequests();
    error NotAContract();
    // Invariant violation errors (should never occur if code is correct)
    error EscrowBalanceMismatch();
    error SharesNotBurned();
    error QueueHeadRegression(); // I.5: FIFO ordering violated
    // Timelock errors
    error TimelockNotExpired();
    error NoPendingChange();
    // Yield reporting errors
    error YieldChangeTooLarge();
    error ReportTooSoon();
    // Transfer protection errors
    error CannotTransferToVault(); // V-2: Prevent accidental share loss

    // ============ Modifiers ============

    modifier onlyOwner() {
        if (msg.sender != roleManager.owner()) revert OnlyOwner();
        _;
    }

    modifier onlyOperator() {
        if (!roleManager.isOperator(msg.sender)) revert OnlyOperator();
        _;
    }

    /// @notice Modifier for functions callable by either owner or operator
    /// @dev Used for daily operations that need flexibility (yield reporting, buffer adjustments)
    modifier onlyOperatorOrOwner() {
        if (msg.sender != roleManager.owner() && !roleManager.isOperator(msg.sender)) {
            revert Unauthorized();
        }
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
     * @param _roleManager RoleManager contract address
     * @param _multisig Multisig address for strategy funds
     * @param _treasury Treasury address for fees
     * @param _feeRate Initial fee rate (18 decimals)
     * @param _cooldownPeriod Initial cooldown period
     * @param _shareName Name for the vault share token (e.g., "LazyUSD")
     * @param _shareSymbol Symbol for the vault share token (e.g., "lazyUSD")
     */
    constructor(
        address _usdc,
        address _roleManager,
        address _multisig,
        address _treasury,
        uint256 _feeRate,
        uint256 _cooldownPeriod,
        string memory _shareName,
        string memory _shareSymbol
    ) ERC20(_shareName, _shareSymbol) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_roleManager == address(0)) revert ZeroAddress();
        if (_multisig == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_usdc.code.length == 0) revert NotAContract();
        if (_roleManager.code.length == 0) revert NotAContract();
        if (_feeRate > MAX_FEE_RATE) revert InvalidFeeRate();
        if (_cooldownPeriod < MIN_COOLDOWN || _cooldownPeriod > MAX_COOLDOWN) revert InvalidCooldown();

        usdc = IERC20(_usdc);
        roleManager = IRoleManager(_roleManager);

        multisig = _multisig;
        treasury = _treasury;
        feeRate = _feeRate;
        cooldownPeriod = _cooldownPeriod;
    }

    // ============ View Functions ============

    /**
     * @notice Get total assets (NAV) computed from deposits, withdrawals, and yield
     * @return Total assets in USDC (6 decimals)
     * @dev totalAssets = totalDeposited - totalWithdrawn + accumulatedYield
     * @dev Invariant I.3: This value applies uniformly to all shares
     */
    function totalAssets() public view returns (uint256) {
        int256 nav = int256(totalDeposited) - int256(totalWithdrawn) + accumulatedYield;

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
        uint256 totalShareSupply = totalSupply();
        if (totalShareSupply == 0) {
            return INITIAL_SHARE_PRICE; // 1 USDC = 1 share initially
        }
        uint256 nav = totalAssets();
        return Math.mulDiv(nav, PRECISION, totalShareSupply);
    }

    /**
     * @notice Get total outstanding shares
     * @return Total share supply (includes escrowed shares)
     * @dev Invariant I.3: Escrowed shares are still part of totalSupply
     */
    function totalShares() external view returns (uint256) {
        return totalSupply();
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
        return Math.mulDiv(shareAmount, sharePrice(), PRECISION);
    }

    /**
     * @notice Calculate shares for USDC amount at current NAV
     * @param usdcAmount USDC amount
     * @return Number of shares
     */
    function usdcToShares(uint256 usdcAmount) public view returns (uint256) {
        uint256 price = sharePrice();
        if (price == 0) return 0;
        return Math.mulDiv(usdcAmount, PRECISION, price);
    }

    /**
     * @notice Get shares held in escrow by vault (for pending withdrawals)
     * @return Escrowed share balance
     */
    function escrowedShares() public view returns (uint256) {
        return balanceOf(address(this));
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

        // Mint shares to user
        _mint(msg.sender, sharesMinted);

        // Transfer USDC from user (SafeERC20 handles non-standard tokens)
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

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
        if (balanceOf(msg.sender) < shareAmount) revert InsufficientShares();

        // M-1: Check per-user pending request limit
        if (userPendingRequests[msg.sender] >= MAX_PENDING_PER_USER) revert TooManyPendingRequests();

        // INVARIANT I.2: Escrow shares into vault
        // Shares are transferred FROM user TO vault, preventing double-spend
        _transfer(msg.sender, address(this), shareAmount);

        requestId = withdrawalQueue.length;

        withdrawalQueue.push(WithdrawalRequest({
            requester: msg.sender,
            shares: shareAmount,
            requestTimestamp: block.timestamp
        }));

        pendingWithdrawalShares += shareAmount;
        userPendingRequests[msg.sender]++;

        // INVARIANT I.2: Verify escrow balance matches pending shares
        if (balanceOf(address(this)) < pendingWithdrawalShares) revert EscrowBalanceMismatch();

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
        uint256 available = availableLiquidity();
        uint256 head = withdrawalQueueHead;
        uint256 queueLen = withdrawalQueue.length;

        // Snapshot for invariant check
        uint256 sharesBefore = totalSupply();

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
            _burn(address(this), sharesToBurn);

            // Update state
            pendingWithdrawalShares -= sharesToBurn;
            userPendingRequests[request.requester]--;
            request.shares = 0;

            // Track withdrawal for NAV calculation
            totalWithdrawn += usdcOut;

            // Transfer USDC to requester (SafeERC20 handles non-standard tokens)
            // INVARIANT I.1: USDC only exits when shares are burned
            usdc.safeTransfer(request.requester, usdcOut);

            available -= usdcOut;
            usdcPaid += usdcOut;
            processed++;
            head++;

            emit WithdrawalFulfilled(request.requester, sharesToBurn, usdcOut, head - 1);
        }

        // INVARIANT I.5: Queue head must only advance (FIFO ordering)
        if (head < withdrawalQueueHead) revert QueueHeadRegression();
        withdrawalQueueHead = head;

        // INVARIANT I.1: Conservation of value
        // If shares were burned, totalShares decreased proportionally to USDC paid
        if (processed > 0) {
            uint256 sharesAfter = totalSupply();
            // Verify: shares decreased when USDC exited
            if (sharesAfter >= sharesBefore && usdcPaid > 0) revert SharesNotBurned();
        }

        // INVARIANT I.2: Escrow balance covers pending shares
        // Note: Balance may exceed pending if shares were donated directly to vault
        // (orphaned shares can be recovered via recoverOrphanedShares)
        if (balanceOf(address(this)) < pendingWithdrawalShares) revert EscrowBalanceMismatch();
    }

    // ============ Owner Functions ============

    // ============ Timelocked Configuration Functions ============

    /**
     * @notice Queue a multisig address change (3-day timelock)
     * @param newMultisig New multisig address
     */
    function queueMultisig(address newMultisig) external onlyOwner {
        if (newMultisig == address(0)) revert ZeroAddress();
        pendingMultisig = newMultisig;
        pendingMultisigTimestamp = block.timestamp + TIMELOCK_MULTISIG;
        emit MultisigChangeQueued(newMultisig, pendingMultisigTimestamp);
    }

    /**
     * @notice Execute a queued multisig change after timelock expires
     */
    function executeMultisig() external onlyOwner {
        if (pendingMultisigTimestamp == 0) revert NoPendingChange();
        if (block.timestamp < pendingMultisigTimestamp) revert TimelockNotExpired();
        address oldMultisig = multisig;
        multisig = pendingMultisig;
        pendingMultisig = address(0);
        pendingMultisigTimestamp = 0;
        emit MultisigChangeExecuted(oldMultisig, multisig);
    }

    /**
     * @notice Cancel a pending multisig change
     */
    function cancelMultisig() external onlyOwner {
        if (pendingMultisigTimestamp == 0) revert NoPendingChange();
        address cancelled = pendingMultisig;
        pendingMultisig = address(0);
        pendingMultisigTimestamp = 0;
        emit MultisigChangeCancelled(cancelled);
    }

    /**
     * @notice Queue a treasury address change (2-day timelock)
     * @param newTreasury New treasury address
     */
    function queueTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        pendingTreasury = newTreasury;
        pendingTreasuryTimestamp = block.timestamp + TIMELOCK_TREASURY;
        emit TreasuryChangeQueued(newTreasury, pendingTreasuryTimestamp);
    }

    /**
     * @notice Execute a queued treasury change after timelock expires
     */
    function executeTreasury() external onlyOwner {
        if (pendingTreasuryTimestamp == 0) revert NoPendingChange();
        if (block.timestamp < pendingTreasuryTimestamp) revert TimelockNotExpired();
        address oldTreasury = treasury;
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        pendingTreasuryTimestamp = 0;
        emit TreasuryChangeExecuted(oldTreasury, treasury);
    }

    /**
     * @notice Cancel a pending treasury change
     */
    function cancelTreasury() external onlyOwner {
        if (pendingTreasuryTimestamp == 0) revert NoPendingChange();
        address cancelled = pendingTreasury;
        pendingTreasury = address(0);
        pendingTreasuryTimestamp = 0;
        emit TreasuryChangeCancelled(cancelled);
    }

    /**
     * @notice Queue a fee rate change (1-day timelock)
     * @param newFeeRate New fee rate (18 decimals)
     * @dev Invariant I.4: Fee rate capped at MAX_FEE_RATE
     */
    function queueFeeRate(uint256 newFeeRate) external onlyOwner {
        if (newFeeRate > MAX_FEE_RATE) revert InvalidFeeRate();
        pendingFeeRate = newFeeRate;
        pendingFeeRateTimestamp = block.timestamp + TIMELOCK_FEE_RATE;
        emit FeeRateChangeQueued(newFeeRate, pendingFeeRateTimestamp);
    }

    /**
     * @notice Execute a queued fee rate change after timelock expires
     */
    function executeFeeRate() external onlyOwner {
        if (pendingFeeRateTimestamp == 0) revert NoPendingChange();
        if (block.timestamp < pendingFeeRateTimestamp) revert TimelockNotExpired();
        uint256 oldFeeRate = feeRate;
        feeRate = pendingFeeRate;
        pendingFeeRate = 0;
        pendingFeeRateTimestamp = 0;
        emit FeeRateChangeExecuted(oldFeeRate, feeRate);
    }

    /**
     * @notice Cancel a pending fee rate change
     */
    function cancelFeeRate() external onlyOwner {
        if (pendingFeeRateTimestamp == 0) revert NoPendingChange();
        uint256 cancelled = pendingFeeRate;
        pendingFeeRate = 0;
        pendingFeeRateTimestamp = 0;
        emit FeeRateChangeCancelled(cancelled);
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
     * @dev Callable by owner or operator for operational flexibility
     */
    function setWithdrawalBuffer(uint256 newBuffer) external onlyOperatorOrOwner {
        emit WithdrawalBufferUpdated(withdrawalBuffer, newBuffer);
        withdrawalBuffer = newBuffer;
    }

    /**
     * @notice Queue a cooldown period change (1-day timelock)
     * @param newCooldown New cooldown in seconds
     * @dev IMPORTANT: This change affects ALL pending withdrawals, including existing ones.
     *      Increasing the cooldown will delay fulfillment of requests already in the queue.
     */
    function queueCooldown(uint256 newCooldown) external onlyOwner {
        if (newCooldown < MIN_COOLDOWN || newCooldown > MAX_COOLDOWN) revert InvalidCooldown();
        pendingCooldownPeriod = newCooldown;
        pendingCooldownTimestamp = block.timestamp + TIMELOCK_COOLDOWN;
        emit CooldownChangeQueued(newCooldown, pendingCooldownTimestamp);
    }

    /**
     * @notice Execute a queued cooldown change after timelock expires
     */
    function executeCooldown() external onlyOwner {
        if (pendingCooldownTimestamp == 0) revert NoPendingChange();
        if (block.timestamp < pendingCooldownTimestamp) revert TimelockNotExpired();
        uint256 oldCooldown = cooldownPeriod;
        cooldownPeriod = pendingCooldownPeriod;
        pendingCooldownPeriod = 0;
        pendingCooldownTimestamp = 0;
        emit CooldownChangeExecuted(oldCooldown, cooldownPeriod);
    }

    /**
     * @notice Cancel a pending cooldown change
     */
    function cancelCooldown() external onlyOwner {
        if (pendingCooldownTimestamp == 0) revert NoPendingChange();
        uint256 cancelled = pendingCooldownPeriod;
        pendingCooldownPeriod = 0;
        pendingCooldownTimestamp = 0;
        emit CooldownChangeCancelled(cancelled);
    }

    /**
     * @notice Force process a specific withdrawal (emergency, skips cooldown)
     * @param requestId Request ID to process
     * @dev Invariant I.1: Still burns shares at current NAV
     * @dev WARNING: Skips FIFO order - use only in emergencies
     * @dev Callable by owner or operator for operational flexibility
     */
    function forceProcessWithdrawal(uint256 requestId) external nonReentrant onlyOperatorOrOwner {
        if (requestId >= withdrawalQueue.length) revert InvalidRequestId();

        WithdrawalRequest storage request = withdrawalQueue[requestId];
        if (request.shares == 0) revert RequestAlreadyProcessed();

        uint256 sharesToBurn = request.shares;
        uint256 usdcOut = sharesToUsdc(sharesToBurn);

        if (usdcOut > availableLiquidity()) revert InsufficientLiquidity();

        // Burn escrowed shares from vault
        _burn(address(this), sharesToBurn);

        // Update state
        pendingWithdrawalShares -= sharesToBurn;
        userPendingRequests[request.requester]--;
        request.shares = 0;

        // Track withdrawal for NAV calculation
        totalWithdrawn += usdcOut;

        // Transfer USDC (SafeERC20 handles non-standard tokens)
        usdc.safeTransfer(request.requester, usdcOut);

        // INVARIANT I.2: Escrow balance covers pending shares
        if (balanceOf(address(this)) < pendingWithdrawalShares) revert EscrowBalanceMismatch();

        emit WithdrawalForced(request.requester, sharesToBurn, usdcOut, requestId);
    }

    /**
     * @notice Cancel a queued withdrawal (emergency, or by user within grace period)
     * @param requestId Request ID to cancel
     * @dev Invariant I.2: Returns escrowed shares to original requester
     * @dev H-3: Users can cancel within CANCELLATION_WINDOW, owner can cancel anytime
     */
    function cancelWithdrawal(uint256 requestId) external nonReentrant {
        if (requestId >= withdrawalQueue.length) revert InvalidRequestId();

        WithdrawalRequest storage request = withdrawalQueue[requestId];
        if (request.shares == 0) revert RequestAlreadyProcessed();

        // H-3: Allow owner always, or requester within cancellation window
        bool isOwner = msg.sender == roleManager.owner();
        bool isRequesterInWindow = msg.sender == request.requester &&
            block.timestamp < request.requestTimestamp + CANCELLATION_WINDOW;

        if (!isOwner && !isRequesterInWindow) revert Unauthorized();

        uint256 sharesToReturn = request.shares;
        address requester = request.requester;

        // Update state first
        pendingWithdrawalShares -= sharesToReturn;
        userPendingRequests[requester]--;
        request.shares = 0;

        // Return escrowed shares to requester
        _transfer(address(this), requester, sharesToReturn);

        // INVARIANT I.2: Escrow balance covers pending shares
        if (balanceOf(address(this)) < pendingWithdrawalShares) revert EscrowBalanceMismatch();

        emit WithdrawalCancelled(requester, sharesToReturn, requestId);
    }

    /**
     * @notice Report yield and collect fees atomically
     * @param yieldDelta Change in yield (positive for gains, negative for losses)
     * @dev This is the ONLY way to report yield and collect fees. Fees are:
     *      - Collected as a percentage of positive yield only
     *      - Paid via minting shares to treasury (no USDC transfer)
     *      - Applied at report time (simple, predictable)
     *
     * Fee model: fee = positiveYield * feeRate / PRECISION
     * This is simpler than HWM-based fees - every positive yield report triggers fees.
     *
     * Safety mechanisms:
     * - Enforces MIN_YIELD_REPORT_INTERVAL (1 day) between reports
     * - If maxYieldChangePercent is set, enforces bounds to prevent misreporting
     *
     * @dev Callable by owner or operator for daily operational flexibility.
     *      Safety is maintained via maxYieldChangePercent bounds (default 0.5% of NAV).
     */
    function reportYieldAndCollectFees(int256 yieldDelta) external onlyOperatorOrOwner {
        // Enforce minimum interval between reports (prevents compounding bypass)
        if (lastYieldReportTime > 0 && block.timestamp < lastYieldReportTime + MIN_YIELD_REPORT_INTERVAL) {
            revert ReportTooSoon();
        }

        // Check yield bounds if enabled
        if (maxYieldChangePercent > 0) {
            uint256 nav = totalAssets();
            // Only enforce if vault has assets (skip on first deposit or empty vault)
            if (nav > 0) {
                uint256 absoluteDelta = yieldDelta >= 0 ? uint256(yieldDelta) : uint256(-yieldDelta);
                uint256 maxAllowed = (nav * maxYieldChangePercent) / 1e18;
                if (absoluteDelta > maxAllowed) revert YieldChangeTooLarge();
            }
        }

        // Update accumulated yield
        accumulatedYield += yieldDelta;
        lastYieldReportTime = block.timestamp;

        emit YieldReported(yieldDelta, accumulatedYield, block.timestamp);

        // Collect fees directly from positive yield
        if (yieldDelta > 0 && feeRate > 0) {
            uint256 yield = uint256(yieldDelta);
            uint256 fee = Math.mulDiv(yield, feeRate, PRECISION);

            if (fee > 0) {
                // Convert fee to shares at current price (post-yield)
                uint256 feeShares = usdcToShares(fee);
                if (feeShares > 0) {
                    _mint(treasury, feeShares);
                    emit FeeCollected(feeShares, treasury);
                }
            }
        }
    }

    /**
     * @notice Set maximum yield change percentage (safety bounds)
     * @param _maxPercent Maximum yield change as percentage of NAV (18 decimals)
     * @dev Set to 0 to disable bounds checking. Only callable by owner.
     *      Default is 1% (0.01e18). Yield deltas exceeding this % of vault NAV will revert.
     */
    function setMaxYieldChangePercent(uint256 _maxPercent) external onlyOwner {
        emit MaxYieldChangeUpdated(maxYieldChangePercent, _maxPercent);
        maxYieldChangePercent = _maxPercent;
    }

    /**
     * @notice Recover orphaned shares sent directly to vault (H-2)
     * @dev If someone accidentally transfers shares to the vault (not via requestWithdrawal),
     *      those shares become stuck. This function burns them to prevent dilution.
     *      V-3 Fix: Defensive check prevents revert on corrupted state.
     * @return recovered Amount of orphaned shares burned
     */
    function recoverOrphanedShares() external onlyOwner returns (uint256 recovered) {
        uint256 vaultShareBalance = balanceOf(address(this));

        // V-3: Defensive check - if invariant is violated, return 0 instead of reverting
        if (vaultShareBalance <= pendingWithdrawalShares) {
            return 0;
        }

        recovered = vaultShareBalance - pendingWithdrawalShares;

        _burn(address(this), recovered);
        emit OrphanedSharesRecovered(recovered);
    }

    /**
     * @notice Purge processed withdrawal entries to reclaim storage (M-1)
     * @param count Maximum number of entries to purge
     * @return purged Number of entries purged
     * @dev Clears storage for processed entries (shares=0) up to withdrawalQueueHead.
     *      This reclaims storage slots and provides gas refunds.
     *      Note: Array length doesn't shrink, but storage is cleared.
     *
     *      PUBLICLY CALLABLE: This function has no access control by design.
     *      Anyone can call it to clean up processed entries and receive gas refunds.
     *      This is safe because it only deletes already-processed entries (shares=0)
     *      and cannot affect pending or unprocessed withdrawals.
     */
    function purgeProcessedWithdrawals(uint256 count) external returns (uint256 purged) {
        uint256 head = withdrawalQueueHead;
        uint256 toPurge = count < head ? count : head;

        for (uint256 i = head - toPurge; i < head && purged < count; i++) {
            // Only purge if already processed (shares = 0) and not already purged
            if (withdrawalQueue[i].requester != address(0)) {
                delete withdrawalQueue[i];
                purged++;
            }
        }

        if (purged > 0) {
            emit WithdrawalsPurged(purged);
        }
    }

    // ============ ERC20 Overrides ============

    /**
     * @notice Override transfer to prevent accidental share loss (V-2 fix)
     * @dev Users cannot transfer shares directly to the vault address.
     *      Use requestWithdrawal() instead to properly escrow shares.
     */
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (to == address(this)) revert CannotTransferToVault();
        return super.transfer(to, amount);
    }

    /**
     * @notice Override transferFrom to prevent accidental share loss (V-2 fix)
     * @dev Users cannot transfer shares directly to the vault address.
     *      Use requestWithdrawal() instead to properly escrow shares.
     */
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (to == address(this)) revert CannotTransferToVault();
        return super.transferFrom(from, to, amount);
    }

    // ============ Internal Functions ============

    /**
     * @notice Forward excess USDC to multisig for strategy deployment
     * @dev Called after deposits to send funds exceeding withdrawalBuffer to multisig.
     *      The multisig deploys these funds to external on-chain yield strategies.
     *      withdrawalBuffer is retained in vault for immediate withdrawal liquidity.
     *      If balance <= withdrawalBuffer, no transfer occurs.
     */
    function _forwardToMultisig() internal {
        uint256 balance = usdc.balanceOf(address(this));
        if (balance > withdrawalBuffer) {
            uint256 excess = balance - withdrawalBuffer;
            usdc.safeTransfer(multisig, excess);
            emit FundsForwardedToMultisig(excess);
        }
    }

}
