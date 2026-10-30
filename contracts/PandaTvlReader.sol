// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "./interfaces/IPandaRegistry.sol";
import "./libraries/TickMath.sol";

interface IRegistryVaults {
    function vaults() external view returns (address[] memory);
}

interface IVaultForTvl {
    function openPositionCount() external view returns (uint256);
    function openPositionAt(uint256 i) external view returns (uint256);
    function reserves(uint256 id) external view returns (uint256 a, uint256 b, uint256 aero);
    function positionManager() external view returns (address);
    function tokenA() external view returns (address);
    function tokenB() external view returns (address);
    function aIsToken0() external view returns (bool);
    function spotTwapTicks() external view returns (int24 spot, int24 twap, uint24 maxDeviation);
}

interface INfpmPositions {
    function positions(uint256 tokenId) external view returns (
        uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper,
        uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1);
}

/**
 * @title PandaTvlReader
 * @notice The vaults' 30-day average size, measured on chain, and the fee stage it implies (owner 2026-10-10: stage
 * moves must not depend on a person). Once a day anyone calls `poke()` (the keeper does it in its heartbeat): the
 * reader values every open position of every registered vault in its vault's token B (USDC for the live vault) at the
 * pool's time-weighted price (the same 5-minute TWAP the vault's guard rails use, so a one-block price push can't
 * move it), adds the position's reserve, and keeps the last 30 daily samples. The 30-day average decides the stage:
 *
 *  - up one step when the average is at least `enterAt[next]` (the "move when" level: the line times the old
 *    company rate over the new one, so the company's income never falls on a move);
 *  - down one step when the average is below `lineAt[current]` (the band's own line);
 *  - at most one step per `STEP_COOLDOWN` (7 days), only with at least `MIN_SAMPLES` (7) samples, never more than one
 *    step in a poke. The stage can never jump.
 *
 * The fee policy reads `stage()` (one stored number, cheap inside the vault's fee call). The Safe keeps an override:
 * through the timelock it can replace the thresholds, or point the fee policy back at a manual stage.
 *
 * Scale: valuing a position costs about 25,000 gas and Base caps one transaction at 16,777,216 gas (measured
 * 2026-10-11), so one transaction can value roughly 650 positions. A sample is therefore taken in pieces when needed:
 * `poke(maxPositions)` values up to that many positions and keeps a running total; the call that values the last one
 * records the sample. A sample still unfinished SWEEP_MAX_AGE after it started is thrown away and started again, so a
 * stale half-sample can never count. Positions opened or closed while a sample is in progress can be counted at most
 * once and can be missed (the vault's position list is reordered on removal); the error is at most those positions and
 * the 30-day average dampens it. `poke()` with no argument values everything in one transaction (small vaults).
 */
