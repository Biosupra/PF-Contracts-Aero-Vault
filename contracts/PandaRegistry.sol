// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IPandaRegistry.sol";

/**
 * @title PandaRegistry
 * @notice The single place where anything about the Panda platform can be changed after launch. One registry
 * serves every vault (WETH/USDC, BTC/USDC, ... each its own immutable vault contract).
 *
 * Design rule: NOTHING in this contract can move, claim, freeze or redirect a user's funds. The registry only
 * holds (1) role addresses, (2) which vaults accept deposits, (3) the fee policy contract, whose answers every
 * vault clamps to its own immutable ceilings, (4) guard rails that LIMIT what each vault's keeper may do,
 * (5) pause switches that stop deposits and rebalances only, and (6) the emergency shutdown.
 *
 * Who changes what:
 *  - owner = a TimelockController whose proposer/executor is the team Safe: every address and parameter change
 *    waits the timelock delay and is visible on-chain before it takes effect;
 *  - safety module: pause / unpause deposits and rebalances immediately (and only that);
 *  - emergency admin (the team Safe, directly, NO timelock): the kill switch. `shutdownAll()` or
 *    `shutdownVault(v)` PERMANENTLY stops deposits and rebalances, turns every fee to zero, and lets the
 *    emergency admin or the vault's keeper push every position's tokens, reserve and unclaimed rewards to its own
 *    owner (`PandaVault.forceExit`). Funds can only ever go to each position's owner. It cannot be undone:
 *    a shut-down vault is retired, a new one can be registered.
 *
 * The code of this contract and of every vault is not upgradeable. "Upgradeable" for this platform means
 * "these parameters, and the fee policy, can be changed"; the fund-handling logic is fixed at deploy time on purpose.
 */
