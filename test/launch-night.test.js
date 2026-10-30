// Launch-night kit, unit level (the end-to-end dry run is scripts/dryrun-launch-night.js on a local node):
// the pool choice, every waiting / stop state of step (a) against the repo's mocks, every file write, every calldata.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");
const { choosePool, checkOnce, waitForAddresses, ABI, WETH, USDC } = require("../scripts/launch-night-addresses");
const { fillAeroFile, buildResult, safeTxBuilder, AERO_SLOTS } = require("../scripts/lib/launch-night-files");
const up = require("../scripts/aero-upgrade-calldata");
const pz = require("../scripts/aero-pause-calldata");

const verified = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "aero-base-abi.json"), "utf8"));
function has(contract, fragment) {
  const f = ethers.Fragment.from(fragment);
  const sig = f.format("sighash");
  const hit = verified[contract].functions.find((x) => x.startsWith(sig + "->"));
  expect(hit, `${contract}: ${sig} is not on the deployed contract`).to.not.equal(undefined);
  if (f.outputs && f.outputs.length) expect(hit.slice(sig.length + 2), `${contract}: ${sig} return shape`).to.equal(`(${f.outputs.map((o) => o.format("sighash")).join(",")})`);
}
const A1 = "0x1111111111111111111111111111111111111111", A2 = "0x2222222222222222222222222222222222222222";
const A3 = "0x3333333333333333333333333333333333333333", A4 = "0x4444444444444444444444444444444444444444";
const quiet = () => {};

describe("Launch night: choosing the pool (pure)", function () {
  const p = (spacing, liquidity = 1n) => ({ spacing, pool: `0x${String(spacing).padStart(40, "0")}`, liquidity });
  it("WETH/USDC: CL50 wins and the others are named; nothing found = wait", () => {
    expect(choosePool("wethUsdc", "WETH/USDC", [], undefined).wait).to.match(/no WETH\/USDC pool/);
    const r = choosePool("wethUsdc", "WETH/USDC", [p(10), p(50), p(100)], undefined);
    expect(r.pick.spacing).to.equal(50);
    expect(r.note).to.match(/also found CL10 .*CL100/);
  });
  it("WETH/USDC: no CL50 (one pool or several) = STOP with every pool listed and the override named", () => {
    for (const found of [[p(100)], [p(10), p(100)]]) {
      const r = choosePool("wethUsdc", "WETH/USDC", found, undefined);
      expect(r.stop).to.match(/not at tick spacing 50/);
      expect(r.stop).to.match(/WETH_USDC_SPACING=<spacing>/);
      for (const f of found) expect(r.stop).to.include(f.pool);
    }
  });
  it("an owner's override picks that spacing, or stops if it does not exist", () => {
    expect(choosePool("wethUsdc", "WETH/USDC", [p(10), p(100)], "100").pick.spacing).to.equal(100);
    expect(choosePool("wethUsdc", "WETH/USDC", [p(10)], "50").stop).to.match(/WETH_USDC_SPACING=50 was set, but there is no/);
  });
  it("AERO pools: CL200 wins, but only once it has liquidity (wait, naming the others)", () => {
    const liquid = (f) => f.liquidity > 0n;
    expect(choosePool("aeroUsdc", "AERO/USDC", [p(100), p(200)], undefined, liquid).pick.spacing).to.equal(200);
    expect(choosePool("aeroUsdc", "AERO/USDC", [p(100), p(200, 0n)], undefined, liquid).wait).to.match(/CL200 .* no liquidity yet.*also found: CL100.*AERO_USDC_SPACING/);
    expect(choosePool("aeroWeth", "AERO/WETH", [p(100)], undefined, liquid).stop).to.match(/not at tick spacing 200.*AERO_WETH_SPACING/);
  });
});

