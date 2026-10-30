// PRE-LAUNCH rehearsal on a Base FORK, before Aero's WETH/USDC pool and gauge exist (they are created on launch day,
// 2026-10-22). Against Aero's REAL deployed Base contracts (CLFactory, CLGaugeFactory, GaugeManager, LeafVoter, root
// Voter, NFPM, SwapRouter, the new AERO, the Migration) and Panda's REAL registry, timelock, Safe and live vault:
//
//   1. creates the WETH/USDC CL50 pool on Aero's CLFactory (permissionless) at the Aerodrome CL50 pool's current price,
//      creates and activates its gauge through the real GaugeManager (impersonating the roles the verified sources
//      require), checks its emission cap, creates the AERO/WETH and AERO/USDC CL200 pools, seeds all three with
//      full-range liquidity (new AERO from the Migration contract, USDC from the Aerodrome pool, WETH from ETH) and
//      warms their TWAPs;
//   2. writes a temp aero-base.json with those addresses and runs the whole launch-day rehearsal
//      (scripts/rehearse-aero-fork.js): preflight, deploy, Safe batch through the real timelock (+48 h), pauses lifted,
//      a REAL live position migrated by its owner, deposit, zap, top-up, keeper rebalance, emissions, claim, deferred,
//      withdraw, shutdown, forceExit. Once positions are staked it makes emissions flow: the gauge's settled share in
//      the LeafVoter is raised (storage, verified through the public getter) and Base's chain buffer on the root Voter
//      is funded through its public `donate`, so the claim mints real AERO through LeafVoter -> emissions handler ->
//      root Voter, the path Base uses after launch.
//
//   FORK=1 RPC_URL=https://mainnet.base.org FORK_BLOCK=<recent block> npx hardhat run scripts/rehearse-aero-fork-prelaunch.js
//   Options: PENALTY=<blocks> also sets the gauge's early-unstake window (PENALTY_ADMIN_ROLE impersonated).
//            MAX_REBALANCE_SLIPPAGE_BPS=<bps> the batch's rail (default here 250, the recommended value for Aero's 2% fee
//            on the AERO/WETH CL200 compound route: docs/LAUNCH-NIGHT.md "Swap fees"); ROUTE=weth|usdc as the deploy script.
//
//   3. (2026-10-21, Aero's swap fees) PROVES auto-compound: after the claim, more emissions are credited, the keeper
//      rebalances the auto-compound position (same range, with the balancing swap the real keeper sends), and the run
//      asserts RewardsCompounded, the position's AERO reserve spent, its liquidity and holdings grown. It prints every
//      route hop's pool.fee(). With the live vault's 1% rail the preflight itself STOPS (fee 2% >= rail).
//
// WRITTEN 2026-10-20 IN THE CLOUD, WHERE NO BASE NODE WAS REACHABLE: it passes `node --check`, and every ABI fragment
// it uses is checked against the DEPLOYED contracts' verified ABIs by test/aero-review.test.js. Run it on the PC and
// send the output, good or bad. Nothing it does reaches Base. Public RPC only, gently (cache FORK_BLOCK).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");
const P = require("./lib/aero-prelaunch");

