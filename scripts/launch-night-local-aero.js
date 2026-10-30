// The launch-night DRY RUN's other side, on a LOCAL Hardhat node only: it plays the Panda platform (fresh registry,
// timelock, fee policy v3, the live vault's migrator at its address, both global pauses on) and Aero (the repo's
// mocks: contracts/test/AeroMocks.sol + LaunchNightMocks.sol), and makes Aero's launch happen one step at a time while
// scripts/launch-night.js polls. scripts/dryrun-launch-night.js drives it; nothing here can run against Base (chain 31337 only).
//
//   STATE=<file> STEP=<step> npx hardhat run scripts/launch-night-local-aero.js --network localhost
//
// Steps, in launch order: setup | pool-no-gauge | gauge | activate | cap | aero-pools | liquidity | safe-execute | verify
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const LIVE_VAULT = "0x61986AFae9B07314d855E7C54949E30A866c93a8";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OLD_AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const SAFE_ADDR = "0x9eb619B3aB33192080FfA846820117e2f00EE9bA";
const COMPANY_ADDR = "0x090646B5da23d102d08fAe6166F37678b135A221";
const E = (x) => ethers.parseEther(String(x));

async function main() {
  if (Number((await ethers.provider.getNetwork()).chainId) !== 31337) throw new Error("local Hardhat chain only");
  const stateFile = path.resolve(process.env.STATE || "");
  const step = process.env.STEP;
  const S = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(S, null, 2) + "\n");
  const [deployer, safe, keeper, treasury, safety, company, stakers] = await ethers.getSigners();
  const F = async (n, ...a) => { const c = await (await ethers.getContractFactory(n)).deploy(...a); await c.waitForDeployment(); return c; };
  const C = (n, a) => ethers.getContractAt(n, a);
  const send = async (p) => (await p).wait();
  const log = (m) => console.log(`[aero-local] ${m}`);

  if (step === "setup") {
    const erc = await F("MockERC20", "x", "x");
    for (const a of [WETH, USDC, OLD_AERO]) await network.provider.send("hardhat_setCode", [a, await ethers.provider.getCode(erc.target)]);
    const aero = await F("MockAeroToken");
    const factory = await F("LaunchCLFactory", [1, 10, 50, 100, 200, 2000]);
    const nfpm = await F("MockAeroNfpm", factory.target);
    const router = await F("MockRouter", factory.target);
    const voter = await F("LaunchLeafVoter", aero.target);
    const gfac = await F("LaunchGaugeFactory", nfpm.target);
    // a pool Aero made before launch on another pair (the WETH/cbBTC CL10 of 2026-10-20): must be ignored
    const cbbtc = await F("MockERC20", "cbBTC", "cbBTC");
    const early = await F("LaunchCLPool", WETH, cbbtc.target, 10, factory.target);
    await send(factory.addPool(WETH, cbbtc.target, 10, early.target));

    const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "base.json"), "utf8"));
    const timelock = await F("PandaTimelock", dep.timelockDelay, [safe.address], [safe.address], ethers.ZeroAddress);
    const registry = await F("PandaRegistry", timelock.target, { keeper: keeper.address, daoTreasury: treasury.address, safetyModule: safety.address,
      emergencyAdmin: safe.address, guardRails: dep.guardRails });
    const referrals = await F("PandaReferrals", registry.target, [], []);
    const c3 = dep.feePolicyV3Config;
    const policy = await F("PandaFeePolicyV3", { registry: registry.target, initialOwner: timelock.target, keeperRewardBps: c3.keeperRewardBps, basePandaBps: c3.basePandaBps,
      company: company.address, stages: c3.stages, activeStage: 0, stakerRewards: stakers.address, referrals: referrals.target, referralShareBps: c3.referralShareBps,
      stageSource: ethers.ZeroAddress, minTreasuryBps: c3.minTreasuryBps, specialPandaBps: c3.specialPandaBps });
    await send(registry.setFeePolicy(policy.target));
    const liveImpl = await F("MockLiveVault", WETH, USDC);
    await network.provider.send("hardhat_setCode", [LIVE_VAULT, await ethers.provider.getCode(liveImpl.target)]);
    await send(registry.addVault(LIVE_VAULT));
    await send(registry.finishBootstrap());
    await send(registry.connect(safety).setDepositsPaused(true));
    await send(registry.connect(safety).setRebalancesPaused(true));
    // old AERO held by the Safe and the company wallet (for aero-upgrade-calldata.js AMOUNT=balance)
    const old = await C("MockERC20", OLD_AERO);
    await send(old.mint(SAFE_ADDR, E("1234.5")));
    await send(old.mint(COMPANY_ADDR, E("10")));

    Object.assign(S, { aero: aero.target, factory: factory.target, nfpm: nfpm.target, router: router.target, voter: voter.target, gfac: gfac.target,
      timelock: timelock.target, registry: registry.target, safe: safe.address, safety: safety.address, keeper: keeper.address, earlyPool: early.target });
    // the files launch-night.js reads: the deployments file (gitignored *.local.json) and an aero-base.json copy whose
    // six known addresses point at the mocks and whose four launch slots are null, as in the real file
    fs.writeFileSync(path.resolve(process.env.DEP_FILE), JSON.stringify({ network: "launch-dryrun", deployer: deployer.address, safe: safe.address,
      registry: registry.target, timelock: timelock.target, timelockDelay: dep.timelockDelay, safetyModule: safety.address,
      vaultLib: deployer.address, topUpLib: deployer.address, vaults: [{ key: "weth-usdc", address: LIVE_VAULT }] }, null, 2) + "\n");
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "aero-base.json"), "utf8"));
    Object.assign(real, { clFactory: factory.target, gaugeFactory: gfac.target, positionManager: nfpm.target, swapRouter: router.target, leafVoter: voter.target, aero: aero.target });
    fs.writeFileSync(path.resolve(process.env.AERO_FILE), JSON.stringify(real, null, 2) + "\n");
    save();
    log(`setup: platform (registry ${registry.target}, timelock ${timelock.target}, pauses on) and Aero mocks (factory ${factory.target}); only Aero's early WETH/cbBTC CL10 pool exists`);
    return;
  }

  const factory = await C("LaunchCLFactory", S.factory);
  // Aero's swap fees per tick spacing (facts 2026-10-21): the dry run's pools charge what the real ones do.
  const AERO_FEE = { 1: 100, 10: 500, 50: 3000, 100: 10000, 150: 15000, 200: 20000, 250: 25000 };
  const mkPool = async (a, b, ts) => {
    const p = await F("LaunchCLPool", a, b, ts, S.factory);
    await send(factory.addPool(a, b, ts, p.target));
    await send(p.setFee(AERO_FEE[ts] || 0));
    return p;
  };
  const mkGauge = async (pool, ts) => {
    const g = await F("MockAeroGauge", pool.target, S.nfpm, S.voter, S.gfac, ts, await pool.token0(), await pool.token1());
    await send(pool.setGauge(g.target, S.nfpm));
    await send((await C("LaunchGaugeFactory", S.gfac)).setIsGauge(g.target, true));
    return g;
  };

  if (step === "pool-no-gauge") {
    const p50 = await mkPool(WETH, USDC, 50);
    const p100 = await mkPool(WETH, USDC, 100);
    Object.assign(S, { wethUsdcPool: p50.target, decoyWethUsdc100: p100.target });
    log(`Aero created WETH/USDC CL50 ${p50.target} (no gauge yet) and a second WETH/USDC pool at CL100 ${p100.target}`);
  } else if (step === "gauge") {
    const g = await mkGauge(await C("LaunchCLPool", S.wethUsdcPool), 50);
    await mkGauge(await C("LaunchCLPool", S.decoyWethUsdc100), 100);
    S.wethUsdcGauge = g.target;
    log(`gauge ${g.target} created for the CL50 pool: not activated, emission cap 0`);
  } else if (step === "activate") {
    await send((await C("LaunchLeafVoter", S.voter)).setActivated(S.wethUsdcGauge, true));
    log("LeafVoter: gauge activated (cap still 0)");
  } else if (step === "cap") {
    await send((await C("LaunchGaugeFactory", S.gfac)).setEmissionCap(S.wethUsdcGauge, E(1_000_000)));
    log("CLGaugeFactory: emission cap set");
  } else if (step === "aero-pools") {
    const aw = await mkPool(S.aero, WETH, 200);
    const au = await mkPool(S.aero, USDC, 200);
    const au100 = await mkPool(S.aero, USDC, 100);
    await send(au100.setLiquidity(10n ** 20n));
    Object.assign(S, { aeroWethPool: aw.target, aeroUsdcPool: au.target, decoyAeroUsdc100: au100.target });
    log(`AERO/WETH CL200 ${aw.target} and AERO/USDC CL200 ${au.target} created, no liquidity yet (and a liquid AERO/USDC CL100 ${au100.target})`);
  } else if (step === "liquidity") {
    await send((await C("LaunchCLPool", S.aeroWethPool)).setLiquidity(10n ** 21n));
    await send((await C("LaunchCLPool", S.aeroUsdcPool)).setLiquidity(10n ** 21n));
    log("liquidity added to both AERO CL200 pools");
  } else if (step === "safe-execute") {
    // The Safe signs the two files launch-night.js wrote; the safety wallet lifts the pauses.
    const sched = JSON.parse(fs.readFileSync(path.resolve(process.env.SCHEDULE_FILE), "utf8")).transactions[0];
    const exec = JSON.parse(fs.readFileSync(path.resolve(process.env.EXECUTE_FILE), "utf8")).transactions[0];
    await send(safe.sendTransaction({ to: sched.to, value: sched.value, data: sched.data }));
    const resNow = JSON.parse(fs.readFileSync(path.resolve(process.env.RESULT_FILE), "utf8"));
    const tl = await C("PandaTimelock", resNow.batch.timelock);
    if (!(await tl.isOperationPending(resNow.timelockOperationId))) throw new Error("the result's timelockOperationId is not the scheduled operation");
    // the cancel file is the right rollback: simulate it from the Safe (eth_call, nothing changes)
    const cancel = JSON.parse(fs.readFileSync(path.resolve(process.env.CANCEL_FILE), "utf8")).transactions[0];
    await ethers.provider.call({ from: safe.address, to: cancel.to, data: cancel.data });
    log(`Safe: schedule sent; operation ${resNow.timelockOperationId} pending; the cancel file would cancel it (simulated, not sent)`);
    let early = false;
    try { await send(safe.sendTransaction({ to: exec.to, value: exec.value, data: exec.data })); } catch (e) { early = true; }
    if (!early) throw new Error("execute before 48 h was NOT refused");
    log("Safe: schedule sent; execute before 48 h refused by the timelock (as it must be)");
    await network.provider.send("evm_increaseTime", [172800]);
    await network.provider.send("evm_mine");
    await send(safe.sendTransaction({ to: exec.to, value: exec.value, data: exec.data }));
    log("Safe: execute sent after 48 h");
    const res = JSON.parse(fs.readFileSync(path.resolve(process.env.RESULT_FILE), "utf8"));
    for (const c of res.batch.afterExecute.calls) await send(safety.sendTransaction({ to: c.to, data: c.data }));
    log("safety wallet: deposits and rebalances unpaused");
  } else if (step === "verify") {
    const res = JSON.parse(fs.readFileSync(path.resolve(process.env.RESULT_FILE), "utf8"));
    const reg = await C("PandaRegistry", S.registry);
    const checks = [
      [await reg.isVault(res.vault), "the new vault is registered"],
      [(await reg.keeperOf(res.vault)) === S.keeper, "its keeper is the live vault's keeper"],
      [!(await reg.vaultDepositsOpen(LIVE_VAULT)), "the live vault takes no new deposits"],
      [await reg.vaultDepositsOpen(res.vault), "the new vault takes deposits"],
      [!(await reg.depositsPaused()) && !(await reg.rebalancesPaused()), "both global pauses lifted"],
      [(await (await C("PandaVault", res.vault)).gauge()) === S.wethUsdcGauge, "vault.gauge() is the CL50 gauge"],
    ];
    let bad = 0;
    for (const [ok, m] of checks) { console.log(`  ${ok ? "ok  " : "FAIL"} ${m}`); if (!ok) bad++; }
    if (bad) throw new Error(`${bad} check(s) failed`);
  } else throw new Error(`unknown STEP ${step}`);
  save();
}

main().catch((e) => { console.error(e); process.exit(1); });
