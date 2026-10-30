// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "../libraries/TickMath.sol";

/// Test-only stand-ins that behave like Aero's Base contracts as read from the public source
/// (Dromos-Labs/metadex-slipstream-public CLGauge / Gauge, metadex-public LeafVoter / Token). Written for this repo;
/// no Dromos code is copied. Never deployed to a live network.

interface IMockCLFactory { function getPool(address a, address b, int24 ts) external view returns (address); }
interface IMockCLPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, bool);
}

/// @dev The new AERO stand-in: minted by the voter. The DEPLOYED token (0x3f5b...a4Ee) has no transfer lock; the
/// `transfersEnabledAt` switch only plays a token that refuses a payout, to prove the vault reverts instead of booking it.
contract MockAeroToken is ERC20 {
    uint256 public transfersEnabledAt;
    constructor() ERC20("Aero", "AERO") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setTransfersEnabledAt(uint256 t) external { transfersEnabledAt = t; }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) require(block.timestamp >= transfersEnabledAt, "TransfersDisabled");
        super._update(from, to, value);
    }
}

contract MockCLFactory {
    mapping(bytes32 => address) internal _pools;
    function setPool(address a, address b, int24 ts, address pool) external {
        _pools[keccak256(abi.encode(a, b, ts))] = pool;
        _pools[keccak256(abi.encode(b, a, ts))] = pool;
    }
    function getPool(address a, address b, int24 ts) external view returns (address) { return _pools[keccak256(abi.encode(a, b, ts))]; }
}

/// @dev CL pool: settable spot tick and TWAP tick (observe returns cumulatives whose average is the TWAP tick).
contract MockCLPool {
    address public token0;
    address public token1;
    int24 public tickSpacing;
    address public factory;
    address public gauge;
    address public nft;
    int24 public tick;
    int24 public twapTick;
    bool public twapBroken;
    /// The pool's swap fee in pips (1e6 = 100%), as the real CLPool.fee() (Aero: per tick spacing, changeable by its fee
    /// manager). 0 unless the test sets it; the mock router charges nothing either way.
    uint24 public fee;

    constructor(address t0, address t1, int24 ts, address factory_) {
        (token0, token1) = t0 < t1 ? (t0, t1) : (t1, t0);
        tickSpacing = ts;
        factory = factory_;
    }
    function setGauge(address g, address n) external { gauge = g; nft = n; }
    function setFee(uint24 f) external { fee = f; }
    function setTick(int24 t) external { tick = t; twapTick = t; }
    function setSpot(int24 t) external { tick = t; }
    function setTwapBroken(bool b) external { twapBroken = b; }
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, bool) {
        return (TickMath.getSqrtRatioAtTick(tick), tick, 0, 1000, 1000, true);
    }
    function observe(uint32[] calldata ago) external view returns (int56[] memory cum, uint160[] memory spl) {
        require(!twapBroken, "OLD");
        cum = new int56[](ago.length);
        spl = new uint160[](ago.length);
        for (uint256 i = 0; i < ago.length; i++) cum[i] = -int56(twapTick) * int56(uint56(ago[i]));
    }
    function increaseObservationCardinalityNext(uint16) external {}
}