const { ADDR, FRAGMENTS, E, at } = P;
const U = (n) => ethers.parseUnits(String(n), 6);
const RECOMMENDED_RAIL_BPS = "250"; // 2% route fee + 0.5% room for price impact; the registry allows at most 300
let checks = 0, failures = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); c ? checks++ : failures++; };
const parse = (c, rc, name) => rc.logs.map((l) => { try { return c.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === name);

async function main() {
  if (process.env.FORK !== "1" || Number((await ethers.provider.getNetwork()).chainId) !== 31337) throw new Error("run with FORK=1 on the Hardhat network (a Base fork)");
  const [deployer] = await ethers.getSigners();
  const block = await ethers.provider.getBlock("latest");
  console.log(`fork block ${block.number} at ${new Date(block.timestamp * 1000).toISOString()}; deployer ${deployer.address}`);
  const known = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "aero-base.json"), "utf8"));
  for (const k of ["clFactory", "gaugeFactory", "positionManager", "swapRouter", "leafVoter", "aero"]) {
    if (!known[k] || known[k].toLowerCase() !== ADDR[k].toLowerCase()) throw new Error(`deployments/aero-base.json ${k} ${known[k]} != facts ${ADDR[k]}`);
  }

  await network.provider.send("evm_mine"); // Base fork: Hardhat cannot run a call on the fork block itself (no hardfork history for 8453)
  console.log("=== A. Aero's pools and gauge (created here as they will be on launch day) ===");
  const prices = await P.launchPrices();
  console.log(`  prices from the Aerodrome pools: WETH/USDC sqrtP ${prices.wethUsdc}, AERO/WETH ${prices.aeroWeth}, AERO/USDC ${prices.aeroUsdc} (new AERO is token0: ${prices.newAeroIs0})`);
  const wethUsdcPool = await P.ensureClPool(ADDR.weth, ADDR.usdc, 50, prices.wethUsdc, deployer);
  const aeroWethPool = await P.ensureClPool(ADDR.aero, ADDR.weth, 200, prices.aeroWeth, deployer);
  const aeroUsdcPool = await P.ensureClPool(ADDR.aero, ADDR.usdc, 200, prices.aeroUsdc, deployer);
  const AERO_SEED = E(150_000);
  const wethForAero = P.priceOut(prices.aeroWeth, AERO_SEED, prices.newAeroIs0) * 11n / 10n;
  const usdcForAero = P.priceOut(prices.aeroUsdc, AERO_SEED, true) * 11n / 10n;
  const usdcForWeth = P.priceOut(prices.wethUsdc, E(100), true) * 11n / 10n;
  await P.fund(deployer.address, { aero: AERO_SEED * 2n + E(1000), weth: E(100) + wethForAero + E(5), usdc: usdcForWeth + usdcForAero + U(1000) });
  await P.seedClPool(wethUsdcPool, { token: ADDR.weth, amount: E(100) }, { token: ADDR.usdc, amount: usdcForWeth }, deployer);
  await P.seedClPool(aeroWethPool, { token: ADDR.aero, amount: AERO_SEED }, { token: ADDR.weth, amount: wethForAero }, deployer);
  await P.seedClPool(aeroUsdcPool, { token: ADDR.aero, amount: AERO_SEED }, { token: ADDR.usdc, amount: usdcForAero }, deployer);
  await P.warmTwap(wethUsdcPool, ADDR.weth, E("0.01"), deployer, 300);
  await P.warmTwap(aeroWethPool, ADDR.aero, E(10), deployer, 300);
  await P.warmTwap(aeroUsdcPool, ADDR.aero, E(10), deployer, 300);
  // Aero's swap fees (not Aerodrome's): every pool's fee() is read, printed and compared with the rail; never assumed.
  for (const [label, pool] of [["WETH/USDC CL50 (the vault's pool)", wethUsdcPool], ["AERO/WETH CL200 (compound route, ROUTE=weth)", aeroWethPool], ["AERO/USDC CL200 (ROUTE=usdc)", aeroUsdcPool]]) {
    console.log(`  ${label} ${pool}: pool.fee() = ${Number(await at(pool, FRAGMENTS.CLPool).fee()) / 1e4}% right now`);
  }
  if (!process.env.MAX_REBALANCE_SLIPPAGE_BPS) process.env.MAX_REBALANCE_SLIPPAGE_BPS = RECOMMENDED_RAIL_BPS;
  console.log(`  rail for this rehearsal's batch: MAX_REBALANCE_SLIPPAGE_BPS=${process.env.MAX_REBALANCE_SLIPPAGE_BPS} (the live vault's is 100; the compound floor is the route's TWAP minus this rail)`);
  const { gauge } = await P.ensureGauge(wethUsdcPool, deployer);
  if (process.env.PENALTY) await P.setPenaltyWindow(gauge, Number(process.env.PENALTY));
  const lv = at(ADDR.leafVoter, FRAGMENTS.LeafVoter);
  console.log(`  LeafVoter chain status ${await lv.chainStatus()} (1 = Active expected), emissions handler ${await lv.EMISSIONS_HANDLER()}, orchestrator ${await lv.ORCHESTRATOR()}`);
  const mig = at(ADDR.migration, FRAGMENTS.AerodromeMigration);
  console.log(`  Migration: remaining ${ethers.formatEther(await mig.remaining())} AERO, paused ${await mig.paused()}, MIGRATION_OPEN ${new Date(Number(await mig.MIGRATION_OPEN()) * 1000).toISOString()}`);

  console.log("=== B. The launch-day rehearsal (scripts/rehearse-aero-fork.js) against these pools ===");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panda-aero-prelaunch-"));
  const file = path.join(tmp, "aero-base.json");
  const book = {};
  for (const k of ["clFactory", "gaugeFactory", "positionManager", "swapRouter", "leafVoter", "aero"]) book[k] = ADDR[k];
  Object.assign(book, { wethUsdcPool, wethUsdcGauge: gauge, aeroUsdcPool, aeroWethPool, _note: "temp file written by rehearse-aero-fork-prelaunch.js on a fork" });
  fs.writeFileSync(file, JSON.stringify(book, null, 2));
  process.env.AERO_FILE = file;
  console.log(`  temp address file ${file}`);
  const res = await require("./rehearse-aero-fork.js").main({
    afterStaked: async ({ vault }) => {
      console.log("=== B2. Emissions: the gauge's settled share in the LeafVoter is raised and Base's buffer on the root Voter funded ===");
      await P.fundEmissions(gauge, E(1_000_000));
      const g = at(gauge, FRAGMENTS.CLGauge);
      const ids = [];
      const v = await ethers.getContractAt("PandaVault", vault.target);
      for (let i = 0n; i < (await v.openPositionCount()); i++) ids.push(await v.openPositionAt(i));
      console.log(`  gauge.earned(vault, [${ids.join(", ")}]) = ${ethers.formatEther(await g.earned(vault.target, ids))} AERO before any block passes (the share is credited at the next settle)`);
      // A dry run of the real claim path (LeafVoter mint -> emissions handler -> root Voter -> AERO), as the vault.
      const asVault = await P.as(vault.target);
      try {
        await at(gauge, ["function claimEmissions(address,address,uint256[])"], asVault).claimEmissions.staticCall(vault.target, vault.target, [ids[0]]);
        console.log("  dry run of gauge.claimEmissions as the vault: OK (AERO would be minted to the vault)");
      } catch (e) {
        console.log(`  dry run of gauge.claimEmissions as the vault REVERTS: ${(e.shortMessage || e.message).slice(0, 200)}`);
        console.log("  -> the gauge will DEFER emissions on unstake instead (vault books them per position); send this output to the reviewer");
      }
    },
    expectEmissions: true,
    afterClaim: async ({ vault, p2, p3 }) => {
      const v = await ethers.getContractAt("PandaVault", vault.target);
      console.log(`  pendingUserAero(${p3}) after the claim: ${ethers.formatEther(await v.pendingUserAero(p3))} AERO (0 right after a claim; grows per block)`);
      await proveCompound(v, p2);
    },
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  const bad = (res.failures || 0) + failures;
  console.log(`  compound proof: ${checks} check(s) passed, ${failures} failed`);
  console.log(bad ? `\nPRELAUNCH REHEARSAL: ${bad} CHECK(S) FAILED` : "\nPRELAUNCH REHEARSAL PASSED");
  if (failures) process.exitCode = 1;
}

/// The compound proof (2026-10-21): `id` is an auto-compound position already rebalanced once. More emissions are
/// credited to the gauge, the keeper rebalances it again to the SAME range with the balancing swap the real keeper
/// sends (half of the compound's output back into token B), and the run asserts that the AERO was swapped along the
/// route (RewardsCompounded), the position's AERO reserve is spent, and its liquidity and holdings grew.
async function proveCompound(v, id) {
  console.log("=== B3. Auto-compound on the real pools: the AERO reserve is spent and the position grows ===");
  const [tokens, spacings, pools] = await v.compoundRoute();
  const rails = await v.guardRails();
  for (let i = 0; i < pools.length; i++) {
    const fee = Number(await at(pools[i], FRAGMENTS.CLPool).fee());
    console.log(`  route hop ${i}: ${tokens[i]} -> ${tokens[i + 1]} on CL${spacings[i]} ${pools[i]}: pool.fee() = ${fee / 1e4}% right now; rail maxRebalanceSlippageBps ${rails.maxRebalanceSlippageBps} (${Number(rails.maxRebalanceSlippageBps) / 100}%)`);
    ok(fee / 100 < Number(rails.maxRebalanceSlippageBps), `route hop ${i}: fee ${fee / 1e4}% is under the rail ${Number(rails.maxRebalanceSlippageBps) / 100}% (otherwise the compound could never clear)`);
  }
  const gauge = await v.gauge();
  const registry = await ethers.getContractAt("PandaRegistry", await v.registry());
  const keeper = await P.as(await registry.keeperOf(v.target));
  const nfpm = at(await v.positionManager(), FRAGMENTS.NonfungiblePositionManager);
  const pool = at(await v.pool(), FRAGMENTS.CLPool);
  // Modest emissions, so the compound's swap stays well inside the rail's room for price impact on a launch-size pool.
  await P.fundEmissions(gauge, E(5_000));
  await P.mine(5);
  const before = await nfpm.positions(id);
  const [L0, lower, upper] = [before[7], Number(before[5]), Number(before[6])];
  const r0 = await v.reserves(id);
  const pot = (await v.pendingUserAero(id)) + r0.aero;
  const s0 = (await pool.slot0())[0];
  const h0 = P.holdingsInToken1(s0, lower, upper, L0, r0.a, r0.b);
  console.log(`  position ${id} before: liquidity ${L0}, reserve ${ethers.formatEther(r0.a)} WETH / ${ethers.formatUnits(r0.b, 6)} USDC / ${ethers.formatEther(r0.aero)} AERO, pending ${ethers.formatEther(pot - r0.aero)} AERO; holdings ~ ${(h0 / 1e6).toFixed(2)} USDC`);
  ok(pot > 10n ** 16n, `the position has ${ethers.formatEther(pot)} AERO to compound (above MIN_COMPOUND_AERO 0.01)`);
  const floor = await v.compoundSwapFloor(pot);
  ok(floor > 0n, `compoundSwapFloor(${ethers.formatEther(pot)} AERO) = ${ethers.formatEther(floor)} ${tokens[tokens.length - 1] === ADDR.weth ? "WETH" : "out"} (route TWAP minus the rail)`);
  await P.later(Number(rails.minRebalanceInterval) + 1);
  await P.mine(5);
  // The balancing swap the keeper sends: about half of the compound's output goes to the other side of the range.
  const outIsA = tokens[tokens.length - 1].toLowerCase() === (await v.tokenA()).toLowerCase();
  const swapIn = floor / 2n;
  const rc = await (await v.connect(keeper).rebalance({ tokenId: id, isAToB: outIsA, rebalanceAmountIn: swapIn, rebalanceAmountOutMin: 0, newTickLower: lower, newTickUpper: upper,
    amount0MinMint: 0, amount1MinMint: 0, decreaseAmount0Min: 0, decreaseAmount1Min: 0, deadline: P.FAR })).wait();
  const comp = parse(v, rc, "RewardsCompounded");
  const minted = parse(v, rc, "PositionMinted");
  const newId = minted ? minted.args.tokenId : undefined;
  ok(!!comp && comp.args.aeroIn > 0n && comp.args.amountOut > 0n, comp
    ? `RewardsCompounded: ${ethers.formatEther(comp.args.aeroIn)} AERO swapped along the route for ${outIsA ? ethers.formatEther(comp.args.amountOut) + " WETH" : ethers.formatUnits(comp.args.amountOut, 6) + " USDC"} (the floor was ${ethers.formatEther(floor)})`
    : `no RewardsCompounded in the rebalance: the compound swap did not clear its floor (route fee vs rail ${Number(rails.maxRebalanceSlippageBps) / 100}%, or price impact); the AERO stayed in the reserve`);
  if (newId === undefined) { ok(false, "no PositionMinted in the rebalance"); return; }
  const after = await nfpm.positions(newId);
  const r1 = await v.reserves(newId);
  const s1 = (await pool.slot0())[0];
  const h1 = P.holdingsInToken1(s1, Number(after[5]), Number(after[6]), after[7], r1.a, r1.b);
  console.log(`  position ${id} -> ${newId} after: liquidity ${after[7]}, reserve ${ethers.formatEther(r1.a)} WETH / ${ethers.formatUnits(r1.b, 6)} USDC / ${ethers.formatEther(r1.aero)} AERO; holdings ~ ${(h1 / 1e6).toFixed(2)} USDC`);
  ok(r1.aero === 0n, `the AERO reserve was spent (${ethers.formatEther(r1.aero)} AERO left in the new position's reserve)`);
  ok(after[7] > L0, `the position's liquidity grew: ${L0} -> ${after[7]} (same range ${lower}..${upper})`);
  ok(h1 > h0, `the position's holdings grew: ~${(h0 / 1e6).toFixed(2)} -> ~${(h1 / 1e6).toFixed(2)} USDC (liquidity + reserves at the spot price)`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main, FRAGMENTS };
