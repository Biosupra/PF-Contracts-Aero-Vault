// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Test-only stand-ins for the parts of Aero that the rehearsal (scripts/rehearse-aero-local.js) does not build from
/// Aero's public source: the LeafVoter as the CL gauge and pool see it, the factory registry, and the voting-rewards
/// factory. Aero's real CLFactory, CLPool, NonfungiblePositionManager, SwapRouter, CLGauge and CLGaugeFactory are
/// built from their source in a scratch folder outside this repo. Written for this repo; no Dromos code is copied.
/// Never deployed to a live network.

interface IMintable { function mint(address to, uint256 amount) external; }

/// @dev Emissions accrue per second for every gauge (the pool settles per timestamp); `mintEmissions` mints the AERO
/// stand-in synchronously to the recipients, as Aero's root-chain path does on Base, or reverts like an exhausted
/// ceiling when `failMint` is set.
contract RehearsalLeafVoter {
    address public immutable aero;
    uint256 public ratePerSecond;
    uint256 public base;
    uint256 public since;
    bool public failMint;
    uint256 public forfeited;
    uint256 public minted;

    constructor(address aero_, uint256 rate) { aero = aero_; ratePerSecond = rate; since = block.timestamp; }

    function _cum() internal view returns (uint256) { return base + ratePerSecond * (block.timestamp - since); }
    function setRate(uint256 r) external { base = _cum(); since = block.timestamp; ratePerSecond = r; }
    function setFailMint(bool f) external { failMint = f; }

    function settleGauge(address) external view returns (uint256) { return _cum(); }
    function projectedCumulativeRewardShare(address) external view returns (uint256) { return _cum(); }
    function mintEmissions(address[] calldata to, uint128[] calldata amounts) external {
        require(!failMint, "CeilingExceeded");
        for (uint256 i = 0; i < to.length; i++) { IMintable(aero).mint(to[i], amounts[i]); minted += amounts[i]; }
    }
    function forfeitEmissions(uint128 amount) external { forfeited += amount; }
    function isActivated(address) external pure returns (bool) { return true; }
    function hasRole(bytes32, address) external pure returns (bool) { return false; }
}

contract RehearsalFactoryRegistry {
    mapping(address => address) public targetFactoryToGaugeFactory;
    mapping(address => address) public targetToGauge;
    function setGaugeFactory(address factory, address gaugeFactory) external { targetFactoryToGaugeFactory[factory] = gaugeFactory; }
    function setGauge(address pool, address gauge) external { targetToGauge[pool] = gauge; }
    function registerTarget(address) external {}
    function emissionCap(address) external pure returns (uint256) { return type(uint128).max; }
}

contract RehearsalRewardsFactory {
    function createRewards(address, address[] memory) external view returns (address) { return address(this); }
}
