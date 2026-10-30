// Launch night (Aero, 2026-10-22 00:00 UTC) in ONE command. It chains, in order, and STOPS at the first problem with
// one plain sentence:
//   (a) wait for the four addresses Aero creates (scripts/launch-night-addresses.js): the WETH/USDC CL pool, its gauge
//       (pool.gauge(), gauge.nft(), LeafVoter.isActivated, emission cap > 0, tick spacing), the AERO/WETH and AERO/USDC
//       pools (token order, liquidity). A pool whose gauge is not activated yet means WAIT, not deploy;
//   (b) write them into deployments/aero-base.json (never overwrites a different address);
//   (c) run the read-only preflight of scripts/deploy-aero-vault.js;
//   (d) print what the owner does next; with DEPLOY=1, run the deploy itself, exactly as deploy-aero-vault.js does
//       (same code: this file calls its main());
//   (e) after the deploy, write deployments/aero-launch-result.json (vault, libraries, block, pool, gauge, batch JSON,
//       salt) and the two Safe Transaction Builder files, and print the Safe "schedule" and the "execute" (+48 h).
// Every step is idempotent: run the same command again after a stop and the finished steps are checked and skipped.
//
//   1. Wait and check (read-only, no wallet, nothing sent):
//        npx hardhat run scripts/launch-night.js --network base
//   2. Deploy (3 transactions in the owner's browser wallet, then the result file):
//        DEPLOY=1 WALLET=browser DEPLOYER=0x3e1fe6c4E81B9F59912B0b9074E71dd2F1A61919 npx hardhat run scripts/launch-night.js --network base
//
// Options: POLL_SECONDS (60), MAX_WAIT_MINUTES (240), WETH_USDC_SPACING / AERO_WETH_SPACING / AERO_USDC_SPACING (the
// owner's pick when the preferred spacing does not exist), FORCE_INACTIVE_GAUGE=1 (deploy although the gauge is not
// activated or has a 0 cap: only on the owner's explicit decision), KEEPER, ROUTE, MAX_REBALANCE_SLIPPAGE_BPS (the
// batch's rail; Aero's swap fees: the preflight prints every pool's fee() and STOPS when the compound route pool's fee
// is at or above the rail, see docs/LAUNCH-NIGHT.md "Swap fees"), VAULT_LIB / TOPUP_LIB (resume a
// stopped deploy, printed by the deploy script), NETWORK / AERO_FILE / BATCH_OUT / RESULT_FILE (other files; the
// local dry run uses them).
//
// Local dry run (no Base RPC is reachable from the cloud session that wrote this): scripts/dryrun-launch-night.js runs this
// file against a local Hardhat node with the repo's Aero mocks, start to finish, twice (to prove the re-run).
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { checkOnce, waitForAddresses } = require("./launch-night-addresses");
const { fillAeroFile, buildResult, safeTxBuilder, writeJsonAtomic } = require("./lib/launch-night-files");

const OWNER_WALLET = "0x3e1fe6c4E81B9F59912B0b9074E71dd2F1A61919"; // deployments/base.json deployer (owner decision 2026-10-04)
const KNOWN = ["clFactory", "gaugeFactory", "positionManager", "swapRouter", "leafVoter", "aero"];
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const stop = (step, sentence) => Object.assign(new Error(`STOPPED at step (${step}): ${sentence}`), { stopped: true });
const rel = (f) => path.relative(process.cwd(), f) || f;

