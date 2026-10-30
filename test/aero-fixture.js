// Shared test harness for the Aero vault tests (test/aero-vault.test.js, test/aero-review.test.js): Aero-shaped
// stand-ins (contracts/test/AeroMocks.sol) around the real registry, timelock, fee policy v3 and referrals.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const E = (x) => ethers.parseEther(String(x));
const DAY = 86400;
const RAILS = { maxRebalanceSlippageBps: 100, twapWindow: 300, minRebalanceInterval: 3600, maxRangeSpacings: 40, maxTwapDeviationTicks: 100 };
const STAGES = [[0, 17, 2, 1000], [25_000, 16, 3, 1000]].map(([minVaultUsd, companyWeight, treasuryWeight, stakerShareBps]) => ({ minVaultUsd, companyWeight, treasuryWeight, stakerShareBps }));
const RATE = E("0.1"); // AERO per block per 1e18 liquidity
const FAR = 2n ** 40n;
const LO = -500, HI = 500;

async function mine(n) { await network.provider.send("hardhat_mine", ["0x" + n.toString(16)]); }
async function increaseTime(sec) { await network.provider.send("evm_increaseTime", [Number(sec)]); await network.provider.send("evm_mine"); }
const path = (...xs) => ethers.solidityPacked(xs.map((x) => (typeof x === "number" ? "int24" : "address")), xs);

async function fixture() {
  const s = await ethers.getSigners();
  const [deployer, safe, keeper, treasury, safety, company, stakers, alice, bob, carol, referrer] = s;
  const F = (n, ...a) => ethers.getContractFactory(n).then((f) => f.deploy(...a));
  const weth = await F("MockERC20", "Wrapped Ether", "WETH");
  const usdc = await F("MockERC20", "USD Coin", "USDC");
  const aero = await F("MockAeroToken");
  const factory = await F("MockCLFactory");
  const pool = await F("MockCLPool", weth.target, usdc.target, 50, factory.target);
  const aeroPool = await F("MockCLPool", aero.target, weth.target, 200, factory.target);
  await factory.setPool(weth.target, usdc.target, 50, pool.target);
  await factory.setPool(aero.target, weth.target, 200, aeroPool.target);
  const nfpm = await F("MockAeroNfpm", factory.target);
  const router = await F("MockRouter", factory.target);
  const voter = await F("MockLeafVoter", aero.target);
  const gfac = await F("MockGaugeFactory");
  const gauge = await F("MockAeroGauge", pool.target, nfpm.target, voter.target, gfac.target, 50, await pool.token0(), await pool.token1());
  await pool.setGauge(gauge.target, nfpm.target);
  await gauge.setRatePerBlock(RATE);
  for (const t of [weth, usdc, aero]) await t.mint(router.target, E(1_000_000));

  const timelock = await F("PandaTimelock", 2 * DAY, [safe.address], [safe.address], ethers.ZeroAddress);
  const registry = await F("PandaRegistry", timelock.target, {
    keeper: keeper.address, daoTreasury: treasury.address, safetyModule: safety.address, emergencyAdmin: safe.address, guardRails: RAILS,
  });
  const referrals = await F("PandaReferrals", registry.target, [], []);
  const policy = await F("PandaFeePolicyV3", {
    registry: registry.target, initialOwner: deployer.address, keeperRewardBps: 100, basePandaBps: [1900, 0, 0, 0, 0, 0, 0],
    company: company.address, stages: STAGES, activeStage: 0, stakerRewards: stakers.address, referrals: referrals.target,
    referralShareBps: 100, stageSource: ethers.ZeroAddress, minTreasuryBps: 50, specialPandaBps: 1400,
  });
  await registry.setFeePolicy(policy.target);

  const vaultLib = await F("PandaVaultLib");
  const topUpLib = await (await ethers.getContractFactory("PandaTopUpLib", { libraries: { PandaVaultLib: vaultLib.target } })).deploy();
  const Vault = await ethers.getContractFactory("PandaVault", { libraries: { PandaVaultLib: vaultLib.target, PandaTopUpLib: topUpLib.target } });
  const deployVault = (o = {}) => Vault.deploy(registry.target, nfpm.target, o.gauge || gauge.target, router.target, o.aero || aero.target,
    o.tokenA || weth.target, usdc.target, o.routeTokens || [aero.target, weth.target], o.routeSpacings || [200]);
  const vault = await deployVault();
  await registry.addVault(vault.target);

  for (const u of [alice, bob, carol]) {
    for (const t of [weth, usdc]) { await t.mint(u.address, E(10_000)); await t.connect(u).approve(vault.target, ethers.MaxUint256); }
  }
  const ctx = { s, deployer, safe, keeper, treasury, safety, company, stakers, alice, bob, carol, referrer, weth, usdc, aero, factory, pool, aeroPool,
    nfpm, router, voter, gfac, gauge, timelock, registry, referrals, policy, vaultLib, topUpLib, Vault, deployVault, vault };
  ctx.deposit = async (u, a, b, o = {}) => {
    const tx = await vault.connect(u).depositAndStake({ amountA: E(a), amountB: E(b), tickLower: o.lo ?? LO, tickUpper: o.hi ?? HI, amount0Min: 0, amount1Min: 0, deadline: FAR, autoCompound: !!o.ac });
    return mintedId(vault, await tx.wait());
  };
  ctx.feeRecipients = [keeper, company, treasury, stakers, referrer].map((x) => x.address);
  ctx.aeroOf = async (addrs) => Promise.all(addrs.map((a) => aero.balanceOf(a)));
  ctx.rebalanceParams = (tokenId, o = {}) => ({ tokenId, isAToB: !!o.isAToB, rebalanceAmountIn: o.swapIn || 0, rebalanceAmountOutMin: 0,
    newTickLower: o.lo ?? -1000, newTickUpper: o.hi ?? 1000, amount0MinMint: 0, amount1MinMint: 0, decreaseAmount0Min: 0, decreaseAmount1Min: 0, deadline: FAR });
  ctx.withdrawParams = (tokenId) => ({ tokenId, aeroToBPath: "0x", amountBMinReward: 0, amount0Min: 0, amount1Min: 0, aToBPath: "0x", amountBMinReturned: 0, deadline: FAR });
  return ctx;
}

function mintedId(vault, receipt) {
  for (const l of receipt.logs) {
    try { const p = vault.interface.parseLog(l); if (p && p.name === "PositionMinted") return p.args.tokenId; } catch (e) {}
  }
  throw new Error("no PositionMinted");
}
function events(contract, receipt, name) {
  const out = [];
  for (const l of receipt.logs) {
    try { const p = contract.interface.parseLog(l); if (p && p.name === name) out.push(p.args); } catch (e) {}
  }
  return out;
}
// What the mock gauge accrues for a position of `liq` between two blocks (exact integer math, as the gauge does it).
const accrued = (liq, fromBlock, toBlock) => (liq * RATE * BigInt(toBlock - fromBlock)) / E(1);
const liqOf = async (c, id) => (await c.nfpm.positions(id))[7];

module.exports = { E, DAY, RAILS, STAGES, RATE, FAR, LO, HI, mine, increaseTime, path, fixture, mintedId, events, accrued, liqOf };
