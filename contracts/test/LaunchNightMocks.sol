// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./AeroMocks.sol";

/// Test-only additions to the Aero stand-ins (AeroMocks.sol) for the launch-night dry run (scripts/launch-night.js on a
/// local Hardhat node): the reads launch night makes that the vault itself never needs. Shapes follow the DEPLOYED Base
/// ABIs (test/fixtures/aero-base-abi.json): CLFactory.tickSpacings() -> int24[], CLPool.liquidity() -> uint128,
/// LeafVoter.isActivated(address) -> bool, CLGaugeFactory.emissionCap(address) -> uint128 / isGauge / nft. Written for
/// this repo; no Dromos code is copied. Never deployed to a live network.

contract LaunchCLFactory is MockCLFactory {
    int24[] internal _spacings;
    address[] public allPools;
    constructor(int24[] memory spacings) { _spacings = spacings; }
    function tickSpacings() external view returns (int24[] memory) { return _spacings; }
    function addPool(address a, address b, int24 ts, address pool) external {
        this.setPool(a, b, ts, pool);
        allPools.push(pool);
    }
    function allPoolsLength() external view returns (uint256) { return allPools.length; }
}

contract LaunchCLPool is MockCLPool {
    uint128 public liquidity;
    constructor(address t0, address t1, int24 ts, address factory_) MockCLPool(t0, t1, ts, factory_) {}
    function setLiquidity(uint128 l) external { liquidity = l; }
}

contract LaunchLeafVoter is MockLeafVoter {
    mapping(address => bool) public isActivated;
    constructor(MockAeroToken aero_) MockLeafVoter(aero_) {}
    function setActivated(address gauge, bool on) external { isActivated[gauge] = on; }
}

contract LaunchGaugeFactory is MockGaugeFactory {
    address public nft;
    mapping(address => uint128) public emissionCap;
    mapping(address => bool) public isGauge;
    constructor(address nft_) { nft = nft_; }
    function setEmissionCap(address gauge, uint128 cap) external { emissionCap[gauge] = cap; }
    function setIsGauge(address gauge, bool on) external { isGauge[gauge] = on; }
}
