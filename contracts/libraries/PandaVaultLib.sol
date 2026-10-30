// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IAerodrome.sol";
import "../interfaces/IPandaRegistry.sol";
import "../interfaces/IPandaFeePolicy.sol";
import "./TickMath.sol";

/**
 * @title PandaVaultLib
 * @notice Helpers split out of PandaVault only to keep the vault under the 24 KB contract size limit.
 * External library: deployed once, its address is fixed into the vault's bytecode at link time (not upgradeable),
 * and every state-changing function runs by DELEGATECALL in the vault's own context (calling one directly
 * reverts). It holds no state and adds no power: the fee ceilings, the recipients' validation, the no-block rules
 * and the zero-fee shutdown are the vault's rules.
 */
library PandaVaultLib {
    using SafeERC20 for IERC20;

    uint8 internal constant FEE_REWARD = 0;
    uint8 internal constant FEE_DEPOSIT = 1;
    uint8 internal constant FEE_WITHDRAW = 2;
    uint8 internal constant FEE_COMPOUND_SWAP = 5;
    uint8 internal constant FEE_TIME = 6;
    uint16 internal constant MAX_REWARD_FEE_BPS = 2000;   // 20% of AERO rewards
    uint16 internal constant MAX_DEPOSIT_FEE_BPS = 200;   // 2.00% of principal deposited
    uint16 internal constant MAX_WITHDRAW_FEE_BPS = 200;  // 2.00% of principal withdrawn
    uint16 internal constant MAX_SWAP_FEE_BPS = 100;      // 1.00% of an amount swapped for a position
    uint16 internal constant MAX_TIME_FEE_BPS = 200;      // 2.00% A YEAR of a position's liquidity (0 at launch)
    /// @dev The time fee is charged for at most this much time per charge, so switching it on can never bill a
    /// position for a long stretch it spent while the rate was 0.
    uint256 internal constant MAX_TIME_FEE_PERIOD = 30 days;
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant MAX_FEE_LEGS = 6;
    uint256 internal constant MAX_ROUTE_HOPS = 3;
    uint256 internal constant POLICY_GAS = 150_000;
    uint256 internal constant BPS = 10000;
    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant MIN_COMPOUND_AERO = 1e16; // same as PandaVault.MIN_COMPOUND_AERO

    /// @dev A fee policy answer after validation and clamping.
    struct Legs {
        address[6] to;
        uint16[6] bps;
        uint256 n;
        uint256 totalBps;
    }

    /// @dev The vault's fixed Aerodrome addresses, passed in one piece. Token A is the volatile side (WETH, cbBTC),
    /// token B the quote side (USDC).
    struct PoolRefs {
        address pool;
        address nfpm;
        address gauge;
        address tokenA;
        address tokenB;
        int24 tickSpacing;
        bool aIsToken0;
    }

    /// @dev The fixed AERO -> token A or B compounding route (1 to 3 hops), validated in the vault constructor.
    struct Route {
        address[4] tokens;     // tokens[0] = AERO, tokens[hops] = the token compounded into
        int24[3] spacings;     // tick spacing of each hop's pool
        address[3] pools;      // each hop's pool (factory.getPool), for its TWAP
        bool[3] zeroForOne;    // tokens[i] is that pool's token0
        uint8 hops;
    }

    /// @dev Emissions Aero's gauge stored for the vault instead of minting them when a position was unstaked, keyed by
    /// the token id that earned them (reward fee not taken yet). Paid only to `owner`, by `claimDeferred`.
    /// (Review 2026-10-20: the deployed new AERO has no transfer lock, so a payout the token refuses is NOT booked
    /// here any more; it reverts, as on main. The only transfer the deployed token refuses is one the vault cannot
    /// cover, and booking that would let a position collect later out of other positions' AERO.)
    struct Pending {
        address owner;
        uint256 gross;
    }

    /// @dev Per-position ledger for the AERO above. Aero's gauge keeps deferred emissions per ACCOUNT (the vault) and
    /// pays them on the vault's next claim for ANY position, so the vault books them here against the position that
    /// earned them. Sum of all entries = held + atGauge.
    struct AeroBook {
        mapping(uint256 => Pending) byId;
        uint256 atGauge; // booked emissions the gauge still owes the vault (its deferredEmissions(vault))
        uint256 held;    // booked AERO already in the vault
    }

    error FeeCheckNeedsMoreGas();
    error InvalidSwapPath();
    error SlippageExceeded();
    error InvalidTickRange();
    error OneSidedMintRequiresSwap();
    error RangeMustContainPrice();
    error RangeTooWide();
    error SpotFarFromTwap();
    error TwapUnavailable();
    error StakeTooRecent();
    error NotPendingOwner();

    event FeeCharged(address indexed user, uint8 indexed kind, address indexed token, address to, uint256 amount);
    event RewardsClaimed(address indexed user, uint256 indexed tokenId, uint256 aeroAmount, uint256 valueB);
    event RewardsCompounded(address indexed user, uint256 indexed tokenId, uint256 aeroIn, uint256 amountOut);
    /// @notice Emissions earned by `tokenId` that Aero's gauge stored instead of minting; they wait in the vault's
    /// per-position book for its owner (`claimDeferred`; the reward fee is taken when paid).
    event RewardsDeferred(address indexed user, uint256 indexed tokenId, uint256 grossAero);

    // ==========================================
    // FEES
    // ==========================================

    function feeCap(uint8 kind) public pure returns (uint256) {
        if (kind == FEE_REWARD) return MAX_REWARD_FEE_BPS;
        if (kind == FEE_DEPOSIT) return MAX_DEPOSIT_FEE_BPS;
        if (kind == FEE_WITHDRAW) return MAX_WITHDRAW_FEE_BPS;
        if (kind <= FEE_COMPOUND_SWAP) return MAX_SWAP_FEE_BPS;
        if (kind == FEE_TIME) return MAX_TIME_FEE_BPS;
        return 0;
    }

    /// @notice Asks the registry's fee policy for `kind`, reading at most MAX_FEE_LEGS legs straight from return data
    /// (no abi.decode that could revert, no unbounded copy), dropping invalid legs and clamping the total to the
    /// ceiling. No fee at all while the vault is shut down, or if the policy fails in any way. The gas check stops
    /// a caller from starving the policy call to skip fees.
    function getLegs(address registry, address vault, uint8 kind, address user) public view returns (Legs memory L) {
        IPandaRegistry reg = IPandaRegistry(registry);
        if (reg.isShutdown(vault)) return L;
        address policy = reg.feePolicy();
        if (policy == address(0)) return L;
        if (gasleft() < POLICY_GAS + POLICY_GAS / 63 + 20_000) revert FeeCheckNeedsMoreGas();

        bytes memory cd = abi.encodeCall(IPandaFeePolicy.feeLegs, (kind, user));
        uint256[14] memory out; // [offset, length, to0, bps0, ..., to5, bps5]
        bool ok;
        uint256 size;
        uint256 g = POLICY_GAS;
        assembly ("memory-safe") {
            ok := staticcall(g, policy, add(cd, 32), mload(cd), out, 448)
            size := returndatasize()
        }
        if (!ok || size < 64 || out[0] != 32) return L;
        uint256 n = out[1];
        if (n > MAX_FEE_LEGS) n = MAX_FEE_LEGS;
        if (size < 64 + n * 64) n = (size - 64) / 64;

        uint256 cap = feeCap(kind);
        for (uint256 i = 0; i < n && L.totalBps < cap; i++) {
            uint256 rawTo = out[2 + 2 * i];
            uint256 rawBps = out[3 + 2 * i];
            if (rawTo == 0 || rawTo > type(uint160).max || rawBps == 0 || rawBps > type(uint16).max) continue;
            address to = address(uint160(rawTo));
            if (to == vault) continue;
            uint256 bps = rawBps;
            if (L.totalBps + bps > cap) bps = cap - L.totalBps;
            L.to[L.n] = to;
            L.bps[L.n] = uint16(bps);
            L.n++;
            L.totalBps += bps;
        }
    }

    /// @notice Total clamped fee in bps for `kind` (0 once the vault is shut down).
    function feeTotalBps(address registry, address vault, uint8 kind, address user) external view returns (uint256) {
        return getLegs(registry, vault, kind, user).totalBps;
    }

    /// @notice Spot tick, TWAP tick and the allowed distance for a vault's pool, read with that vault's guard rails.
    function spotTwapTicks(address registry, address vault, address pool) external view returns (int24 spot, int24 twap, uint24 maxDeviation) {
        IPandaRegistry.GuardRails memory g = IPandaRegistry(registry).guardRailsOf(vault);
        (, spot,,,,) = ICLPool(pool).slot0();
        bool ok;
        (ok, twap) = twapTick(pool, g.twapWindow);
        if (!ok) revert TwapUnavailable();
        maxDeviation = g.maxTwapDeviationTicks;
    }

    /// @notice Pays `amount * bps` to each leg out of tokens the vault holds for this operation. A leg whose
    /// transfer fails (e.g. a blacklisted recipient) is simply not charged. Returns what was actually taken.
    function charge(Legs memory L, uint8 kind, address user, address token, uint256 amount) public returns (uint256 taken) {
        for (uint256 i = 0; i < L.n; i++) {
            uint256 f = (amount * L.bps[i]) / BPS;
            if (f > 0 && _tryTransfer(token, L.to[i], f)) {
                taken += f;
                emit FeeCharged(user, kind, token, L.to[i], f);
            }
        }
    }

    /// @notice getLegs + charge in one call.
    function chargeKind(address registry, uint8 kind, address user, address token, uint256 amount) external returns (uint256) {
        if (amount == 0) return 0;
        return charge(getLegs(registry, address(this), kind, user), kind, user, token, amount);
    }

    /// @notice Withdrawal fee on principal leaving the vault; returns what is left for the owner.
    function chargeWithdraw(address registry, address user, address tokenA, address tokenB, uint256 amountA, uint256 amountB)
        external returns (uint256, uint256)
    {
        if (amountA == 0 && amountB == 0) return (0, 0);
        Legs memory L = getLegs(registry, address(this), FEE_WITHDRAW, user);
        return (
            amountA - charge(L, FEE_WITHDRAW, user, tokenA, amountA),
            amountB - charge(L, FEE_WITHDRAW, user, tokenB, amountB)
        );
    }

    /// @notice Time fee on liquidity leaving a position (a rebalance or an exit). The time fee's legs are rates PER
    /// YEAR, charged pro rata for the time since the position's checkpoint (at most MAX_TIME_FEE_PERIOD). Always
    /// clears the checkpoint. Returns what is left of each amount. 0 at launch: the fee policy sets no TIME legs.
    function chargeTime(
        address registry, mapping(uint256 => uint256) storage checkpoints, uint256 tokenId, address user,
        address tokenA, address tokenB, uint256 amountA, uint256 amountB
    ) external returns (uint256, uint256) {
        uint256 elapsed = _timeElapsed(checkpoints, tokenId);
        if (elapsed == 0 || (amountA == 0 && amountB == 0)) return (amountA, amountB);
        Legs memory L = getLegs(registry, address(this), FEE_TIME, user);
        if (L.totalBps == 0) return (amountA, amountB);
        return (
            amountA - charge(L, FEE_TIME, user, tokenA, (amountA * elapsed) / YEAR),
            amountB - charge(L, FEE_TIME, user, tokenB, (amountB * elapsed) / YEAR)
        );
    }

    /// @dev Seconds of time fee owed by `tokenId` (capped), and clears its checkpoint. No checkpoint = nothing owed.
    function _timeElapsed(mapping(uint256 => uint256) storage checkpoints, uint256 tokenId) private returns (uint256 elapsed) {
        uint256 since = checkpoints[tokenId];
        if (since == 0) return 0;
        delete checkpoints[tokenId];
        elapsed = block.timestamp - since;
        if (elapsed > MAX_TIME_FEE_PERIOD) elapsed = MAX_TIME_FEE_PERIOD;
    }

    /// @notice Fees on an NFT handed to its owner as is (`withdrawRawNft`): the time fee, then the withdrawal fee,
    /// each taken as a slice of the NFT's liquidity and split between that fee's legs. Every step is try/catch: a
    /// broken position manager must never stop the NFT from reaching its owner. A leg whose transfer fails is paid to
    /// the owner instead, so nothing is left behind in the vault. Clears the time-fee checkpoint.
    function takeNftFees(address registry, PoolRefs memory R, mapping(uint256 => uint256) storage checkpoints, uint256 tokenId, address owner) external {
        uint256 elapsed = _timeElapsed(checkpoints, tokenId);
        if (elapsed > 0) _nftSlice(R, tokenId, owner, FEE_TIME, getLegs(registry, address(this), FEE_TIME, owner), elapsed, YEAR);
        _nftSlice(R, tokenId, owner, FEE_WITHDRAW, getLegs(registry, address(this), FEE_WITHDRAW, owner), 1, 1);
    }

    /// @dev Removes `legs total bps * num / den` of the NFT's liquidity and splits what comes out between the legs.
    function _nftSlice(PoolRefs memory R, uint256 tokenId, address owner, uint8 kind, Legs memory L, uint256 num, uint256 den) private {
        if (L.totalBps == 0) return;
        INonfungiblePositionManager pm = INonfungiblePositionManager(R.nfpm);
        uint128 liquidity;
        try pm.positions(tokenId) returns (
            uint96, address, address, address, int24, int24, int24, uint128 liq, uint256, uint256, uint128, uint128
        ) { liquidity = liq; } catch { return; }
        uint128 feeLiquidity = uint128((uint256(liquidity) * L.totalBps * num) / (BPS * den));
        if (feeLiquidity == 0) return;
        try pm.decreaseLiquidity(INonfungiblePositionManager.DecreaseLiquidityParams({
            tokenId: tokenId, liquidity: feeLiquidity, amount0Min: 0, amount1Min: 0, deadline: block.timestamp
        })) {} catch { return; }
        uint256 a0;
        uint256 a1;
        try pm.collect(INonfungiblePositionManager.CollectParams({
            tokenId: tokenId, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max
        })) returns (uint256 c0, uint256 c1) { a0 = c0; a1 = c1; } catch { return; }
        _split(L, kind, owner, R.tokenA, R.aIsToken0 ? a0 : a1);
        _split(L, kind, owner, R.tokenB, R.aIsToken0 ? a1 : a0);
    }

    function _split(Legs memory L, uint8 kind, address owner, address token, uint256 amount) private {
        if (amount == 0) return;
        uint256 left = amount;
        for (uint256 i = 0; i < L.n; i++) {
            uint256 f = i + 1 == L.n ? left : (amount * L.bps[i]) / L.totalBps;
            if (f == 0) continue;
            left -= f;
            if (_tryTransfer(token, L.to[i], f)) emit FeeCharged(owner, kind, token, L.to[i], f);
            else IERC20(token).safeTransfer(owner, f);
        }
    }

    /// @notice Pays `amount` AERO (already net of the reward fee) to `owner`: raw, or swapped to token B along an
    /// owner-supplied path (the ZAP_SWAP fee applies to the swapped amount). Returns the AERO sent raw. A transfer the
    /// token refuses reverts the whole call (as on main): it is never booked as if the vault still held it.
    function payAero(
        address registry, address router, address aero, address tokenB, uint256 tokenId, address owner,
        uint256 amount, bytes memory aeroToBPath, uint256 minB, uint256 deadline
    ) external returns (uint256) {
        if (amount == 0) return 0;
        if (aeroToBPath.length > 0) {
            uint256 fee = charge(getLegs(registry, address(this), 3, owner), 3, owner, aero, amount);
            (uint256 consumed, uint256 gainedB) = _swap(router, aero, tokenB, aeroToBPath, amount - fee, minB, deadline);
            IERC20(tokenB).safeTransfer(owner, gainedB);
            uint256 rest = amount - fee - consumed;
            if (rest > 0) IERC20(aero).safeTransfer(owner, rest);
            emit RewardsClaimed(owner, tokenId, amount, gainedB);
            return rest;
        }
        IERC20(aero).safeTransfer(owner, amount);
        emit RewardsClaimed(owner, tokenId, amount, 0);
        return amount;
    }

    // ==========================================
    // AERO GAUGE: claims, deferred emissions, early-unstake window
    // ==========================================

    /// @notice Unstakes `tokenId` (the gauge pays its emissions to the vault in the same call) and books against it
    /// whatever the gauge stored as deferred instead of paying.
    function unstake(address gauge, AeroBook storage B, uint256 tokenId, address owner) public {
        ICLGauge(gauge).withdraw(tokenId);
        uint256 d = ICLGauge(gauge).deferredEmissions(address(this));
        if (d > B.atGauge) {
            uint256 x = d - B.atGauge;
            B.atGauge = d;
            Pending storage p = B.byId[tokenId];
            p.owner = owner;
            p.gross += x;
            emit RewardsDeferred(owner, tokenId, x);
        }
    }

    /// @notice Claims ONE staked position's emissions to the vault and returns only that position's part. The gauge
    /// adds the vault's whole deferred balance to any claim; that part is moved to the book (it belongs to the
    /// positions it was booked for), never to this position. Skipped (returns 0, nothing forfeited) while the position
    /// is inside the gauge's early-unstake window.
    function claimGauge(address gauge, AeroBook storage B, address aero, uint256 tokenId) external returns (uint256 gained) {
        if (block.number < penaltyFreeBlock(gauge, tokenId)) return 0;
        uint256 d = ICLGauge(gauge).deferredEmissions(address(this));
        uint256 before = IERC20(aero).balanceOf(address(this));
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;
        ICLGauge(gauge).claimEmissions(address(this), address(this), ids);
        gained = IERC20(aero).balanceOf(address(this)) - before;
        if (d > 0) {
            uint256 deferredPart = gained < d ? gained : d;
            gained -= deferredPart;
            B.held += deferredPart;
            B.atGauge = 0;
        }
    }

    /// @notice Takes a position's booked emissions out of the book for its owner (`caller` must be that owner), first
    /// collecting the gauge's deferred emissions if the vault does not hold enough yet. Returns the gross amount
    /// (reward fee still to take).
    function takeDeferred(address gauge, AeroBook storage B, address aero, uint256 tokenId, address caller)
        external returns (uint256 gross)
    {
        Pending memory p = B.byId[tokenId];
        if (p.owner != caller) revert NotPendingOwner();
        gross = p.gross;
        if (B.held < gross && B.atGauge > 0) {
            uint256 before = IERC20(aero).balanceOf(address(this));
            ICLGauge(gauge).claimEmissions(address(this), address(this), new uint256[](0));
            B.held += IERC20(aero).balanceOf(address(this)) - before;
            B.atGauge = 0;
        }
        // Only dust can be missing here (Aero's emissions handler holds back sub-1e6-wei mints per account).
        if (B.held < gross) gross = B.held;
        B.held -= gross;
        delete B.byId[tokenId];
    }

    /// @notice Pending gauge emissions of one staked position (the gauge's estimate, penalty applied), without the
    /// vault's deferred balance that the gauge's `earned` adds to every answer, after `owner`'s reward fee.
    function pendingGauge(address registry, address gauge, uint256 tokenId, address owner) external view returns (uint256) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = tokenId;
        uint256 e = ICLGauge(gauge).earned(address(this), ids);
        uint256 d = ICLGauge(gauge).deferredEmissions(address(this));
        uint256 total = e > d ? e - d : 0;
        return total - (total * getLegs(registry, address(this), FEE_REWARD, owner).totalBps) / BPS;
    }

    /// @notice First block at which unstaking or claiming `tokenId` forfeits nothing (0 = no window applies). An
    /// unreadable penalty config counts as no window, so it can never block anything. A plain view: the keeper and the
    /// website call it on the library's own address with the vault's gauge (a vault-level view would not fit the vault).
    function penaltyFreeBlock(address gauge, uint256 tokenId) public view returns (uint256) {
        try ICLGaugeFactory(ICLGauge(gauge).gaugeFactory()).effectivePenaltyConfig(gauge) returns (uint256 minBlocks, uint256 rate) {
            if (minBlocks == 0 || rate == 0) return 0;
            uint256 db = ICLGauge(gauge).depositBlock(tokenId);
            return db == 0 ? 0 : db + minBlocks;
        } catch {
            return 0;
        }
    }

    /// @notice Reverts while `tokenId` is inside the gauge's early-unstake window (keeper rebalance, owner top-up).
    function requireStakeSettled(address gauge, uint256 tokenId) public view {
        if (block.number < penaltyFreeBlock(gauge, tokenId)) revert StakeTooRecent();
    }

    /// @notice Sends each amount to `to`, returning what could NOT be sent (a refused transfer must not stop a batch).
    function pushAll(address[3] memory tokens, address to, uint256[3] memory amounts) external returns (uint256[3] memory kept) {
        for (uint256 i = 0; i < 3; i++) {
            if (amounts[i] > 0 && !_tryTransfer(tokens[i], to, amounts[i])) kept[i] = amounts[i];
        }
    }

    /// @notice The compound route as plain arrays (for the vault's `compoundRoute` view). The route is read from the
    /// vault's storage (passed by reference: copying it into memory cost the vault over 1 KB of code).
    function routeView(Route storage r) external view returns (address[] memory tokens, int24[] memory spacings, address[] memory pools) {
        uint256 h = r.hops;
        tokens = new address[](h + 1);
        spacings = new int24[](h);
        pools = new address[](h);
        tokens[0] = r.tokens[0];
        for (uint256 i = 0; i < h; i++) {
            tokens[i + 1] = r.tokens[i + 1];
            spacings[i] = r.spacings[i];
            pools[i] = r.pools[i];
        }
    }

    /// @notice Transfer that reports failure instead of reverting (a blocked recipient must not stop a batch).
    function tryTransfer(address token, address to, uint256 amount) external returns (bool) {
        return _tryTransfer(token, to, amount);
    }

    function _tryTransfer(address token, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))));
    }

    // ==========================================
    // POSITIONS
    // ==========================================

    /// @notice Mints from the given amounts (after the one-sided check), stakes in the gauge, leaves no allowance.
    /// Returns what the range did not take (the vault reserves it for the position).
    function mintAndStake(
        PoolRefs memory R, uint256 amountA, uint256 amountB, int24 tickLower, int24 tickUpper, uint256 min0, uint256 min1, uint256 deadline
    ) external returns (uint256 tokenId, uint128 liquidity, uint256 leftA, uint256 leftB) {
        if (tickLower >= tickUpper) revert InvalidTickRange();
        (, int24 currentTick,,,,) = ICLPool(R.pool).slot0();
        uint256 bal0 = R.aIsToken0 ? amountA : amountB;
        uint256 bal1 = R.aIsToken0 ? amountB : amountA;
        if (currentTick < tickLower) {
            if (bal0 == 0) revert OneSidedMintRequiresSwap();
        } else if (currentTick >= tickUpper) {
            if (bal1 == 0) revert OneSidedMintRequiresSwap();
        } else if (bal0 == 0 || bal1 == 0) {
            revert OneSidedMintRequiresSwap();
        }

        IERC20(R.tokenA).forceApprove(R.nfpm, amountA);
        IERC20(R.tokenB).forceApprove(R.nfpm, amountB);
        uint256 used0;
        uint256 used1;
        (tokenId, liquidity, used0, used1) = INonfungiblePositionManager(R.nfpm).mint(INonfungiblePositionManager.MintParams({
            token0: R.aIsToken0 ? R.tokenA : R.tokenB,
            token1: R.aIsToken0 ? R.tokenB : R.tokenA,
            tickSpacing: R.tickSpacing,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: bal0,
            amount1Desired: bal1,
            amount0Min: min0,
            amount1Min: min1,
            recipient: address(this),
            deadline: deadline,
            sqrtPriceX96: 0
        }));
        IERC20(R.tokenA).forceApprove(R.nfpm, 0);
        IERC20(R.tokenB).forceApprove(R.nfpm, 0);

        INonfungiblePositionManager(R.nfpm).approve(R.gauge, tokenId);
        ICLGauge(R.gauge).deposit(tokenId);

        leftA = amountA - (R.aIsToken0 ? used0 : used1);
        leftB = amountB - (R.aIsToken0 ? used1 : used0);
    }

    /// @notice Unstakes, removes all liquidity and collects to the vault. The gauge pays pending AERO on withdraw
    /// (or defers it: booked for this position and `owner`).
    function exitPosition(PoolRefs memory R, AeroBook storage B, uint256 tokenId, address owner, uint256 amount0Min, uint256 amount1Min, uint256 deadline)
        external returns (uint256 amountA, uint256 amountB)
    {
        unstake(R.gauge, B, tokenId, owner);
        INonfungiblePositionManager pm = INonfungiblePositionManager(R.nfpm);
        (,,,,,,, uint128 liquidity,,,,) = pm.positions(tokenId);
        if (liquidity > 0) {
            pm.decreaseLiquidity(INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId, liquidity: liquidity, amount0Min: amount0Min, amount1Min: amount1Min, deadline: deadline
            }));
        }
        (uint256 amount0, uint256 amount1) = pm.collect(INonfungiblePositionManager.CollectParams({
            tokenId: tokenId, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max
        }));
        amountA = R.aIsToken0 ? amount0 : amount1;
        amountB = R.aIsToken0 ? amount1 : amount0;
    }

    /// @notice Keeper range rules: the position is past the gauge's early-unstake window, the new range is
    /// spacing-aligned, contains the current tick, no wider than the vault's guard rails allow, and the spot price is
    /// within the guard rails' distance of the TWAP.
    function checkNewRange(PoolRefs memory R, IPandaRegistry.GuardRails memory g, uint256 tokenId, int24 lower, int24 upper) external view {
        requireStakeSettled(R.gauge, tokenId);
        if (lower >= upper) revert InvalidTickRange();
        if (lower % R.tickSpacing != 0 || upper % R.tickSpacing != 0) revert InvalidTickRange();
        (, int24 currentTick,,,,) = ICLPool(R.pool).slot0();
        if (currentTick < lower || currentTick >= upper) revert RangeMustContainPrice();
        if (uint256(int256(upper - lower)) > uint256(g.maxRangeSpacings) * uint256(int256(R.tickSpacing))) revert RangeTooWide();
        requireSpotNearTwap(R.pool, g);
    }

    /// @notice Reverts unless the pool's spot tick is within the guard rails' distance of its TWAP tick.
    function requireSpotNearTwap(address pool, IPandaRegistry.GuardRails memory g) public view {
        (, int24 spot,,,,) = ICLPool(pool).slot0();
        (bool ok, int24 twap) = twapTick(pool, g.twapWindow);
        if (!ok) revert TwapUnavailable();
        int256 d = int256(spot) - int256(twap);
        if (d < 0) d = -d;
        if (uint256(d) > g.maxTwapDeviationTicks) revert SpotFarFromTwap();
    }

    // ==========================================
    // SWAPS
    // ==========================================

    /// @notice Swaps exactly `amountIn` of tokenIn along `path` (must start with tokenIn and end with tokenOut),
    /// measures what the router really consumed and returned, and leaves no standing allowance.
    function swapExactIn(
        address router, address tokenIn, address tokenOut, bytes memory path, uint256 amountIn, uint256 minOut, uint256 deadline
    ) external returns (uint256 consumed, uint256 received) {
        return _swap(router, tokenIn, tokenOut, path, amountIn, minOut, deadline);
    }

    function _swap(
        address router, address tokenIn, address tokenOut, bytes memory path, uint256 amountIn, uint256 minOut, uint256 deadline
    ) private returns (uint256 consumed, uint256 received) {
        if (path.length < 43) revert InvalidSwapPath();
        address first;
        address last;
        assembly ("memory-safe") {
            first := shr(96, mload(add(path, 32)))
            last := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
        }
        if (first != tokenIn || last != tokenOut) revert InvalidSwapPath();

        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));

        IERC20(tokenIn).forceApprove(router, amountIn);
        ISwapRouter(router).exactInput(ISwapRouter.ExactInputParams({
            path: path, recipient: address(this), deadline: deadline, amountIn: amountIn, amountOutMinimum: minOut
        }));
        IERC20(tokenIn).forceApprove(router, 0);

        consumed = inBefore - IERC20(tokenIn).balanceOf(address(this));
        received = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (received < minOut) revert SlippageExceeded();
    }

    /// @notice Swaps `amountIn` of token A->B (or B->A) through the vault's OWN pool only, requiring at least
    /// max(minOut, TWAP-implied output minus the guard rails' slippage). Shared by the keeper's rebalance swap and the
    /// receiving side of a migration.
    function poolSwap(PoolRefs memory R, address router, IPandaRegistry.GuardRails memory g, bool isAToB, uint256 amountIn, uint256 minOut, uint256 deadline)
        external returns (uint256 consumed, uint256 out)
    {
        (bool ok, uint256 q) = twapQuote(R.pool, g.twapWindow, isAToB == R.aIsToken0, amountIn);
        if (!ok) revert TwapUnavailable();
        uint256 floor = (q * (BPS - g.maxRebalanceSlippageBps)) / BPS;
        if (minOut < floor) minOut = floor;
        address tIn = isAToB ? R.tokenA : R.tokenB;
        address tOut = isAToB ? R.tokenB : R.tokenA;
        return _swap(router, tIn, tOut, abi.encodePacked(tIn, R.tickSpacing, tOut), amountIn, minOut, deadline);
    }

    /// @notice The compounding step of a rebalance (moved out of the vault for size; same rules): below
    /// MIN_COMPOUND_AERO nothing is swapped; otherwise the COMPOUND_SWAP fee is held back, the rest is sold along the
    /// fixed route at no less than every hop's TWAP minus the vault's max slippage, and the fee is charged only if the
    /// swap happened. Returns the AERO that stays in the position's reserve and what the swap produced.
    function compound(address registry, address router, Route storage r, address tokenA, uint256 tokenId, address owner, uint256 pot)
        external returns (uint256 aeroKept, uint256 outA, uint256 outB)
    {
        if (pot < MIN_COMPOUND_AERO) return (pot, 0, 0);
        Legs memory L = getLegs(registry, address(this), FEE_COMPOUND_SWAP, owner);
        uint256 swapIn = pot - (pot * L.totalBps) / BPS;
        IPandaRegistry.GuardRails memory g = IPandaRegistry(registry).guardRailsOf(address(this));
        (uint256 used, uint256 out) = tryCompound(router, r, swapIn, routeFloor(r, g.twapWindow, swapIn, g.maxRebalanceSlippageBps));
        if (used == 0) return (pot, 0, 0);
        // Each leg is floor(pot * bps / 1e4), so the total never exceeds what was held back from swapIn.
        uint256 fee = charge(L, FEE_COMPOUND_SWAP, owner, r.tokens[0], pot);
        emit RewardsCompounded(owner, tokenId, used, out);
        aeroKept = pot - fee - used;
        if (r.tokens[r.hops] == tokenA) outA = out;
        else outB = out;
    }

    /// @notice Sells AERO along the fixed compound route with a floor. Never reverts for market reasons: a failed
    /// swap returns (0, 0) and the AERO stays in the position's reserve.
    function tryCompound(address router, Route storage r, uint256 aeroIn, uint256 minOut) public returns (uint256 used, uint256 out) {
        if (minOut == 0) return (0, 0);
        address aero = r.tokens[0];
        address target = r.tokens[r.hops];
        bytes memory path = abi.encodePacked(aero);
        for (uint256 i = 0; i < r.hops; i++) path = abi.encodePacked(path, r.spacings[i], r.tokens[i + 1]);
        uint256 aeroBefore = IERC20(aero).balanceOf(address(this));
        uint256 outBefore = IERC20(target).balanceOf(address(this));
        IERC20(aero).forceApprove(router, aeroIn);
        try ISwapRouter(router).exactInput(ISwapRouter.ExactInputParams({
            path: path, recipient: address(this), deadline: block.timestamp, amountIn: aeroIn, amountOutMinimum: minOut
        })) {} catch {}
        IERC20(aero).forceApprove(router, 0);
        used = aeroBefore - IERC20(aero).balanceOf(address(this));
        out = IERC20(target).balanceOf(address(this)) - outBefore;
        if (used > 0 && out < minOut) revert SlippageExceeded();
    }

    // ==========================================
    // TWAP
    // ==========================================

    function twapTick(address pool, uint32 window) public view returns (bool ok, int24 tick) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        ago[1] = 0;
        try ICLPool(pool).observe(ago) returns (int56[] memory cum, uint160[] memory) {
            int56 delta = cum[1] - cum[0];
            int56 w = int56(uint56(window));
            tick = int24(delta / w);
            if (delta < 0 && (delta % w != 0)) tick--;
            return (true, tick);
        } catch {
            return (false, 0);
        }
    }

    /// @notice TWAP-implied output of one pool for `amountIn` (no slippage applied); ok=false if unreadable.
    function twapQuote(address pool, uint32 window, bool zeroForOne, uint256 amountIn) public view returns (bool ok, uint256 out) {
        int24 tick;
        (ok, tick) = twapTick(pool, window);
        if (!ok) return (false, 0);
        uint160 sqrtP = TickMath.getSqrtRatioAtTick(tick);
        out = zeroForOne
            ? Math.mulDiv(Math.mulDiv(amountIn, sqrtP, Q96), sqrtP, Q96)
            : Math.mulDiv(Math.mulDiv(amountIn, Q96, sqrtP), Q96, sqrtP);
    }

    /// @notice TWAP-implied output of one pool minus `slippageBps`; ok=false if the TWAP cannot be read.
    function twapFloor(address pool, uint32 window, bool zeroForOne, uint256 amountIn, uint16 slippageBps)
        external view returns (bool ok, uint256 minOut)
    {
        uint256 q;
        (ok, q) = twapQuote(pool, window, zeroForOne, amountIn);
        if (ok) minOut = (q * (BPS - slippageBps)) / BPS;
    }

    /// @notice TWAP-implied output of the whole compound route (every hop at its own pool's TWAP) minus
    /// `slippageBps`; 0 if any hop's TWAP cannot be read.
    function routeFloor(Route storage r, uint32 window, uint256 amountIn, uint16 slippageBps) public view returns (uint256) {
        uint256 amt = amountIn;
        for (uint256 i = 0; i < r.hops; i++) {
            bool ok;
            (ok, amt) = twapQuote(r.pools[i], window, r.zeroForOne[i], amt);
            if (!ok) return 0;
        }
        return (amt * (BPS - slippageBps)) / BPS;
    }
}
