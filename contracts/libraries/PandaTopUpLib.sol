// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IAerodrome.sol";
import "./PandaVaultLib.sol";

/// @dev The PandaVault getters `topUp` reads back (public immutables and views of the calling vault).
interface IPandaVaultRefs {
    function pool() external view returns (address);
    function positionManager() external view returns (address);
    function gauge() external view returns (address);
    function tokenA() external view returns (address);
    function tokenB() external view returns (address);
    function aIsToken0() external view returns (bool);
    function registry() external view returns (address);
    function swapRouter() external view returns (address);
    function aeroToken() external view returns (address);
    function depositsOpen() external view returns (bool);
}

interface ICLGaugeStaked {
    function stakedContains(address depositor, uint256 tokenId) external view returns (bool);
}

/**
 * @title PandaTopUpLib
 * @notice The body of PandaVault.topUp: add money to an EXISTING position (same NFT, same range, same owner) instead
 * of minting a new one. External library like PandaVaultLib: linked into the vault at deploy (not upgradeable) and run
 * by DELEGATECALL, so `address(this)` is the vault, `msg.sender` is the position owner (the vault already checked
 * that) and every event below is emitted from the vault's address. Kept out of PandaVaultLib so neither contract
 * crosses the 24,576-byte limit. Fees go through PandaVaultLib.chargeKind (same policy, same ceilings).
 */
