// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IPandaRegistry.sol";

interface IRegistryVaults {
    function vaults() external view returns (address[] memory);
}

interface IVaultPositions {
    function openPositionCount() external view returns (uint256);
    function openPositionAt(uint256 i) external view returns (uint256);
    function positionInfo(uint256 id) external view returns (address owner, bool isZap, bool autoCompound);
}

/**
 * @title PandaReferrals
 * @notice The referral program, fully on chain (owner 2026-10-10). A wallet accepts a referrer once, before its first
 * deposit; from then on the fee policy pays the referrer a flat share of every reward fee that wallet is charged,
 * instantly and in AERO, as one more leg of the fee. No ledger, no rounds, no robot: this contract only answers
 * "who referred this wallet".
 *
 * Rules, fixed at deploy (no owner, no admin):
 *  - one referrer per wallet, forever; a wallet can't refer itself, two wallets can't refer each other, and a Panda
 *    vault can't be named as referrer (the vault skips fee legs addressed to itself, which would hand the referral
 *    share back to the referee);
 *  - a wallet that already holds a position in any registered Panda vault can't accept a referrer (the program is for
 *    new depositors; checked over the first MAX_CHECKED_POSITIONS open positions, see `hasPosition`). A wallet with an
 *    open position can still BE a referrer.
 * The referrals made under the website's earlier program are carried over once, in the deploy transaction (`seed`),
 * so those referrers keep their referees and earn from the first fee under the new policy; after that the list can
 * only grow through `accept`. The referrer's share is the fee policy's business (`referralShareBps`); this contract
 * has no rates.
 */
contract PandaReferrals {
    IPandaRegistry public immutable registry;

    mapping(address => address) public referrerOf;
    mapping(address => uint256) public refereeCount;
    uint256 public totalReferrals;

    error AlreadyReferred();
    error BadReferrer();
    error AlreadyDeposited();

    event Referred(address indexed referee, address indexed referrer);

    /// @param seedReferees / seedReferrers the earlier program's pairs, recorded as if accepted (same rules, minus the
    /// position check: these wallets already deposited under the old program). Public in the deploy transaction.
    constructor(address registry_, address[] memory seedReferees, address[] memory seedReferrers) {
        require(registry_ != address(0), "registry");
        require(seedReferees.length == seedReferrers.length, "seed");
        registry = IPandaRegistry(registry_);
        for (uint256 i = 0; i < seedReferees.length; i++) {
            address referee = seedReferees[i];
            address referrer = seedReferrers[i];
            if (referee == address(0) || referrer == address(0) || referee == referrer) revert BadReferrer();
            if (referrerOf[referee] != address(0)) revert AlreadyReferred();
            if (referrerOf[referrer] == referee) revert BadReferrer();
            referrerOf[referee] = referrer;
            refereeCount[referrer] += 1;
            totalReferrals += 1;
            emit Referred(referee, referrer);
        }
    }

    /// @notice Record `referrer` as the caller's referrer. Once, before the caller's first deposit.
    function accept(address referrer) external {
        if (referrerOf[msg.sender] != address(0)) revert AlreadyReferred();
        if (referrer == address(0) || referrer == msg.sender || referrerOf[referrer] == msg.sender) revert BadReferrer();
        if (registry.isVault(referrer)) revert BadReferrer();
        if (hasPosition(msg.sender)) revert AlreadyDeposited();
        referrerOf[msg.sender] = referrer;
        refereeCount[referrer] += 1;
        totalReferrals += 1;
        emit Referred(msg.sender, referrer);
    }

    /// @notice The most open positions `hasPosition` reads (about 6,700 gas each). Base caps one transaction at
    /// 16,777,216 gas (measured 2026-10-11), so an unbounded check would make `accept` impossible for everyone once the
    /// vaults hold roughly 2,400 positions. Up to this many positions the rule is enforced in full; beyond it, positions
    /// past the first MAX_CHECKED_POSITIONS (in registry and list order) are not read, so a wallet whose positions are
    /// all past them is not refused: the program keeps working for everyone rather than stopping.
    uint256 public constant MAX_CHECKED_POSITIONS = 1000;

    /// @notice Whether `user` owns one of the first MAX_CHECKED_POSITIONS open positions of the registered vaults
    /// (every open position while the vaults hold no more than that; read from the vaults themselves).
    function hasPosition(address user) public view returns (bool) {
        address[] memory vaults = IRegistryVaults(address(registry)).vaults();
        uint256 checked;
        for (uint256 v = 0; v < vaults.length; v++) {
            IVaultPositions vault = IVaultPositions(vaults[v]);
            uint256 n = vault.openPositionCount();
            for (uint256 i = 0; i < n; i++) {
                if (checked == MAX_CHECKED_POSITIONS) return false;
                checked++;
                (address owner,,) = vault.positionInfo(vault.openPositionAt(i));
                if (owner == user) return true;
            }
        }
        return false;
    }
}
