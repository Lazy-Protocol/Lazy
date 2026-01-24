// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IReferralRegistry} from "./interfaces/IReferralRegistry.sol";

/// @title ReferralRegistry
/// @notice Whitelist-only KOL referral tracking for Lazy Protocol
/// @dev Only owner can register KOLs. Referrals are immutable once set.
contract ReferralRegistry is IReferralRegistry, Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;

    // ═══════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════

    /// @notice KOL address => KOL data
    mapping(address => KOL) private _kols;

    /// @notice Handle string => KOL address (for URL lookup)
    mapping(string => address) public handleToAddress;

    /// @notice Depositor => referrer (immutable once set)
    mapping(address => address) public referrerOf;

    /// @notice KOL => set of referred depositors
    mapping(address => EnumerableSet.AddressSet) private _referrals;

    /// @notice All registered KOL addresses
    EnumerableSet.AddressSet private _allKols;

    /// @notice Authorized address for recording referrals (FeeDistributor or relayer)
    address public registrar;

    // ═══════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════

    constructor(address _owner) Ownable(_owner) {}

    // ═══════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    /// @notice Event for registrar changes
    event RegistrarUpdated(address indexed oldRegistrar, address indexed newRegistrar);

    /// @notice Set the authorized registrar address
    /// @param _registrar Address that can record referrals
    function setRegistrar(address _registrar) external onlyOwner {
        require(_registrar != address(0), "Invalid registrar");
        emit RegistrarUpdated(registrar, _registrar);
        registrar = _registrar;
    }

    /// @notice Convert string to lowercase to prevent handle collisions
    function _toLower(string memory str) internal pure returns (string memory) {
        bytes memory bStr = bytes(str);
        for (uint256 i = 0; i < bStr.length; i++) {
            // ASCII A-Z is 0x41-0x5A, convert to lowercase by adding 32
            if (bStr[i] >= 0x41 && bStr[i] <= 0x5A) {
                bStr[i] = bytes1(uint8(bStr[i]) + 32);
            }
        }
        return str;
    }

    /// @notice Register a new KOL (whitelist-only)
    /// @param kol KOL's wallet address for payouts
    /// @param handle URL handle (e.g., "alice" for ?ref=alice) - will be lowercased
    /// @param feeShareBps Basis points of protocol fee to share (e.g., 2500 = 25%)
    function registerKOL(
        address kol,
        string calldata handle,
        uint16 feeShareBps
    ) external onlyOwner {
        require(kol != address(0), "Invalid address");
        require(bytes(handle).length > 0 && bytes(handle).length <= 32, "Invalid handle");
        require(feeShareBps <= 5000, "Max 50% share");
        require(!_allKols.contains(kol), "KOL exists");

        // Normalize handle to lowercase
        string memory normalizedHandle = _toLower(handle);
        require(handleToAddress[normalizedHandle] == address(0), "Handle taken");

        _kols[kol] = KOL({
            handle: normalizedHandle,
            feeShareBps: feeShareBps,
            active: true,
            totalReferred: 0,
            totalEarned: 0
        });

        handleToAddress[normalizedHandle] = kol;
        _allKols.add(kol);

        emit KOLRegistered(kol, normalizedHandle, feeShareBps);
    }

    /// @notice Update KOL fee share or active status
    /// @param kol KOL address
    /// @param feeShareBps New fee share in basis points
    /// @param active Whether KOL can receive new referrals
    function updateKOL(
        address kol,
        uint16 feeShareBps,
        bool active
    ) external onlyOwner {
        require(_allKols.contains(kol), "KOL not found");
        require(feeShareBps <= 5000, "Max 50% share");

        _kols[kol].feeShareBps = feeShareBps;
        _kols[kol].active = active;

        emit KOLUpdated(kol, feeShareBps, active);
    }

    // ═══════════════════════════════════════════════════════════
    // REFERRAL RECORDING
    // ═══════════════════════════════════════════════════════════

    modifier onlyRegistrar() {
        require(msg.sender == registrar || msg.sender == owner(), "Not registrar");
        _;
    }

    /// @notice Record a referral relationship
    /// @dev Only sets once per depositor, cannot be changed
    /// @param depositor Address of the depositor
    /// @param referrer KOL address who referred them
    function recordReferral(address depositor, address referrer) external onlyRegistrar {
        // Skip if already has referrer
        if (referrerOf[depositor] != address(0)) return;
        // Skip if referrer is not an active KOL
        if (!_kols[referrer].active) return;
        // Skip self-referral
        if (depositor == referrer) return;

        referrerOf[depositor] = referrer;
        // Only increment counter if actually added (prevents double-counting)
        if (_referrals[referrer].add(depositor)) {
            _kols[referrer].totalReferred++;
        }

        emit ReferralRecorded(depositor, referrer);
    }

    /// @notice Record referral by handle string (for frontend relay)
    /// @param depositor Address of the depositor
    /// @param handle KOL's URL handle (will be lowercased for lookup)
    function recordReferralByHandle(
        address depositor,
        string calldata handle
    ) external onlyRegistrar {
        // Normalize handle for lookup
        string memory normalizedHandle = _toLower(handle);
        address referrer = handleToAddress[normalizedHandle];
        if (referrer == address(0)) return;

        // Skip if already has referrer
        if (referrerOf[depositor] != address(0)) return;
        // Skip if referrer is not active
        if (!_kols[referrer].active) return;
        // Skip self-referral
        if (depositor == referrer) return;

        referrerOf[depositor] = referrer;
        // Only increment counter if actually added (prevents double-counting)
        if (_referrals[referrer].add(depositor)) {
            _kols[referrer].totalReferred++;
        }

        emit ReferralRecorded(depositor, referrer);
    }

    // ═══════════════════════════════════════════════════════════
    // FEE DISTRIBUTION (called by FeeDistributor)
    // ═══════════════════════════════════════════════════════════

    /// @notice Record earnings accrued to a KOL
    /// @param kol KOL address
    /// @param amount USDC amount earned
    function accrueEarnings(address kol, uint256 amount) external onlyRegistrar {
        _kols[kol].totalEarned += amount;
        emit EarningsAccrued(kol, amount);
    }

    // ═══════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    /// @notice Get KOL data
    function kols(address kol) external view returns (
        string memory handle,
        uint16 feeShareBps,
        bool active,
        uint256 totalReferred,
        uint256 totalEarned
    ) {
        KOL storage k = _kols[kol];
        return (k.handle, k.feeShareBps, k.active, k.totalReferred, k.totalEarned);
    }

    /// @notice Get all depositors referred by a KOL
    function getReferrals(address kol) external view returns (address[] memory) {
        return _referrals[kol].values();
    }

    /// @notice Get count of depositors referred by a KOL
    function getReferralCount(address kol) external view returns (uint256) {
        return _referrals[kol].length();
    }

    /// @notice Get all registered KOL addresses
    function getAllKOLs() external view returns (address[] memory) {
        return _allKols.values();
    }

    /// @notice Check if address is an active KOL
    function isKOL(address addr) external view returns (bool) {
        return _kols[addr].active;
    }

    /// @notice Resolve handle to KOL address
    function resolveHandle(string calldata handle) external view returns (address) {
        return handleToAddress[handle];
    }

    /// @notice Get KOL count
    function getKOLCount() external view returns (uint256) {
        return _allKols.length();
    }
}