describe("Launch night: Aero's swap fees against the rail (pure)", function () {
  const { routeFeeProblem, railsFor, REGISTRY_MAX_SLIPPAGE_BPS } = require("../scripts/deploy-aero-vault.js");
  const live = { maxRebalanceSlippageBps: 100, twapWindow: 300, minRebalanceInterval: 3600, maxRangeSpacings: 40, maxTwapDeviationTicks: 100 };
  it("a compound route pool at or above the rail STOPS with the plain sentence (2% on CL200 vs the live 1% rail); under it passes", () => {
    const p = routeFeeProblem("AERO/WETH CL200 0xc85D5CB72d1aaD6f152A8decAd228AE4A59Ac9B3", 20000, 100);
    expect(p).to.match(/AERO\/WETH CL200 0xc85D.* charges 2% per swap right now, at or above the rail maxRebalanceSlippageBps 100 \(1%\)/);
    expect(p).to.match(/auto-compound would never happen/);
    expect(p).to.match(/MAX_REBALANCE_SLIPPAGE_BPS=<bps above the fee, at most 300 = 3%>/);
    expect(p).to.match(/Nothing was deployed/);
    expect(routeFeeProblem("x", 10000, 100)).to.match(/charges 1% per swap right now, at or above the rail maxRebalanceSlippageBps 100/); // equal = still never (impact)
    expect(routeFeeProblem("x", 20000, 250)).to.equal(null);
    expect(routeFeeProblem("x", 10000, 150)).to.equal(null);
    expect(routeFeeProblem("x", 3000, 100)).to.equal(null); // Aerodrome's 0.3% on CL200 under the live rail: today's case
    expect(routeFeeProblem("x", undefined, 100)).to.match(/cannot be read/);
  });
  it("MAX_REBALANCE_SLIPPAGE_BPS replaces the rail within the registry's bound (1..300); anything else is refused", () => {
    expect(REGISTRY_MAX_SLIPPAGE_BPS).to.equal(300);
    expect(railsFor(live, 50)).to.deep.equal(live);
    expect(railsFor(live, 50, undefined)).to.deep.equal(live);
    expect(railsFor(live, 50, "")).to.deep.equal(live);
    expect(railsFor(live, 50, "250")).to.deep.equal({ ...live, maxRebalanceSlippageBps: 250 });
    expect(railsFor(live, 50, 300).maxRebalanceSlippageBps).to.equal(300);
    expect(railsFor(live, 100, "250")).to.deep.equal({ ...live, maxRebalanceSlippageBps: 250, maxRangeSpacings: 20 }); // the spacing rule still applies
    for (const bad of ["0", "301", "2.5", "abc", "-1"]) expect(() => railsFor(live, 50, bad), bad).to.throw(/MAX_REBALANCE_SLIPPAGE_BPS=.* 1 to 300/);
  });
  it("the mock CL pool answers fee() like the deployed one (uint24 pips), settable for the dry run", async () => {
    const factory = await (await ethers.getContractFactory("LaunchCLFactory")).deploy([50, 200]);
    const p = await (await ethers.getContractFactory("LaunchCLPool")).deploy(WETH, USDC, 50, factory.target);
    expect(await p.fee()).to.equal(0);
    await p.setFee(3000);
    expect(await p.fee()).to.equal(3000);
    has("CLPool", "function fee() view returns (uint24)");
  });
});

