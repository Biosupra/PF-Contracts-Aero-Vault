// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Test-only contracts for PandaReferrals and PandaTvlReader. Never deployed to a live network.

contract MockVaultList {
    address[] internal _vaults;
    function add(address v) external { _vaults.push(v); }
    function vaults() external view returns (address[] memory) { return _vaults; }
    function isVault(address v) external view returns (bool) {
        for (uint256 i = 0; i < _vaults.length; i++) if (_vaults[i] == v) return true;
        return false;
    }
}

contract MockToken6 {
    function decimals() external pure returns (uint8) { return 6; }
}

contract MockNfpm {
    struct P { int24 lo; int24 hi; uint128 liq; }
    mapping(uint256 => P) public pos;
    function set(uint256 id, int24 lo, int24 hi, uint128 liq) external { pos[id] = P(lo, hi, liq); }
    function positions(uint256 id) external view returns (
        uint96, address, address, address, int24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        P memory p = pos[id];
        return (0, address(0), address(0), address(0), 50, p.lo, p.hi, p.liq, 0, 0, 0, 0);
    }
}

/// @dev The vault views PandaReferrals and PandaTvlReader read: an ordered list of open position ids with owners,
/// reserves, the pool's TWAP tick, token order and token B. Removal is swap-and-pop, like EnumerableSet.
contract MockVaultPositions {
    uint256[] internal _open;
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => uint256) public resA;
    mapping(uint256 => uint256) public resB;
    address public positionManager;
    address public tokenB;
    address public tokenA = address(0xA);
    bool public aIsToken0 = true;
    int24 public twap;
    bool public twapBroken;

    constructor(address nfpm, address tokenB_, int24 twap_) { positionManager = nfpm; tokenB = tokenB_; twap = twap_; }
    function addPosition(uint256 id, address owner, uint256 ra, uint256 rb) external { _open.push(id); ownerOf[id] = owner; resA[id] = ra; resB[id] = rb; }
    function addMany(uint256 firstId, uint256 count, address owner) external {
        for (uint256 i = 0; i < count; i++) { _open.push(firstId + i); ownerOf[firstId + i] = owner; }
    }
    function removeAt(uint256 i) external { _open[i] = _open[_open.length - 1]; _open.pop(); }
    function setTwap(int24 t) external { twap = t; }
    function setTwapBroken(bool b) external { twapBroken = b; }
    function openPositionCount() external view returns (uint256) { return _open.length; }
    function openPositionAt(uint256 i) external view returns (uint256) { return _open[i]; }
    function positionInfo(uint256 id) external view returns (address owner, bool isZap, bool autoCompound) { return (ownerOf[id], false, false); }
    function reserves(uint256 id) external view returns (uint256 a, uint256 b, uint256 aero) { return (resA[id], resB[id], 0); }
    function spotTwapTicks() external view returns (int24 spot, int24 t, uint24 maxDeviation) {
        require(!twapBroken, "TwapUnavailable");
        return (twap, twap, 100);
    }
}
