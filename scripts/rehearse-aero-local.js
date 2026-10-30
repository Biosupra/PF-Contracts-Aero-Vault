// Level 2 rehearsal WITHOUT a Base fork: our Aero vault against Aero's REAL concentrated-liquidity contracts (CLFactory,
// CLPool, NonfungiblePositionManager, SwapRouter, CLGauge, CLGaugeFactory), built from Aero's public source in a
// scratch folder OUTSIDE this repo (their files carry the Dromos Restricted Use License: test use only, never committed).
// The voter, factory registry and rewards factory are this repo's stand-ins (contracts/test/AeroRehearsalStandins.sol),
// the new AERO is MockAeroToken (its transfer switch plays a token that refuses a payout), and the Panda platform (timelock, registry, fee
// policy v3, referrals) is deployed fresh on the local chain with the live configuration. The live vault
// 0x6198...93a8 is played by MockLiveVault placed at that address (it calls receiveMigration exactly as the live one).
// Then: scripts/deploy-aero-vault.js runs end to end (preflight, deploy, batch JSON), the Safe batch is scheduled and
// executed through the timelock, the safety module lifts the pauses, and every vault path runs.
//
// Why not a fork: this cloud session's network policy refuses both public Base RPCs (mainnet.base.org,
// base-rpc.publicnode.com). On a machine that can reach them, the same steps against the REAL registry, timelock and
// live vault are the FORK=1 rehearsal (see docs/AERO-VAULT-RUNBOOK.md).
//
// Build Aero (once): clone github.com/Dromos-Labs/metadex-slipstream-public into a scratch folder, install its four
// dependencies (@openzeppelin/contracts@3.4.2-solc-0.7, @uniswap/lib@4.0.1-alpha, base64-sol@1.1.0,
// @nomad-xyz/excessively-safe-call@0.0.1-rc.1) and compile CLFactory, CLPool, NonfungiblePositionManager, SwapRouter,
// CLGauge and CLGaugeFactory with solc 0.7.6 (optimizer 200, bytecodeHash none) to a standard-JSON output file.
//
//   AERO_BUILD=<that output .json> npx hardhat run scripts/rehearse-aero-local.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers, network } = require("hardhat");

