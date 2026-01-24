// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReferralRegistry {
    struct KOL {
        string handle;
        uint16 feeShareBps;
        bool active;
        uint256 totalReferred;
        uint256 totalEarned;
    }

    event KOLRegistered(address indexed kol, string handle, uint16 feeShareBps);
    event KOLUpdated(address indexed kol, uint16 feeShareBps, bool active);
    event ReferralRecorded(address indexed depositor, address indexed referrer);
    event EarningsAccrued(address indexed kol, uint256 amount);

    function kols(address kol) external view returns (
        string memory handle,
        uint16 feeShareBps,
        bool active,
        uint256 totalReferred,
        uint256 totalEarned
    );

    function handleToAddress(string calldata handle) external view returns (address);
    function referrerOf(address depositor) external view returns (address);
    function registrar() external view returns (address);

    function recordReferral(address depositor, address referrer) external;
    function recordReferralByHandle(address depositor, string calldata handle) external;
    function accrueEarnings(address kol, uint256 amount) external;

    function getReferrals(address kol) external view returns (address[] memory);
    function getReferralCount(address kol) external view returns (uint256);
    function getAllKOLs() external view returns (address[] memory);
    function isKOL(address addr) external view returns (bool);
    function resolveHandle(string calldata handle) external view returns (address);
}
