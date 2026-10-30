// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IPandaFeePolicy.sol";
import "../libraries/PandaVaultLib.sol";

/// Test-only contracts. Never deployed to a live network.

contract MockERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev ERC20 whose transfers to one blocked address fail (like a USDC blacklist).
contract BlockingERC20 is ERC20 {
    address public blocked;
    constructor() ERC20("Blocking", "BLK") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setBlocked(address a) external { blocked = a; }
    function _update(address from, address to, uint256 value) internal override {
        require(to != blocked, "blocked");
        super._update(from, to, value);
    }
}

contract MockDiscountSource {
    mapping(address => uint256) public stakeOf;
    mapping(address => uint256) public passesOf;
    function set(address user, uint256 stake, uint256 passes) external { stakeOf[user] = stake; passesOf[user] = passes; }
    function activeStakeOf(address user) external view returns (uint256) { return stakeOf[user]; }
    function activePassLevel(address user) external view returns (uint256) { return passesOf[user]; }
}

/// @dev Registry stand-in with only what PandaFeePolicy and PandaVaultLib.getLegs read.
contract MockFeeRegistry {
    address public feePolicy;
    address public keeper;
    address public daoTreasury;
    bool public shutdown;
    function set(address policy, address keeper_, address treasury_) external { feePolicy = policy; keeper = keeper_; daoTreasury = treasury_; }
    function setShutdown(bool s) external { shutdown = s; }
    function keeperOf(address) external view returns (address) { return keeper; }
    function isShutdown(address) external view returns (bool) { return shutdown; }
}

contract MockFeePolicy is IPandaFeePolicy {
    FeeLeg[] internal _legs;
    function setLegs(FeeLeg[] calldata legs) external {
        delete _legs;
        for (uint256 i = 0; i < legs.length; i++) _legs.push(legs[i]);
    }
    function feeLegs(uint8, address) external view returns (FeeLeg[] memory) { return _legs; }
}

contract RevertingPolicy {
    function feeLegs(uint8, address) external pure returns (IPandaFeePolicy.FeeLeg[] memory) { revert("no"); }
}

contract GasBurnerPolicy {
    function feeLegs(uint8, address) external view returns (IPandaFeePolicy.FeeLeg[] memory) {
        uint256 x;
        while (gasleft() > 1000) { x++; }
        return new IPandaFeePolicy.FeeLeg[](0);
    }
}

/// @dev Returns malformed ABI (wrong offset, length far beyond the data).
contract GarbagePolicy {
    fallback() external {
        assembly {
            mstore(0, 0x40)
            mstore(32, 0xffffffffffffffff)
            return(0, 64)
        }
    }
}

/// @dev Returns ~100 KB of data; the caller must not pay to copy it.
contract HugeReturnPolicy {
    fallback() external {
        assembly {
            mstore(0, 32)
            mstore(32, 4)
            return(0, 100000)
        }
    }
}

/// @dev Calls PandaVaultLib the way PandaVault does, so its fee plumbing can be tested without a fork.
contract FeeHarness {
    address public immutable registry;
    constructor(address registry_) { registry = registry_; }

    function legs(uint8 kind, address user) external view returns (address[6] memory to, uint16[6] memory bps, uint256 n, uint256 totalBps) {
        PandaVaultLib.Legs memory L = PandaVaultLib.getLegs(registry, address(this), kind, user);
        return (L.to, L.bps, L.n, L.totalBps);
    }

    function charge(uint8 kind, address user, address token, uint256 amount) external returns (uint256) {
        return PandaVaultLib.chargeKind(registry, kind, user, token, amount);
    }

    // Time fee, with the same checkpoint mapping the vault keeps per position.
    mapping(uint256 => uint256) public timeFeeCheckpoint;
    function setCheckpoint(uint256 id, uint256 t) external { timeFeeCheckpoint[id] = t; }
    function chargeTime(uint256 id, address user, address tokenA, address tokenB, uint256 a, uint256 b) external returns (uint256, uint256) {
        return PandaVaultLib.chargeTime(registry, timeFeeCheckpoint, id, user, tokenA, tokenB, a, b);
    }
}
