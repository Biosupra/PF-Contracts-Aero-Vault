// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "./interfaces/IAerodrome.sol";
import "./interfaces/IPandaRegistry.sol";
import "./interfaces/IPandaFeePolicy.sol";
import "./libraries/PandaVaultLib.sol";
import "./libraries/PandaTopUpLib.sol";

/**
 * @title PandaVault
 * @notice One Aero (Slipstream CL) pool (token A / token B, e.g. WETH/USDC or cbBTC/USDC), one Aero gauge, one NFT per
 * user deposit, keeper-rebalanced. The same audited template is deployed once per pool; all of them share one
 * registry, fee policy and staking.
 *
 * FUND-SAFETY INVARIANTS (enforced in code, see SECURITY-MODEL.md):
 *  1. No function lets any address other than the position owner move that position's tokens, AERO or NFT out of
 *     the vault to a third party, except fees within the ceilings below. No owner, no admin, no sweep, no proxy.
 *  2. The keeper can only rebalance: unstake -> optional swap through THIS pool only -> mint a new range that
 *     contains the current price -> restake, credited to the same owner. It may only act while the spot price is
 *     within a registry-bounded distance of the TWAP, and its swap must return at least TWAP price minus a
 *     registry-bounded slippage.
 *  3. The registry can pause new deposits and rebalances. It can never pause withdrawPosition,
 *     emergencyWithdraw, withdrawRawNft, claimRewards, withdrawReserves or setAutoCompound.
 *  4. Fees: rates and recipients come from a replaceable fee policy, but every fee is clamped to the ceilings
 *     compiled into PandaVaultLib (REWARD 20% of AERO rewards, DEPOSIT 2.00% and WITHDRAW 2.00% of principal,
 *     each swap kind 1.00% of the amount swapped, TIME 2.00% a year of a position's liquidity). A failing policy
 *     yields NO fee and never blocks an exit. The TIME fee is dormant at launch (the policy sets no rate); if it
 *     is ever switched on (timelock), it is charged pro rata for the time since the position's last rebalance or
 *     deposit, at most 30 days per charge, when liquidity leaves the position (rebalance, exit, move).
 *  5. Per-position reserves: whatever a deposit or rebalance cannot fit into the range (and, when compounding,
 *     AERO not yet swapped) stays in the vault against that position's token id, and is only ever put back into the
 *     SAME position or paid to that position's owner. Every other amount is a before/after balance delta.
 *  6. Emergency kill switch: once the registry's emergency admin (the team Safe, no timelock) shuts this vault or
 *     the whole platform down, it is permanent: no deposits, no rebalances, NO FEES, and `forceExit` pushes each
 *     open position's tokens, reserve and unclaimed rewards to that position's own owner, and nowhere else.
 *  7. Rewards are per position on Aero too: a claim credits only the claimed position's emissions; emissions Aero's
 *     gauge defers on an unstake (it keeps them per ACCOUNT and adds them to the vault's next claim for any position)
 *     are booked against the position that earned them and paid only to its owner (`claimDeferred`). An AERO payout
 *     the token refuses reverts (never booked). The early-unstake window never blocks an exit.
 */