contract PandaTvlReader is Ownable2Step {
    uint256 public constant SAMPLES = 30;
    uint256 public constant MIN_SAMPLES = 7;
    uint256 public constant SAMPLE_INTERVAL = 20 hours; // a daily poke with slack
    uint256 public constant STEP_COOLDOWN = 7 days;
    uint256 public constant MAX_STAGES = 8;
    uint256 public constant SWEEP_MAX_AGE = 6 hours;
    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant ONE = 1e18; // running totals are kept in token-B value scaled to 18 decimals

    IPandaRegistry public immutable registry;

    uint256[] internal _lineAt;   // stage k's own line, in whole token-B units (USDC): fall below it to drop a step
    uint256[] internal _enterAt;  // the level the 30-day average must reach to move UP into stage k
    uint256 public stage;
    uint256 public lastStepAt;

    uint256[SAMPLES] internal _samples; // whole token-B units
    uint256 public sampleCount;
    uint256 public lastSampleAt;
    uint256 public lastTotal;

    // The sample in progress (0 = none): where the next piece starts and the value counted so far.
    uint256 public sweepStartedAt;
    uint256 public sweepVault;       // index into registry.vaults()
    uint256 public sweepIndex;       // next open-position index in that vault
    uint256 public sweepValueE18;    // token-B value counted so far, scaled to 18 decimals

    error BadThresholds();
    error TooSoon();
    error ZeroBatch();

    event Sampled(uint256 total, uint256 average, uint256 samples);
    event StageMoved(uint256 indexed from, uint256 indexed to, uint256 average);
    event ThresholdsSet(uint256[] lineAt, uint256[] enterAt);
    event SweepStarted(uint256 at);
    event SweepProgress(uint256 vaultIndex, uint256 positionIndex, uint256 valueE18);

    constructor(address registry_, address initialOwner, uint256[] memory lineAt, uint256[] memory enterAt, uint256 initialStage) Ownable(initialOwner) {
        require(registry_ != address(0), "registry");
        registry = IPandaRegistry(registry_);
        _setThresholds(lineAt, enterAt);
        require(initialStage < lineAt.length, "stage");
        stage = initialStage;
    }

    // ------------------------------------------------------------------ views

    function thresholds() external view returns (uint256[] memory lineAt, uint256[] memory enterAt) { return (_lineAt, _enterAt); }

    /// @notice The 30-day average of the daily samples taken so far (0 before the first).
    function average() public view returns (uint256) {
        uint256 n = sampleCount < SAMPLES ? sampleCount : SAMPLES;
        if (n == 0) return 0;
        uint256 sum;
        for (uint256 i = 0; i < n; i++) sum += _samples[i];
        return sum / n;
    }

    /// @notice Every registered vault's open positions valued now, in whole token-B units (USDC dollars for the live vault).
    /// A view for dashboards and checks; the sample itself is taken by `poke`, with the same valuation.
    function totalValue() public view returns (uint256) {
        address[] memory vaults = IRegistryVaults(address(registry)).vaults();
        uint256 sumE18;
        for (uint256 v = 0; v < vaults.length; v++) {
            (uint256 val,,) = _valueSlice(vaults[v], 0, type(uint256).max);
            sumE18 += val;
        }
        return sumE18 / ONE;
    }

    /// @notice One vault's open positions, valued in whole units of its token B at the pool's TWAP (reserves included).
    function vaultValue(address vaultAddr) public view returns (uint256) {
        (uint256 val,,) = _valueSlice(vaultAddr, 0, type(uint256).max);
        return val / ONE;
    }

    /// @notice Whether a sample is in progress (it continues with the next `poke`), and where it stands.
    function sweeping() external view returns (bool inProgress, uint256 vaultIndex, uint256 positionIndex, uint256 startedAt) {
        inProgress = sweepStartedAt != 0 && block.timestamp <= sweepStartedAt + SWEEP_MAX_AGE;
        return (inProgress, sweepVault, sweepIndex, sweepStartedAt);
    }

    /// @dev Positions [start, start + budget) of one vault (fewer at its end), valued at the pool's TWAP in token B
    /// scaled to 18 decimals, reserves included. Returns the value, the next index and whether the vault is finished.
    function _valueSlice(address vaultAddr, uint256 start, uint256 budget) internal view returns (uint256 valueE18, uint256 next, bool done) {
        IVaultForTvl vault = IVaultForTvl(vaultAddr);
        uint256 n = vault.openPositionCount();
        if (start >= n) return (0, start, true);
        next = budget >= n - start ? n : start + budget;
        INfpmPositions nfpm = INfpmPositions(vault.positionManager());
        bool aIs0 = vault.aIsToken0();
        (, int24 twap,) = vault.spotTwapTicks();
        uint160 sqrtP = TickMath.getSqrtRatioAtTick(twap);
        uint256 amountA;
        uint256 amountB;
        for (uint256 i = start; i < next; i++) {
            uint256 id = vault.openPositionAt(i);
            (,,,,, int24 lo, int24 hi, uint128 liq,,,,) = nfpm.positions(id);
            (uint256 a0, uint256 a1) = _amountsForLiquidity(sqrtP, TickMath.getSqrtRatioAtTick(lo), TickMath.getSqrtRatioAtTick(hi), liq);
            (uint256 ra, uint256 rb,) = vault.reserves(id);
            amountA += (aIs0 ? a0 : a1) + ra;
            amountB += (aIs0 ? a1 : a0) + rb;
        }
        // token A priced in token B at the TWAP: price = (sqrtP / Q96)^2 as token1 per token0
        uint256 aInB = aIs0
            ? Math.mulDiv(Math.mulDiv(amountA, sqrtP, Q96), sqrtP, Q96)
            : Math.mulDiv(Math.mulDiv(amountA, Q96, sqrtP), Q96, sqrtP);
        uint8 dec = IERC20Metadata(vault.tokenB()).decimals();
        uint256 raw = amountB + aInB;
        valueE18 = dec <= 18 ? raw * (10 ** (18 - dec)) : raw / (10 ** (dec - 18));
        done = next >= n;
    }

    // ------------------------------------------------------------------ anyone

    /// @notice Take today's sample in one transaction (fine while the vaults hold a few hundred positions).
    function poke() external returns (bool done, uint256 total, uint256 avg) {
        return _poke(type(uint256).max);
    }

    /// @notice Take today's sample, valuing at most `maxPositions` positions in this transaction. The call that values
    /// the last position records the sample and moves the stage one step if the 30-day average says so. Anyone.
    function poke(uint256 maxPositions) external returns (bool done, uint256 total, uint256 avg) {
        if (maxPositions == 0) revert ZeroBatch();
        return _poke(maxPositions);
    }

    function _poke(uint256 maxPositions) internal returns (bool done, uint256 total, uint256 avg) {
        if (sweepStartedAt == 0 || block.timestamp > sweepStartedAt + SWEEP_MAX_AGE) {
            if (block.timestamp < lastSampleAt + SAMPLE_INTERVAL) revert TooSoon();
            sweepStartedAt = block.timestamp;
            sweepVault = 0;
            sweepIndex = 0;
            sweepValueE18 = 0;
            emit SweepStarted(block.timestamp);
        }
        address[] memory vaults = IRegistryVaults(address(registry)).vaults();
        uint256 v = sweepVault;
        uint256 i = sweepIndex;
        uint256 acc = sweepValueE18;
        uint256 budget = maxPositions;
        while (v < vaults.length && budget > 0) {
            (uint256 val, uint256 next, bool vaultDone) = _valueSlice(vaults[v], i, budget);
            acc += val;
            budget -= next - i;
            if (vaultDone) { v++; i = 0; } else { i = next; }
        }
        if (v < vaults.length) {
            sweepVault = v;
            sweepIndex = i;
            sweepValueE18 = acc;
            emit SweepProgress(v, i, acc);
            return (false, 0, 0);
        }
        sweepStartedAt = 0;
        sweepVault = 0;
        sweepIndex = 0;
        sweepValueE18 = 0;
        done = true;
        total = acc / ONE;
        _samples[sampleCount % SAMPLES] = total;
        sampleCount += 1;
        lastSampleAt = block.timestamp;
        lastTotal = total;
        avg = average();
        emit Sampled(total, avg, sampleCount < SAMPLES ? sampleCount : SAMPLES);

        if (sampleCount >= MIN_SAMPLES && block.timestamp >= lastStepAt + STEP_COOLDOWN) {
            uint256 s = stage;
            if (s + 1 < _enterAt.length && avg >= _enterAt[s + 1]) {
                stage = s + 1;
                lastStepAt = block.timestamp;
                emit StageMoved(s, s + 1, avg);
            } else if (s > 0 && avg < _lineAt[s]) {
                stage = s - 1;
                lastStepAt = block.timestamp;
                emit StageMoved(s, s - 1, avg);
            }
        }
    }

    // ------------------------------------------------------------------ owner (timelock)

    /// @notice Replace the thresholds (same length, rising, enterAt[k] >= lineAt[k]).
    function setThresholds(uint256[] calldata lineAt, uint256[] calldata enterAt) external onlyOwner { _setThresholds(lineAt, enterAt); }

    function _setThresholds(uint256[] memory lineAt, uint256[] memory enterAt) internal {
        uint256 n = lineAt.length;
        if (n == 0 || n > MAX_STAGES || enterAt.length != n || lineAt[0] != 0 || enterAt[0] != 0) revert BadThresholds();
        for (uint256 i = 1; i < n; i++) {
            if (lineAt[i] <= lineAt[i - 1] || enterAt[i] < lineAt[i] || enterAt[i] <= enterAt[i - 1]) revert BadThresholds();
        }
        _lineAt = lineAt;
        _enterAt = enterAt;
        emit ThresholdsSet(lineAt, enterAt);
    }

    /// @dev Uniswap v3 LiquidityAmounts.getAmountsForLiquidity (token0, token1).
    function _amountsForLiquidity(uint160 sqrtP, uint160 sqrtA, uint160 sqrtB, uint128 liq) internal pure returns (uint256 amount0, uint256 amount1) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        if (sqrtP <= sqrtA) {
            amount0 = _amount0(sqrtA, sqrtB, liq);
        } else if (sqrtP < sqrtB) {
            amount0 = _amount0(sqrtP, sqrtB, liq);
            amount1 = _amount1(sqrtA, sqrtP, liq);
        } else {
            amount1 = _amount1(sqrtA, sqrtB, liq);
        }
    }

    function _amount0(uint160 sqrtA, uint160 sqrtB, uint128 liq) internal pure returns (uint256) {
        return Math.mulDiv(uint256(liq) << 96, sqrtB - sqrtA, sqrtB) / sqrtA;
    }

    function _amount1(uint160 sqrtA, uint160 sqrtB, uint128 liq) internal pure returns (uint256) {
        return Math.mulDiv(liq, sqrtB - sqrtA, Q96);
    }
}