contract PandaRegistry is Ownable2Step, IPandaRegistry {
    // ==========================================
    // HARD LIMITS (cannot be changed by anyone)
    // ==========================================

    uint16 public constant MAX_REBALANCE_SLIPPAGE_BPS = 300;      // keeper swaps may never be worse than 3% under TWAP
    uint32 public constant MIN_TWAP_WINDOW = 60;                  // seconds
    uint32 public constant MAX_TWAP_WINDOW = 3600;
    uint32 public constant MAX_MIN_REBALANCE_INTERVAL = 1 days;
    /// @notice Floor for the keeper cooldown: a compromised keeper cannot churn a position many times per block.
    uint32 public constant MIN_MIN_REBALANCE_INTERVAL = 15 minutes;
    uint24 public constant MAX_RANGE_SPACINGS_CAP = 1000;
    uint24 public constant MAX_TWAP_DEVIATION_TICKS = 500;        // ~5%: spot may never be further than this from TWAP

    // ==========================================
    // STATE
    // ==========================================

    /// @notice Default keeper for every vault without its own (`keeperOf`).
    address public keeper;
    address public daoTreasury;
    address public safetyModule;
    /// @notice The team Safe: may trigger the emergency shutdown directly (no timelock). Nothing else.
    address public emergencyAdmin;

    /// @notice Contract that decides fee rates, discounts and recipients (address(0) = no fees at all).
    address public feePolicy;

    GuardRails internal _defaultGuardRails;
    mapping(address => GuardRails) internal _vaultGuardRails;
    mapping(address => bool) public hasVaultGuardRails;
    mapping(address => address) public vaultKeeper; // address(0) = use the default keeper

    bool public depositsPaused;
    bool public rebalancesPaused;

    bool public allShutdown;
    mapping(address => bool) public vaultShutdown;

    struct VaultConfig {
        bool registered;
        bool depositsOpen;
    }
    mapping(address => VaultConfig) private _vaults;
    address[] private _vaultList;

    /// @dev One-time deploy helper: lets the deploy script register the first vault(s) and the fee policy
    /// before handing everything to the timelock. Irrevocably disabled by `finishBootstrap()`.
    address public bootstrapper;
    bool public bootstrapFinished;

    // ==========================================
    // ERRORS & EVENTS
    // ==========================================

    error ZeroAddress();
    error Unauthorized();
    error OutOfBounds();
    error NotAVault();
    error AlreadyRegistered();
    error BootstrapOver();
    error AlreadyShutdown();

    event KeeperUpdated(address indexed previous, address indexed current);
    event VaultKeeperUpdated(address indexed vault, address indexed keeper);
    event DaoTreasuryUpdated(address indexed previous, address indexed current);
    event SafetyModuleUpdated(address indexed previous, address indexed current);
    event EmergencyAdminUpdated(address indexed previous, address indexed current);
    event FeePolicyUpdated(address indexed previous, address indexed current);
    event GuardRailsUpdated(address indexed vault, GuardRails rails); // vault = address(0) for the default
    event VaultGuardRailsCleared(address indexed vault);
    event DepositsPausedSet(bool paused, address indexed by);
    event RebalancesPausedSet(bool paused, address indexed by);
    event PlatformShutdown(address indexed by);
    event VaultShutdown(address indexed vault, address indexed by);
    event VaultAdded(address indexed vault);
    event VaultDepositsOpenSet(address indexed vault, bool open);
    event BootstrapFinished();

    // ==========================================
    // CONSTRUCTOR
    // ==========================================

    struct InitialConfig {
        address keeper;
        address daoTreasury;
        address safetyModule;
        address emergencyAdmin;
        GuardRails guardRails;
    }

    /// @param initialOwner the timelock (proposer/executor = the team Safe). Set at construction, no acceptance step.
    constructor(address initialOwner, InitialConfig memory cfg) Ownable(initialOwner) {
        bootstrapper = msg.sender;
        _setKeeper(cfg.keeper);
        _setDaoTreasury(cfg.daoTreasury);
        _setSafetyModule(cfg.safetyModule);
        _setEmergencyAdmin(cfg.emergencyAdmin);
        _checkGuardRails(cfg.guardRails);
        _defaultGuardRails = cfg.guardRails;
        emit GuardRailsUpdated(address(0), cfg.guardRails);
    }

    // ==========================================
    // MODIFIERS
    // ==========================================

    modifier onlyOwnerOrBootstrapper() {
        if (msg.sender != owner()) {
            if (msg.sender != bootstrapper || bootstrapFinished) revert Unauthorized();
        }
        _;
    }

    modifier onlySafetyOrOwner() {
        if (msg.sender != safetyModule && msg.sender != owner()) revert Unauthorized();
        _;
    }

    modifier onlyEmergencyAdmin() {
        if (msg.sender != emergencyAdmin) revert Unauthorized();
        _;
    }

    // ==========================================
    // ROLE ADDRESSES (timelock)
    // ==========================================

    function setKeeper(address a) external onlyOwner { _setKeeper(a); }
    function setDaoTreasury(address a) external onlyOwner { _setDaoTreasury(a); }
    function setSafetyModule(address a) external onlyOwner { _setSafetyModule(a); }
    function setEmergencyAdmin(address a) external onlyOwner { _setEmergencyAdmin(a); }

    /// @notice Give one vault its own keeper wallet (address(0) = back to the default keeper).
    function setVaultKeeper(address vault, address k) external onlyOwnerOrBootstrapper {
        if (!_vaults[vault].registered) revert NotAVault();
        vaultKeeper[vault] = k;
        emit VaultKeeperUpdated(vault, k);
    }

    function keeperOf(address vault) external view returns (address) {
        address k = vaultKeeper[vault];
        return k == address(0) ? keeper : k;
    }

    function _setKeeper(address a) internal {
        if (a == address(0)) revert ZeroAddress();
        emit KeeperUpdated(keeper, a);
        keeper = a;
    }
    function _setDaoTreasury(address a) internal {
        if (a == address(0)) revert ZeroAddress();
        emit DaoTreasuryUpdated(daoTreasury, a);
        daoTreasury = a;
    }
    function _setSafetyModule(address a) internal {
        if (a == address(0)) revert ZeroAddress();
        emit SafetyModuleUpdated(safetyModule, a);
        safetyModule = a;
    }
    function _setEmergencyAdmin(address a) internal {
        if (a == address(0)) revert ZeroAddress();
        emit EmergencyAdminUpdated(emergencyAdmin, a);
        emergencyAdmin = a;
    }

    // ==========================================
    // FEE POLICY (timelock; bootstrapper before launch)
    // ==========================================

    /// @notice Replace the whole fee structure. Every vault still clamps the policy's answers to the ceilings
    /// compiled into that vault, so no policy can ever charge more than a depositor was promised.
    function setFeePolicy(address policy) external onlyOwnerOrBootstrapper {
        emit FeePolicyUpdated(feePolicy, policy);
        feePolicy = policy; // address(0) allowed: no fees
    }

    // ==========================================
    // KEEPER GUARD RAILS (timelock, bounded; per vault with a default)
    // ==========================================

    function setDefaultGuardRails(GuardRails calldata r) external onlyOwner {
        _checkGuardRails(r);
        _defaultGuardRails = r;
        emit GuardRailsUpdated(address(0), r);
    }

    /// @notice Settings for one vault (e.g. BTC is more volatile than ETH). Same hard bounds as the default.
    function setVaultGuardRails(address vault, GuardRails calldata r) external onlyOwnerOrBootstrapper {
        if (!_vaults[vault].registered) revert NotAVault();
        _checkGuardRails(r);
        _vaultGuardRails[vault] = r;
        hasVaultGuardRails[vault] = true;
        emit GuardRailsUpdated(vault, r);
    }

    function clearVaultGuardRails(address vault) external onlyOwner {
        delete _vaultGuardRails[vault];
        hasVaultGuardRails[vault] = false;
        emit VaultGuardRailsCleared(vault);
    }

    function guardRailsOf(address vault) external view returns (GuardRails memory) {
        return hasVaultGuardRails[vault] ? _vaultGuardRails[vault] : _defaultGuardRails;
    }

    function defaultGuardRails() external view returns (GuardRails memory) {
        return _defaultGuardRails;
    }

    function _checkGuardRails(GuardRails memory r) internal pure {
        if (r.maxRebalanceSlippageBps == 0 || r.maxRebalanceSlippageBps > MAX_REBALANCE_SLIPPAGE_BPS) revert OutOfBounds();
        if (r.twapWindow < MIN_TWAP_WINDOW || r.twapWindow > MAX_TWAP_WINDOW) revert OutOfBounds();
        if (r.minRebalanceInterval < MIN_MIN_REBALANCE_INTERVAL || r.minRebalanceInterval > MAX_MIN_REBALANCE_INTERVAL) revert OutOfBounds();
        if (r.maxRangeSpacings == 0 || r.maxRangeSpacings > MAX_RANGE_SPACINGS_CAP) revert OutOfBounds();
        if (r.maxTwapDeviationTicks == 0 || r.maxTwapDeviationTicks > MAX_TWAP_DEVIATION_TICKS) revert OutOfBounds();
    }

    // ==========================================
    // PAUSE SWITCHES (safety module or timelock; withdrawals are never pausable)
    // ==========================================

    function setDepositsPaused(bool paused) external onlySafetyOrOwner {
        depositsPaused = paused;
        emit DepositsPausedSet(paused, msg.sender);
    }

    function setRebalancesPaused(bool paused) external onlySafetyOrOwner {
        rebalancesPaused = paused;
        emit RebalancesPausedSet(paused, msg.sender);
    }

    // ==========================================
    // EMERGENCY KILL SWITCH (emergency admin = the team Safe; NO timelock; permanent)
    // ==========================================

    /// @notice Shut down EVERY vault, permanently: no deposits, no rebalances, no fees; positions are pushed back to
    /// their owners with `PandaVault.forceExit`, and owners can still exit themselves at any time.
    function shutdownAll() external onlyEmergencyAdmin {
        if (allShutdown) revert AlreadyShutdown();
        allShutdown = true;
        emit PlatformShutdown(msg.sender);
    }

    /// @notice Shut down one vault, permanently (same effects as `shutdownAll`, for that vault only).
    function shutdownVault(address vault) external onlyEmergencyAdmin {
        if (!_vaults[vault].registered) revert NotAVault();
        if (vaultShutdown[vault] || allShutdown) revert AlreadyShutdown();
        vaultShutdown[vault] = true;
        emit VaultShutdown(vault, msg.sender);
    }

    function isShutdown(address vault) external view returns (bool) {
        return allShutdown || vaultShutdown[vault];
    }

    // ==========================================
    // VAULT TARGETING (timelock; bootstrapper before launch)
    // ==========================================

    function addVault(address vault) external onlyOwnerOrBootstrapper {
        if (vault == address(0)) revert ZeroAddress();
        if (_vaults[vault].registered) revert AlreadyRegistered();
        _vaults[vault] = VaultConfig({registered: true, depositsOpen: true});
        _vaultList.push(vault);
        emit VaultAdded(vault);
        emit VaultDepositsOpenSet(vault, true);
    }

    /// @notice Open or close NEW deposits for a vault. Existing positions in that vault keep every function.
    function setVaultDepositsOpen(address vault, bool open) external onlyOwnerOrBootstrapper {
        if (!_vaults[vault].registered) revert NotAVault();
        _vaults[vault].depositsOpen = open;
        emit VaultDepositsOpenSet(vault, open);
    }

    function isVault(address vault) external view returns (bool) { return _vaults[vault].registered; }
    function vaultDepositsOpen(address vault) external view returns (bool) { return _vaults[vault].depositsOpen; }
    function vaults() external view returns (address[] memory) { return _vaultList; }
    function vaultCount() external view returns (uint256) { return _vaultList.length; }

    /// @notice Vaults currently accepting deposits (what the dapp should offer): registered, open, not shut down.
    function activeVaults() external view returns (address[] memory out) {
        uint256 n;
        for (uint256 i = 0; i < _vaultList.length; i++) if (_isActive(_vaultList[i])) n++;
        out = new address[](n);
        uint256 j;
        for (uint256 i = 0; i < _vaultList.length; i++) {
            if (_isActive(_vaultList[i])) out[j++] = _vaultList[i];
        }
    }

    function _isActive(address v) internal view returns (bool) {
        return _vaults[v].depositsOpen && !allShutdown && !vaultShutdown[v];
    }

    // ==========================================
    // BOOTSTRAP
    // ==========================================

    /// @notice Permanently removes the deployer's bootstrap rights. Called at the end of the deploy script.
    function finishBootstrap() external {
        if (msg.sender != bootstrapper && msg.sender != owner()) revert Unauthorized();
        if (bootstrapFinished) revert BootstrapOver();
        bootstrapFinished = true;
        bootstrapper = address(0);
        emit BootstrapFinished();
    }
}