/// @dev Position manager with Slipstream's shapes. Price comes from the pool's spot tick; liquidity is a plain number
/// (token0 + token1 value at mint), principal is tracked per position and paid back pro rata.
contract MockAeroNfpm is ERC721 {
    using SafeERC20 for IERC20;
    struct Pos { address token0; address token1; int24 ts; int24 lo; int24 hi; uint128 liq; uint256 amt0; uint256 amt1; uint256 owed0; uint256 owed1; }
    address public factory;
    uint256 public nextId = 1;
    mapping(uint256 => Pos) internal _pos;

    constructor(address factory_) ERC721("Mock CL positions", "MCLP") { factory = factory_; }

    struct MintParams { address token0; address token1; int24 tickSpacing; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; uint160 sqrtPriceX96; }
    struct IncreaseLiquidityParams { uint256 tokenId; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }
    struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }
    struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }

    function _take(address pool, int24 lo, int24 hi, uint256 a0, uint256 a1) internal view returns (uint256 u0, uint256 u1) {
        (uint160 sqrtP, int24 t,,,,) = IMockCLPool(pool).slot0();
        if (t < lo) return (a0, 0);
        if (t >= hi) return (0, a1);
        uint256 a1In0 = Math.mulDiv(Math.mulDiv(a1, 2 ** 96, sqrtP), 2 ** 96, sqrtP);
        u0 = a0 < a1In0 ? a0 : a1In0;
        u1 = Math.mulDiv(Math.mulDiv(u0, sqrtP, 2 ** 96), sqrtP, 2 ** 96);
        if (u1 > a1) u1 = a1;
    }

    function mint(MintParams calldata p) external payable returns (uint256 id, uint128 liq, uint256 u0, uint256 u1) {
        require(block.timestamp <= p.deadline, "Transaction too old");
        address pool = IMockCLFactory(factory).getPool(p.token0, p.token1, p.tickSpacing);
        require(pool != address(0), "no pool");
        (u0, u1) = _take(pool, p.tickLower, p.tickUpper, p.amount0Desired, p.amount1Desired);
        require(u0 + u1 > 0, "zero");
        require(u0 >= p.amount0Min && u1 >= p.amount1Min, "Price slippage check");
        if (u0 > 0) IERC20(p.token0).safeTransferFrom(msg.sender, address(this), u0);
        if (u1 > 0) IERC20(p.token1).safeTransferFrom(msg.sender, address(this), u1);
        id = nextId++;
        liq = uint128(u0 + u1);
        _pos[id] = Pos(p.token0, p.token1, p.tickSpacing, p.tickLower, p.tickUpper, liq, u0, u1, 0, 0);
        _mint(p.recipient, id);
    }

    function increaseLiquidity(IncreaseLiquidityParams calldata p) external payable returns (uint128 liq, uint256 u0, uint256 u1) {
        require(_isAuthorized(_ownerOf(p.tokenId), msg.sender, p.tokenId), "Not approved");
        Pos storage s = _pos[p.tokenId];
        address pool = IMockCLFactory(factory).getPool(s.token0, s.token1, s.ts);
        (u0, u1) = _take(pool, s.lo, s.hi, p.amount0Desired, p.amount1Desired);
        require(u0 >= p.amount0Min && u1 >= p.amount1Min, "Price slippage check");
        if (u0 > 0) IERC20(s.token0).safeTransferFrom(msg.sender, address(this), u0);
        if (u1 > 0) IERC20(s.token1).safeTransferFrom(msg.sender, address(this), u1);
        liq = uint128(u0 + u1);
        s.liq += liq;
        s.amt0 += u0;
        s.amt1 += u1;
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata p) external payable returns (uint256 o0, uint256 o1) {
        require(_isAuthorized(_ownerOf(p.tokenId), msg.sender, p.tokenId), "Not approved");
        Pos storage s = _pos[p.tokenId];
        require(p.liquidity <= s.liq, "liq");
        o0 = s.amt0 * p.liquidity / s.liq;
        o1 = s.amt1 * p.liquidity / s.liq;
        require(o0 >= p.amount0Min && o1 >= p.amount1Min, "Price slippage check");
        s.liq -= p.liquidity;
        s.amt0 -= o0;
        s.amt1 -= o1;
        s.owed0 += o0;
        s.owed1 += o1;
    }

    function collect(CollectParams calldata p) external payable returns (uint256 c0, uint256 c1) {
        require(_isAuthorized(_ownerOf(p.tokenId), msg.sender, p.tokenId), "Not approved");
        Pos storage s = _pos[p.tokenId];
        c0 = s.owed0 < p.amount0Max ? s.owed0 : p.amount0Max;
        c1 = s.owed1 < p.amount1Max ? s.owed1 : p.amount1Max;
        s.owed0 -= c0;
        s.owed1 -= c1;
        if (c0 > 0) IERC20(s.token0).safeTransfer(p.recipient, c0);
        if (c1 > 0) IERC20(s.token1).safeTransfer(p.recipient, c1);
    }

    /// @dev Test helper: credit trading fees to a position (pulled from the caller).
    function addFees(uint256 id, uint256 f0, uint256 f1) external {
        Pos storage s = _pos[id];
        if (f0 > 0) IERC20(s.token0).safeTransferFrom(msg.sender, address(this), f0);
        if (f1 > 0) IERC20(s.token1).safeTransferFrom(msg.sender, address(this), f1);
        s.owed0 += f0;
        s.owed1 += f1;
    }

    function positions(uint256 id) external view returns (
        uint96, address, address, address, int24, int24, int24, uint128, uint256, uint256, uint128, uint128
    ) {
        Pos storage s = _pos[id];
        return (0, address(0), s.token0, s.token1, s.ts, s.lo, s.hi, s.liq, 0, 0, uint128(s.owed0), uint128(s.owed1));
    }
}

