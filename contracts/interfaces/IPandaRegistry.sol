// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The read surface a PandaVault needs from the registry. Every value here is a plain storage read.
interface IPandaRegistry {
    /// @notice Limits on what a vault's keeper may do (per vault, falling back to the platform default).
    struct GuardRails {
        uint16 maxRebalanceSlippageBps;
        uint32 twapWindow;
        uint32 minRebalanceInterval;
        uint24 maxRangeSpacings;
        uint24 maxTwapDeviationTicks;
    }

    // Roles
    function keeperOf(address vault) external view returns (address);
    function daoTreasury() external view returns (address);
    function safetyModule() external view returns (address);
    function emergencyAdmin() external view returns (address);

    // Fees: rates and recipients come from a replaceable policy; each vault clamps them to its own ceilings.
    function feePolicy() external view returns (address);

    // Keeper guard rails for a vault
    function guardRailsOf(address vault) external view returns (GuardRails memory);

    // Pause switches (never affect withdrawals) and the permanent emergency shutdown
    function depositsPaused() external view returns (bool);
    function rebalancesPaused() external view returns (bool);
    function isShutdown(address vault) external view returns (bool);

    // Vault targeting
    function isVault(address vault) external view returns (bool);
    function vaultDepositsOpen(address vault) external view returns (bool);
}