describe("Launch night: every call exists on Aero's DEPLOYED Base contracts", function () {
  it("step (a) reads", () => {
    ABI.factory.forEach((f) => has("CLFactory", f));
    ABI.pool.forEach((f) => has("CLPool", f));
    ABI.gauge.forEach((f) => has("CLGauge", f));
    ABI.voter.forEach((f) => has("LeafVoter", f));
    ABI.gaugeFactory.forEach((f) => has("CLGaugeFactory", f));
  });
  it("the upgrade's depositLiquid(uint256,address) is the verified Migration's, payable", () => {
    has("AerodromeMigration", "function depositLiquid(uint256,address) payable");
    // and, when the job folder's Sourcify file is next to this repo, against the full verified ABI with its names
    const src = path.join(__dirname, "..", "..", "facts", "sourcify", "migration.json");
    if (fs.existsSync(src)) {
      const abi = JSON.parse(fs.readFileSync(src, "utf8")).abi;
      const f = abi.find((x) => x.name === "depositLiquid");
      expect(f.inputs.map((i) => `${i.type} ${i.name}`)).to.deep.equal(["uint256 _amount", "address _recipient"]);
      expect(f.stateMutability).to.equal("payable");
      expect(up.DEPOSIT.inputs.map((i) => `${i.type} ${i.name}`)).to.deep.equal(["uint256 _amount", "address _recipient"]);
      const iface = new ethers.Interface(abi);
      const [, dep] = up.upgradeCalls(123n, up.SAFE);
      const d = iface.decodeFunctionData("depositLiquid", dep.data);
      expect(d._amount).to.equal(123n);
      expect(d._recipient).to.equal(up.SAFE);
    }
  });
});

