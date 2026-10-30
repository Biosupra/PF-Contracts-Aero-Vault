// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Minimal concentrated-liquidity interfaces, written for this repo (no third-party source copied). The position
/// manager, pool, factory and router keep the Aerodrome Slipstream shapes, which Aero (Dromos "Metadex" Slipstream,
/// github.com/Dromos-Labs/metadex-slipstream-public) kept unchanged. The gauge is Aero's: rewards are claimed with
/// `claimEmissions` and read with the array `earned`; there is no `getReward`, `rewardRate`, `periodFinish` or
/// `rewardToken`. The PandaVault on `main` (and on chain) is the Aerodrome version.

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        int24 tickSpacing;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
        uint160 sqrtPriceX96;
    }
    function mint(MintParams calldata params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    function increaseLiquidity(IncreaseLiquidityParams calldata params) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1);

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    function decreaseLiquidity(DecreaseLiquidityParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    function positions(uint256 tokenId) external view returns (
        uint96 nonce, address operator, address token0, address token1, int24 tickSpacing,
        int24 tickLower, int24 tickUpper, uint128 liquidity,
        uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128,
        uint128 tokensOwed0, uint128 tokensOwed1
    );

    function approve(address to, uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function factory() external view returns (address);
}

/// @dev Aero's CL gauge. `withdraw` settles and pays the position's emissions to the caller in the same call; if the
/// emissions cannot be minted then, they are stored per ACCOUNT (`deferredEmissions`) and paid on that account's next
/// `claimEmissions`, whatever token ids it names. A position unstaked or claimed within `minStakeBlocks` of its
/// `depositBlock` forfeits a share of its emissions (never principal).
interface ICLGauge {
    function deposit(uint256 tokenId) external;
    function withdraw(uint256 tokenId) external;
    /// @dev Caller must be `account` (or approved by it). Also pays all of `account`'s deferred emissions.
    function claimEmissions(address account, address recipient, uint256[] calldata tokenIds) external;
    /// @dev Penalty and Aero's own referral share already applied; includes `deferredEmissions(account)`.
    function earned(address account, uint256[] calldata tokenIds) external view returns (uint256);
    function deferredEmissions(address account) external view returns (uint256);
    function depositBlock(uint256 tokenId) external view returns (uint256);
    function gaugeFactory() external view returns (address);
    function voter() external view returns (address);
    function tickSpacing() external view returns (int24);
    function pool() external view returns (address);
    function nft() external view returns (address);
}

/// @dev Aero's CL gauge factory: the early-unstake penalty that applies to a gauge (rate in pips, 1e6 = 100%).
interface ICLGaugeFactory {
    function effectivePenaltyConfig(address gauge) external view returns (uint256 minStakeBlocks, uint256 penaltyRate);
}

interface ICLPool {
    function slot0() external view returns (
        uint160 sqrtPriceX96, int24 tick, uint16 observationIndex,
        uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked
    );
    function token0() external view returns (address);
    function token1() external view returns (address);
    function tickSpacing() external view returns (int24);
    function factory() external view returns (address);
    function gauge() external view returns (address);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}

interface ISwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
    /// @dev Slipstream routers resolve every path hop through THEIR factory.
    function factory() external view returns (address);
}

interface ICLFactory {
    function getPool(address tokenA, address tokenB, int24 tickSpacing) external view returns (address);
}