async function main(o = {}) {
  const env = process.env;
  const log = o.log || console.log;
  const net = env.NETWORK || "base";
  const root = path.join(__dirname, "..");
  const depPath = path.join(root, "deployments", `${net}.json`);
  const aeroFile = env.AERO_FILE ? path.resolve(env.AERO_FILE) : path.join(root, "deployments", "aero-base.json");
  const batchFile = env.BATCH_OUT ? path.resolve(env.BATCH_OUT) : path.join(root, "deployments", `aero-vault-batch-${net}.json`);
  const resultFile = env.RESULT_FILE ? path.resolve(env.RESULT_FILE) : path.join(root, "deployments", "aero-launch-result.json");
  if (env.RECORD === "0") throw stop("d", "RECORD=0 is set, but launch night needs the deploy record to resume after a stop. Remove RECORD=0.");
  const { chainId } = await ethers.provider.getNetwork();
  const local = Number(chainId) === 31337;
  if (!local && Number(chainId) !== 8453) throw stop("a", `this is chain ${chainId}, not Base (8453).`);
  log(`=== Launch night on ${local ? "a LOCAL Hardhat chain (dry run or fork: nothing reaches Base)" : "Base"} ===`);
  log(`files: ${rel(aeroFile)} | ${rel(depPath)} | ${rel(batchFile)} | ${rel(resultFile)}`);

  // (a) the four addresses
  log("\n--- (a) Waiting for Aero's four addresses (read-only) ---");
  const raw = JSON.parse(fs.readFileSync(aeroFile, "utf8"));
  const A = {};
  for (const k of KNOWN) {
    if (!ethers.isAddress(raw[k])) throw stop("a", `${rel(aeroFile)} has no valid ${k}; the six known Aero addresses must be filled in first.`);
    A[k] = ethers.getAddress(raw[k]);
  }
  const r = await waitForAddresses(ethers.provider, A, { onPoll: o.onPoll, log, pollSeconds: o.pollSeconds, maxWaitMinutes: o.maxWaitMinutes });
  const F = r.found;
  log(`ready: WETH/USDC CL${F.wethUsdcSpacing} ${F.wethUsdcPool}, gauge ${F.wethUsdcGauge} (activated ${F.gaugeActivated}, cap ${F.emissionCap}); ` +
    `AERO/WETH CL${F.aeroWethSpacing} ${F.aeroWethPool}; AERO/USDC CL${F.aeroUsdcSpacing} ${F.aeroUsdcPool}`);
  // Aero's swap fees are per tick spacing and changeable by its fee manager: read each pool's fee() now and print it.
  const feeOf = async (a) => { try { return `${Number(await new ethers.Contract(a, ["function fee() view returns (uint24)"], ethers.provider).fee()) / 1e4}%`; } catch { return "unreadable"; } };
  log(`swap fees right now (pool.fee()): WETH/USDC CL${F.wethUsdcSpacing} ${await feeOf(F.wethUsdcPool)}; AERO/WETH CL${F.aeroWethSpacing} ${await feeOf(F.aeroWethPool)}; ` +
    `AERO/USDC CL${F.aeroUsdcSpacing} ${await feeOf(F.aeroUsdcPool)}${env.MAX_REBALANCE_SLIPPAGE_BPS ? ` | rail MAX_REBALANCE_SLIPPAGE_BPS=${env.MAX_REBALANCE_SLIPPAGE_BPS}` : " | rail: the live vault's (MAX_REBALANCE_SLIPPAGE_BPS not set)"}`);

  // (b) aero-base.json
  log(`\n--- (b) Writing ${rel(aeroFile)} ---`);
  const block = await ethers.provider.getBlock("latest");
  let filled;
  try {
    filled = fillAeroFile(aeroFile, F, `filled by scripts/launch-night.js at ${new Date().toISOString()} from chain ${chainId} block ${block.number}: ` +
      `WETH/USDC CL${F.wethUsdcSpacing}, gauge activated ${F.gaugeActivated}, emission cap ${F.emissionCap}; AERO/WETH CL${F.aeroWethSpacing}; AERO/USDC CL${F.aeroUsdcSpacing}`);
  } catch (e) { throw Object.assign(e, { stopped: true }); }
  log(filled.written.length ? `written: ${filled.written.join(", ")}${filled.same.length ? ` (already there: ${filled.same.join(", ")})` : ""}` : "already filled with the same addresses: nothing to write");

  // (c) preflight (deploy-aero-vault.js, read-only)
  log("\n--- (c) Preflight (scripts/deploy-aero-vault.js, read-only) ---");
  const deployScript = require("./deploy-aero-vault.js");
  const saved = { NETWORK: env.NETWORK, AERO_FILE: env.AERO_FILE, BATCH_OUT: env.BATCH_OUT, PREFLIGHT_ONLY: env.PREFLIGHT_ONLY };
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete env[k]; else env[k] = v; } };
  Object.assign(env, { NETWORK: net, AERO_FILE: aeroFile, BATCH_OUT: batchFile, PREFLIGHT_ONLY: "1" });
  try { await deployScript.main(); } catch (e) { restore(); throw stop("c", `the preflight found a problem; nothing was deployed. ${String(e.message || e).split("\n").join(" ")}`); }
  restore();

  // (d) deploy, or say what to do
  const deployCmd = `DEPLOY=1 WALLET=browser DEPLOYER=${OWNER_WALLET} npx hardhat run scripts/launch-night.js --network base`;
  let dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  let rec = dep.aeroVault;
  log("\n--- (d) Deploy ---");
  if (rec && rec.address) {
    if ((await ethers.provider.getCode(rec.address)) === "0x") throw stop("d", `${rel(depPath)} records an Aero vault at ${rec.address}, but that address has no code on this chain.`);
    if (!eq(rec.pool, F.wethUsdcPool) || !eq(rec.gauge, F.wethUsdcGauge)) throw stop("d", `${rel(depPath)} records an Aero vault on pool ${rec.pool} / gauge ${rec.gauge}, not on the pool and gauge found now.`);
    log(`already deployed: PandaVault ${rec.address} (block ${rec.deployBlock}); the deploy is skipped.`);
  } else if (env.DEPLOY !== "1") {
    log("Preflight passed. Next, the owner:");
    log("  1. (if not done) the Remix pass on PandaVault.sol, PandaVaultLib.sol, PandaTopUpLib.sol");
    log(`  2. deploy with the browser wallet (3 transactions: PandaVaultLib, PandaTopUpLib, PandaVault):\n       ${deployCmd}`);
    log(`  3. then, in the Safe ${dep.safe || ""}: the "schedule" transaction the deploy prints (the Safe batch); "execute" 48 hours later.`);
    log("Stopped before the deploy, as planned (DEPLOY=1 not set). Nothing was sent.");
    return { stage: "ready-to-deploy", found: F };
  } else {
    const again = await checkOnce(ethers.provider, A);
    if (again.state !== "ready" || !eq(again.found.wethUsdcGauge, F.wethUsdcGauge) || !eq(again.found.wethUsdcPool, F.wethUsdcPool)) {
      throw stop("d", `just before the deploy the chain no longer looks ready (${again.reasons.join("; ") || "another pool or gauge"}). Nothing was deployed.`);
    }
    delete env.PREFLIGHT_ONLY;
    Object.assign(env, { NETWORK: net, AERO_FILE: aeroFile, BATCH_OUT: batchFile });
    try { await deployScript.main(); } catch (e) {
      restore();
      throw stop("d", `the deploy stopped: ${String(e.message || e).split("\n")[0]}. If a library was already created, the line above says how to resume (VAULT_LIB=... TOPUP_LIB=...): add it in front of the same command.`);
    }
    restore();
    dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
    rec = dep.aeroVault;
    if (!rec || !rec.address) throw stop("e", `the deploy finished but ${rel(depPath)} has no aeroVault record.`);
  }

  // (e) result file and the Safe transactions
  log(`\n--- (e) ${rel(resultFile)} and the Safe transactions ---`);
  if (!fs.existsSync(batchFile)) throw stop("e", `the batch file ${rel(batchFile)} is missing; it is written by the deploy. Do not schedule anything until it is back.`);
  const batch = JSON.parse(fs.readFileSync(batchFile, "utf8"));
  const v = new ethers.Contract(rec.address, ["function gauge() view returns (address)", "function pool() view returns (address)"], ethers.provider);
  const [vg, vp] = [await v.gauge(), await v.pool()];
  if (!eq(vg, F.wethUsdcGauge) || !eq(vp, F.wethUsdcPool)) throw stop("e", `the vault reads gauge ${vg} / pool ${vp}, not the gauge and pool found.`);
  const result = buildResult({ network: net, chainId, rec, batch, found: F });
  // The rollback before the 48 h: the Safe (the timelock's canceller) cancels the scheduled batch. Its id is read from the
  // timelock itself (hashOperationBatch, a pure function of the batch).
  const tlc = new ethers.Contract(batch.timelock, ["function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) pure returns (bytes32)", "function cancel(bytes32)"], ethers.provider);
  const opId = await tlc.hashOperationBatch(batch.calls.map((c) => c.to), batch.calls.map((c) => c.value), batch.calls.map((c) => c.data), ethers.ZeroHash, batch.salt);
  result.timelockOperationId = opId;
  result.cancel = { to: batch.timelock, value: "0", data: tlc.interface.encodeFunctionData("cancel", [opId]) };
  if (fs.existsSync(resultFile)) {
    const old = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    if (old.vault && !eq(old.vault, result.vault)) throw stop("e", `${rel(resultFile)} already describes another vault (${old.vault}). Move it away before going on.`);
  }
  writeJsonAtomic(resultFile, result);
  const delayH = batch.delaySeconds / 3600;
  const safe = dep.safe || batch.safe;
  const tb = (name, tx, what) => safeTxBuilder({ chainId, safe, name, description: what, txs: [{ to: tx.to, value: tx.value, data: tx.data }] });
  const scheduleFile = resultFile.replace(/\.json$/, "") + "-safe-schedule.json";
  const executeFile = resultFile.replace(/\.json$/, "") + "-safe-execute.json";
  const cancelFile = resultFile.replace(/\.json$/, "") + "-safe-cancel.json";
  writeJsonAtomic(scheduleFile, tb("Panda Aero vault: schedule", batch.schedule, `Timelock scheduleBatch, salt ${batch.salt}: ${batch.calls.map((c) => c.what).join("; ")}`));
  writeJsonAtomic(executeFile, tb("Panda Aero vault: execute", batch.execute, `Timelock executeBatch, salt ${batch.salt}: only ${delayH} h after the schedule is mined`));
  writeJsonAtomic(cancelFile, tb("Panda Aero vault: CANCEL (rollback only)", result.cancel, `Timelock cancel(${opId}): only to call off the scheduled batch before it executes`));
  log(`written: ${rel(resultFile)}, ${rel(scheduleFile)}, ${rel(executeFile)}, ${rel(cancelFile)}`);
  log(`\nPandaVault ${result.vault} | block ${result.startBlock} | PandaVaultLib ${result.vaultLib} | PandaTopUpLib ${result.topUpLib}`);
  log(`pool ${result.pool} (CL${result.tickSpacing}) | gauge ${result.gauge} | salt ${result.salt}`);
  log(`\nThe one timelock batch on registry ${batch.registry}:`);
  batch.calls.forEach((c, i) => log(`  ${i + 1}. ${c.what}`));
  log(`\nSafe transaction "schedule" (sign now), to ${batch.schedule.to}, value 0, data:\n  ${batch.schedule.data}`);
  log(`Safe transaction "execute" (sign ${delayH} h after the schedule is mined; earliest ${new Date(Date.now() + batch.delaySeconds * 1000).toISOString()} if scheduled now), to ${batch.execute.to}, value 0, data:\n  ${batch.execute.data}`);
  log(`(Safe{Wallet} > Transaction Builder: drag in ${path.basename(scheduleFile)} now, ${path.basename(executeFile)} after ${delayH} h.)`);
  log(`Rollback before the execute: the Safe signs ${path.basename(cancelFile)} (timelock cancel of operation ${opId}). The old vault is untouched either way.`);
  log(`\nKeeper (Railway, new service; start it only after the execute and the unpause): VAULT_ADDRESS=${result.vault} START_BLOCK=${result.startBlock} ` +
    `GAUGE_MODE=aero AERO_WETH_POOL_ADDRESS=${result.aeroWethPool} VAULT_LIB_ADDRESS=${result.vaultLib}; KEEPER_PRIVATE_KEY = the key of ${result.keeper} (the batch's keeper; never pasted anywhere else). Details: docs/aero-keeper-railway.md`);
  log(`\nAfter the execute: the safety wallet lifts the two pauses (scripts/aero-pause-calldata.js prints them), then the website and staking fill-ins and the keeper (docs/LAUNCH-NIGHT.md).`);
  return { stage: "deployed", result, scheduleFile, executeFile, cancelFile };
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`\n${e.stopped ? e.message : `STOPPED: ${e.stack || e}`}`);
    console.error("Nothing after this point was done. Fix what the sentence says, then run the SAME command again: finished steps are checked and skipped.");
    process.exit(1);
  });
}
module.exports = { main, OWNER_WALLET };
