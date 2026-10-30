// Launch day for Aero (Aerodrome + Velodrome merge, 2026-10-22): deploys the NEW PandaVault on Aero's WETH/USDC pool
// and gauge, with its two libraries, and prints the ONE Safe timelock batch that registers it and closes new deposits
// on the live Aerodrome vault. Nothing here touches the registry; the Safe signs the batch.
//
//   1. Fill every field of deployments/aero-base.json with Aero's published Base addresses.
//   2. Read-only checks first (no wallet, nothing sent):
//        PREFLIGHT_ONLY=1 npx hardhat run scripts/deploy-aero-vault.js --network base
//   3. Deploy with the owner's browser wallet (same page as every other Panda deploy, scripts/lib/wallet-signer.js):
//        WALLET=browser DEPLOYER=0x<owner wallet> npx hardhat run scripts/deploy-aero-vault.js --network base
//      Without WALLET=browser the first Hardhat signer deploys, on Hardhat's own chain only (a FORK=1 Base fork or the
//      local rehearsal, scripts/rehearse-aero-local.js); on Base the browser wallet is required.
//
// Options: KEEPER=0x... (default: the live vault's keeper in the registry), ROUTE=weth|usdc (compound route, default weth:
// AERO -> WETH in one hop, as the live vault), MAX_REBALANCE_SLIPPAGE_BPS=<1..300> (the batch's maxRebalanceSlippageBps
// rail instead of the live vault's 100: Aero charges 2% on the AERO/WETH CL200 pool and 1% on AERO/USDC CL100, so the
// auto-compound swap, floored at the route's TWAP minus this rail, needs a rail ABOVE the route pool's fee; the preflight
// STOPS when a route hop's fee is at or above the rail; docs/LAUNCH-NIGHT.md "Swap fees"), AERO_FILE=<path> (default deployments/aero-base.json), NETWORK=<name>
// (deployments/<name>.json, default base), VAULT_LIB=0x.. / TOPUP_LIB=0x.. (resume after a stop: reuse deployed
// libraries), RECORD=0 (do not write the deployments file; the fork rehearsal), BATCH_OUT=<path> (where the batch JSON
// goes, default deployments/aero-vault-batch-<network>.json).
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { walletSigner, say, assertCreated, closeWallet } = require("./lib/wallet-signer");

const LIVE_VAULT = "0x61986AFae9B07314d855E7C54949E30A866c93a8";
const OLD_AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const LIVE_SPACING = 50; // the live vault's pool (Aerodrome CL50): the guard rails are written for it
const REGISTRY_MAX_SLIPPAGE_BPS = 300; // PandaRegistry.MAX_REBALANCE_SLIPPAGE_BPS: a rail above it is refused on chain
const pct = (pips) => (pips === undefined ? "unreadable" : `${Number(pips) / 1e4}%`);
const FIELDS = ["clFactory", "gaugeFactory", "wethUsdcPool", "wethUsdcGauge", "positionManager", "swapRouter", "leafVoter", "aero", "aeroUsdcPool", "aeroWethPool"];
let SIGNER = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
// Same rule as the other deploy scripts: retry reads only on transient RPC trouble, never on a real revert.
const TRANSIENT = /could not decode result data|rate limit|too many requests|\b429\b|\b50[234]\b|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|header not found|missing trie node|unknown block/i;
async function readBack(fn, label, tries = 30) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const transient = e && e.code !== "CALL_EXCEPTION" && !/execution reverted/i.test(String(e.message)) &&
        ((e.code === "BAD_DATA" && (e.value === "0x" || e.value === undefined)) || ["TIMEOUT", "NETWORK_ERROR", "SERVER_ERROR"].includes(e.code) || TRANSIENT.test(String(e.message)));
      if (!transient || i >= tries) { if (e && typeof e === "object") e.message = `${label}: ${e.message}`; throw e; }
      await sleep(1500);
    }
  }
}
const tryRead = async (fn) => { try { return await fn(); } catch (e) { return undefined; } };

function loadAero(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const missing = FIELDS.filter((f) => raw[f] === null || raw[f] === undefined || raw[f] === "");
  if (missing.length) {
    throw new Error(`${path.relative(process.cwd(), file)}: these Aero addresses are not filled in yet: ${missing.join(", ")}. ` +
      "Aero publishes them on launch day; fill every field (see the '_' line under each) and run again. Nothing was checked or sent.");
  }
  const out = {};
  for (const f of FIELDS) {
    if (!ethers.isAddress(raw[f])) throw new Error(`${f} is not an address: ${raw[f]}`);
    out[f] = ethers.getAddress(raw[f]);
  }
  return out;
}

