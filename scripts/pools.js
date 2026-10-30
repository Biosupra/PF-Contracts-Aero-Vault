// The Aerodrome deployment every Panda vault uses, and the vaults we know how to deploy. Every address here was
// read on-chain (2026-09-27): each pool from the new CLFactory's getPool, each gauge from pool.gauge(), and each
// gauge checked for nft() == NFPM and rewardToken() == AERO. The PandaVault constructor re-checks all of it.
const AERODROME = {
  NFPM: "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53",   // new-factory NonfungiblePositionManager
  ROUTER: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F", // new-factory SwapRouter
  FACTORY: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
  VOTER: "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5",
};
const TOKENS = {
  AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",   // 8 decimals
};

// tokenA = the volatile side, tokenB = the quote side (zap deposits come in as tokenB).
// route = the fixed AERO -> ... compounding path (tokens and each hop's tick spacing), deepest pools first.
// guardRails = per-vault keeper limits (null = the registry default).
const VAULTS = {
  "weth-usdc": {
    tokenA: TOKENS.WETH, tokenB: TOKENS.USDC,
    gauge: "0xA0B61fdB9f1FB9b917Fe38b49427Fd4D87472D28",          // CL50 WETH/USDC 0x3FE0...392A
    route: { tokens: [TOKENS.AERO, TOKENS.WETH], spacings: [200] }, // AERO/WETH CL200 0x4e50...cE51
    guardRails: null,
  },
  "cbbtc-usdc": {
    tokenA: TOKENS.cbBTC, tokenB: TOKENS.USDC,
    gauge: "0x7B0f1103746648FBfce9222f1266f79B934E16b2",          // CL50 cbBTC/USDC 0x160D...eb12 (token0 = USDC)
    // AERO -> WETH (CL200, deep) -> cbBTC (CL10 0x42d4...B76b); the direct AERO/cbBTC CL200 pool is much thinner.
    route: { tokens: [TOKENS.AERO, TOKENS.WETH, TOKENS.cbBTC], spacings: [200, 10] },
    guardRails: null,
  },
};

module.exports = { AERODROME, TOKENS, VAULTS };
