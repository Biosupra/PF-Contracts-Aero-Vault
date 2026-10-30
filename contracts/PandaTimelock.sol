// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title PandaTimelock
 * @notice OpenZeppelin TimelockController, unchanged. Owns PandaRegistry and PandaStaking.
 *
 * Intended wiring (see scripts/deploy.js):
 *   proposers  = [multisig]      the Safe schedules changes
 *   executors  = [multisig]      the Safe executes them after `minDelay`
 *   cancellers = [multisig]      (granted automatically to proposers)
 *   admin      = address(0)      the timelock administers itself; changing the delay is itself a delayed operation
 *
 * Every parameter change on the platform therefore appears on-chain as a scheduled operation at least `minDelay`
 * before it can take effect, giving users time to react (withdrawals are never delayed or pausable).
 */
contract PandaTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