library PandaTopUpLib {
    using SafeERC20 for IERC20;

    uint8 internal constant FEE_REWARD = 0;
    uint8 internal constant FEE_DEPOSIT = 1;
    uint8 internal constant FEE_ZAP_SWAP = 3;

    error DepositsClosed();
    error DeadlineExpired();
    error UnknownPosition();
    error InvalidSwapAmount();

    /// @notice The owner added `amountA` / `amountB` (after fees and any swap) to an existing position; `liquidity`
    /// went into the range, the rest to its reserve.
    event ToppedUp(address indexed user, uint256 indexed tokenId, uint256 amountA, uint256 amountB, uint128 liquidity);
    /// @notice Same signature (same topic) as PandaVault.RewardsEarned: the AERO the unstake paid, after the reward fee.
    event RewardsEarned(address indexed user, uint256 indexed tokenId, uint256 aeroAmount);

    struct Ctx {
        address registry;
        address tokenA;
        address tokenB;
        address gauge;
        address nfpm;
        address aero;
        bool aIsToken0;
    }

    /// @notice `data` = abi.encode(uint256 amountA, uint256 amountB, uint256 swapAmountIn, bytes swapPath,
    /// uint256 amountAMin, uint256 amount0Min, uint256 amount1Min, uint256 deadline).
    /// Pulls amountA / amountB from the owner, takes the deposit fee on each, optionally swaps `swapAmountIn` of the
    /// token B left (the zap-swap fee comes out of it) into token A along `swapPath` (B -> ... -> A, at least
    /// `amountAMin`), then unstakes the NFT, increases its liquidity, and restakes it. If the range cannot take the
    /// tokens (out of range on the other side, or the mint minimums fail) nothing is added and they all stay with the
    /// position. Returns what goes to the position's reserve: tokens the range did not take, and the AERO the unstake
    /// paid (reward fee taken). Every amount is a before/after balance delta inside this call.
    /// Refused while the position is inside the gauge's early-unstake window (the unstake would forfeit its emissions).
    function topUp(PandaVaultLib.AeroBook storage B, uint256 tokenId, bytes calldata data) external returns (uint256 leftA, uint256 leftB, uint256 userAero) {
        IPandaVaultRefs v = IPandaVaultRefs(address(this));
        if (!v.depositsOpen()) revert DepositsClosed();
        Ctx memory c = Ctx({
            registry: v.registry(), tokenA: v.tokenA(), tokenB: v.tokenB(), gauge: v.gauge(),
            nfpm: v.positionManager(), aero: v.aeroToken(), aIsToken0: v.aIsToken0()
        });
        if (!ICLGaugeStaked(c.gauge).stakedContains(address(this), tokenId)) revert UnknownPosition();
        PandaVaultLib.requireStakeSettled(c.gauge, tokenId);

        (uint256 amountA, uint256 amountB, uint256 swapIn, bytes memory path, uint256 aMin, uint256 min0, uint256 min1, uint256 deadline) =
            abi.decode(data, (uint256, uint256, uint256, bytes, uint256, uint256, uint256, uint256));
        if (block.timestamp > deadline) revert DeadlineExpired();

        if (amountA > 0) IERC20(c.tokenA).safeTransferFrom(msg.sender, address(this), amountA);
        if (amountB > 0) IERC20(c.tokenB).safeTransferFrom(msg.sender, address(this), amountB);
        uint256 aIn = amountA - _fee(c.registry, FEE_DEPOSIT, c.tokenA, amountA);
        uint256 bIn = amountB - _fee(c.registry, FEE_DEPOSIT, c.tokenB, amountB);
        if (swapIn > 0) {
            if (swapIn > bIn) revert InvalidSwapAmount();
            uint256 zapFee = _fee(c.registry, FEE_ZAP_SWAP, c.tokenB, swapIn);
            (uint256 consumed, uint256 received) =
                PandaVaultLib.swapExactIn(v.swapRouter(), c.tokenB, c.tokenA, path, swapIn - zapFee, aMin, deadline);
            aIn += received;
            bIn -= zapFee + consumed;
        }

        uint256 aeroBefore = IERC20(c.aero).balanceOf(address(this));
        uint128 liquidity;
        (liquidity, leftA, leftB) = _increaseStaked(c, B, tokenId, aIn, bIn, min0, min1, deadline);
        uint256 gained = IERC20(c.aero).balanceOf(address(this)) - aeroBefore;
        userAero = gained - _fee(c.registry, FEE_REWARD, c.aero, gained);
        if (userAero > 0) emit RewardsEarned(msg.sender, tokenId, userAero);
        emit ToppedUp(msg.sender, tokenId, aIn, bIn, liquidity);
    }

    function _fee(address registry, uint8 kind, address token, uint256 amount) private returns (uint256) {
        if (amount == 0) return 0;
        return PandaVaultLib.chargeKind(registry, kind, msg.sender, token, amount);
    }

    /// @dev Unstake (the gauge pays the position's pending AERO, or defers it: booked for this position, and its collect
    /// sends any owed tokens here), add the tokens to the SAME NFT, restake, leave no allowance. Left over = inputs +
    /// collected - taken, as a balance delta.
    function _increaseStaked(Ctx memory c, PandaVaultLib.AeroBook storage B, uint256 tokenId, uint256 amountA, uint256 amountB, uint256 min0, uint256 min1, uint256 deadline)
        private returns (uint128 liquidity, uint256 leftA, uint256 leftB)
    {
        uint256 a0 = IERC20(c.tokenA).balanceOf(address(this));
        uint256 b0 = IERC20(c.tokenB).balanceOf(address(this));
        INonfungiblePositionManager pm = INonfungiblePositionManager(c.nfpm);
        PandaVaultLib.unstake(c.gauge, B, tokenId, msg.sender);
        uint256 inA = amountA + IERC20(c.tokenA).balanceOf(address(this)) - a0;
        uint256 inB = amountB + IERC20(c.tokenB).balanceOf(address(this)) - b0;

        IERC20(c.tokenA).forceApprove(c.nfpm, inA);
        IERC20(c.tokenB).forceApprove(c.nfpm, inB);
        try pm.increaseLiquidity(INonfungiblePositionManager.IncreaseLiquidityParams({
            tokenId: tokenId,
            amount0Desired: c.aIsToken0 ? inA : inB,
            amount1Desired: c.aIsToken0 ? inB : inA,
            amount0Min: min0,
            amount1Min: min1,
            deadline: deadline
        })) returns (uint128 liq, uint256, uint256) {
            liquidity = liq;
        } catch {}
        IERC20(c.tokenA).forceApprove(c.nfpm, 0);
        IERC20(c.tokenB).forceApprove(c.nfpm, 0);

        pm.approve(c.gauge, tokenId);
        ICLGauge(c.gauge).deposit(tokenId);
        leftA = amountA + IERC20(c.tokenA).balanceOf(address(this)) - a0;
        leftB = amountB + IERC20(c.tokenB).balanceOf(address(this)) - b0;
    }
}