describe("Launch night: step (a) against the mocks", function () {
  let m, A, env;
  const deploy = async (n, ...a) => (await ethers.getContractFactory(n)).deploy(...a);
  beforeEach(async () => {
    const aero = await deploy("MockAeroToken");
    const factory = await deploy("LaunchCLFactory", [1, 10, 50, 100, 200, 2000]);
    const nfpm = await deploy("MockAeroNfpm", factory.target);
    const voter = await deploy("LaunchLeafVoter", aero.target);
    const gfac = await deploy("LaunchGaugeFactory", nfpm.target);
    m = { aero, factory, nfpm, voter, gfac };
    A = { clFactory: factory.target, gaugeFactory: gfac.target, positionManager: nfpm.target, leafVoter: voter.target, aero: aero.target };
    env = {};
  });
  const pool = async (a, b, ts, liq = 0n) => {
    const p = await deploy("LaunchCLPool", a, b, ts, m.factory.target);
    await m.factory.addPool(a, b, ts, p.target);
    if (liq) await p.setLiquidity(liq);
    return p;
  };
  const gauge = async (p, ts, o = {}) => {
    const g = await deploy("MockAeroGauge", o.pool || p.target, o.nft || m.nfpm.target, o.voter || m.voter.target, m.gfac.target, ts, await p.token0(), await p.token1());
    await p.setGauge(g.target, m.nfpm.target);
    return g;
  };
  const ready = async () => {
    const p = await pool(WETH, USDC, 50);
    const g = await gauge(p, 50);
    await m.voter.setActivated(g.target, true);
    await m.gfac.setEmissionCap(g.target, 1000n);
    const aw = await pool(m.aero.target, WETH, 200, 10n ** 18n);
    const au = await pool(m.aero.target, USDC, 200, 10n ** 18n);
    return { p, g, aw, au };
  };

  it("waits through every launch stage, in order, and ignores other pairs' pools", async () => {
    const other = await deploy("MockERC20", "cbBTC", "cbBTC");
    await pool(WETH, other.target, 10, 5n); // Aero's early WETH/cbBTC CL10
    let r = await checkOnce(ethers.provider, A, env);
    expect(r.state).to.equal("waiting"); expect(r.reasons[0]).to.match(/no WETH\/USDC pool on Aero yet/);
    expect(r.notes[0]).to.match(/tick spacings enabled on Aero's CLFactory: 1, 10, 50, 100, 200, 2000/);
    const p = await pool(WETH, USDC, 50);
    r = await checkOnce(ethers.provider, A, env);
    expect(r.reasons[0]).to.match(/exists; its gauge is not created yet/);
    const g = await gauge(p, 50);
    r = await checkOnce(ethers.provider, A, env);
    expect(r.state).to.equal("waiting");
    expect(r.reasons[0]).to.match(/does not list the gauge as activated and the gauge's emission cap is 0/);
    await m.voter.setActivated(g.target, true);
    r = await checkOnce(ethers.provider, A, env);
    expect(r.reasons[0]).to.match(/emission cap is 0 \(it would earn nothing; waiting for Aero\)/);
    await m.gfac.setEmissionCap(g.target, 1n);
    r = await checkOnce(ethers.provider, A, env);
    expect(r.reasons[0]).to.match(/no AERO\/WETH pool on Aero yet/);
    const aw = await pool(m.aero.target, WETH, 200);
    r = await checkOnce(ethers.provider, A, env);
    expect(r.reasons[0]).to.match(/AERO\/WETH CL200 .* no liquidity yet/);
    await aw.setLiquidity(7n);
    r = await checkOnce(ethers.provider, A, env);
    expect(r.reasons[0]).to.match(/no AERO\/USDC pool on Aero yet/);
    const au = await pool(m.aero.target, USDC, 200, 9n);
    r = await checkOnce(ethers.provider, A, env);
    expect(r.state).to.equal("ready");
    expect(r.found).to.include({ wethUsdcPool: p.target, wethUsdcGauge: g.target, wethUsdcSpacing: 50, aeroWethPool: aw.target, aeroWethSpacing: 200,
      aeroUsdcPool: au.target, aeroUsdcSpacing: 200, gaugeActivated: true, emissionCap: "1", forced: false, aeroWethLiquidity: "7", aeroUsdcLiquidity: "9" });
    // token order is reported, whichever it is
    expect(r.found.aeroWethAeroIsToken0).to.equal(m.aero.target.toLowerCase() < WETH.toLowerCase());
  });

  it("FORCE_INACTIVE_GAUGE=1 (owner only) lets an unactivated, zero-cap gauge through, and says so", async () => {
    const { g } = await ready();
    await m.voter.setActivated(g.target, false);
    await m.gfac.setEmissionCap(g.target, 0n);
    expect((await checkOnce(ethers.provider, A, env)).state).to.equal("waiting");
    const r = await checkOnce(ethers.provider, A, { FORCE_INACTIVE_GAUGE: "1" });
    expect(r.state).to.equal("ready");
    expect(r.found.forced).to.equal(true);
    expect(r.notes.join("\n")).to.match(/FORCE_INACTIVE_GAUGE=1: going on although/);
  });

  it("several WETH/USDC pools: CL50 is used if it exists; without it, STOP listing all", async () => {
    await pool(WETH, USDC, 100);
    await pool(WETH, USDC, 10);
    let r = await checkOnce(ethers.provider, A, env);
    expect(r.state).to.equal("stop");
    expect(r.reasons[0]).to.match(/not at tick spacing 50\. Found: CL10 .*, CL100 /);
    const { p } = await ready();
    r = await checkOnce(ethers.provider, A, env);
    expect(r.state).to.equal("ready");
    expect(r.found.wethUsdcPool).to.equal(p.target);
    expect(r.notes.join("\n")).to.match(/CL50 chosen; also found CL10 .*CL100/);
  });

  it("contradictions STOP: a gauge on another position manager, a gauge of another pool, a pool with other tokens", async () => {
    const p = await pool(WETH, USDC, 50);
    await gauge(p, 50, { nft: A1 });
    let r = await checkOnce(ethers.provider, A, env);
    expect(r.state).to.equal("stop"); expect(r.reasons[0]).to.match(/gauge.nft\(\) is 0x1111.*not Aero's position manager/);
    await gauge(p, 50, { pool: A2 });
    r = await checkOnce(ethers.provider, A, env);
    expect(r.state).to.equal("stop"); expect(r.reasons[0]).to.match(/that gauge's pool\(\) is 0x2222/);
    const wrong = await deploy("LaunchCLPool", WETH, m.aero.target, 50, m.factory.target);
    await m.factory.setPool(WETH, USDC, 50, wrong.target);
    r = await checkOnce(ethers.provider, A, env);
    expect(r.state).to.equal("stop"); expect(r.reasons[0]).to.match(/holds .* not WETH\/USDC/);
  });

  it("a contract that does not answer like Aero's STOPS (revert), it does not wait forever", async () => {
    const r = await checkOnce(ethers.provider, { ...A, clFactory: m.nfpm.target }, env);
    expect(r.state).to.equal("stop");
    expect(r.reasons[0]).to.match(/CLFactory.tickSpacings\(\) reverted on chain/);
  });

  it("waitForAddresses polls until ready, and turns a stop into an error sentence", async () => {
    let n = 0;
    const r = await waitForAddresses(ethers.provider, A, { pollSeconds: 0, log: quiet, env, onPoll: async (i, res) => { n = i; if (i === 2) await ready(); } });
    expect(r.state).to.equal("ready");
    expect(n).to.equal(3);
    await pool(WETH, USDC, 100);
    await m.factory.setPool(WETH, USDC, 50, ethers.ZeroAddress);
    await expectReject(waitForAddresses(ethers.provider, A, { pollSeconds: 0, log: quiet, env }), /STOPPED at step \(a\): Aero's WETH\/USDC pool is not at tick spacing 50/);
  });
});

describe("Launch night: file writes", function () {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "launch-night-"));
  const found = { wethUsdcPool: A1, wethUsdcGauge: A2, aeroUsdcPool: A3, aeroWethPool: A4 };

  it("aero-base.json: the four slots written, every other key and its order kept; a re-run writes nothing", () => {
    const f = path.join(tmp(), "aero-base.json");
    // The committed file is filled since the launch; rebuild its pre-launch state (the four slots empty, no stamp).
    const launched = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "aero-base.json"), "utf8"));
    delete launched._launchNight;
    for (const k of AERO_SLOTS) launched[k] = null;
    const real = JSON.stringify(launched, null, 2) + "\n";
    fs.writeFileSync(f, real);
    const r = fillAeroFile(f, found, "stamp");
    expect(r.written).to.deep.equal(AERO_SLOTS);
    const after = JSON.parse(fs.readFileSync(f, "utf8"));
    const before = JSON.parse(real);
    expect(Object.keys(after)).to.deep.equal([...Object.keys(before), "_launchNight"]);
    for (const k of Object.keys(before)) if (!AERO_SLOTS.includes(k)) expect(after[k]).to.deep.equal(before[k]);
    expect(after).to.include({ wethUsdcPool: A1, wethUsdcGauge: A2, aeroUsdcPool: A3, aeroWethPool: A4, _launchNight: "stamp" });
    const text = fs.readFileSync(f, "utf8");
    expect(fillAeroFile(f, found, "other stamp")).to.deep.equal({ written: [], same: AERO_SLOTS });
    expect(fs.readFileSync(f, "utf8")).to.equal(text);
    // and the deploy script accepts the filled file
    expect(require("../scripts/deploy-aero-vault.js").loadAero(f).wethUsdcGauge).to.equal(A2);
  });

  it("aero-base.json: a slot holding another address is never overwritten (STOP, nothing written)", () => {
    const f = path.join(tmp(), "aero-base.json");
    fs.writeFileSync(f, JSON.stringify({ wethUsdcPool: A3, wethUsdcGauge: null, aeroUsdcPool: null, aeroWethPool: null }));
    const text = fs.readFileSync(f, "utf8");
    expect(() => fillAeroFile(f, found, "s")).to.throw(/STOPPED at step \(b\).*wethUsdcPool: the file says 0x3333.*the chain says 0x1111/);
    expect(fs.readFileSync(f, "utf8")).to.equal(text);
    expect(fs.readdirSync(path.dirname(f))).to.deep.equal(["aero-base.json"]);
  });

  it("the result file has every field the fill-ins and the keeper read, and refuses a batch of another vault", () => {
    const rec = { address: A1, deployBlock: 123, vaultLib: A2, topUpLib: A3, pool: A4, gauge: A2, tickSpacing: 50, aero: A3, keeper: A4, guardRails: {}, route: {} };
    const batch = { vault: A1, salt: "0x" + "ab".repeat(32), calls: [], schedule: {}, execute: {} };
    const r = buildResult({ network: "base", chainId: 8453n, rec, batch, found: { aeroWethPool: A3, aeroWethSpacing: 200, aeroUsdcPool: A4, aeroUsdcSpacing: 100 } });
    expect(r).to.include({ network: "base", chainId: 8453, vault: A1, startBlock: 123, vaultLib: A2, topUpLib: A3, pool: A4, gauge: A2, tickSpacing: 50,
      aeroWethPool: A3, aeroWethSpacing: 200, aeroUsdcPool: A4, aeroUsdcSpacing: 100, keeper: A4, salt: batch.salt });
    expect(r.batch).to.equal(batch);
    expect(() => buildResult({ network: "base", chainId: 8453, rec, batch: { ...batch, vault: A2 }, found: {} })).to.throw(/the batch is for/);
  });

  it("Safe Transaction Builder files: raw calldata and method forms", () => {
    const t = safeTxBuilder({ chainId: 8453, safe: up.SAFE.toLowerCase(), name: "n", description: "d", createdAt: 5,
      txs: [{ to: A1, value: "0", data: "0x1234" }, { to: A2, method: up.APPROVE, values: { spender: A3, amount: "7" } }] });
    expect(t).to.deep.include({ version: "1.0", chainId: "8453", createdAt: 5 });
    expect(t.meta.createdFromSafeAddress).to.equal(up.SAFE);
    expect(t.transactions[0]).to.deep.equal({ to: A1, value: "0", data: "0x1234", contractMethod: null, contractInputsValues: null });
    expect(t.transactions[1].data).to.equal(null);
    expect(t.transactions[1].contractMethod).to.deep.equal({ name: "approve", payable: false, inputs: [
      { internalType: "address", name: "spender", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }] });
  });
});

