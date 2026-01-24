// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IReferralRegistry} from "./interfaces/IReferralRegistry.sol";

/// @title FeeDistributor
/// @notice Automated weekly fee distribution to KOLs based on referred user yield
/// @dev Tracks yield via share price changes to prevent transfer manipulation
contract FeeDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════
    // IMMUTABLES
    // ═══════════════════════════════════════════════════════════

    IERC20 public immutable usdc;
    IReferralRegistry public immutable registry;

    // ═══════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════

    /// @notice Vault contract for balance queries
    address public vault;

    /// @notice Track shares and entry share price at initialization
    /// @dev Using shares + entry price prevents transfer manipulation attacks
    struct DepositorRecord {
        uint256 shares;          // Shares at initialization
        uint256 entrySharePrice; // Share price (scaled 1e18) when initialized
        bool initialized;
    }
    mapping(address => DepositorRecord) public depositorRecords;

    /// @notice Last distribution timestamp
    uint256 public lastDistribution;

    /// @notice Minimum period between distributions
    uint256 public distributionInterval = 7 days;

    /// @notice Protocol fee in basis points (e.g., 2000 = 20%)
    uint256 public protocolFeeBps = 2000;

    /// @notice Treasury receives remaining protocol fees
    address public treasury;

    /// @notice Total fees distributed to KOLs all-time
    uint256 public totalDistributed;

    /// @notice Keeper address for automated record updates
    address public keeper;

    /// @notice Basis points denominator
    uint256 public constant BPS_DENOMINATOR = 10000;

    /// @notice Maximum referrals to process per KOL in single distribute call
    uint256 public constant MAX_REFERRALS_PER_CALL = 100;

    // ═══════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════

    event FeesDistributed(
        uint256 indexed epoch,
        uint256 totalFees,
        uint256 kolShare,
        uint256 treasuryShare
    );
    event KOLPaid(
        address indexed kol,
        uint256 amount,
        uint256 referralCount,
        uint256 totalYield
    );
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event VaultUpdated(address indexed oldVault, address indexed newVault);
    event IntervalUpdated(uint256 oldInterval, uint256 newInterval);
    event ProtocolFeeUpdated(uint256 oldFee, uint256 newFee);
    event DepositorInitialized(address indexed depositor, uint256 shares, uint256 sharePrice);
    event DepositorRecordUpdated(address indexed depositor, uint256 oldShares, uint256 newShares, uint256 newEntryPrice);
    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);

    // ═══════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════

    constructor(
        address _usdc,
        address _vault,
        address _registry,
        address _treasury,
        address _owner
    ) Ownable(_owner) {
        require(_usdc != address(0), "Invalid USDC");
        require(_vault != address(0), "Invalid vault");
        require(_registry != address(0), "Invalid registry");
        require(_treasury != address(0), "Invalid treasury");

        usdc = IERC20(_usdc);
        vault = _vault;
        registry = IReferralRegistry(_registry);
        treasury = _treasury;
        lastDistribution = block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════
    // DISTRIBUTION (with pagination to prevent DoS)
    // ═══════════════════════════════════════════════════════════

    /// @notice Distribute fees to a single KOL - prevents unbounded loop DoS
    /// @param kol KOL address to distribute to
    /// @return payout Amount paid to KOL
    function distributeForKOL(address kol) external nonReentrant returns (uint256 payout) {
        require(
            block.timestamp >= lastDistribution + distributionInterval,
            "Too soon"
        );

        payout = _calculateAndPayKOL(kol);

        if (payout > 0) {
            totalDistributed += payout;
        }

        return payout;
    }

    /// @notice Distribute fees to multiple KOLs (batch)
    /// @param kols Array of KOL addresses
    /// @return totalKolPayouts Total paid to all KOLs
    function distributeBatch(address[] calldata kols) external nonReentrant returns (uint256 totalKolPayouts) {
        require(
            block.timestamp >= lastDistribution + distributionInterval,
            "Too soon"
        );
        require(kols.length <= 20, "Max 20 KOLs per batch");

        for (uint256 i = 0; i < kols.length; i++) {
            totalKolPayouts += _calculateAndPayKOL(kols[i]);
        }

        totalDistributed += totalKolPayouts;
        return totalKolPayouts;
    }

    /// @notice Finalize distribution epoch and sweep remaining to treasury
    /// @dev Call after all KOLs have been distributed to
    function finalizeEpoch() external nonReentrant {
        require(
            block.timestamp >= lastDistribution + distributionInterval,
            "Too soon"
        );

        lastDistribution = block.timestamp;

        // Remaining balance goes to treasury
        uint256 remaining = usdc.balanceOf(address(this));
        if (remaining > 0) {
            usdc.safeTransfer(treasury, remaining);
        }

        uint256 epoch = block.timestamp / distributionInterval;
        emit FeesDistributed(epoch, remaining, 0, remaining);
    }

    /// @notice Calculate and pay a single KOL
    /// @dev Uses share-price-based yield calculation to prevent transfer attacks
    function _calculateAndPayKOL(address kol) internal returns (uint256 payout) {
        (
            ,
            uint16 feeShareBps,
            bool active,
            ,
        ) = registry.kols(kol);

        if (!active) return 0;

        address[] memory referrals = registry.getReferrals(kol);
        if (referrals.length == 0) return 0;

        uint256 currentSharePrice = _getSharePrice();
        if (currentSharePrice == 0) return 0;

        uint256 totalYield;
        uint256 processCount = referrals.length > MAX_REFERRALS_PER_CALL
            ? MAX_REFERRALS_PER_CALL
            : referrals.length;

        for (uint256 i = 0; i < processCount; i++) {
            address depositor = referrals[i];
            DepositorRecord storage record = depositorRecords[depositor];

            if (!record.initialized) continue;

            // Get current share balance
            uint256 currentShares = _getDepositorShares(depositor);

            // Use minimum of recorded vs current shares
            // - If sold/transferred: only count yield on remaining shares
            // - If bought more: don't count new shares (prevents inflation attack)
            uint256 effectiveShares = currentShares < record.shares
                ? currentShares
                : record.shares;

            // Calculate yield based on share price appreciation only
            if (currentSharePrice > record.entrySharePrice && effectiveShares > 0) {
                uint256 priceGain = currentSharePrice - record.entrySharePrice;
                // yield = effectiveShares * priceGain / 1e18 (to get USDC value)
                uint256 yieldUsdc = (effectiveShares * priceGain) / 1e18;
                totalYield += yieldUsdc;
            }

            // Update record for next period
            record.shares = currentShares;
            record.entrySharePrice = currentSharePrice;
        }

        if (totalYield == 0) return 0;

        // Protocol fee on yield
        uint256 protocolFee = (totalYield * protocolFeeBps) / BPS_DENOMINATOR;

        // KOL's share of protocol fee
        payout = (protocolFee * feeShareBps) / BPS_DENOMINATOR;

        if (payout > 0) {
            uint256 balance = usdc.balanceOf(address(this));
            if (balance >= payout) {
                usdc.safeTransfer(kol, payout);
                registry.accrueEarnings(kol, payout);
                emit KOLPaid(kol, payout, processCount, totalYield);
            }
        }

        return payout;
    }

    /// @notice Get current share price from vault
    function _getSharePrice() internal view returns (uint256) {
        (bool success, bytes memory data) = vault.staticcall(
            abi.encodeWithSignature("sharePrice()")
        );
        if (!success || data.length == 0) return 0;
        return abi.decode(data, (uint256));
    }

    /// @notice Get depositor's current share balance from vault
    function _getDepositorShares(address depositor) internal view returns (uint256) {
        (bool success, bytes memory data) = vault.staticcall(
            abi.encodeWithSignature("balanceOf(address)", depositor)
        );
        if (!success || data.length == 0) return 0;
        return abi.decode(data, (uint256));
    }

    // ═══════════════════════════════════════════════════════════
    // DEPOSITOR INITIALIZATION
    // ═══════════════════════════════════════════════════════════

    /// @notice Initialize depositor tracking - should be called when referral is recorded
    /// @dev Called by registry or owner to set baseline for yield tracking
    function initializeDepositor(address depositor) external {
        require(
            msg.sender == address(registry) || msg.sender == owner(),
            "Not authorized"
        );
        _initializeDepositor(depositor);
    }

    /// @notice Batch initialize depositors
    function initializeDepositors(address[] calldata depositors) external onlyOwner {
        for (uint256 i = 0; i < depositors.length; i++) {
            _initializeDepositor(depositors[i]);
        }
    }

    function _initializeDepositor(address depositor) internal {
        if (depositorRecords[depositor].initialized) return;

        uint256 shares = _getDepositorShares(depositor);
        uint256 sharePrice = _getSharePrice();

        depositorRecords[depositor] = DepositorRecord({
            shares: shares,
            entrySharePrice: sharePrice,
            initialized: true
        });

        emit DepositorInitialized(depositor, shares, sharePrice);
    }

    // ═══════════════════════════════════════════════════════════
    // KEEPER FUNCTIONS (for tracking additional deposits)
    // ═══════════════════════════════════════════════════════════

    /// @notice Update depositor record when they make additional deposits
    /// @dev Called by keeper when vault Deposit events are detected for referred users
    /// @param depositor Address of the depositor who made additional deposit
    function updateDepositorRecord(address depositor) external {
        require(msg.sender == keeper || msg.sender == owner(), "Not keeper");

        // Skip if depositor has no referrer
        if (registry.referrerOf(depositor) == address(0)) return;

        DepositorRecord storage record = depositorRecords[depositor];

        // Skip if not initialized
        if (!record.initialized) return;

        uint256 currentShares = _getDepositorShares(depositor);
        uint256 currentPrice = _getSharePrice();

        // Only update if shares increased (new deposit)
        if (currentShares > record.shares) {
            uint256 oldShares = record.shares;

            // Calculate weighted average entry price
            // oldValue = oldShares * oldEntryPrice
            // newValue = newShares * currentPrice
            // newEntryPrice = (oldValue + newValue) / totalShares
            uint256 oldValue = record.shares * record.entrySharePrice;
            uint256 newShares = currentShares - record.shares;
            uint256 newValue = newShares * currentPrice;

            record.entrySharePrice = (oldValue + newValue) / currentShares;
            record.shares = currentShares;

            emit DepositorRecordUpdated(depositor, oldShares, currentShares, record.entrySharePrice);
        }
    }

    /// @notice Batch update depositor records
    /// @param depositors Array of depositor addresses
    function updateDepositorRecords(address[] calldata depositors) external {
        require(msg.sender == keeper || msg.sender == owner(), "Not keeper");

        for (uint256 i = 0; i < depositors.length; i++) {
            address depositor = depositors[i];

            if (registry.referrerOf(depositor) == address(0)) continue;

            DepositorRecord storage record = depositorRecords[depositor];
            if (!record.initialized) continue;

            uint256 currentShares = _getDepositorShares(depositor);
            uint256 currentPrice = _getSharePrice();

            if (currentShares > record.shares) {
                uint256 oldShares = record.shares;
                uint256 oldValue = record.shares * record.entrySharePrice;
                uint256 newShares = currentShares - record.shares;
                uint256 newValue = newShares * currentPrice;

                record.entrySharePrice = (oldValue + newValue) / currentShares;
                record.shares = currentShares;

                emit DepositorRecordUpdated(depositor, oldShares, currentShares, record.entrySharePrice);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    /// @notice Update treasury address
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Invalid treasury");
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    /// @notice Update keeper address
    function setKeeper(address _keeper) external onlyOwner {
        emit KeeperUpdated(keeper, _keeper);
        keeper = _keeper;
    }

    /// @notice Update vault address
    function setVault(address _vault) external onlyOwner {
        require(_vault != address(0), "Invalid vault");
        emit VaultUpdated(vault, _vault);
        vault = _vault;
    }

    /// @notice Update distribution interval
    function setDistributionInterval(uint256 _interval) external onlyOwner {
        require(_interval >= 1 days, "Min 1 day");
        require(_interval <= 30 days, "Max 30 days");
        emit IntervalUpdated(distributionInterval, _interval);
        distributionInterval = _interval;
    }

    /// @notice Update protocol fee basis points
    function setProtocolFeeBps(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 5000, "Max 50%");
        emit ProtocolFeeUpdated(protocolFeeBps, _feeBps);
        protocolFeeBps = _feeBps;
    }

    /// @notice Rescue tokens sent to this contract by mistake (excludes USDC)
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        require(token != address(usdc), "Cannot rescue USDC");
        IERC20(token).safeTransfer(owner(), amount);
    }

    // ═══════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    /// @notice Preview KOL earnings for current period (before distribution)
    function previewKOLEarnings(address kol) external view returns (uint256) {
        (
            ,
            uint16 feeShareBps,
            bool active,
            ,
        ) = registry.kols(kol);

        if (!active) return 0;

        address[] memory referrals = registry.getReferrals(kol);
        if (referrals.length == 0) return 0;

        uint256 currentSharePrice = _getSharePrice();
        if (currentSharePrice == 0) return 0;

        uint256 totalYield;

        for (uint256 i = 0; i < referrals.length && i < MAX_REFERRALS_PER_CALL; i++) {
            address depositor = referrals[i];
            DepositorRecord storage record = depositorRecords[depositor];

            if (!record.initialized) continue;

            // Use minimum of recorded vs current shares
            uint256 currentShares = _getDepositorShares(depositor);
            uint256 effectiveShares = currentShares < record.shares
                ? currentShares
                : record.shares;

            if (currentSharePrice > record.entrySharePrice && effectiveShares > 0) {
                uint256 priceGain = currentSharePrice - record.entrySharePrice;
                uint256 yieldUsdc = (effectiveShares * priceGain) / 1e18;
                totalYield += yieldUsdc;
            }
        }

        if (totalYield == 0) return 0;

        uint256 protocolFee = (totalYield * protocolFeeBps) / BPS_DENOMINATOR;
        return (protocolFee * feeShareBps) / BPS_DENOMINATOR;
    }

    /// @notice Get total AUM from a KOL's referrals
    function getKOLTotalAUM(address kol) external view returns (uint256 totalAUM) {
        address[] memory referrals = registry.getReferrals(kol);
        uint256 sharePrice = _getSharePrice();

        for (uint256 i = 0; i < referrals.length; i++) {
            uint256 shares = _getDepositorShares(referrals[i]);
            totalAUM += (shares * sharePrice) / 1e18;
        }
    }

    /// @notice Get total yield generated by a KOL's referrals this period
    function previewKOLReferralYield(address kol) external view returns (uint256 totalYield) {
        address[] memory referrals = registry.getReferrals(kol);
        uint256 currentSharePrice = _getSharePrice();

        for (uint256 i = 0; i < referrals.length && i < MAX_REFERRALS_PER_CALL; i++) {
            address depositor = referrals[i];
            DepositorRecord storage record = depositorRecords[depositor];

            if (!record.initialized) continue;

            // Use minimum of recorded vs current shares
            uint256 currentShares = _getDepositorShares(depositor);
            uint256 effectiveShares = currentShares < record.shares
                ? currentShares
                : record.shares;

            if (currentSharePrice > record.entrySharePrice && effectiveShares > 0) {
                uint256 priceGain = currentSharePrice - record.entrySharePrice;
                totalYield += (effectiveShares * priceGain) / 1e18;
            }
        }
    }

    /// @notice Next distribution timestamp
    function nextDistribution() external view returns (uint256) {
        return lastDistribution + distributionInterval;
    }

    /// @notice Check if distribution is available
    function canDistribute() external view returns (bool) {
        return block.timestamp >= lastDistribution + distributionInterval;
    }

    /// @notice Time until next distribution
    function timeUntilDistribution() external view returns (uint256) {
        uint256 next = lastDistribution + distributionInterval;
        if (block.timestamp >= next) return 0;
        return next - block.timestamp;
    }
}