/**
 * Rails are counted in tick spacings: the same PRICE width on a pool of another spacing needs another count.
 * `slippageOverride` (MAX_REBALANCE_SLIPPAGE_BPS) replaces maxRebalanceSlippageBps: the owner's decision for Aero's swap
 * fees (the compound floor is the route's TWAP minus this rail); 1..300, the registry's own bound.
 */
function railsFor(live, spacing, slippageOverride) {
  const r = { ...live };
  if (spacing !== LIVE_SPACING) {
    // Round DOWN so a range can never be wider than today's; at least 1, at most the registry's cap of 1000.
    r.maxRangeSpacings = Math.min(1000, Math.max(1, Math.floor((live.maxRangeSpacings * LIVE_SPACING) / spacing)));
  }
  if (slippageOverride !== undefined && slippageOverride !== null && slippageOverride !== "") {
    const v = Number(slippageOverride);
    if (!Number.isInteger(v) || v < 1 || v > REGISTRY_MAX_SLIPPAGE_BPS) throw new Error(`MAX_REBALANCE_SLIPPAGE_BPS=${slippageOverride} is not a whole number of basis points from 1 to ${REGISTRY_MAX_SLIPPAGE_BPS} (the registry refuses more than 3%)`);
    r.maxRebalanceSlippageBps = v;
  }
  return r;
}

/**
 * Why auto-compound can never run when a compound route pool's fee is at or above the rail: the compound swap is
 * floored at the route's TWAP minus maxRebalanceSlippageBps, and the pool pays TWAP minus its fee minus price impact,
 * so the floor is never met and PandaVaultLib.tryCompound skips silently every time (the AERO stays in the position's
 * reserve, nothing is lost, nothing compounds). Returns the plain sentence, or null when the rail is above the fee. Pure.
 */
function routeFeeProblem(label, feePips, railBps) {
  if (feePips === undefined || feePips === null) return `${label}: its swap fee (pool.fee()) cannot be read, so it is not known whether auto-compound can run`;
  const feeBps = Number(feePips) / 100;
  if (feeBps < Number(railBps)) return null;
  return `the compound route pool ${label} charges ${pct(feePips)} per swap right now, at or above the rail maxRebalanceSlippageBps ${railBps} (${Number(railBps) / 100}%): ` +
    "the auto-compound swap could never clear its floor (the route's TWAP minus the rail), so auto-compound would never happen. " +
    `Decide the rail before deploying: MAX_REBALANCE_SLIPPAGE_BPS=<bps above the fee, at most ${REGISTRY_MAX_SLIPPAGE_BPS} = 3%> (the fee plus room for price impact), ` +
    "or ROUTE=usdc on a cheaper pool with a rail above ITS fee, or accept no auto-compound for now (docs/LAUNCH-NIGHT.md, \"Swap fees\"). Nothing was deployed.";
}