/// @dev Aero's LeafVoter as the gauge sees it: mints the new AERO to the recipients (synchronous on Base, the root
/// chain), or reverts when the gauge's entitlement cannot be minted (`failMint`), and takes back forfeited emissions.
contract MockLeafVoter {
    MockAeroToken public immutable aero;
    bool public failMint;
    uint256 public forfeited;
    /// @dev Aero's root emissions handler pays sub-1e6-wei amounts with the account's NEXT mint: the next mint pays
    /// `holdback` wei less than asked (one shot), the way such dust shifts between claims.
    uint256 public holdback;
    constructor(MockAeroToken aero_) { aero = aero_; }
    function setFailMint(bool f) external { failMint = f; }
    function setHoldback(uint256 h) external { holdback = h; }
    function mintEmissions(address[] calldata to, uint128[] calldata amounts) external {
        require(!failMint, "CeilingExceeded");
        for (uint256 i = 0; i < to.length; i++) {
            uint256 a = amounts[i];
            if (holdback > 0 && a > holdback) { a -= holdback; holdback = 0; }
            aero.mint(to[i], a);
        }
    }
    function forfeitEmissions(uint128 amount) external { forfeited += amount; }
}

contract MockGaugeFactory {
    uint256 public minStakeBlocks = 5;    // Aero's factory default
    uint256 public penaltyRate = 1e6;     // pips: 100% of emissions forfeited inside the window
    bool public broken;
    function setPenalty(uint256 blocks, uint256 rate) external { minStakeBlocks = blocks; penaltyRate = rate; }
    function setBroken(bool b) external { broken = b; }
    function effectivePenaltyConfig(address) external view returns (uint256, uint256) {
        require(!broken, "broken");
        return (minStakeBlocks, penaltyRate);
    }
}

interface IMockNfpm {
    function ownerOf(uint256) external view returns (address);
    function safeTransferFrom(address, address, uint256) external;
    function positions(uint256) external view returns (uint96, address, address, address, int24, int24, int24, uint128, uint256, uint256, uint128, uint128);
    function collect(MockAeroNfpm.CollectParams calldata) external payable returns (uint256, uint256);
}