describe("Old AERO upgrade calldata (docs/safe-aero-upgrade.json)", function () {
  it("approve(Migration, amount) on old AERO, then depositLiquid(amount, recipient) on the Migration, value 0", () => {
    const [ap, dl] = up.upgradeCalls(10n ** 18n * 1234n, up.SAFE);
    expect(ap.to).to.equal("0x940181a94A35A4569E4529A3CDfB74e38FD98631");
    expect(dl.to).to.equal("0x22a2F7340a3fB4C7C389D91eE954766B12476721");
    expect(ap.data.slice(0, 10)).to.equal("0x095ea7b3"); // approve(address,uint256)
    expect(dl.data.slice(0, 10)).to.equal(ethers.id("depositLiquid(uint256,address)").slice(0, 10));
    const erc = new ethers.Interface(["function approve(address,uint256)"]);
    expect(erc.decodeFunctionData("approve", ap.data).map(String)).to.deep.equal([up.MIGRATION, String(10n ** 18n * 1234n)]);
    expect(ethers.AbiCoder.defaultAbiCoder().decode(["uint256", "address"], "0x" + dl.data.slice(10)).map(String)).to.deep.equal([String(10n ** 18n * 1234n), up.SAFE]);
    expect([ap.value, dl.value]).to.deep.equal(["0", "0"]);
    expect(() => up.upgradeCalls(0n, up.SAFE)).to.throw(/above 0/);
    expect(up.upgradeCalls(5n, up.COMPANY)[1].data.toLowerCase()).to.include(up.COMPANY.slice(2).toLowerCase());
  });

  it("the committed Safe file is exactly the generator's template; the builder's encoding of a filled file equals the calldata", () => {
    const committed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "docs", "safe-aero-upgrade.json"), "utf8"));
    expect(committed).to.deep.equal(up.safeFile(up.PLACEHOLDER, 0));
    expect(committed.transactions.map((t) => t.to)).to.deep.equal([up.OLD_AERO, up.MIGRATION]);
    expect(committed.transactions[1].contractInputsValues).to.deep.equal({ _amount: up.PLACEHOLDER, _recipient: up.SAFE });
    expect(committed.meta.createdFromSafeAddress).to.equal("0x9eb619B3aB33192080FfA846820117e2f00EE9bA");
    // what Transaction Builder encodes from a filled file (method + values) is the same calldata as upgradeCalls
    const filled = up.safeFile("777", 1);
    const calls = up.upgradeCalls(777n, up.SAFE);
    filled.transactions.forEach((t, i) => {
      const frag = ethers.FunctionFragment.from({ type: "function", name: t.contractMethod.name, inputs: t.contractMethod.inputs, outputs: [], stateMutability: t.contractMethod.payable ? "payable" : "nonpayable" });
      const data = new ethers.Interface([frag]).encodeFunctionData(frag.name, t.contractMethod.inputs.map((x) => t.contractInputsValues[x.name]));
      expect(data).to.equal(calls[i].data);
    });
  });

  it("the liquid upgrade opens at 2026-10-22 00:00 UTC: the next week boundary after MIGRATION_OPEN (verified source)", () => {
    const MIGRATION_OPEN = 1792620000, WEEK = 604800;
    expect(MIGRATION_OPEN % WEEK).to.equal(WEEK - 7200);
    expect(MIGRATION_OPEN - (MIGRATION_OPEN % WEEK) + WEEK).to.equal(up.LIQUID_OPEN);
    expect(new Date(up.LIQUID_OPEN * 1000).toISOString()).to.equal("2026-10-22T00:00:00.000Z");
  });
});

