// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVault} from "./interfaces/IVault.sol";
import {IStrategyOracle} from "./interfaces/IStrategyOracle.sol";
import {IRoleManager} from "./interfaces/IRoleManager.sol";
import {VaultShare} from "./VaultShare.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
 *   - ERC20 (VaultShare): Standard token mechanics (no governance assumptions)
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
contract USDCSavingsVault is IVault, ReentrancyGuard {
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

    // Withdrawal queue
    WithdrawalRequest[] public withdrawalQueue;
    uint256 public withdrawalQueueHead; // Index of next request to process
    uint256 public pendingWithdrawalShares; // Total shares escrowed in queue
    mapping(address => uint256) public userPendingRequests; // M-1: Track pending requests per user

    // Timelock pending changes (0 = no pending change)
    uint256 public pendingFeeRate;
    uint256 public pendingFeeRateTimestamp;
    address public pendingTreasury;
    uint256 public pendingTreasuryTimestamp;
    address public pendingMultisig;
    uint256 public pendingMultisigTimestamp;
    uint256 public pendingCooldownPeriod;
    uint256 public pendingCooldownTimestamp;

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
    error Unauthorized();
    error TooManyPendingRequests();
    error NotAContract();
    // Invariant violation errors (should never occur if code is correct)
    error EscrowBalanceMismatch();
    error SharesNotBurned();
    error FeeExceedsProfit();
    error QueueHeadRegression(); // I.5: FIFO ordering violated
    // Timelock errors
    error TimelockNotExpired();
    error NoPendingChange();

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
     * @param _shareName Name for the vault share token (e.g., "USDC Savings Vault Share")
     * @param _shareSymbol Symbol for the vault share token (e.g., "svUSDC")
     */
    constructor(
        address _usdc,
        address _strategyOracle,
        address _roleManager,
        address _multisig,
        address _treasury,
        uint256 _feeRate,
        uint256 _cooldownPeriod,
        string memory _shareName,
        string memory _shareSymbol
    ) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_strategyOracle == address(0)) revert ZeroAddress();
        if (_roleManager == address(0)) revert ZeroAddress();
        if (_multisig == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_usdc.code.length == 0) revert NotAContract();
        if (_strategyOracle.code.length == 0) revert NotAContract();
        if (_roleManager.code.length == 0) revert NotAContract();
        if (_feeRate > MAX_FEE_RATE) revert InvalidFeeRate();
        if (_cooldownPeriod < MIN_COOLDOWN || _cooldownPeriod > MAX_COOLDOWN) revert InvalidCooldown();

        usdc = IERC20(_usdc);
        strategyOracle = IStrategyOracle(_strategyOracle);
        roleManager = IRoleManager(_roleManager);
        shares = new VaultShare(address(this), _shareName, _shareSymbol);

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

        // Collect any pending fees before deposit
        // This ensures depositors buy at the post-fee price
        _collectFees();

        // Check per-user cap (M-2: based on current holdings value, not cumulative deposits)
        if (perUserCap > 0) {
            uint256 currentHoldingsValue = sharesToUsdc(shares.balanceOf(msg.sender));
            if (currentHoldingsValue + usdcAmount > perUserCap) {
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

        // M-1: Check per-user pending request limit
        if (userPendingRequests[msg.sender] >= MAX_PENDING_PER_USER) revert TooManyPendingRequests();

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
        userPendingRequests[msg.sender]++;

        // INVARIANT I.2: Verify escrow balance matches pending shares
        if (shares.balanceOf(address(this)) < pendingWithdrawalShares) revert EscrowBalanceMismatch();

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
            userPendingRequests[request.requester]--;
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

        // INVARIANT I.5: Queue head must only advance (FIFO ordering)
        if (head < withdrawalQueueHead) revert QueueHeadRegression();
        withdrawalQueueHead = head;

        // INVARIANT I.1: Conservation of value
        // If shares were burned, totalShares decreased proportionally to USDC paid
        if (processed > 0) {
            uint256 sharesAfter = shares.totalSupply();
            // Verify: shares decreased when USDC exited
            if (sharesAfter >= sharesBefore && usdcPaid > 0) revert SharesNotBurned();
        }

        // INVARIANT I.2: Escrow balance covers pending shares
        // Note: Balance may exceed pending if shares were donated directly to vault
        // (orphaned shares can be recovered via recoverOrphanedShares)
        if (shares.balanceOf(address(this)) < pendingWithdrawalShares) revert EscrowBalanceMismatch();
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
        userPendingRequests[request.requester]--;
        request.shares = 0;

        // Track withdrawal for NAV calculation
        totalWithdrawn += usdcOut;

        // Transfer USDC
        bool success = usdc.transfer(request.requester, usdcOut);
        if (!success) revert TransferFailed();

        // INVARIANT I.2: Escrow balance covers pending shares
        if (shares.balanceOf(address(this)) < pendingWithdrawalShares) revert EscrowBalanceMismatch();

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
        bool success = shares.transfer(requester, sharesToReturn);
        if (!success) revert TransferFailed();

        // INVARIANT I.2: Escrow balance covers pending shares
        if (shares.balanceOf(address(this)) < pendingWithdrawalShares) revert EscrowBalanceMismatch();

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

    /**
     * @notice Reset price HWM to current share price (M-4 emergency fix)
     * @dev Use if HWM was incorrectly set due to oracle error or misreporting.
     *      This allows fee collection to resume from current price.
     *      WARNING: Should only be used in emergencies as it may skip owed fees.
     */
    function resetPriceHWM() external onlyOwner {
        uint256 oldHWM = priceHighWaterMark;
        priceHighWaterMark = sharePrice();
        emit PriceHWMUpdated(oldHWM, priceHighWaterMark);
    }

    /**
     * @notice Report yield and collect fees atomically
     * @param yieldDelta Change in yield (positive for gains, negative for losses)
     * @dev This is the RECOMMENDED way to report yield. It ensures:
     *      1. Yield is reported to the oracle
     *      2. Fees are collected immediately (no gap for arbitrage)
     *
     * Note: Requires this vault to be set as authorized in StrategyOracle via setVault()
     */
    function reportYieldAndCollectFees(int256 yieldDelta) external onlyOwner {
        // Report yield to oracle (vault must be authorized via strategyOracle.setVault())
        strategyOracle.reportYield(yieldDelta);

        // Collect fees immediately - no gap between yield report and fee collection
        _collectFees();
    }

    /**
     * @notice Recover orphaned shares sent directly to vault (H-2)
     * @dev If someone accidentally transfers shares to the vault (not via requestWithdrawal),
     *      those shares become stuck. This function burns them to prevent dilution.
     * @return recovered Amount of orphaned shares burned
     */
    function recoverOrphanedShares() external onlyOwner returns (uint256 recovered) {
        uint256 vaultShareBalance = shares.balanceOf(address(this));
        recovered = vaultShareBalance - pendingWithdrawalShares;

        if (recovered > 0) {
            shares.burn(address(this), recovered);
            emit OrphanedSharesRecovered(recovered);
        }
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
        // (priceGain is in 18 decimals, shares in 18 decimals)
        uint256 profit = (priceGain * totalShareSupply) / PRECISION;

        // Fee is percentage of profit
        uint256 fee = (profit * feeRate) / PRECISION;

        // INVARIANT I.4: Fee cannot exceed profit
        if (fee > profit) revert FeeExceedsProfit();

        // C-1 Fix: Guard against division by zero or invalid state
        // Skip fee collection if fee >= NAV (prevents revert, preserves liveness)
        uint256 currentNav = totalAssets();
        if (fee == 0 || fee >= currentNav) {
            // Update HWM even if no fees collected to prevent re-processing
            priceHighWaterMark = sharePrice();
            return;
        }

        // INVARIANT I.4: Pay fee by minting shares to treasury
        // feeShares = fee / currentPrice (in proper decimals)
        // This dilutes existing holders proportionally
        uint256 feeShares = (fee * totalShareSupply) / (currentNav - fee);
        if (feeShares > 0) {
            shares.mint(treasury, feeShares);
            emit FeeCollected(feeShares, treasury);
        }

        // Update HWM to POST-dilution price
        // This ensures next cycle only fees NEW gains
        uint256 oldHWM = priceHighWaterMark;
        priceHighWaterMark = sharePrice();
        emit PriceHWMUpdated(oldHWM, priceHighWaterMark);
    }
}