/// @dev Aero's CL gauge, behaviour only: emissions accrue PER BLOCK through a growth accumulator (no rewardRate /
/// periodFinish / epochs); `withdraw` claims the position's emissions to the caller, or stores them per ACCOUNT when
/// the voter cannot mint; `claimEmissions` (caller must be the account) pays the named positions plus ALL of the
/// account's deferred emissions; the early-unstake penalty applies to withdraw and claim inside the window.
contract MockAeroGauge is ERC721Holder {
    address public immutable pool;
    address public immutable nft;
    address public immutable voter;
    address public immutable gaugeFactory;
    int24 public immutable tickSpacing;
    address public immutable token0;
    address public immutable token1;

    uint256 public ratePerBlock; // AERO per block per 1e18 liquidity
    uint256 public acc;
    uint256 public lastBlock;
    mapping(uint256 => uint256) public snap;
    mapping(uint256 => uint256) public depositBlock;
    mapping(uint256 => address) public stakeOwner;
    mapping(address => uint256) public deferredEmissions;
    mapping(address => mapping(uint256 => bool)) internal _staked;

    event Deferred(address account, uint256 tokenId, uint256 amount);

    constructor(address pool_, address nft_, address voter_, address factory_, int24 ts, address t0, address t1) {
        pool = pool_; nft = nft_; voter = voter_; gaugeFactory = factory_; tickSpacing = ts; token0 = t0; token1 = t1;
        lastBlock = block.number;
    }

    function _accNow() internal view returns (uint256) { return acc + ratePerBlock * (block.number - lastBlock); }
    function _settle() internal { acc = _accNow(); lastBlock = block.number; }
    function setRatePerBlock(uint256 r) external { _settle(); ratePerBlock = r; }

    function _liq(uint256 id) internal view returns (uint128 liq) { (,,,,,,, liq,,,,) = IMockNfpm(nft).positions(id); }
    function _raw(uint256 id) internal view returns (uint256) { return uint256(_liq(id)) * (_accNow() - snap[id]) / 1e18; }
    function _penalty(uint256 id, uint256 reward) internal view returns (uint256) {
        (uint256 blocks, uint256 rate) = MockGaugeFactory(gaugeFactory).effectivePenaltyConfig(address(this));
        return rate > 0 && blocks > 0 && block.number < depositBlock[id] + blocks ? reward * rate / 1e6 : 0;
    }
    function _take(uint256 id) internal returns (uint256 reward) {
        reward = _raw(id);
        snap[id] = acc;
        uint256 pen = _penalty(id, reward);
        if (pen > 0) MockLeafVoter(voter).forfeitEmissions(uint128(pen));
        reward -= pen;
    }
    function _mintTo(address to, uint256 amount) internal {
        address[] memory r = new address[](1);
        uint128[] memory a = new uint128[](1);
        r[0] = to;
        a[0] = uint128(amount);
        MockLeafVoter(voter).mintEmissions(r, a);
    }
    function _mintOrDefer(address account, address to, uint256 id, uint256 amount) external {
        require(msg.sender == address(this));
        try this._mint(to, amount) {} catch { deferredEmissions[account] += amount; emit Deferred(account, id, amount); }
    }
    function _mint(address to, uint256 amount) external { require(msg.sender == address(this)); _mintTo(to, amount); }

    function deposit(uint256 id) external {
        require(IMockNfpm(nft).ownerOf(id) == msg.sender, "NA");
        (,, address t0, address t1, int24 ts,,,,,,,) = IMockNfpm(nft).positions(id);
        require(t0 == token0 && t1 == token1 && ts == tickSpacing, "PM");
        IMockNfpm(nft).collect(MockAeroNfpm.CollectParams(id, msg.sender, type(uint128).max, type(uint128).max));
        IMockNfpm(nft).safeTransferFrom(msg.sender, address(this), id);
        _settle();
        snap[id] = acc;
        depositBlock[id] = block.number;
        stakeOwner[id] = msg.sender;
        _staked[msg.sender][id] = true;
    }

    function withdraw(uint256 id) external {
        require(stakeOwner[id] == msg.sender, "NA");
        IMockNfpm(nft).collect(MockAeroNfpm.CollectParams(id, msg.sender, type(uint128).max, type(uint128).max));
        _settle();
        uint256 reward = _take(id);
        if (reward > 0) this._mintOrDefer(msg.sender, msg.sender, id, reward);
        delete stakeOwner[id];
        delete depositBlock[id];
        _staked[msg.sender][id] = false;
        IMockNfpm(nft).safeTransferFrom(address(this), msg.sender, id);
    }

    function claimEmissions(address account, address recipient, uint256[] calldata ids) external {
        require(msg.sender == account, "NA");
        require(recipient != address(0), "ZA");
        require(ids.length > 0 || deferredEmissions[account] > 0, "NS");
        _settle();
        uint256 total;
        for (uint256 i = 0; i < ids.length; i++) {
            require(_staked[account][ids[i]], "NA");
            total += _take(ids[i]);
        }
        total += deferredEmissions[account];
        deferredEmissions[account] = 0;
        if (total > 0) _mintTo(recipient, total);
    }

    function earned(address account, uint256[] calldata ids) external view returns (uint256 total) {
        for (uint256 i = 0; i < ids.length; i++) {
            require(_staked[account][ids[i]], "NA");
            uint256 r = _raw(ids[i]);
            total += r - _penalty(ids[i], r);
        }
        total += deferredEmissions[account];
    }

    function stakedContains(address account, uint256 id) external view returns (bool) { return _staked[account][id]; }
}