const LIVE_VAULT = "0x61986AFae9B07314d855E7C54949E30A866c93a8";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DAY = 86400;
const E = (x) => ethers.parseEther(String(x));
const FAR = 2n ** 40n;
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`); if (!cond) failures++; };
const mine = (n) => network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
const later = async (sec) => { await network.provider.send("evm_increaseTime", [sec]); await network.provider.send("evm_mine"); };
const sqrtBig = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
const sqrtPriceX96 = (num, den) => sqrtBig((num << 192n) / den); // price = token1 per token0
const pathOf = (...xs) => ethers.solidityPacked(xs.map((x) => (typeof x === "number" ? "int24" : "address")), xs);

function aeroArtifacts(file) {
  const out = JSON.parse(fs.readFileSync(file, "utf8"));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(`the Aero build has errors: ${errs[0].formattedMessage}`);
  const find = (name) => {
    for (const [, cs] of Object.entries(out.contracts)) if (cs[name]) return cs[name];
    throw new Error(`${name} not in the Aero build`);
  };
  return (name, signer, links = {}) => {
    const c = find(name);
    let bytecode = c.evm.bytecode.object;
    for (const [, libs] of Object.entries(c.evm.bytecode.linkReferences || {})) {
      for (const [lib, refs] of Object.entries(libs)) {
        const addr = links[lib];
        if (!addr) throw new Error(`${name} needs library ${lib}`);
        for (const r of refs) bytecode = bytecode.slice(0, r.start * 2) + addr.slice(2).toLowerCase() + bytecode.slice((r.start + r.length) * 2);
      }
    }
    return new ethers.ContractFactory(c.abi, "0x" + bytecode, signer);
  };
}

function eventsOf(iface, receipt, name, address) {
  const out = [];
  for (const l of receipt.logs) {
    if (address && l.address.toLowerCase() !== address.toLowerCase()) continue;
    try { const p = iface.parseLog(l); if (p && p.name === name) out.push(p.args); } catch (e) {}
  }
  return out;
}

async function main() {
  if (!process.env.AERO_BUILD) throw new Error("set AERO_BUILD to the solc standard-JSON output of Aero's Slipstream build (see the header)");
  if (Number((await ethers.provider.getNetwork()).chainId) !== 31337) throw new Error("local Hardhat network only");
  const aeroF = aeroArtifacts(path.resolve(process.env.AERO_BUILD));
  const [deployer, safe, keeper, treasury, safety, company, lp, u1, u2, u3, u4, stakers, referrer] = await ethers.getSigners();
  const F = async (n, ...a) => (await ethers.getContractFactory(n)).deploy(...a);

  console.log("=== 1. Tokens: WETH and USDC at their Base addresses, the new-AERO stand-in ===");
  const erc = await F("MockERC20", "x", "x");
  for (const a of [WETH, USDC]) await network.provider.send("hardhat_setCode", [a, await ethers.provider.getCode(erc.target)]);
  const weth = await ethers.getContractAt("MockERC20", WETH);
  const usdc = await ethers.getContractAt("MockERC20", USDC);
  const aero = await F("MockAeroToken");
  console.log("AERO stand-in", aero.target);

  console.log("=== 2. Aero's real CL stack (built from github.com/Dromos-Labs/metadex-slipstream-public) ===");
  const voter = await F("RehearsalLeafVoter", aero.target, E(1)); // 1 AERO a second for the gauge
  const freg = await F("RehearsalFactoryRegistry");
  const rewardsF = await F("RehearsalRewardsFactory");
  const nonSwap = await aeroF("CLPoolNonSwapPath", deployer).deploy();
  const poolImpl = await aeroF("CLPool", deployer, { CLPoolNonSwapPath: nonSwap.target }).deploy();
  const factory = await aeroF("CLFactory", deployer).deploy(deployer.address, deployer.address, deployer.address, voter.target, poolImpl.target,
    freg.target, ethers.ZeroAddress, deployer.address, deployer.address);
  const nfpm = await aeroF("NonfungiblePositionManager", deployer).deploy(deployer.address, factory.target, WETH, deployer.address, "Aero CL Positions", "AERO-CL-POS");
  const router = await aeroF("SwapRouter", deployer).deploy(factory.target, WETH);
  const gfac = await aeroF("CLGaugeFactory", deployer).deploy(voter.target, deployer.address, rewardsF.target, nfpm.target,
    [deployer.address, deployer.address, deployer.address, deployer.address], [2n ** 100n, 1n, 2n ** 100n, 100n]);
  await freg.setGaugeFactory(factory.target, gfac.target);
  const poolAt = async (a, b, ts, price) => {
    const [t0] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    const p = t0.toLowerCase() === a.toLowerCase() ? price : [price[1], price[0]]; // price given as a-in-b: [num, den] of b per a
    await (await factory["createPool(address,address,int24,uint160)"](a, b, ts, sqrtPriceX96(p[0], p[1]))).wait();
    return new ethers.Contract(await factory["getPool(address,address,int24)"](a, b, ts), poolImpl.interface, deployer);
  };
  const wethUsdc = await poolAt(WETH, USDC, 50, [3000n, 1n]);              // 1 WETH = 3000 USDC
  const aeroWeth = await poolAt(aero.target, WETH, 200, [1n, 6000n]);      // 1 AERO = 0.5 USDC = 1/6000 WETH
  const aeroUsdc = await poolAt(aero.target, USDC, 200, [1n, 2n]);         // 1 AERO = 0.5 USDC
  await (await gfac.createGauge(wethUsdc.target, "0x")).wait();
  const gauge = new ethers.Contract(await wethUsdc.gauge(), aeroF("CLGauge", deployer).interface, deployer);
  await freg.setGauge(wethUsdc.target, gauge.target);
  console.log(`CLFactory ${factory.target} | NFPM ${nfpm.target} | router ${router.target} | gauge factory ${gfac.target}`);
  console.log(`WETH/USDC CL50 ${wethUsdc.target} gauge ${gauge.target} | AERO/WETH CL200 ${aeroWeth.target} | AERO/USDC CL200 ${aeroUsdc.target}`);
  ok((await gauge.nft()) === nfpm.target && (await wethUsdc.gauge()) === gauge.target, "pool <-> gauge <-> NFPM wired by Aero's own createGauge");

  // Liquidity from an outside LP (full range), then price history for the TWAP.
  for (const t of [weth, usdc, aero]) { await t.mint(lp.address, E(100_000_000)); await t.connect(lp).approve(nfpm.target, ethers.MaxUint256); }
  const full = (ts) => Math.floor(887272 / ts) * ts;
  const lpMint = async (pool, a0, a1) => {
    const ts = Number(await pool.tickSpacing());
    await (await nfpm.connect(lp).mint({ token0: await pool.token0(), token1: await pool.token1(), tickSpacing: ts, tickLower: -full(ts), tickUpper: full(ts),
      amount0Desired: a0, amount1Desired: a1, amount0Min: 0, amount1Min: 0, recipient: lp.address, deadline: FAR, sqrtPriceX96: 0 })).wait();
  };
  await lpMint(wethUsdc, E(1000), E(3_000_000));
  const aeroIs0 = (p) => p.token0().then((t) => t === aero.target);
  await lpMint(aeroWeth, (await aeroIs0(aeroWeth)) ? E(6_000_000) : E(1000), (await aeroIs0(aeroWeth)) ? E(1000) : E(6_000_000));
  await lpMint(aeroUsdc, (await aeroIs0(aeroUsdc)) ? E(1_000_000) : E(500_000), (await aeroIs0(aeroUsdc)) ? E(500_000) : E(1_000_000));
  for (const p of [wethUsdc, aeroWeth, aeroUsdc]) await p.increaseObservationCardinalityNext(700);
  await later(900);

  console.log("=== 3. The Panda platform, fresh, with the live configuration ===");
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "base.json"), "utf8"));
  const timelock = await F("PandaTimelock", dep.timelockDelay, [safe.address], [safe.address], ethers.ZeroAddress);
  const registry = await F("PandaRegistry", timelock.target, { keeper: keeper.address, daoTreasury: treasury.address, safetyModule: safety.address,
    emergencyAdmin: safe.address, guardRails: dep.guardRails });
  const referrals = await F("PandaReferrals", registry.target, [], []);
  const c3 = dep.feePolicyV3Config;
  const policy = await F("PandaFeePolicyV3", { registry: registry.target, initialOwner: timelock.target, keeperRewardBps: c3.keeperRewardBps, basePandaBps: c3.basePandaBps,
    company: company.address, stages: c3.stages, activeStage: 0, stakerRewards: stakers.address, referrals: referrals.target, referralShareBps: c3.referralShareBps,
    stageSource: ethers.ZeroAddress, minTreasuryBps: c3.minTreasuryBps, specialPandaBps: c3.specialPandaBps });
  await registry.setFeePolicy(policy.target);
  // the live vault: a live-vault-shaped migrator at the live address
  const liveImpl = await F("MockLiveVault", WETH, USDC);
  await network.provider.send("hardhat_setCode", [LIVE_VAULT, await ethers.provider.getCode(liveImpl.target)]);
  const live = await ethers.getContractAt("MockLiveVault", LIVE_VAULT);
  await registry.addVault(LIVE_VAULT);
  await registry.finishBootstrap();
  // as on Base on launch day: both global pauses on (the Safe's emergency step before the merge)
  await registry.connect(safety).setDepositsPaused(true);
  await registry.connect(safety).setRebalancesPaused(true);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panda-aero-"));
  const depName = `aero-rehearsal-${process.pid}.local`;
  const depFile = path.join(__dirname, "..", "deployments", `${depName}.json`);
  fs.writeFileSync(depFile, JSON.stringify({ network: "rehearsal", registry: registry.target, timelock: timelock.target, timelockDelay: dep.timelockDelay,
    safetyModule: safety.address, vaultLib: deployer.address, topUpLib: deployer.address, vaults: [{ key: "weth-usdc", address: LIVE_VAULT }] }, null, 2));
  const aeroFile = path.join(tmp, "aero-base.json");
  fs.writeFileSync(aeroFile, JSON.stringify({ clFactory: factory.target, gaugeFactory: gfac.target, wethUsdcPool: wethUsdc.target, wethUsdcGauge: gauge.target,
    positionManager: nfpm.target, swapRouter: router.target, leafVoter: voter.target, aero: aero.target, aeroUsdcPool: aeroUsdc.target, aeroWethPool: aeroWeth.target }, null, 2));

  console.log("=== 4. scripts/deploy-aero-vault.js end to end (temp aero-base.json with the local Aero addresses) ===");
  Object.assign(process.env, { NETWORK: depName, AERO_FILE: aeroFile, RECORD: "0", BATCH_OUT: path.join(tmp, "batch.json") });
  delete process.env.PREFLIGHT_ONLY;
  const { main: deployMain } = require("./deploy-aero-vault.js");
  let res;
  try { res = await deployMain(); } finally { fs.rmSync(depFile, { force: true }); }
  const vault = await ethers.getContractAt("PandaVault", res.vault);
  const lib = await ethers.getContractAt("PandaVaultLib", res.vaultLib);
  ok(!(await registry.isVault(vault.target)), "the new vault is NOT registered before the Safe batch executes");

  console.log("=== 5. The Safe batch through the timelock (schedule, +48 h, execute), then the safety module lifts the pauses ===");
  const b = JSON.parse(fs.readFileSync(path.join(tmp, "batch.json"), "utf8"));
  await (await safe.sendTransaction({ to: b.schedule.to, data: b.schedule.data })).wait();
  await expectRevert(safe.sendTransaction({ to: b.execute.to, data: b.execute.data }), "execute before 48 h is refused");
  await later(b.delaySeconds);
  await (await safe.sendTransaction({ to: b.execute.to, data: b.execute.data })).wait();
  for (const call of b.afterExecute.calls) await (await safety.sendTransaction({ to: call.to, data: call.data })).wait();
  ok(await registry.isVault(vault.target), "registered");
  ok((await registry.keeperOf(vault.target)) === keeper.address, "keeper set for the new vault");
  const rails = await registry.guardRailsOf(vault.target);
  ok(Number(rails[3]) === dep.guardRails.maxRangeSpacings, `guard rails carried over (Aero pool spacing ${await vault.tickSpacing()})`);
  ok(!(await registry.vaultDepositsOpen(LIVE_VAULT)), "live vault: new deposits closed");
  ok(await registry.vaultDepositsOpen(vault.target), "new vault: deposits open");
  ok(!(await registry.depositsPaused()) && !(await registry.rebalancesPaused()), "global pauses lifted");

  for (const u of [u1, u2, u3, u4]) for (const t of [weth, usdc]) { await t.mint(u.address, E(1_000_000)); await t.connect(u).approve(vault.target, ethers.MaxUint256); }
  await referrals.connect(u2).accept(referrer.address);
  const tick0 = Number((await wethUsdc.slot0())[1]);
  const base = Math.floor(tick0 / 50) * 50;
  const LO = base - 1000, HI = base + 1000;
  const minted = (rc) => eventsOf(vault.interface, rc, "PositionMinted")[0].tokenId;
  const gI = gauge.interface;
  const feeRecipients = [keeper, company, treasury, stakers, referrer].map((x) => x.address);
  const aeroOf = (addrs) => Promise.all(addrs.map((a) => aero.balanceOf(a)));
  const sum = (xs) => xs.reduce((a, x) => a + x, 0n);

  console.log("=== 6. Migration from the live vault (its exact receiveMigration call) ===");
  await weth.mint(LIVE_VAULT, E(2)); await usdc.mint(LIVE_VAULT, E(6000));
  const rdata = ethers.AbiCoder.defaultAbiCoder().encode(["int24", "int24", "bool", "uint256", "uint256", "uint256", "uint256", "uint256"], [LO, HI, false, 0, 0, 0, 0, FAR]);
  const rcM = await (await live.migrateOut(vault.target, u1.address, E(2), E(6000), true, rdata)).wait();
  const p1 = minted(rcM);
  ok((await vault.positionInfo(p1)).owner === u1.address && (await vault.positionInfo(p1)).autoCompound, `migrated position ${p1}: owner u1, auto-compound kept`);
  ok(await gauge.stakedContains(vault.target, p1), "staked in Aero's real gauge");

  console.log("=== 7. Deposit, zap (real SwapRouter path, int24 spacing), referral ===");
  const p2 = minted(await (await vault.connect(u2).depositAndStake({ amountA: E(1), amountB: E(3000), tickLower: LO, tickUpper: HI, amount0Min: 0, amount1Min: 0, deadline: FAR, autoCompound: false })).wait());
  const p3 = minted(await (await vault.connect(u3).depositZap({ amountB: E(6000), swapAmountIn: E(3000), swapPath: pathOf(USDC, 50, WETH), tickLower: LO, tickUpper: HI,
    amountAMin: E("0.9"), amount0MinMint: 0, amount1MinMint: 0, deadline: FAR, autoCompound: false })).wait());
  ok(await gauge.stakedContains(vault.target, p2) && await gauge.stakedContains(vault.target, p3), `deposit ${p2} and zap ${p3} staked`);

  console.log("=== 8. Emissions accrue (Aero's pool reward growth), claims are exactly per position ===");
  await later(600);
  await mine(5);
  {
    const before = await aeroOf([u2.address, ...feeRecipients]);
    const rc = await (await vault.connect(u2).claimRewards({ tokenId: p2, aeroToBPath: "0x", amountBMin: 0, deadline: FAR })).wait();
    const after = await aeroOf([u2.address, ...feeRecipients]);
    const gaugePaid = eventsOf(gI, rc, "EmissionsClaimed", gauge.target).filter((e) => e._tokenId === p2);
    const got = after.map((x, i) => x - before[i]);
    ok(gaugePaid.length === 1 && sum(got) === gaugePaid[0]._rewardAmount, `claim: u2 + fee legs = exactly what Aero's gauge says position ${p2} earned (${ethers.formatEther(gaugePaid[0]._rewardAmount)} AERO)`);
    ok(got[5] > 0n && got[5] === gaugePaid[0]._rewardAmount * 20n / 10000n, "instant referral leg paid in the vault's AERO");
  }

  console.log("=== 9. Deferred emissions (the voter cannot mint): booked for the position that earned them ===");
  await later(300);
  await voter.setFailMint(true);
  const rcW = await (await vault.connect(u3).withdrawPosition({ tokenId: p3, aeroToBPath: "0x", amountBMinReward: 0, amount0Min: 0, amount1Min: 0, aToBPath: "0x", amountBMinReturned: 0, deadline: FAR })).wait();
  const def = eventsOf(gI, rcW, "EmissionsDeferred", gauge.target);
  ok(def.length === 1 && def[0]._tokenId === p3, `Aero's gauge deferred ${def.length ? ethers.formatEther(def[0]._rewardAmount) : "?"} AERO for position ${p3} to the vault's account`);
  const book = await vault.pendingDeferred(p3);
  ok(book.owner === u3.address && def.length === 1 && book.gross === def[0]._rewardAmount, "the vault booked exactly that amount for u3's position");
  await voter.setFailMint(false);
  await later(120);
  {
    const before = await aeroOf([u2.address, ...feeRecipients]);
    const rc = await (await vault.connect(u2).claimRewards({ tokenId: p2, aeroToBPath: "0x", amountBMin: 0, deadline: FAR })).wait();
    const after = await aeroOf([u2.address, ...feeRecipients]);
    const own = eventsOf(gI, rc, "EmissionsClaimed", gauge.target).filter((e) => e._tokenId === p2)[0]._rewardAmount;
    const deferredPaid = eventsOf(gI, rc, "DeferredEmissionsClaimed", gauge.target);
    ok(deferredPaid.length === 1, "the gauge paid the vault's deferred lump together with u2's claim");
    ok(sum(after.map((x, i) => x - before[i])) === own, "u2 received only its own position's emissions (regression: not the pooled balance)");
  }
  {
    const before = await aeroOf([u3.address, ...feeRecipients]);
    await (await vault.connect(u3).claimDeferred(p3)).wait();
    const after = await aeroOf([u3.address, ...feeRecipients]);
    ok(sum(after.map((x, i) => x - before[i])) === def[0]._rewardAmount, "u3 collected exactly its deferred emissions (fee taken as on any reward)");
  }

  console.log("=== 10. Early-unstake penalty window (Aero's real gauge: 5 blocks, 100%) ===");
  const p4 = minted(await (await vault.connect(u4).depositAndStake({ amountA: E(1), amountB: E(3000), tickLower: LO, tickUpper: HI, amount0Min: 0, amount1Min: 0, deadline: FAR, autoCompound: false })).wait());
  ok((await lib.penaltyFreeBlock(gauge.target, p4)) === (await gauge.depositBlock(p4)) + 5n, "window read from Aero's gauge factory: deposit block + 5");
  await expectRevert(vault.connect(keeper).rebalance(rb(p4, LO, HI)), "keeper rebalance inside the window is refused (StakeTooRecent)");
  const forfeitBefore = await voter.forfeited();
  const rcC = await (await vault.connect(u4).claimRewards({ tokenId: p4, aeroToBPath: "0x", amountBMin: 0, deadline: FAR })).wait();
  ok(eventsOf(gI, rcC, "EarlyWithdrawPenalty", gauge.target).length === 0 && (await voter.forfeited()) === forfeitBefore, "a claim inside the window is skipped: nothing forfeited");
  const wBefore = await weth.balanceOf(u4.address);
  const rcE = await (await vault.connect(u4).emergencyWithdraw(p4)).wait();
  const pens = eventsOf(gI, rcE, "EarlyWithdrawPenalty", gauge.target);
  ok((await weth.balanceOf(u4.address)) > wBefore, `emergency exit inside the window does not revert; principal returned (Aero's gauge forfeited ${pens.length ? ethers.formatEther(pens[0]._penalty) : "0"} AERO of emissions, as designed)`);

  console.log("=== 11. Top-up, keeper rebalance with swap, auto-compound through Aero's AERO/WETH pool ===");
  await mine(6);
  const tdata = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256", "bytes", "uint256", "uint256", "uint256", "uint256"], [E("0.5"), E(1500), 0, "0x", 0, 0, 0, FAR]);
  const liqBefore = (await nfpm.positions(p2))[7];
  await (await vault.connect(u2).topUp(p2, tdata)).wait();
  ok((await nfpm.positions(p2))[7] > liqBefore && await gauge.stakedContains(vault.target, p2), "top-up: same NFT, more liquidity, restaked");
  await later(600);
  await mine(6);
  const rcR = await (await vault.connect(keeper).rebalance(rb(p1, LO + 200, HI + 200, { isAToB: true, swapIn: E("0.1") }))).wait();
  const comp = eventsOf(vault.interface, rcR, "RewardsCompounded");
  const p1b = minted(rcR);
  ok(comp.length === 1 && comp[0].amountOut > 0n, `rebalance ${p1} -> ${p1b}: AERO compounded into WETH (${comp.length ? ethers.formatEther(comp[0].aeroIn) : 0} AERO in)`);
  ok((await vault.positionInfo(p1b)).owner === u1.address && await gauge.stakedContains(vault.target, p1b), "same owner, restaked");

  console.log("=== 12. A payout the AERO token refuses reverts the exit (never booked); it pays once the token sends again ===");
  const lockUntil = (await ethers.provider.getBlock("latest")).timestamp + 7 * DAY;
  await aero.setTransfersEnabledAt(lockUntil);
  await later(300);
  const p2Info = await vault.positionInfo(p2);
  const wp = { tokenId: p2, aeroToBPath: "0x", amountBMinReward: 0, amount0Min: 0, amount1Min: 0, aToBPath: "0x", amountBMinReturned: 0, deadline: FAR };
  await expectRevert(vault.connect(u2).withdrawPosition(wp), "withdraw while the token refuses the AERO payout");
  ok(p2Info.owner === u2.address && (await vault.pendingDeferred(p2)).gross === 0n && await gauge.stakedContains(vault.target, p2), "nothing booked, position untouched");
  await aero.setTransfersEnabledAt(0);
  const u2Before = await aero.balanceOf(u2.address);
  await (await vault.connect(u2).withdrawPosition(wp)).wait();
  ok((await aero.balanceOf(u2.address)) > u2Before, "once the token sends again the same withdraw pays its AERO");

  console.log("=== 13. Shutdown and forceExit ===");
  await later(300);
  await (await registry.connect(safe).shutdownVault(vault.target)).wait();
  const open = [];
  for (let i = 0n; i < (await vault.openPositionCount()); i++) open.push(await vault.openPositionAt(i));
  const u1Before = await weth.balanceOf(u1.address);
  const rcF = await (await vault.connect(safe).forceExit(open)).wait();
  ok(eventsOf(vault.interface, rcF, "ForceExited").length === open.length && (await vault.openPositionCount()) === 0n, `forceExit pushed ${open.length} position(s) to their owners`);
  ok((await weth.balanceOf(u1.address)) > u1Before, "u1 received its tokens");
  const leftover = await aero.balanceOf(vault.target);
  ok(leftover === 0n, `no AERO left in the vault (${leftover})`);

  console.log(`\nSizes: PandaVault ${(await ethers.provider.getCode(vault.target)).length / 2 - 1} bytes, PandaVaultLib ${(await ethers.provider.getCode(res.vaultLib)).length / 2 - 1}, PandaTopUpLib ${(await ethers.provider.getCode(res.topUpLib)).length / 2 - 1}`);
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL REHEARSAL CHECKS PASSED");
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures) process.exitCode = 1;

  function rb(tokenId, lo, hi, o = {}) {
    return { tokenId, isAToB: !!o.isAToB, rebalanceAmountIn: o.swapIn || 0, rebalanceAmountOutMin: 0, newTickLower: lo, newTickUpper: hi,
      amount0MinMint: 0, amount1MinMint: 0, decreaseAmount0Min: 0, decreaseAmount1Min: 0, deadline: FAR };
  }
}

async function expectRevert(p, msg) {
  try { await (await p).wait(); ok(false, msg); } catch (e) { ok(true, `${msg} [${String(e.shortMessage || e.message).slice(0, 80)}]`); }
}

main().catch((e) => { console.error(e); process.exit(1); });