contract PandaVault is ReentrancyGuard, ERC721Holder {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    // ==========================================
    // IMMUTABLES (fixed at deploy; a new pool means a new vault registered in the registry)
    // ==========================================

    IPandaRegistry public immutable registry;
    INonfungiblePositionManager public immutable positionManager;
    ICLGauge public immutable gauge;
    ICLPool public immutable pool;
    ISwapRouter public immutable swapRouter;
    IERC20 public immutable aeroToken;
    /// @notice The volatile side (WETH, cbBTC, ...).
    IERC20 public immutable tokenA;
    /// @notice The quote side (USDC). Zap deposits come in as token B.
    IERC20 public immutable tokenB;
    int24 public immutable tickSpacing;
    bool public immutable aIsToken0;

    /// @dev AERO -> token A or B compounding route, fixed in the constructor (no setter).
    PandaVaultLib.Route internal _route;

    /// @notice Below this much AERO a position's compounding pot is not swapped; it waits in the reserve.
    /// (Applied in PandaVaultLib.compound, which holds the same value.)
    uint256 public constant MIN_COMPOUND_AERO = 1e16; // 0.01 AERO

    // Fee kinds (argument to the fee policy) and the ceilings no policy can ever exceed (enforced in PandaVaultLib).
    uint8 public constant FEE_REWARD = 0;
    uint8 public constant FEE_DEPOSIT = 1;
    uint8 public constant FEE_WITHDRAW = 2;
    uint8 public constant FEE_ZAP_SWAP = 3;
    uint8 public constant FEE_REBALANCE_SWAP = 4;
    uint8 public constant FEE_COMPOUND_SWAP = 5;
    uint8 public constant FEE_TIME = 6;

    // ==========================================
    // STATE
    // ==========================================

    struct PositionInfo {
        address owner;
        bool isZap;        // deposited via depositZap (informational)
        bool autoCompound; // owner's choice: rebalances turn this position's AERO share back into liquidity
    }

    /// @notice Funds that belong to a position but are not inside its NFT, keyed by the position's CURRENT token id.
    struct Reserve {
        uint256 a;
        uint256 b;
        uint256 aero; // owner's share, reward fees already taken
    }

    mapping(uint256 => PositionInfo) public positionInfo;
    mapping(uint256 => uint256) public lastRebalanceAt;
    mapping(uint256 => Reserve) public reserves;
    /// @notice When the time fee was last settled for a position (its mint), keyed by the CURRENT token id.
    mapping(uint256 => uint256) public timeFeeCheckpoint;
    EnumerableSet.UintSet internal _open; // token ids whose NFT is live in the gauge

    uint256 public totalReservedA;
    uint256 public totalReservedB;
    uint256 public totalReservedAero;

    /// @dev Emissions each position earned that Aero's gauge stored instead of minting (per-account deferral), by
    /// token id; see PandaVaultLib.AeroBook. Read with `pendingDeferred`, paid with `claimDeferred`.
    PandaVaultLib.AeroBook internal _book;

    // Lifetime totals per owner are not stored: sum the RewardsEarned / RewardsClaimed / RewardsCompounded events.

    // ==========================================
    // ERRORS & EVENTS
    // ==========================================

    error ZeroAddress();
    error Unauthorized();
    error UnknownPosition();
    error DeadlineExpired();
    error InvalidSwapAmount();
    error InvalidRoute();
    error PoolTokenMismatch();
    error RouterFactoryMismatch();
    error InconsistentDeployment();
    error DepositsClosed();
    error RebalancesPaused();
    error RebalanceTooSoon();
    error VaultIsShutdown();
    error NotShutdown();
    error BadMigrationTarget();
    error AeroPairUnsupported();

    event PositionMinted(address indexed user, uint256 indexed tokenId, uint128 liquidity);
    event PositionWithdrawn(address indexed user, uint256 indexed tokenId);
    event EmergencyWithdrawn(address indexed user, uint256 indexed tokenId, uint256 amountA, uint256 amountB, uint256 aeroAmount);
    event RawNftWithdrawn(address indexed user, uint256 indexed tokenId, uint256 aeroAmount);
    /// @notice The owner's share of gauge AERO this position just earned (after the reward fee), wherever it goes next.
    event RewardsEarned(address indexed user, uint256 indexed tokenId, uint256 aeroAmount);
    /// @notice AERO that left the owner's entitlement to their wallet (fresh and/or reserved), and the token B it became if swapped.
    event RewardsClaimed(address indexed user, uint256 indexed tokenId, uint256 aeroAmount, uint256 valueB);
    event RewardsCompounded(address indexed user, uint256 indexed tokenId, uint256 aeroIn, uint256 amountOut);
    event ReserveUpdated(address indexed user, uint256 indexed tokenId, uint256 a, uint256 b, uint256 aero);
    event AutoCompoundSet(address indexed user, uint256 indexed tokenId, bool enabled);
    // ToppedUp(user, tokenId, amountA, amountB, liquidity) is declared in PandaTopUpLib and emitted from this address.
    event FeeCharged(address indexed user, uint8 indexed kind, address indexed token, address to, uint256 amount);
    event KeeperRebalanced(uint256 oldTokenId, uint256 newTokenId);
    /// @notice Emergency shutdown pushed a position out to its owner. What could not be sent stays claimable in the
    /// position's reserve (`withdrawReserves`).
    event ForceExited(address indexed user, uint256 indexed tokenId, uint256 amountA, uint256 amountB, uint256 aeroAmount, bool fullySent);
    /// @notice The owner moved this position to another Panda vault (one transaction, no Panda fees on the move).
    event MigratedOut(address indexed user, uint256 indexed tokenId, address indexed toVault, uint256 newTokenId, uint256 amountA, uint256 amountB);
    event MigratedIn(address indexed user, uint256 indexed tokenId, address indexed fromVault, uint256 amountA, uint256 amountB);

    // ==========================================
    // CONSTRUCTOR
    // ==========================================

    /// @param routeTokens AERO, then each hop's output token (last = token A or B); 1 to 3 hops.
    /// @param routeSpacings tick spacing of each hop's pool (routeTokens.length - 1 entries).
    constructor(
        address _registry,
        address _positionManager,
        address _gauge,
        address _swapRouter,
        address _aeroToken,
        address _tokenA,
        address _tokenB,
        address[] memory routeTokens,
        int24[] memory routeSpacings
    ) {
        if (_registry == address(0) || _positionManager == address(0) || _gauge == address(0) || _swapRouter == address(0)) revert ZeroAddress();
        if (_aeroToken == address(0) || _tokenA == address(0) || _tokenB == address(0)) revert ZeroAddress();
        // Rewards are measured as the rise in the vault's AERO balance, so a pair containing AERO would count principal
        // as rewards (fee taken from principal, paid twice from other positions' funds). Never allowed.
        if (_tokenA == _aeroToken || _tokenB == _aeroToken) revert AeroPairUnsupported();

        registry = IPandaRegistry(_registry);
        positionManager = INonfungiblePositionManager(_positionManager);
        gauge = ICLGauge(_gauge);
        aeroToken = IERC20(_aeroToken);
        tokenA = IERC20(_tokenA);
        tokenB = IERC20(_tokenB);

        ICLPool _pool = ICLPool(ICLGauge(_gauge).pool());
        address t0 = _pool.token0();
        address t1 = _pool.token1();
        if (!((t0 == _tokenA && t1 == _tokenB) || (t0 == _tokenB && t1 == _tokenA))) revert PoolTokenMismatch();
        pool = _pool;
        aIsToken0 = (t0 == _tokenA);
        tickSpacing = ICLGauge(_gauge).tickSpacing();

        // Every address must come from ONE Slipstream deployment (the old/new factory mix-up cost us a redeploy).
        address factory = INonfungiblePositionManager(_positionManager).factory();
        if (ISwapRouter(_swapRouter).factory() != factory) revert RouterFactoryMismatch();
        if (_pool.factory() != factory || ICLFactory(factory).getPool(_tokenA, _tokenB, tickSpacing) != address(_pool)) revert InconsistentDeployment();
        // Aero's gauge has no rewardToken(): it mints through its voter. The AERO address is checked by the deploy
        // script's preflight (scripts/deploy-aero-vault.js) and by the fork rehearsal, where emissions really arrive.
        if (_pool.gauge() != _gauge || ICLGauge(_gauge).nft() != _positionManager) revert InconsistentDeployment();
        swapRouter = ISwapRouter(_swapRouter);

        // Compound route: AERO -> ... -> token A or B, every hop a real pool of the same factory.
        uint256 hops = routeSpacings.length;
        if (hops == 0 || hops > 3 || routeTokens.length != hops + 1 || routeTokens[0] != _aeroToken) revert InvalidRoute();
        address last = routeTokens[hops];
        if (last != _tokenA && last != _tokenB) revert InvalidRoute();
        _route.hops = uint8(hops);
        _route.tokens[0] = _aeroToken;
        for (uint256 i = 0; i < hops; i++) {
            address hopPool = ICLFactory(factory).getPool(routeTokens[i], routeTokens[i + 1], routeSpacings[i]);
            if (hopPool == address(0)) revert InvalidRoute();
            _route.tokens[i + 1] = routeTokens[i + 1];
            _route.spacings[i] = routeSpacings[i];
            _route.pools[i] = hopPool;
            _route.zeroForOne[i] = ICLPool(hopPool).token0() == routeTokens[i];
        }
    }

    // ==========================================
    // VIEWS
    // ==========================================

    /// @notice The keeper allowed to rebalance this vault (the registry's keeper for this vault).
    function keeperBot() external view returns (address) { return registry.keeperOf(address(this)); }
    function isShutdown() public view returns (bool) { return registry.isShutdown(address(this)); }
    function depositsOpen() public view returns (bool) {
        return !registry.depositsPaused() && registry.vaultDepositsOpen(address(this)) && !isShutdown();
    }
    function guardRails() public view returns (IPandaRegistry.GuardRails memory) { return registry.guardRailsOf(address(this)); }

    function openPositionCount() external view returns (uint256) { return _open.length(); }
    function openPositionAt(uint256 i) external view returns (uint256) { return _open.at(i); }

    function compoundRoute() external view returns (address[] memory, int24[] memory, address[] memory) {
        return PandaVaultLib.routeView(_route);
    }

    /// @notice Pending gauge rewards for a position, after the reward fee, as the owner would receive them now.
    /// Does not include AERO already held in the position's reserve (see `reserves`) or book (`pendingDeferred`).
    function pendingUserAero(uint256 tokenId) external view returns (uint256) {
        PositionInfo memory info = positionInfo[tokenId];
        if (info.owner == address(0) || !_open.contains(tokenId)) return 0;
        return PandaVaultLib.pendingGauge(address(registry), address(gauge), tokenId, info.owner);
    }

    /// @notice Gauge-deferred emissions booked for `tokenId` and its owner (gross: the reward fee is taken when paid).
    function pendingDeferred(uint256 tokenId) external view returns (PandaVaultLib.Pending memory) {
        return _book.byId[tokenId];
    }

    /// @notice The fee `user` would pay on `kind` right now, in basis points, after clamping (0 once shut down).
    function feeBps(uint8 kind, address user) external view returns (uint256) {
        return PandaVaultLib.feeTotalBps(address(registry), address(this), kind, user);
    }

    /// @notice The ceiling this vault enforces for a fee kind, whatever the fee policy says.
    function feeCap(uint8 kind) external pure returns (uint256) {
        return PandaVaultLib.feeCap(kind);
    }

    /// @notice Spot tick, TWAP tick and the allowed distance; a rebalance needs |spot - twap| <= maxDeviation.
    function spotTwapTicks() external view returns (int24, int24, uint24) {
        return PandaVaultLib.spotTwapTicks(address(registry), address(this), address(pool));
    }

    /// @notice Minimum output the vault will accept for a keeper swap of `amountIn` (already net of the swap fee):
    /// TWAP-implied output minus the guard rails' max slippage. Reverts if the TWAP is unavailable.
    function rebalanceSwapFloor(bool isAToB, uint256 amountIn) public view returns (uint256) {
        IPandaRegistry.GuardRails memory g = guardRails();
        (bool ok, uint256 minOut) = PandaVaultLib.twapFloor(address(pool), g.twapWindow, isAToB == aIsToken0, amountIn, g.maxRebalanceSlippageBps);
        if (!ok) revert PandaVaultLib.TwapUnavailable();
        return minOut;
    }

    /// @notice Minimum output auto-compounding accepts for `aeroIn` AERO along the route (every hop at its TWAP, minus
    /// the max slippage). 0 means compounding would be skipped right now.
    function compoundSwapFloor(uint256 aeroIn) public view returns (uint256) {
        IPandaRegistry.GuardRails memory g = guardRails();
        return PandaVaultLib.routeFloor(_route, g.twapWindow, aeroIn, g.maxRebalanceSlippageBps);
    }

    // ==========================================
    // MODIFIERS
    // ==========================================

    modifier checkDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        _;
    }

    modifier onlyPositionOwner(uint256 tokenId) {
        if (positionInfo[tokenId].owner != msg.sender) revert Unauthorized();
        _;
    }

    // ==========================================
    // INTERNAL WRAPPERS (logic lives in PandaVaultLib)
    // ==========================================

    function _chargeKind(uint8 kind, address user, IERC20 token, uint256 amount) internal returns (uint256) {
        if (amount == 0) return 0;
        return PandaVaultLib.chargeKind(address(registry), kind, user, address(token), amount);
    }

    function _swapExactIn(IERC20 tokenIn, IERC20 tokenOut, bytes memory path, uint256 amountIn, uint256 minOut, uint256 deadline)
        internal returns (uint256, uint256)
    {
        return PandaVaultLib.swapExactIn(address(swapRouter), address(tokenIn), address(tokenOut), path, amountIn, minOut, deadline);
    }

    function _refs() internal view returns (PandaVaultLib.PoolRefs memory) {
        return PandaVaultLib.PoolRefs({
            pool: address(pool), nfpm: address(positionManager), gauge: address(gauge),
            tokenA: address(tokenA), tokenB: address(tokenB), tickSpacing: tickSpacing, aIsToken0: aIsToken0
        });
    }

    /// @dev Mints and stakes, records `info` against the new token id, and reserves what the range did not take.
    function _mintAndStake(
        PositionInfo memory info,
        uint256 amountA, uint256 amountB, uint256 aeroToReserve,
        int24 tickLower, int24 tickUpper, uint256 min0, uint256 min1, uint256 deadline
    ) internal returns (uint256 tokenId) {
        uint128 liquidity;
        uint256 leftA;
        uint256 leftB;
        (tokenId, liquidity, leftA, leftB) =
            PandaVaultLib.mintAndStake(_refs(), amountA, amountB, tickLower, tickUpper, min0, min1, deadline);
        positionInfo[tokenId] = info;
        timeFeeCheckpoint[tokenId] = block.timestamp;
        _open.add(tokenId);
        emit PositionMinted(info.owner, tokenId, liquidity);
        _addReserve(tokenId, info.owner, leftA, leftB, aeroToReserve);
    }

    /// @dev Unstakes `tokenId`, removes all liquidity and collects to the vault. The gauge pays pending AERO on withdraw
    /// (what it defers instead is booked for this position).
    function _exitPosition(uint256 tokenId, uint256 amount0Min, uint256 amount1Min, uint256 deadline)
        internal returns (uint256, uint256)
    {
        _open.remove(tokenId);
        return PandaVaultLib.exitPosition(_refs(), _book, tokenId, positionInfo[tokenId].owner, amount0Min, amount1Min, deadline);
    }

    function _sendRaw(address to, uint256 amountA, uint256 amountB) internal {
        if (amountA > 0) tokenA.safeTransfer(to, amountA);
        if (amountB > 0) tokenB.safeTransfer(to, amountB);
    }

    /// @dev Liquidity leaving a position: the time fee (dormant unless the policy sets it), returns what is left.
    function _takeTimeFee(uint256 tokenId, address owner, uint256 amountA, uint256 amountB) internal returns (uint256, uint256) {
        return PandaVaultLib.chargeTime(address(registry), timeFeeCheckpoint, tokenId, owner, address(tokenA), address(tokenB), amountA, amountB);
    }

    /// @dev Principal leaving the vault: the withdrawal fee on each token, returns what is left for the owner.
    function _takeWithdrawFee(address owner, uint256 amountA, uint256 amountB) internal returns (uint256, uint256) {
        return PandaVaultLib.chargeWithdraw(address(registry), owner, address(tokenA), address(tokenB), amountA, amountB);
    }

    // ==========================================
    // PER-POSITION RESERVES
    // ==========================================

    function _takeReserve(uint256 tokenId, address owner) internal returns (Reserve memory r) {
        r = reserves[tokenId];
        if (r.a == 0 && r.b == 0 && r.aero == 0) return r;
        delete reserves[tokenId];
        totalReservedA -= r.a;
        totalReservedB -= r.b;
        totalReservedAero -= r.aero;
        emit ReserveUpdated(owner, tokenId, 0, 0, 0);
    }

    /// @dev Only ever called with amounts measured inside the current transaction for that same position.
    function _addReserve(uint256 tokenId, address owner, uint256 amountA, uint256 amountB, uint256 aeroAmt) internal {
        if (amountA == 0 && amountB == 0 && aeroAmt == 0) return;
        Reserve storage r = reserves[tokenId];
        r.a += amountA;
        r.b += amountB;
        r.aero += aeroAmt;
        totalReservedA += amountA;
        totalReservedB += amountB;
        totalReservedAero += aeroAmt;
        emit ReserveUpdated(owner, tokenId, r.a, r.b, r.aero);
    }

    // ==========================================
    // REWARDS (per-position delta accounting)
    // ==========================================

    /// @dev Takes the reward fee (none once shut down) out of `gained` AERO measured for THIS position.
    function _accrue(uint256 tokenId, address owner, uint256 gained) internal returns (uint256 userShare) {
        if (gained == 0) return 0;
        userShare = gained - _chargeKind(FEE_REWARD, owner, aeroToken, gained);
        if (userShare > 0) emit RewardsEarned(owner, tokenId, userShare);
    }

    /// @dev Pays `amount` AERO (net of the reward fee) to the owner: raw, or swapped to token B along an owner path.
    function _payAero(uint256 tokenId, address owner, uint256 amount, bytes memory aeroToBPath, uint256 minB, uint256 deadline)
        internal returns (uint256)
    {
        return PandaVaultLib.payAero(
            address(registry), address(swapRouter), address(aeroToken), address(tokenB), tokenId, owner, amount, aeroToBPath, minB, deadline
        );
    }

    // ==========================================
    // DEPOSITS (pausable; never touch existing positions)
    // ==========================================

    struct DepositZapParams {
        uint256 amountB;
        uint256 swapAmountIn;   // token B (out of amountB after the deposit fee) allocated to buying token A; the swap fee comes out of it
        bytes swapPath;         // token B -> ... -> token A
        int24 tickLower;
        int24 tickUpper;
        uint256 amountAMin;     // for the swap of swapAmountIn minus the swap fee
        uint256 amount0MinMint;
        uint256 amount1MinMint;
        uint256 deadline;
        bool autoCompound;
    }

    /// @notice Deposit fee, then swaps part of token B into token A (caller-chosen path and minimum), mints and stakes.
    /// What the range cannot take is kept in the new position's reserve and goes in at its first rebalance.
    function depositZap(DepositZapParams calldata p) external nonReentrant checkDeadline(p.deadline) returns (uint256 tokenId) {
        if (!depositsOpen()) revert DepositsClosed();
        tokenB.safeTransferFrom(msg.sender, address(this), p.amountB);
        uint256 bIn = p.amountB - _chargeKind(FEE_DEPOSIT, msg.sender, tokenB, p.amountB);
        if (p.swapAmountIn == 0 || p.swapAmountIn >= bIn) revert InvalidSwapAmount();

        uint256 zapFee = _chargeKind(FEE_ZAP_SWAP, msg.sender, tokenB, p.swapAmountIn);
        (uint256 consumed, uint256 aReceived) = _swapExactIn(tokenB, tokenA, p.swapPath, p.swapAmountIn - zapFee, p.amountAMin, p.deadline);

        tokenId = _mintAndStake(
            PositionInfo({owner: msg.sender, isZap: true, autoCompound: p.autoCompound}),
            aReceived, bIn - zapFee - consumed, 0, p.tickLower, p.tickUpper, p.amount0MinMint, p.amount1MinMint, p.deadline
        );
        if (p.autoCompound) emit AutoCompoundSet(msg.sender, tokenId, true);
    }

    struct DepositAdvancedParams {
        uint256 amountA;
        uint256 amountB;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
        bool autoCompound;
    }

    /// @notice Deposit exact token A and token B (deposit fee on each), mint and stake. Leftovers go to the reserve.
    function depositAndStake(DepositAdvancedParams calldata p) external nonReentrant checkDeadline(p.deadline) returns (uint256 tokenId) {
        if (!depositsOpen()) revert DepositsClosed();
        tokenA.safeTransferFrom(msg.sender, address(this), p.amountA);
        tokenB.safeTransferFrom(msg.sender, address(this), p.amountB);
        uint256 aIn = p.amountA - _chargeKind(FEE_DEPOSIT, msg.sender, tokenA, p.amountA);
        uint256 bIn = p.amountB - _chargeKind(FEE_DEPOSIT, msg.sender, tokenB, p.amountB);
        tokenId = _mintAndStake(
            PositionInfo({owner: msg.sender, isZap: false, autoCompound: p.autoCompound}),
            aIn, bIn, 0, p.tickLower, p.tickUpper, p.amount0Min, p.amount1Min, p.deadline
        );
        if (p.autoCompound) emit AutoCompoundSet(msg.sender, tokenId, true);
    }

    /// @notice Add money to one of your existing positions instead of opening a new one (closed whenever deposits
    /// are). Deposit fee on each token, optional zap swap, then the same NFT is unstaked, increased and restaked; the
    /// AERO the unstake pays (reward fee taken) and whatever the range cannot take go to the position's reserve and
    /// join it at the next rebalance. The time-fee checkpoint and the rebalance clock are unchanged. `data` and the
    /// ToppedUp event are documented in PandaTopUpLib.
    function topUp(uint256 tokenId, bytes calldata data) external nonReentrant onlyPositionOwner(tokenId) {
        (uint256 leftA, uint256 leftB, uint256 userAero) = PandaTopUpLib.topUp(_book, tokenId, data);
        _addReserve(tokenId, msg.sender, leftA, leftB, userAero);
    }

    // ==========================================
    // OWNER SETTINGS AND RESERVES (owner only, never pausable)
    // ==========================================

    /// @notice Turn auto-compounding on or off for one position. Takes effect at the next rebalance.
    function setAutoCompound(uint256 tokenId, bool enabled) external onlyPositionOwner(tokenId) {
        positionInfo[tokenId].autoCompound = enabled;
        emit AutoCompoundSet(msg.sender, tokenId, enabled);
    }

    /// @notice Pay a position's whole reserve to its owner (tokens less the withdrawal fee; AERO in full). Also how an
    /// owner collects anything a forced exit could not send.
    function withdrawReserves(uint256 tokenId) external nonReentrant onlyPositionOwner(tokenId) {
        Reserve memory r = _takeReserve(tokenId, msg.sender);
        (uint256 a, uint256 b) = _takeWithdrawFee(msg.sender, r.a, r.b);
        _sendRaw(msg.sender, a, b);
        _payAero(tokenId, msg.sender, r.aero, "", 0, block.timestamp);
        if (!_open.contains(tokenId)) delete positionInfo[tokenId]; // leftovers of a forced exit, now fully paid
    }

    // ==========================================
    // CLAIM (owner only, never pausable)
    // ==========================================

    struct ClaimParams {
        uint256 tokenId;
        bytes aeroToBPath; // empty = receive raw AERO
        uint256 amountBMin;
        uint256 deadline;
    }

    /// @notice Pays the position's pending gauge rewards plus any AERO waiting in its reserve. Inside the gauge's
    /// early-unstake window the gauge claim is skipped (nothing forfeited; claim again a few blocks later).
    function claimRewards(ClaimParams calldata p) external nonReentrant checkDeadline(p.deadline) onlyPositionOwner(p.tokenId) {
        uint256 gained = _open.contains(p.tokenId) ? PandaVaultLib.claimGauge(address(gauge), _book, address(aeroToken), p.tokenId) : 0;
        uint256 userShare = _accrue(p.tokenId, msg.sender, gained);

        uint256 reservedAero = reserves[p.tokenId].aero;
        if (reservedAero > 0) {
            reserves[p.tokenId].aero = 0;
            totalReservedAero -= reservedAero;
            Reserve memory r = reserves[p.tokenId];
            emit ReserveUpdated(msg.sender, p.tokenId, r.a, r.b, 0);
        }
        _payAero(p.tokenId, msg.sender, userShare + reservedAero, p.aeroToBPath, p.amountBMin, p.deadline);
    }

    /// @notice Pays the emissions booked for `tokenId` (see `pendingDeferred`) to its owner, who may call this after
    /// the position is closed or rebalanced. They are collected from the gauge first if the vault does not hold them
    /// yet, and take the reward fee now.
    function claimDeferred(uint256 tokenId) external nonReentrant {
        uint256 gross = PandaVaultLib.takeDeferred(address(gauge), _book, address(aeroToken), tokenId, msg.sender);
        _payAero(tokenId, msg.sender, _accrue(tokenId, msg.sender, gross), "", 0, block.timestamp);
    }

    // ==========================================
    // WITHDRAW (owner only, never pausable)
    // ==========================================

    struct WithdrawParams {
        uint256 tokenId;
        bytes aeroToBPath;            // empty = raw AERO
        uint256 amountBMinReward;
        uint256 amount0Min;
        uint256 amount1Min;
        bytes aToBPath;               // empty = raw token A back; set to receive only token B
        uint256 amountBMinReturned;
        uint256 deadline;
    }

    /// @notice Closes the position and pays everything it owns: liquidity and reserve (less the withdrawal fee),
    /// and pending + reserved rewards.
    function withdrawPosition(WithdrawParams calldata p) external nonReentrant checkDeadline(p.deadline) onlyPositionOwner(p.tokenId) {
        uint256 aeroBefore = aeroToken.balanceOf(address(this));
        (uint256 amountA, uint256 amountB) = _exitPosition(p.tokenId, p.amount0Min, p.amount1Min, p.deadline);
        uint256 userShare = _accrue(p.tokenId, msg.sender, aeroToken.balanceOf(address(this)) - aeroBefore);
        (amountA, amountB) = _takeTimeFee(p.tokenId, msg.sender, amountA, amountB);

        Reserve memory r = _takeReserve(p.tokenId, msg.sender);
        (amountA, amountB) = _takeWithdrawFee(msg.sender, amountA + r.a, amountB + r.b);

        _payAero(p.tokenId, msg.sender, userShare + r.aero, p.aeroToBPath, p.amountBMinReward, p.deadline);

        if (amountA > 0 && p.aToBPath.length > 0) {
            amountA -= _chargeKind(FEE_ZAP_SWAP, msg.sender, tokenA, amountA);
            (uint256 consumed, uint256 bOut) = _swapExactIn(tokenA, tokenB, p.aToBPath, amountA, p.amountBMinReturned, p.deadline);
            amountB += bOut;
            amountA -= consumed;
        }
        _sendRaw(msg.sender, amountA, amountB);

        delete positionInfo[p.tokenId];
        delete lastRebalanceAt[p.tokenId];
        emit PositionWithdrawn(msg.sender, p.tokenId);
    }

    /// @notice No-swap exit: raw tokens (liquidity and reserve, less the withdrawal fee) + AERO back to the owner.
    function emergencyWithdraw(uint256 tokenId) external nonReentrant onlyPositionOwner(tokenId) {
        uint256 aeroBefore = aeroToken.balanceOf(address(this));
        (uint256 amountA, uint256 amountB) = _exitPosition(tokenId, 0, 0, block.timestamp);
        uint256 userShare = _accrue(tokenId, msg.sender, aeroToken.balanceOf(address(this)) - aeroBefore);
        (amountA, amountB) = _takeTimeFee(tokenId, msg.sender, amountA, amountB);

        Reserve memory r = _takeReserve(tokenId, msg.sender);
        (amountA, amountB) = _takeWithdrawFee(msg.sender, amountA + r.a, amountB + r.b);
        _sendRaw(msg.sender, amountA, amountB);
        uint256 userAero = _payAero(tokenId, msg.sender, userShare + r.aero, "", 0, block.timestamp);

        delete positionInfo[tokenId];
        delete lastRebalanceAt[tokenId];
        emit EmergencyWithdrawn(msg.sender, tokenId, amountA, amountB, userAero);
    }

    /// @notice Last-resort exit: unstake and hand the Slipstream NFT itself to the owner, no swaps. The reserve and
    /// rewards are paid raw in the same transaction. The time fee and the withdrawal fee are taken from matching slices
    /// of the NFT's liquidity if the position manager works; if it does not, no fee is taken and the NFT still goes to
    /// the owner.
    function withdrawRawNft(uint256 tokenId) external nonReentrant onlyPositionOwner(tokenId) {
        uint256 aeroBefore = aeroToken.balanceOf(address(this));
        _open.remove(tokenId);
        PandaVaultLib.unstake(address(gauge), _book, tokenId, msg.sender);
        uint256 userShare = _accrue(tokenId, msg.sender, aeroToken.balanceOf(address(this)) - aeroBefore);

        Reserve memory r = _takeReserve(tokenId, msg.sender);
        (uint256 a, uint256 b) = _takeWithdrawFee(msg.sender, r.a, r.b);
        _sendRaw(msg.sender, a, b);
        uint256 userAero = _payAero(tokenId, msg.sender, userShare + r.aero, "", 0, block.timestamp);
        PandaVaultLib.takeNftFees(address(registry), _refs(), timeFeeCheckpoint, tokenId, msg.sender);

        delete positionInfo[tokenId];
        delete lastRebalanceAt[tokenId];
        positionManager.safeTransferFrom(address(this), msg.sender, tokenId);
        emit RawNftWithdrawn(msg.sender, tokenId, userAero);
    }

    // ==========================================
    // ONE-CLICK UPGRADE (opt-in, owner only): move a position into another registered Panda vault
    // ==========================================

    struct MigrateParams {
        uint256 tokenId;
        address toVault;          // must be a vault registered in the registry, for the same token pair
        uint256 decreaseAmount0Min;
        uint256 decreaseAmount1Min;
        bytes receiveData;        // passed to toVault.receiveMigration (new range, optional balancing swap, mins, deadline)
        uint256 deadline;
    }

    /// @notice Move this position into another Panda vault in ONE transaction, signed by the owner. The target must be
    /// registered in the registry (registration goes through the timelock, so nobody can slip in a fake vault) and hold
    /// the same token pair. This vault unwinds the position; its tokens and leftovers go to the target, which opens a
    /// new position for the same owner. No withdrawal or deposit toll on the move; rewards earned so far are paid to the
    /// owner as usual (reward fee applies), and so is any time fee already accrued. Anything the target does not take
    /// comes straight back to the owner.
    function migrate(MigrateParams calldata p) external nonReentrant checkDeadline(p.deadline) onlyPositionOwner(p.tokenId) returns (uint256 newTokenId) {
        if (p.toVault == address(this) || !registry.isVault(p.toVault)) revert BadMigrationTarget();
        PandaVault target = PandaVault(p.toVault);
        if (address(target.tokenA()) != address(tokenA) || address(target.tokenB()) != address(tokenB)) revert BadMigrationTarget();
        PositionInfo memory info = positionInfo[p.tokenId];

        uint256 aeroBefore = aeroToken.balanceOf(address(this));
        (uint256 a, uint256 b) = _exitPosition(p.tokenId, p.decreaseAmount0Min, p.decreaseAmount1Min, p.deadline);
        uint256 userShare = _accrue(p.tokenId, msg.sender, aeroToken.balanceOf(address(this)) - aeroBefore);
        (a, b) = _takeTimeFee(p.tokenId, msg.sender, a, b);
        Reserve memory r = _takeReserve(p.tokenId, msg.sender);
        a += r.a;
        b += r.b;
        _payAero(p.tokenId, msg.sender, userShare + r.aero, "", 0, p.deadline);
        delete positionInfo[p.tokenId];
        delete lastRebalanceAt[p.tokenId];

        uint256 aBefore = tokenA.balanceOf(address(this));
        uint256 bBefore = tokenB.balanceOf(address(this));
        tokenA.forceApprove(p.toVault, a);
        tokenB.forceApprove(p.toVault, b);
        newTokenId = target.receiveMigration(msg.sender, a, b, info.autoCompound, p.receiveData);
        tokenA.forceApprove(p.toVault, 0);
        tokenB.forceApprove(p.toVault, 0);
        // Whatever the target did not pull belongs to the owner.
        _sendRaw(msg.sender, a - (aBefore - tokenA.balanceOf(address(this))), b - (bBefore - tokenB.balanceOf(address(this))));
        emit MigratedOut(msg.sender, p.tokenId, p.toVault, newTokenId, a, b);
    }

    /// @notice Receiving side of `migrate`: only another registered Panda vault can call it. Pulls exactly `amountA` /
    /// `amountB` from that vault, optionally balances them through this vault's own pool (floored at TWAP minus the
    /// max slippage, no fee), and mints a position for `owner`; what the range cannot take goes to its reserve.
    /// `data` = abi.encode(int24 tickLower, int24 tickUpper, bool isAToB, uint256 swapIn, uint256 swapMinOut,
    /// uint256 amount0Min, uint256 amount1Min, uint256 deadline).
    function receiveMigration(address owner, uint256 amountA, uint256 amountB, bool autoCompound, bytes calldata data)
        external nonReentrant returns (uint256 tokenId)
    {
        if (msg.sender == address(this) || !registry.isVault(msg.sender)) revert Unauthorized();
        if (!depositsOpen()) revert DepositsClosed();
        (int24 lo, int24 hi, bool isAToB, uint256 swapIn, uint256 swapMinOut, uint256 min0, uint256 min1, uint256 deadline) =
            abi.decode(data, (int24, int24, bool, uint256, uint256, uint256, uint256, uint256));
        if (block.timestamp > deadline) revert DeadlineExpired();
        tokenA.safeTransferFrom(msg.sender, address(this), amountA);
        tokenB.safeTransferFrom(msg.sender, address(this), amountB);

        if (swapIn > 0) {
            uint256 available = isAToB ? amountA : amountB;
            (uint256 consumed, uint256 out) = PandaVaultLib.poolSwap(
                _refs(), address(swapRouter), guardRails(), isAToB, swapIn > available ? available : swapIn, swapMinOut, deadline
            );
            if (isAToB) { amountA -= consumed; amountB += out; } else { amountB -= consumed; amountA += out; }
        }
        tokenId = _mintAndStake(PositionInfo({owner: owner, isZap: false, autoCompound: autoCompound}), amountA, amountB, 0, lo, hi, min0, min1, deadline);
        emit MigratedIn(owner, tokenId, msg.sender, amountA, amountB);
    }

    // ==========================================
    // EMERGENCY KILL SWITCH (only after the registry's emergency admin shut this vault or the platform down)
    // ==========================================

    /// @notice Push positions back to their owners: unstake, remove all liquidity, and send each owner its tokens,
    /// reserve and unclaimed rewards, raw, no fees. Callable only once shut down, by the emergency admin (the team
    /// Safe) or this vault's keeper; the keeper must also pass the spot-near-TWAP check so nobody can time it into a
    /// pushed price. Ids that are not open are skipped. Anything a transfer refuses (e.g. a blocklisted address)
    /// stays in that position's reserve for its owner to collect with `withdrawReserves`.
    function forceExit(uint256[] calldata tokenIds) external nonReentrant returns (uint256 exited) {
        if (!isShutdown()) revert NotShutdown();
        if (msg.sender != registry.emergencyAdmin()) {
            if (msg.sender != registry.keeperOf(address(this))) revert Unauthorized();
            PandaVaultLib.requireSpotNearTwap(address(pool), guardRails());
        }
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 id = tokenIds[i];
            if (!_open.contains(id)) continue;
            _forceExitOne(id);
            exited++;
        }
    }

    function _forceExitOne(uint256 id) internal {
        address owner = positionInfo[id].owner;
        uint256 aeroBefore = aeroToken.balanceOf(address(this));
        (uint256 a, uint256 b) = _exitPosition(id, 0, 0, block.timestamp);
        uint256 earned = _accrue(id, owner, aeroToken.balanceOf(address(this)) - aeroBefore); // no fee: shut down
        delete timeFeeCheckpoint[id];

        Reserve memory r = _takeReserve(id, owner);
        a += r.a;
        b += r.b;
        uint256 ae = earned + r.aero;
        delete lastRebalanceAt[id];

        uint256[3] memory kept = PandaVaultLib.pushAll([address(tokenA), address(tokenB), address(aeroToken)], owner, [a, b, ae]);
        bool fullySent = kept[0] == 0 && kept[1] == 0 && kept[2] == 0;
        if (fullySent) delete positionInfo[id];
        else _addReserve(id, owner, kept[0], kept[1], kept[2]);
        emit ForceExited(owner, id, a - kept[0], b - kept[1], ae - kept[2], fullySent);
    }

    // ==========================================
    // REBALANCE (keeper only; every degree of freedom is bounded)
    // ==========================================

    struct RebalanceParams {
        uint256 tokenId;
        bool isAToB;
        uint256 rebalanceAmountIn;      // gross: the swap fee comes out of it; 0 = no swap
        uint256 rebalanceAmountOutMin;  // for rebalanceAmountIn minus the swap fee; raised on-chain to the TWAP floor if lower
        int24 newTickLower;
        int24 newTickUpper;
        uint256 amount0MinMint;
        uint256 amount1MinMint;
        uint256 decreaseAmount0Min;
        uint256 decreaseAmount1Min;
        uint256 deadline;
    }

    /// @notice Moves a position to a new range. The swap may use everything the position owns: its liquidity, its
    /// reserve and (if auto-compounding) what its AERO was swapped into. What the new range cannot take is kept in
    /// the new token id's reserve, not sent to the owner.
    function rebalance(RebalanceParams calldata p) external nonReentrant checkDeadline(p.deadline) returns (uint256 newTokenId) {
        if (msg.sender != registry.keeperOf(address(this))) revert Unauthorized();
        if (isShutdown()) revert VaultIsShutdown();
        if (registry.rebalancesPaused()) revert RebalancesPaused();
        PositionInfo memory info = positionInfo[p.tokenId];
        if (info.owner == address(0) || !_open.contains(p.tokenId)) revert UnknownPosition();
        IPandaRegistry.GuardRails memory g = guardRails();
        if (block.timestamp < lastRebalanceAt[p.tokenId] + g.minRebalanceInterval) revert RebalanceTooSoon();
        PandaVaultLib.checkNewRange(_refs(), g, p.tokenId, p.newTickLower, p.newTickUpper);

        // 1. Unstake + remove liquidity. The gauge pays this position's pending AERO during withdraw.
        uint256 aeroBefore = aeroToken.balanceOf(address(this));
        (uint256 balA, uint256 balB) = _exitPosition(p.tokenId, p.decreaseAmount0Min, p.decreaseAmount1Min, p.deadline);
        uint256 userShare = _accrue(p.tokenId, info.owner, aeroToken.balanceOf(address(this)) - aeroBefore);
        (balA, balB) = _takeTimeFee(p.tokenId, info.owner, balA, balB);

        // 2. Bring this position's reserve back into play.
        Reserve memory r = _takeReserve(p.tokenId, info.owner);
        balA += r.a;
        balB += r.b;

        // 3. Rewards: compound along the fixed route (what cannot be swapped now waits in the reserve), or pay raw.
        uint256 aeroKept;
        if (info.autoCompound) {
            uint256 outA;
            uint256 outB;
            (aeroKept, outA, outB) = PandaVaultLib.compound(address(registry), address(swapRouter), _route, address(tokenA), p.tokenId, info.owner, userShare + r.aero);
            balA += outA;
            balB += outB;
        } else {
            _payAero(p.tokenId, info.owner, userShare + r.aero, "", 0, p.deadline);
        }

        // 4. Optional swap through this vault's own pool.
        if (p.rebalanceAmountIn > 0) (balA, balB) = _rebalanceSwap(p, info.owner, balA, balB, g);

        // 5. Mint the new range, stake, re-credit the same owner; what did not fit is reserved for this position.
        delete positionInfo[p.tokenId];
        delete lastRebalanceAt[p.tokenId];
        newTokenId = _mintAndStake(info, balA, balB, aeroKept, p.newTickLower, p.newTickUpper, p.amount0MinMint, p.amount1MinMint, p.deadline);
        lastRebalanceAt[newTokenId] = block.timestamp;

        emit KeeperRebalanced(p.tokenId, newTokenId);
    }

    /// @dev Keeper swap: capped at what the position owns, swap fee out of the input, only through this vault's own
    /// pool, floored at TWAP minus the max slippage; the keeper's own minimum is scaled down pro rata if capped.
    function _rebalanceSwap(RebalanceParams calldata p, address owner, uint256 balA, uint256 balB, IPandaRegistry.GuardRails memory g)
        internal returns (uint256, uint256)
    {
        IERC20 tokenIn = p.isAToB ? tokenA : tokenB;
        uint256 available = p.isAToB ? balA : balB;
        uint256 amountIn = p.rebalanceAmountIn > available ? available : p.rebalanceAmountIn;
        if (amountIn == 0) revert InvalidSwapAmount();

        uint256 fee = _chargeKind(FEE_REBALANCE_SWAP, owner, tokenIn, amountIn);
        uint256 keeperMin = amountIn == p.rebalanceAmountIn
            ? p.rebalanceAmountOutMin
            : (p.rebalanceAmountOutMin * amountIn) / p.rebalanceAmountIn;
        (uint256 consumed, uint256 amountOut) =
            PandaVaultLib.poolSwap(_refs(), address(swapRouter), g, p.isAToB, amountIn - fee, keeperMin, p.deadline);
        if (p.isAToB) return (balA - fee - consumed, balB + amountOut);
        return (balA + amountOut, balB - fee - consumed);
    }
}
