// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Implemented by the staking contracts in https://github.com/Biosupra/PF-tokenandnft-Staking-Contracts.
/// Both return only stake that has stayed staked for the warm-up period; unstaking removes it immediately.
interface IPandaTokenStaking {
    function activeStakeOf(address user) external view returns (uint256);
}

/// @dev The Pass level of a wallet's MATURED staked Pass: 0 = none, 1 = a Panda Pass, 2 = a special-edition Pass.
interface IPandaPassStaking {
    function activePassLevel(address user) external view returns (uint256);
}