/// @dev Slipstream router shape: exactInput along (token, int24 tickSpacing, token, ...), each hop at its pool's spot
/// tick, less `haircutBps`. Pays out of its own balance (tests fund it).
contract MockRouter {
    using SafeERC20 for IERC20;
    address public factory;
    uint256 public haircutBps;
    struct ExactInputParams { bytes path; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; }
    constructor(address factory_) { factory = factory_; }
    function setHaircutBps(uint256 b) external { haircutBps = b; }

    function _addr(bytes memory p, uint256 at) internal pure returns (address a) {
        assembly { a := shr(96, mload(add(add(p, 32), at))) }
    }
    function _ts(bytes memory p, uint256 at) internal pure returns (int24 t) {
        uint256 v;
        assembly { v := shr(232, mload(add(add(p, 32), at))) }
        t = int24(uint24(v));
    }

    function exactInput(ExactInputParams calldata p) external payable returns (uint256 out) {
        require(block.timestamp <= p.deadline, "Transaction too old");
        bytes memory path = p.path;
        require(path.length >= 43 && (path.length - 20) % 23 == 0, "path");
        address tokenIn = _addr(path, 0);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        out = p.amountIn;
        address tokenOut;
        for (uint256 at = 0; at + 43 <= path.length; at += 23) {
            tokenIn = _addr(path, at);
            int24 ts = _ts(path, at + 20);
            tokenOut = _addr(path, at + 23);
            address pool = IMockCLFactory(factory).getPool(tokenIn, tokenOut, ts);
            require(pool != address(0), "no pool");
            (uint160 sqrtP,,,,,) = IMockCLPool(pool).slot0();
            out = IMockCLPool(pool).token0() == tokenIn
                ? Math.mulDiv(Math.mulDiv(out, sqrtP, 2 ** 96), sqrtP, 2 ** 96)
                : Math.mulDiv(Math.mulDiv(out, 2 ** 96, sqrtP), 2 ** 96, sqrtP);
            out = out * (10000 - haircutBps) / 10000;
        }
        require(out >= p.amountOutMinimum, "Too little received");
        IERC20(tokenOut).safeTransfer(p.recipient, out);
    }
}

interface IPandaVaultTarget {
    function tokenA() external view returns (address);
    function tokenB() external view returns (address);
    function receiveMigration(address owner, uint256 amountA, uint256 amountB, bool autoCompound, bytes calldata data) external returns (uint256);
}

/// @dev Calls `receiveMigration` exactly the way the LIVE Aerodrome PandaVault's `migrate()` does (main, PandaVault.sol
/// L716-743): same-pair check, exact approvals, the call, approvals reset, whatever was not pulled back to the owner.
contract MockLiveVault {
    using SafeERC20 for IERC20;
    IERC20 public immutable tokenA;
    IERC20 public immutable tokenB;
    constructor(IERC20 a, IERC20 b) { tokenA = a; tokenB = b; }
    /// @dev The position views PandaReferrals / PandaTvlReader read from every registered vault (no positions here).
    function openPositionCount() external pure returns (uint256) { return 0; }
    function openPositionAt(uint256) external pure returns (uint256) { revert(); }
    function migrateOut(address toVault, address owner, uint256 a, uint256 b, bool autoCompound, bytes calldata data) external returns (uint256 newTokenId) {
        IPandaVaultTarget target = IPandaVaultTarget(toVault);
        require(target.tokenA() == address(tokenA) && target.tokenB() == address(tokenB), "BadMigrationTarget");
        uint256 aBefore = tokenA.balanceOf(address(this));
        uint256 bBefore = tokenB.balanceOf(address(this));
        tokenA.forceApprove(toVault, a);
        tokenB.forceApprove(toVault, b);
        newTokenId = target.receiveMigration(owner, a, b, autoCompound, data);
        tokenA.forceApprove(toVault, 0);
        tokenB.forceApprove(toVault, 0);
        uint256 restA = a - (aBefore - tokenA.balanceOf(address(this)));
        uint256 restB = b - (bBefore - tokenB.balanceOf(address(this)));
        if (restA > 0) tokenA.safeTransfer(owner, restA);
        if (restB > 0) tokenB.safeTransfer(owner, restB);
    }
}
