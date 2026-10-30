// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice What a vault asks when it is about to charge a fee. The policy is replaceable (registry, timelock), so the
/// whole fee structure can change without touching a vault. A vault never trusts the answer blindly: it clamps the
/// total of the legs to its own immutable ceiling for that kind, ignores legs beyond MAX_FEE_LEGS, and charges
/// nothing if the call fails or returns malformed data.
interface IPandaFeePolicy {
    struct FeeLeg {
        address to;  // who receives this part of the fee
        uint16 bps;  // share of the charged amount, in basis points
    }

    /// @param kind 0 = REWARD (AERO rewards), 1 = DEPOSIT (principal in), 2 = WITHDRAW (principal out),
    ///             3 = ZAP_SWAP (swap the owner asked for), 4 = REBALANCE_SWAP (keeper swap), 5 = COMPOUND_SWAP
    /// @param user the position owner the fee is charged to (for staking discounts)
    function feeLegs(uint8 kind, address user) external view returns (FeeLeg[] memory);
}