async function preflight(A, dep, opts) {
  const p = ethers.provider;
  const problems = [];
  const warn = [];
  const need = (ok, msg) => { if (!ok) problems.push(msg); };
  const at = (addr, abi) => new ethers.Contract(addr, abi, p);

  const { chainId } = await p.getNetwork();
  console.log(`chain ${chainId}${opts.fork ? " (fork rehearsal)" : ""}`);
  if (!opts.fork) need(Number(chainId) === 8453, `this is chain ${chainId}, not Base (8453)`);
  for (const f of FIELDS) need((await readBack(() => p.getCode(A[f]), `code ${f}`)) !== "0x", `${f} ${A[f]} has no contract code`);
  if (problems.length) return { problems, warn };

  const POOL = ["function token0() view returns (address)", "function token1() view returns (address)", "function tickSpacing() view returns (int24)",
    "function factory() view returns (address)", "function gauge() view returns (address)", "function nft() view returns (address)",
    "function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)", "function observe(uint32[]) view returns (int56[],uint160[])",
    "function fee() view returns (uint24)"];
  const pool = at(A.wethUsdcPool, POOL);
  const gauge = at(A.wethUsdcGauge, ["function pool() view returns (address)", "function nft() view returns (address)", "function tickSpacing() view returns (int24)",
    "function gaugeFactory() view returns (address)", "function voter() view returns (address)", "function deferredEmissions(address) view returns (uint256)"]);
  const factory = at(A.clFactory, ["function getPool(address,address,int24) view returns (address)"]);
  const nfpm = at(A.positionManager, ["function factory() view returns (address)"]);
  const router = at(A.swapRouter, ["function factory() view returns (address)"]);
  const gf = at(A.gaugeFactory, ["function effectivePenaltyConfig(address) view returns (uint256,uint256)", "function isGauge(address) view returns (bool)", "function nft() view returns (address)", "function emissionCap(address) view returns (uint128)"]);
  const voter = at(A.leafVoter, ["function isActivated(address) view returns (bool)"]);
  const aero = at(A.aero, ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function MINTER() view returns (address)", "function MIGRATION() view returns (address)"]);

  // 1. Pool: the pair, its token order and spacing; one factory for pool, position manager and router.
  const [t0, t1, ts, pf, pg] = await Promise.all([pool.token0(), pool.token1(), pool.tickSpacing(), pool.factory(), pool.gauge()]);
  need((eq(t0, WETH) && eq(t1, USDC)) || (eq(t0, USDC) && eq(t1, WETH)), `pool tokens ${t0} / ${t1} are not WETH / USDC`);
  const spacing = Number(ts);
  // Swap fees are Aero's, not Aerodrome's (CL50 0.3%, CL100 1%, CL200 2% on 2026-10-21) and the fee manager can change
  // them: every pool's fee() is read here and printed, never assumed.
  const fees = { pool: await tryRead(() => pool.fee()) };
  console.log(`pool ${A.wethUsdcPool}: token0 ${eq(t0, WETH) ? "WETH" : "USDC"}, token1 ${eq(t1, WETH) ? "WETH" : "USDC"}, tickSpacing ${spacing}, swap fee ${pct(fees.pool)} right now (pool.fee())`);
  need(eq(pf, A.clFactory), `pool.factory() ${pf} is not clFactory`);
  need(eq(await factory.getPool(WETH, USDC, spacing), A.wethUsdcPool), "clFactory.getPool(WETH, USDC, spacing) is not this pool");
  need(eq(await nfpm.factory(), A.clFactory), "positionManager.factory() is not clFactory");
  need(eq(await router.factory(), A.clFactory), "swapRouter.factory() is not clFactory");
  const pnft = await tryRead(() => pool.nft());
  if (pnft !== undefined) need(eq(pnft, A.positionManager), `pool.nft() ${pnft} is not positionManager`);

  // 2. Pool <-> gauge <-> position manager <-> voter <-> gauge factory.
  need(eq(pg, A.wethUsdcGauge), `pool.gauge() ${pg} is not wethUsdcGauge`);
  const [gp, gn, gts, ggf, gv] = await Promise.all([gauge.pool(), gauge.nft(), gauge.tickSpacing(), gauge.gaugeFactory(), gauge.voter()]);
  need(eq(gp, A.wethUsdcPool), "gauge.pool() is not the pool");
  need(eq(gn, A.positionManager), "gauge.nft() is not positionManager");
  need(Number(gts) === spacing, `gauge.tickSpacing() ${gts} != pool ${spacing}`);
  need(eq(ggf, A.gaugeFactory), `gauge.gaugeFactory() ${ggf} is not gaugeFactory`);
  need(eq(gv, A.leafVoter), `gauge.voter() ${gv} is not leafVoter`);
  const isGauge = await tryRead(() => gf.isGauge(A.wethUsdcGauge));
  if (isGauge !== undefined) need(isGauge, "gaugeFactory.isGauge(gauge) is false");
  const gfNft = await tryRead(() => gf.nft());
  if (gfNft !== undefined) need(eq(gfNft, A.positionManager), "gaugeFactory.nft() is not positionManager");
  const active = await tryRead(() => voter.isActivated(A.wethUsdcGauge));
  console.log(`gauge ${A.wethUsdcGauge}: voter ${gv}, activated ${active === undefined ? "unknown" : active}`);
  if (active === false) warn.push("the LeafVoter reports the gauge as NOT activated: it earns nothing until Aero activates it");
  await readBack(() => gauge.deferredEmissions(ethers.ZeroAddress), "gauge.deferredEmissions (Aero gauge shape)");

  // 3. Reward token: the new AERO (Aero's gauge has no rewardToken(); it pays through the voter).
  need(!eq(A.aero, OLD_AERO), "aero is the OLD Aerodrome AERO; the vault needs Aero's new token");
  need(!eq(A.aero, WETH) && !eq(A.aero, USDC), "aero cannot be one side of the pair");
  const sym = await tryRead(() => aero.symbol());
  // The DEPLOYED new AERO (0x3f5b...a4Ee) has no transfer lock (checked 2026-10-20): a plain token the vault can pay out
  // at once. Its MIGRATION() is Aero's AerodromeMigration (old AERO -> new, 1:1), a cheap identity check.
  const migration = await tryRead(() => aero.MIGRATION());
  console.log(`AERO ${A.aero}: symbol ${sym}, decimals ${await tryRead(() => aero.decimals())}, minter ${await tryRead(() => aero.MINTER())}, migration ${migration}`);
  if (migration !== undefined) need(eq(migration, "0x22a2F7340a3fB4C7C389D91eE954766B12476721"), `aero.MIGRATION() ${migration} is not Aero's AerodromeMigration`);
  const emissionCap = await tryRead(() => gf.emissionCap(A.wethUsdcGauge));
  if (emissionCap !== undefined && emissionCap === 0n) warn.push("the gauge's emission cap is 0: it earns nothing until Aero's cap admin sets one");
  // Aero's Minter only starts minting at its activation time (one week after launch per the public source); until then
  // a claim can only be paid from the chain buffer Aero funds on its root Voter. Without either, claims revert (exits
  // still work: the gauge stores the emissions, the vault books them per position).
  const minterAddr = await tryRead(() => aero.MINTER());
  if (minterAddr) {
    const minter = at(minterAddr, ["function ACTIVATION_TIMESTAMP() view returns (uint48)", "function VOTER() view returns (address)"]);
    const activation = await tryRead(() => minter.ACTIVATION_TIMESTAMP());
    const rootVoter = await tryRead(() => minter.VOTER());
    const buffer = rootVoter ? await tryRead(() => at(rootVoter, ["function donatedBuffer(uint256) view returns (uint256)"]).donatedBuffer(8453)) : undefined;
    const now = (await p.getBlock("latest")).timestamp;
    console.log(`Minter ${minterAddr}: activates ${activation === undefined ? "unknown" : new Date(Number(activation) * 1000).toISOString()}; root Voter ${rootVoter}; Base chain buffer ${buffer === undefined ? "unknown" : ethers.formatEther(buffer) + " AERO"}`);
    if (activation !== undefined && Number(activation) > now && (buffer === undefined || buffer === 0n)) {
      warn.push(`Aero's Minter is not active until ${new Date(Number(activation) * 1000).toISOString()} and Base's chain buffer is empty: claims revert until then (withdrawals work; their emissions are booked per position and collected with claimDeferred later)`);
    }
  }

  // 4. Compound route pools: both exist in the same factory and hold the new AERO.
  const route = opts.route === "usdc" ? { pool: A.aeroUsdcPool, out: USDC } : { pool: A.aeroWethPool, out: WETH };
  const routeSpacings = {};
  for (const [name, addr, other] of [["aeroWethPool", A.aeroWethPool, WETH], ["aeroUsdcPool", A.aeroUsdcPool, USDC]]) {
    const rp = at(addr, POOL);
    const [a, b, s, f] = await Promise.all([rp.token0(), rp.token1(), rp.tickSpacing(), rp.factory()]);
    need((eq(a, A.aero) && eq(b, other)) || (eq(b, A.aero) && eq(a, other)), `${name} ${addr} is not AERO / ${eq(other, WETH) ? "WETH" : "USDC"}`);
    need(eq(f, A.clFactory), `${name}.factory() is not clFactory`);
    need(eq(await factory.getPool(A.aero, other, s), addr), `clFactory.getPool for ${name} is not ${addr}`);
    routeSpacings[name] = Number(s);
    fees[name] = await tryRead(() => rp.fee());
    console.log(`${name} ${addr}: tickSpacing ${s}, swap fee ${pct(fees[name])} right now (pool.fee())${eq(addr, route.pool) ? " <- the compound route" : ""}`);
  }

  // 5. The early-unstake penalty window.
  const pen = await tryRead(() => gf.effectivePenaltyConfig(A.wethUsdcGauge));
  if (pen === undefined) problems.push("gaugeFactory.effectivePenaltyConfig(gauge) cannot be read");
  else {
    const [blocks, rate] = pen.map(Number);
    console.log(`early-unstake window: ${blocks} blocks, ${rate / 1e4}% of a position's emissions forfeited inside it ` +
      `(about ${blocks * 2} s at today's 2 s blocks, ${(blocks * 0.2).toFixed(1)} s at 200 ms). The keeper's rebalance and top-ups wait it out; claims skip it.`);
    if (blocks > 1000) warn.push(`the window is ${blocks} blocks: new positions cannot be rebalanced for that long`);
  }

  // 6. Live platform: registry, timelock, the live vault.
  const reg = at(dep.registry, ["function owner() view returns (address)", "function isVault(address) view returns (bool)", "function keeperOf(address) view returns (address)",
    "function guardRailsOf(address) view returns ((uint16,uint32,uint32,uint24,uint24))", "function vaultDepositsOpen(address) view returns (bool)",
    "function depositsPaused() view returns (bool)", "function rebalancesPaused() view returns (bool)", "function safetyModule() view returns (address)",
    "function feePolicy() view returns (address)"]);
  need(eq(await reg.owner(), dep.timelock), "registry owner is not the timelock in the deployments file");
  need(await reg.isVault(LIVE_VAULT), "the live vault is not registered (wrong registry?)");
  const tl = at(dep.timelock, ["function getMinDelay() view returns (uint256)"]);
  const delay = Number(await tl.getMinDelay());
  need(delay === Number(dep.timelockDelay), `timelock delay ${delay} != deployments file ${dep.timelockDelay}`);
  const g = await reg.guardRailsOf(LIVE_VAULT);
  const liveRails = { maxRebalanceSlippageBps: Number(g[0]), twapWindow: Number(g[1]), minRebalanceInterval: Number(g[2]), maxRangeSpacings: Number(g[3]), maxTwapDeviationTicks: Number(g[4]) };
  const rails = railsFor(liveRails, spacing, opts.slippageOverride);
  const keeper = opts.keeper || (await reg.keeperOf(LIVE_VAULT));
  console.log(`registry ${dep.registry}: fee policy ${await reg.feePolicy()}, deposits paused ${await reg.depositsPaused()}, rebalances paused ${await reg.rebalancesPaused()}, safety module ${await reg.safetyModule()}`);
  console.log(`live vault ${LIVE_VAULT}: deposits open ${await reg.vaultDepositsOpen(LIVE_VAULT)}, keeper ${await reg.keeperOf(LIVE_VAULT)}, rails ${JSON.stringify(liveRails)}`);
  if (spacing !== LIVE_SPACING) {
    console.log(`GUARD RAILS RE-EXPRESSED: Aero's pool has tick spacing ${spacing}, the live pool ${LIVE_SPACING}. maxRangeSpacings ${liveRails.maxRangeSpacings} x ${LIVE_SPACING} = ${liveRails.maxRangeSpacings * LIVE_SPACING} ticks ` +
      `-> ${rails.maxRangeSpacings} x ${spacing} = ${rails.maxRangeSpacings * spacing} ticks (rounded down, never wider). The other rails are in bps, seconds or ticks and stay as they are.`);
  } else console.log(`guard rails: same tick spacing (${spacing}) as the live pool, the live vault's rails carry over unchanged`);
  if (rails.maxRebalanceSlippageBps !== liveRails.maxRebalanceSlippageBps) {
    console.log(`RAIL OVERRIDE (MAX_REBALANCE_SLIPPAGE_BPS): maxRebalanceSlippageBps ${liveRails.maxRebalanceSlippageBps} (live vault) -> ${rails.maxRebalanceSlippageBps} in this vault's batch. ` +
      "It is the floor of BOTH the auto-compound swap (route TWAP minus rail) and the keeper's rebalance swap (pool TWAP minus rail; the keeper also sends its own minimum, 40 bps under its quote).");
  }
  // The compound route's pool fee against the rail: at or above it, auto-compound could never run (plain sentence, STOP).
  const routeName = opts.route === "usdc" ? "aeroUsdcPool" : "aeroWethPool";
  const routeLabel = `${opts.route === "usdc" ? "AERO/USDC" : "AERO/WETH"} CL${routeSpacings[routeName]} ${route.pool}`;
  const feeProblem = routeFeeProblem(routeLabel, fees[routeName], rails.maxRebalanceSlippageBps);
  if (feeProblem) problems.push(feeProblem);
  else console.log(`auto-compound: the route pool charges ${pct(fees[routeName])}, the rail is ${rails.maxRebalanceSlippageBps / 100}%: a compound clears when price impact stays under ${(rails.maxRebalanceSlippageBps / 100 - Number(fees[routeName]) / 1e4).toFixed(2)}%`);
  if (fees.pool !== undefined && Number(fees.pool) / 100 >= rails.maxRebalanceSlippageBps) warn.push(`the vault's own pool charges ${pct(fees.pool)}, at or above the rail: the keeper's rebalance swaps could never clear the vault's floor`);

  // 7. TWAP history: the keeper's rebalance needs the pool's TWAP over the rails' window (warn only).
  for (const [name, addr] of [["WETH/USDC pool", A.wethUsdcPool], ["compound route pool", route.pool]]) {
    const ok = await tryRead(() => at(addr, POOL).observe([rails.twapWindow, 0]));
    const card = (await tryRead(() => at(addr, POOL).slot0())) || [];
    if (ok === undefined) warn.push(`${name} ${addr}: its TWAP over ${rails.twapWindow} s cannot be read yet (cardinality ${card[3]}); rebalances and compounding wait until it can. Raise it with increaseObservationCardinalityNext(${rails.twapWindow + 300}) if it stays low`);
  }
  return { problems, warn, spacing, rails, keeper: ethers.getAddress(keeper), route, routeSpacing: routeSpacings[opts.route === "usdc" ? "aeroUsdcPool" : "aeroWethPool"], delay, fees };
}

async function main() {
  const net = process.env.NETWORK || "base";
  // Hardhat's own chain (a Base fork with FORK=1, or the local rehearsal): a Hardhat signer may deploy.
  const fork = Number((await ethers.provider.getNetwork()).chainId) === 31337;
  const depPath = path.join(__dirname, "..", "deployments", `${net}.json`);
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const aeroFile = process.env.AERO_FILE ? path.resolve(process.env.AERO_FILE) : path.join(__dirname, "..", "deployments", "aero-base.json");
  const A = loadAero(aeroFile);
  const live = (dep.vaults || []).find((v) => eq(v.address, LIVE_VAULT));
  if (!live) throw new Error(`the live vault ${LIVE_VAULT} is not in ${depPath}`);
  const opts = { fork, route: process.env.ROUTE === "usdc" ? "usdc" : "weth", keeper: process.env.KEEPER ? ethers.getAddress(process.env.KEEPER) : null, slippageOverride: process.env.MAX_REBALANCE_SLIPPAGE_BPS };

  console.log("=== Preflight (read-only) ===");
  const pf = await preflight(A, dep, opts);
  for (const w of pf.warn) console.log(`WARNING: ${w}`);
  if (pf.problems.length) throw new Error(`preflight failed, nothing deployed:\n - ${pf.problems.join("\n - ")}`);
  const routeTokens = [A.aero, pf.route.out];
  const routeSpacings = [pf.routeSpacing];

  // The vault constructor's own checks, run as a read-only call (no library is called in the constructor, so any
  // library address will do for this simulation).
  const probe = await ethers.getContractFactory("PandaVault", { libraries: { PandaVaultLib: dep.vaultLib, PandaTopUpLib: dep.topUpLib } });
  const ctorArgs = [dep.registry, A.positionManager, A.wethUsdcGauge, A.swapRouter, A.aero, WETH, USDC, routeTokens, routeSpacings];
  const probeTx = await probe.getDeployTransaction(...ctorArgs);
  await readBack(() => ethers.provider.call({ data: probeTx.data }), "vault constructor (simulated)");
  console.log(`vault constructor checks pass (simulated). Compound route: AERO -> ${opts.route === "usdc" ? "USDC" : "WETH"} (spacing ${routeSpacings[0]})`);
  console.log(`keeper ${pf.keeper} | rails ${JSON.stringify(pf.rails)}`);
  console.log("PREFLIGHT OK");
  if (process.env.PREFLIGHT_ONLY === "1") return;

  console.log("\n=== Deploy ===");
  const browser = process.env.WALLET === "browser";
  const DEPLOYER = browser ? ethers.getAddress(process.env.DEPLOYER || "") : ((await ethers.getSigners())[0] || {}).address;
  if (!DEPLOYER) throw new Error("no deployer: WALLET=browser with DEPLOYER=0x<your wallet> (or a Hardhat signer on a fork)");
  if (!fork && !browser) throw new Error("on Base the vault is created by the owner's browser wallet: set WALLET=browser DEPLOYER=0x...");
  const nonce = await readBack(() => ethers.provider.getTransactionCount(DEPLOYER, "pending"), "deployer nonce");
  const names = [...(process.env.VAULT_LIB ? [] : ["PandaVaultLib"]), ...(process.env.TOPUP_LIB ? [] : ["PandaTopUpLib"]), "PandaVault"];
  console.log(`deployer ${DEPLOYER} (${browser ? "your browser wallet" : "Hardhat signer"}) | balance ${ethers.formatEther(await ethers.provider.getBalance(DEPLOYER))} ETH | transactions to approve: ${names.length}`);
  names.forEach((n, i) => console.log(`  ${n.padEnd(14)} will be ${ethers.getCreateAddress({ from: DEPLOYER, nonce: nonce + i })}`));
  const deployer = browser
    ? await walletSigner(ethers.provider, { expected: DEPLOYER, port: Number(process.env.WALLET_PORT || 8790), title: `Panda Aero vault deploy · ${net}` })
    : (await ethers.getSigners())[0];
  SIGNER = deployer;

  let vaultLib, topUpLib;
  if (process.env.VAULT_LIB) vaultLib = await ethers.getContractAt("PandaVaultLib", ethers.getAddress(process.env.VAULT_LIB));
  else {
    say(deployer, "Create PandaVaultLib (Aero version; the vault's fee, swap and gauge helpers; no owner, no state)");
    vaultLib = await (await ethers.getContractFactory("PandaVaultLib", deployer)).deploy();
    await vaultLib.waitForDeployment();
    await assertCreated(vaultLib, "PandaVaultLib");
  }
  console.log(`PandaVaultLib ${vaultLib.target} | resume with VAULT_LIB=${vaultLib.target}`);
  if (process.env.TOPUP_LIB) topUpLib = await ethers.getContractAt("PandaTopUpLib", ethers.getAddress(process.env.TOPUP_LIB));
  else {
    say(deployer, "Create PandaTopUpLib (Aero version; linked to the PandaVaultLib above)");
    topUpLib = await (await ethers.getContractFactory("PandaTopUpLib", { signer: deployer, libraries: { PandaVaultLib: vaultLib.target } })).deploy();
    await topUpLib.waitForDeployment();
    await assertCreated(topUpLib, "PandaTopUpLib");
  }
  console.log(`PandaTopUpLib ${topUpLib.target} | resume with VAULT_LIB=${vaultLib.target} TOPUP_LIB=${topUpLib.target}`);
  for (const [n, c] of [["PandaVaultLib", vaultLib], ["PandaTopUpLib", topUpLib]]) {
    if ((await readBack(() => ethers.provider.getCode(c.target), n)) === "0x") throw new Error(`${n} ${c.target} has no code; stop`);
  }

  say(deployer, "Create PandaVault (Aero WETH/USDC; registered later by the Safe through the timelock)");
  const Vault = await ethers.getContractFactory("PandaVault", { signer: deployer, libraries: { PandaVaultLib: vaultLib.target, PandaTopUpLib: topUpLib.target } });
  const vault = await Vault.deploy(...ctorArgs);
  await vault.waitForDeployment();
  await assertCreated(vault, "PandaVault");
  const block = (await vault.deploymentTransaction().wait()).blockNumber;
  const v = await ethers.getContractAt("PandaVault", vault.target);
  const checks = [
    ["registry", await readBack(() => v.registry(), "vault.registry"), dep.registry], ["gauge", await v.gauge(), A.wethUsdcGauge],
    ["pool", await v.pool(), A.wethUsdcPool], ["positionManager", await v.positionManager(), A.positionManager],
    ["swapRouter", await v.swapRouter(), A.swapRouter], ["aeroToken", await v.aeroToken(), A.aero], ["tokenA", await v.tokenA(), WETH], ["tokenB", await v.tokenB(), USDC],
  ];
  for (const [n, got, want] of checks) if (!eq(got, want)) throw new Error(`vault.${n}() is ${got}, expected ${want}; stop`);
  const [, , routePools] = await v.compoundRoute();
  console.log(`PandaVault ${vault.target} block ${block} | pool ${A.wethUsdcPool} spacing ${await v.tickSpacing()} | route ${routePools.join(" > ")}`);

  // The ONE Safe -> timelock batch.
  const regI = new ethers.Interface([
    "function addVault(address)", "function setVaultKeeper(address,address)",
    "function setVaultGuardRails(address,(uint16,uint32,uint32,uint24,uint24))", "function setVaultDepositsOpen(address,bool)",
    "function setDepositsPaused(bool)", "function setRebalancesPaused(bool)",
  ]);
  const r = pf.rails;
  const calls = [
    { what: `addVault(${vault.target})`, data: regI.encodeFunctionData("addVault", [vault.target]) },
    { what: `setVaultKeeper(${vault.target}, ${pf.keeper})`, data: regI.encodeFunctionData("setVaultKeeper", [vault.target, pf.keeper]) },
    { what: `setVaultGuardRails(${vault.target}, ${JSON.stringify(r)})`, data: regI.encodeFunctionData("setVaultGuardRails", [vault.target, [r.maxRebalanceSlippageBps, r.twapWindow, r.minRebalanceInterval, r.maxRangeSpacings, r.maxTwapDeviationTicks]]) },
    { what: `setVaultDepositsOpen(${LIVE_VAULT}, false)`, data: regI.encodeFunctionData("setVaultDepositsOpen", [LIVE_VAULT, false]) },
  ];
  const tl = new ethers.Interface(["function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)", "function executeBatch(address[],uint256[],bytes[],bytes32,bytes32)"]);
  const salt = ethers.id(`panda-aero-vault-${vault.target}`);
  const args = [calls.map(() => dep.registry), calls.map(() => 0), calls.map((c) => c.data), ethers.ZeroHash, salt];
  const schedule = tl.encodeFunctionData("scheduleBatch", [...args, pf.delay]);
  const execute = tl.encodeFunctionData("executeBatch", args);
  console.log(`\nOne timelock batch on registry ${dep.registry}, salt ${salt}:`);
  calls.forEach((c, i) => console.log(`  ${i + 1}. ${c.what}`));
  console.log(`\nSafe transaction 1 (now), to ${dep.timelock}:\n  ${schedule}`);
  console.log(`Safe transaction 2 (after ${pf.delay / 3600} h), to ${dep.timelock}:\n  ${execute}`);
  const unpause = [
    { what: "setDepositsPaused(false)", data: regI.encodeFunctionData("setDepositsPaused", [false]) },
    { what: "setRebalancesPaused(false)", data: regI.encodeFunctionData("setRebalancesPaused", [false]) },
  ];
  console.log(`\nAfter the batch has executed, the safety module (${dep.safetyModule}) lifts the two global pauses, to ${dep.registry}:`);
  unpause.forEach((c) => console.log(`  ${c.what}: ${c.data}`));
  console.log("  (or: WALLET=browser DEPLOYER=<safety wallet> WHAT=deposits ACTION=unpause npx hardhat run scripts/pause.js --network base, then WHAT=rebalances)");

  const batch = {
    network: net, createdAt: new Date().toISOString(), vault: vault.target, registry: dep.registry, timelock: dep.timelock, delaySeconds: pf.delay, salt,
    calls: calls.map((c) => ({ to: dep.registry, value: "0", what: c.what, data: c.data })),
    schedule: { to: dep.timelock, value: "0", data: schedule }, execute: { to: dep.timelock, value: "0", data: execute },
    afterExecute: { by: dep.safetyModule, calls: unpause.map((c) => ({ to: dep.registry, value: "0", what: c.what, data: c.data })) },
  };
  const batchOut = process.env.BATCH_OUT ? path.resolve(process.env.BATCH_OUT) : path.join(__dirname, "..", "deployments", `aero-vault-batch-${net}.json`);
  fs.writeFileSync(batchOut, JSON.stringify(batch, null, 2) + "\n");
  console.log(`\nbatch written to ${path.relative(process.cwd(), batchOut)}`);
  console.log(`Keeper for this vault: VAULT_ADDRESS=${vault.target} START_BLOCK=${block}`);

  if (process.env.RECORD !== "0") {
    const record = { ...dep, aeroVault: {
      key: "weth-usdc-aero", address: vault.target, deployBlock: block, vaultLib: vaultLib.target, topUpLib: topUpLib.target, pool: A.wethUsdcPool,
      gauge: A.wethUsdcGauge, keeper: pf.keeper, tokenA: WETH, tokenB: USDC, aero: A.aero, tickSpacing: pf.spacing,
      route: { tokens: routeTokens, spacings: routeSpacings }, routePools, guardRails: pf.rails, batchSalt: salt,
      aeroAddresses: A, deployedAt: new Date().toISOString(), registered: false,
    } };
    fs.writeFileSync(depPath, JSON.stringify(record, null, 2) + "\n");
    console.log(`recorded in ${path.relative(process.cwd(), depPath)} under "aeroVault" (registered: false until the batch executes)`);
  }
  await closeWallet(deployer, "Aero vault deployed and checked. Next: the Safe schedules the batch printed in the terminal; execute it after 48 hours.");
  return { vault: vault.target, vaultLib: vaultLib.target, topUpLib: topUpLib.target, batch };
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error(e);
    await closeWallet(SIGNER, `Stopped: ${String(e && e.message || e).slice(0, 300)}`).catch(() => {});
    process.exit(1);
  });
}
module.exports = { main, railsFor, loadAero, routeFeeProblem, REGISTRY_MAX_SLIPPAGE_BPS };