describe("Safety-wallet pause calldata (scripts/aero-pause-calldata.js)", function () {
  it("the four calls, from the compiled registry ABI, do exactly that on a real PandaRegistry (and only for the safety wallet)", async () => {
    const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "base.json"), "utf8"));
    const [owner, safety, keeper, treasury, rando] = await ethers.getSigners();
    const reg = await (await ethers.getContractFactory("PandaRegistry")).deploy(owner.address, { keeper: keeper.address, daoTreasury: treasury.address,
      safetyModule: safety.address, emergencyAdmin: owner.address, guardRails: dep.guardRails });
    const calls = pz.pauseCalls({ ...dep, registry: reg.target }, pz.registryAbi());
    expect(calls.map((c) => c.fn)).to.deep.equal(["setDepositsPaused(true)", "setRebalancesPaused(true)", "setDepositsPaused(false)", "setRebalancesPaused(false)"]);
    expect(calls[0].data).to.equal(new ethers.Interface(["function setDepositsPaused(bool)"]).encodeFunctionData("setDepositsPaused", [true]));
    await expectReject(rando.sendTransaction({ to: calls[0].to, data: calls[0].data }), /revert/i);
    await (await safety.sendTransaction({ to: calls[0].to, data: calls[0].data })).wait();
    await (await safety.sendTransaction({ to: calls[1].to, data: calls[1].data })).wait();
    expect([await reg.depositsPaused(), await reg.rebalancesPaused()]).to.deep.equal([true, true]);
    await (await safety.sendTransaction({ to: calls[2].to, data: calls[2].data })).wait();
    await (await safety.sendTransaction({ to: calls[3].to, data: calls[3].data })).wait();
    expect([await reg.depositsPaused(), await reg.rebalancesPaused()]).to.deep.equal([false, false]);
    const real = pz.pauseCalls(dep, pz.registryAbi());
    expect(real.every((c) => c.to === "0x52643dCDdd95944b01f10A4949d2923a0ff69FCC")).to.equal(true);
    const k = pz.commands(dep);
    expect(k.pause[0]).to.equal("WALLET=browser DEPLOYER=0x3e1fe6c4E81B9F59912B0b9074E71dd2F1A61919 WHAT=deposits ACTION=pause npx hardhat run scripts/pause.js --network base");
    expect(k.unpause[1]).to.match(/WHAT=rebalances ACTION=unpause/);
  });
});

async function expectReject(p, re) {
  try { await (await p).wait?.(); } catch (e) { expect(String(e.message)).to.match(re); return; }
  throw new Error(`expected a rejection matching ${re}`);
}
