// END-TO-END DRY RUN of launch night on a LOCAL Hardhat node with the repo's mocks (no Base RPC is reachable from the
// cloud session that wrote this; on the PC the same commands run against Base). Plain node, from the vault folder:
//
//   node scripts/dryrun-launch-night.js        (starts `npx hardhat node` on 127.0.0.1:8545, stops it at the end)
//
// What it proves, in launch order, with the owner's real commands as separate processes:
//   1. scripts/launch-night.js waits through every Aero stage (no pool; pool without gauge; gauge not activated; cap 0;
//      no AERO pools; AERO pools without liquidity) while Aero's side (scripts/launch-night-local-aero.js) advances,
//      ignores Aero's early WETH/cbBTC CL10 pool, prefers CL50 over a second WETH/USDC pool at CL100, writes the four
//      addresses, passes the preflight, and stops before the deploy as planned;
//   2. the same command with DEPLOY=1 deploys (Hardhat signer: local chain) and writes the result and the Safe files;
//   3. the same command again: every step checked and skipped, nothing deployed twice, same result;
//   4. a conflicting aero-base.json makes it STOP at step (b) without writing;
//   5. the Safe signs the two files (execute before 48 h refused), the safety wallet lifts the pauses, the platform reads right;
//   6. the website fill-in (dapp-config/scripts/fill-aero-config.mjs) checks the vault on this chain and fills a copy of
//      deployments.ts; the staking fill-in fills a copy of addresses.js; the upgrade and pause calldata scripts run.
// Output: test-logs/aero-kit/10-dryrun-launch-night.txt (+ the files it produced, under test-logs/aero-kit/dryrun/).
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const VAULT = path.join(__dirname, "..");
const KIT = path.join(VAULT, "..");
const LOGDIR = path.join(VAULT, "test-logs", "aero-kit");
const OUT = path.join(LOGDIR, "dryrun");
const RPC = "http://127.0.0.1:8545";
const NET = "launch-dryrun.local";
const lines = [];
let failures = 0;
const say = (m) => { console.log(m); lines.push(m); };
const ok = (c, m) => { say(`${c ? "  ok  " : "  FAIL"} ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s) => s.split("\n").map((l) => `      | ${l}`).join("\n");

const F = {
  aero: path.join(OUT, "aero-base.json"), batch: path.join(OUT, "aero-vault-batch.json"), result: path.join(OUT, "aero-launch-result.json"),
  state: path.join(OUT, "aero-local-state.json"), dep: path.join(VAULT, "deployments", `${NET}.json`),
};
const ENV = { ...process.env, NETWORK: NET, AERO_FILE: F.aero, BATCH_OUT: F.batch, RESULT_FILE: F.result, STATE: F.state, DEP_FILE: F.dep, POLL_SECONDS: "1", MAX_WAIT_MINUTES: "10" };
delete ENV.DEPLOY; delete ENV.PREFLIGHT_ONLY; delete ENV.RECORD; delete ENV.FORCE_INACTIVE_GAUGE;

function run(cmd, args, env = ENV, cwd = VAULT) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", maxBuffer: 64 << 20 });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const hh = (script, extra = {}) => run("npx", ["hardhat", "run", script, "--network", "localhost"], { ...ENV, ...extra });
const actor = (step, extra = {}) => {
  const r = hh("scripts/launch-night-local-aero.js", { STEP: step, ...extra });
  say(`  [aero side] STEP=${step}: ${r.code === 0 ? r.out.trim().split("\n").filter((l) => l.startsWith("[aero-local]")).join(" ") : "FAILED\n" + r.out}`);
  if (r.code !== 0) throw new Error(`actor step ${step} failed`);
  return r;
};

async function rpcUp() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if ((await r.json()).result === "0x7a69") return;
    } catch (e) {}
    await sleep(500);
  }
  throw new Error("the local Hardhat node did not start");
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(F.dep, { force: true });
  say(`Launch-night dry run, ${new Date().toISOString()}: local Hardhat node ${RPC} (chain 31337) with the repo's mocks. No Base RPC, no keys, nothing sent anywhere.`);
  const node = spawn("npx", ["hardhat", "node"], { cwd: VAULT, env: ENV, stdio: ["ignore", "pipe", "pipe"], detached: true }); // own group: stopped whole at the end
  node.stdout.on("data", () => {}); node.stderr.on("data", () => {});
  try {
    await rpcUp();
    say("\n=== 0. Platform and Aero's pre-launch state (only Aero's early WETH/cbBTC CL10 pool exists) ===");
    actor("setup");

    say("\n=== 1. npx hardhat run scripts/launch-night.js --network localhost  (no DEPLOY: wait, write, preflight, stop) ===");
    let out = "";
    const ln = spawn("npx", ["hardhat", "run", "scripts/launch-night.js", "--network", "localhost"], { cwd: VAULT, env: ENV });
    ln.stdout.on("data", (d) => (out += d)); ln.stderr.on("data", (d) => (out += d));
    const exited = new Promise((r) => ln.on("exit", r));
    const waitFor = async (re, label) => {
      for (let i = 0; i < 240; i++) { if (re.test(out)) { ok(true, `launch-night is waiting: ${label}`); return; } await sleep(500); }
      ok(false, `launch-night never printed ${re}`); throw new Error(`timeout waiting for ${re}\n${out}`);
    };
    await waitFor(/no WETH\/USDC pool on Aero yet/, "no WETH/USDC pool (the early WETH/cbBTC CL10 is ignored)");
    actor("pool-no-gauge");
    await waitFor(/WETH\/USDC CL50 pool 0x[0-9a-fA-F]{40} exists; its gauge is not created yet/, "pool exists, gauge not created");
    actor("gauge");
    await waitFor(/does not list the gauge as activated/, "gauge not activated (and cap 0): never deploys on it");
    actor("activate");
    await waitFor(/the gauge's emission cap is 0 \(it would earn/, "gauge activated but cap 0");
    actor("cap");
    await waitFor(/no AERO\/WETH pool on Aero yet/, "no AERO/WETH pool");
    actor("aero-pools");
    await waitFor(/AERO\/WETH CL200 0x[0-9a-fA-F]{40} exists but has no liquidity yet/, "AERO pools without liquidity");
    actor("liquidity");
    const code1 = await exited;
    say(short(out.trim()));
    // 2026-10-21: the mock AERO/WETH CL200 pool charges Aero's 2% and the live rail is 1%, so the preflight STOPS with the
    // fee sentence until the owner decides the rail; then the same command with MAX_REBALANCE_SLIPPAGE_BPS passes.
    ok(code1 !== 0 && /STOPPED at step \(c\)/.test(out) && /AERO\/WETH CL200 0x[0-9a-fA-F]{40} charges 2% per swap right now, at or above the rail maxRebalanceSlippageBps 100/.test(out), "step (c) STOPPED: the compound route pool's 2% fee is at or above the 1% rail (the plain sentence)");
    ok(/swap fees right now \(pool.fee\(\)\): WETH\/USDC CL50 0.3%; AERO\/WETH CL200 2%; AERO\/USDC CL200 2%/.test(out), "step (a) printed every pool's fee()");
    say("\n=== 1b. The same command with MAX_REBALANCE_SLIPPAGE_BPS=250 (the owner's rail decision) ===");
    ENV.MAX_REBALANCE_SLIPPAGE_BPS = "250";
    const r1 = hh("scripts/launch-night.js");
    out = r1.out;
    say(short(out.trim()));
    ok(r1.code === 0, "exit 0");
    ok(/RAIL OVERRIDE \(MAX_REBALANCE_SLIPPAGE_BPS\): maxRebalanceSlippageBps 100 \(live vault\) -> 250/.test(out), "the batch's rail is 250 bps, printed loudly");
    ok(/CL50 chosen; also found CL100/.test(out), "two WETH/USDC pools: CL50 chosen, the CL100 one named");
    ok(/AERO\/USDC: CL200 chosen; also found CL100/.test(out), "two AERO/USDC pools: CL200 chosen once liquid, the CL100 one named");
    ok(/already filled with the same addresses: nothing to write/.test(out), "step (b): the four slots were written by the first run and are re-checked");
    ok(/PREFLIGHT OK/.test(out), "step (c) preflight passed");
    ok(/Stopped before the deploy, as planned/.test(out) && /DEPLOY=1 WALLET=browser DEPLOYER=0x3e1fe6c4E81B9F59912B0b9074E71dd2F1A61919 npx hardhat run scripts\/launch-night.js --network base/.test(out), "step (d) printed the owner's deploy command and stopped");
    const S = JSON.parse(fs.readFileSync(F.state, "utf8"));
    const filled = JSON.parse(fs.readFileSync(F.aero, "utf8"));
    ok(filled.wethUsdcPool === S.wethUsdcPool && filled.wethUsdcGauge === S.wethUsdcGauge && filled.aeroWethPool === S.aeroWethPool && filled.aeroUsdcPool === S.aeroUsdcPool,
      "aero-base.json holds exactly Aero's CL50 pool, its gauge and the two CL200 AERO pools");
    ok(!fs.existsSync(F.result), "no result file yet (nothing deployed)");

    say("\n=== 2. DEPLOY=1 ... scripts/launch-night.js (same command + DEPLOY=1; Hardhat signer on the local chain) ===");
    let r = hh("scripts/launch-night.js", { DEPLOY: "1" });
    say(short(r.out.trim()));
    ok(r.code === 0, "exit 0");
    ok(/already filled with the same addresses: nothing to write/.test(r.out), "step (a)/(b) re-checked, nothing rewritten");
    const res = JSON.parse(fs.readFileSync(F.result, "utf8"));
    ok(res.pool === S.wethUsdcPool && res.gauge === S.wethUsdcGauge && res.aeroWethPool === S.aeroWethPool && res.aeroUsdcPool === S.aeroUsdcPool && res.aeroWethSpacing === 200 && res.aeroUsdcSpacing === 200,
      "result: pool, gauge, AERO pools and spacings");
    ok(/^0x[0-9a-fA-F]{40}$/.test(res.vault) && res.startBlock > 0 && /^0x[0-9a-f]{64}$/.test(res.salt) && res.batch.calls.length === 4, `result: vault ${res.vault}, block ${res.startBlock}, salt, 4-call batch`);
    const sched = JSON.parse(fs.readFileSync(F.result.replace(/\.json$/, "-safe-schedule.json"), "utf8"));
    const exec = JSON.parse(fs.readFileSync(F.result.replace(/\.json$/, "-safe-execute.json"), "utf8"));
    ok(sched.transactions[0].data === res.batch.schedule.data && exec.transactions[0].data === res.batch.execute.data && sched.chainId === "31337", "Safe Transaction Builder files carry the batch's schedule / execute");
    ok(/Safe transaction "schedule"/.test(r.out) && /Safe transaction "execute" \(sign 48 h after/.test(r.out), "printed the Safe schedule and the +48 h execute");
    ok(/^0x[0-9a-f]{64}$/.test(res.timelockOperationId) && /cancel/.test(r.out) && fs.existsSync(F.result.replace(/\.json$/, "-safe-cancel.json")), "rollback: the Safe cancel file (timelock operation id read from the timelock)");
    ok(new RegExp(`VAULT_ADDRESS=${res.vault} START_BLOCK=${res.startBlock} GAUGE_MODE=aero AERO_WETH_POOL_ADDRESS=${res.aeroWethPool} VAULT_LIB_ADDRESS=${res.vaultLib}`).test(r.out), "printed the keeper's Railway values");

    say("\n=== 3. The same DEPLOY=1 command again (idempotent: nothing deployed twice) ===");
    r = hh("scripts/launch-night.js", { DEPLOY: "1" });
    say(short(r.out.trim()));
    ok(r.code === 0 && new RegExp(`already deployed: PandaVault ${res.vault}`).test(r.out), "deploy skipped, same vault");
    ok(JSON.stringify(JSON.parse(fs.readFileSync(F.result, "utf8"))) === JSON.stringify(res), "result file unchanged");

    say("\n=== 4. A conflicting aero-base.json: STOP at step (b), nothing written ===");
    const conflict = path.join(OUT, "aero-base-conflict.json");
    fs.writeFileSync(conflict, JSON.stringify({ ...filled, wethUsdcGauge: S.aero }, null, 2) + "\n");
    const before = fs.readFileSync(conflict, "utf8");
    r = hh("scripts/launch-night.js", { AERO_FILE: conflict, DEPLOY: "1" });
    say(short(r.out.trim().split("\n").slice(-3).join("\n")));
    ok(r.code === 1 && /STOPPED at step \(b\)/.test(r.out) && fs.readFileSync(conflict, "utf8") === before, "exit 1, plain sentence, file untouched");
    r = hh("scripts/launch-night.js", { WETH_USDC_SPACING: "10" });
    ok(r.code === 1 && /STOPPED at step \(a\): WETH_USDC_SPACING=10 was set, but there is no WETH\/USDC pool at tick spacing 10/.test(r.out), "an override naming a spacing that does not exist: STOP at (a)");

    say("\n=== 5. The Safe signs the two files, +48 h, the safety wallet lifts the pauses ===");
    actor("safe-execute", { SCHEDULE_FILE: F.result.replace(/\.json$/, "-safe-schedule.json"), EXECUTE_FILE: F.result.replace(/\.json$/, "-safe-execute.json"), CANCEL_FILE: F.result.replace(/\.json$/, "-safe-cancel.json") });
    r = hh("scripts/launch-night-local-aero.js", { STEP: "verify" });
    say(short(r.out.trim()));
    ok(r.code === 0, "registered, keeper set, live vault closed to deposits, new vault open, pauses lifted, vault.gauge() right");

    say("\n=== 6. Website fill-in on a copy of deployments.ts (checks the vault on this chain) ===");
    const ts = path.join(OUT, "deployments.ts");
    fs.copyFileSync(path.join(KIT, "dapp-config", "src", "config", "deployments.ts"), ts);
    const fillEnv = { ...process.env, RPC_URL: RPC, ALLOW_LOCAL: "1" };
    r = run("node", [path.join(KIT, "dapp-config", "scripts", "fill-aero-config.mjs"), F.result, "--config", ts], fillEnv, KIT);
    say(short(r.out.trim()));
    const tsAfter = fs.readFileSync(ts, "utf8");
    ok(r.code === 0 && tsAfter.includes(`address: '${res.vault}' as`) && tsAfter.includes(`startBlock: ${res.startBlock}n as`) && tsAfter.includes(`gauge: '${res.gauge}' as`), "AERO_VAULT filled from the result after the on-chain check");
    r = run("node", [path.join(KIT, "dapp-config", "scripts", "fill-aero-config.mjs"), F.result, "--config", ts], fillEnv, KIT);
    ok(r.code === 0 && /already filled/.test(r.out), "second run: already filled");
    r = run("node", [path.join(KIT, "dapp-config", "scripts", "fill-aero-config.mjs"), F.result, "--config", ts], { ...process.env, RPC_URL: RPC }, KIT);
    ok(r.code === 1 && /not Base \(8453\)/.test(r.out), "without ALLOW_LOCAL a local result is refused");
    const tampered = path.join(OUT, "result-tampered.json");
    fs.writeFileSync(tampered, JSON.stringify({ ...res, gauge: S.decoyWethUsdc100 }));
    const ts2 = path.join(OUT, "deployments-2.ts");
    fs.copyFileSync(path.join(KIT, "dapp-config", "src", "config", "deployments.ts"), ts2);
    r = run("node", [path.join(KIT, "dapp-config", "scripts", "fill-aero-config.mjs"), tampered, "--config", ts2], fillEnv, KIT);
    ok(r.code === 1 && /vault.gauge\(\) is/.test(r.out) && fs.readFileSync(ts2, "utf8") === fs.readFileSync(path.join(KIT, "dapp-config", "src", "config", "deployments.ts"), "utf8"), "a result whose gauge is not the vault's own: STOP, file untouched");

    say("\n=== 7. Staking fill-in on a copy of addresses.js ===");
    const book = path.join(OUT, "addresses.js");
    fs.copyFileSync(path.join(KIT, "staking", "deployments", "addresses.js"), book);
    r = run("node", [path.join(KIT, "staking", "scripts", "fill-aero-addresses.js"), F.result, "--file", book], process.env, path.join(KIT, "staking"));
    say(short(r.out.trim()));
    ok(r.code === 0 && fs.readFileSync(book, "utf8").includes(`pools: ["${res.aeroWethPool}"]`) && fs.readFileSync(book, "utf8").includes(`pools: ["${res.aeroUsdcPool}"]`), "both routes filled, read back complete");

    say("\n=== 8. Old AERO upgrade calldata with balances read from the chain; pause calldata ===");
    r = run("node", ["scripts/aero-upgrade-calldata.js"], { ...process.env, AMOUNT: "balance", RPC_URL: RPC, TEMPLATE_OUT: path.join(OUT, "safe-aero-upgrade.json"), FILLED_OUT: path.join(OUT, "safe-aero-upgrade-filled.json") });
    say(short(r.out.trim()));
    const upFilled = JSON.parse(fs.readFileSync(path.join(OUT, "safe-aero-upgrade-filled.json"), "utf8"));
    ok(r.code === 0 && /Safe 1234\.5, company 10\.0/.test(r.out) && upFilled.transactions[0].contractInputsValues.amount === "1234500000000000000000", "balances read (Safe 1234.5, company 10), Safe file filled with the exact wei");
    r = run("node", ["scripts/aero-pause-calldata.js"]);
    say(short(r.out.trim()));
    ok(r.code === 0 && (r.out.match(/data 0x/g) || []).length === 4, "four pause / unpause calls printed");
  } finally {
    try { process.kill(-node.pid, "SIGINT"); } catch (e) { node.kill("SIGINT"); }
    if (fs.existsSync(F.dep)) { fs.copyFileSync(F.dep, path.join(OUT, `${NET}.json`)); fs.rmSync(F.dep, { force: true }); }
  }
  say(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL DRY-RUN CHECKS PASSED");
  fs.mkdirSync(LOGDIR, { recursive: true });
  fs.writeFileSync(path.join(LOGDIR, "10-dryrun-launch-night.txt"), lines.join("\n") + "\n");
  if (failures) process.exitCode = 1;
}

main().catch((e) => { say(`DRY RUN ERROR: ${e.stack || e}`); fs.mkdirSync(LOGDIR, { recursive: true }); fs.writeFileSync(path.join(LOGDIR, "10-dryrun-launch-night.txt"), lines.join("\n") + "\n"); process.exit(1); });
