// Launch night, step (a): read the four addresses Aero creates at launch from the chain, read-only, and say whether
// they are ready for the vault: the WETH/USDC CL pool, its gauge, the AERO/WETH and AERO/USDC CL pools.
//
//   npx hardhat run scripts/launch-night-addresses.js --network base     (one look, prints what it sees, sends nothing)
//
// scripts/launch-night.js uses waitForAddresses() from here and keeps polling until everything is ready.
//
// Rules (owner 2026-10-20, after Aero created a WETH/cbBTC CL10 pool and its gauge BEFORE launch):
//  - Tick spacings are read from CLFactory.tickSpacings(), never guessed (CL10 exists and is not in the docs' list).
//  - WETH/USDC: if a CL50 pool exists it is the one (others are listed). If there is none at 50, every pool found is
//    listed and the run STOPS for the owner, who picks one with WETH_USDC_SPACING=<n>.
//  - AERO/WETH and AERO/USDC: the CL200 pool if it exists (the live vault's route spacing); otherwise the same rule:
//    list them and stop; the owner picks with AERO_WETH_SPACING=<n> / AERO_USDC_SPACING=<n>.
//  - A pool that exists but whose gauge is not created, not activated in the LeafVoter, or has an emission cap of 0,
//    or an AERO pool with no liquidity yet, means WAIT, not stop. Only FORCE_INACTIVE_GAUGE=1 (the owner's explicit
//    choice) lets an unactivated or zero-cap gauge through.
//  - Anything that contradicts itself (wrong tokens, a gauge of another pool, a gauge on another position manager, a
//    pool of another factory) STOPS with a plain sentence.
const { ethers } = require("ethers");

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PREFERRED = { wethUsdc: 50, aeroWeth: 200, aeroUsdc: 200 };
const ENV_SPACING = { wethUsdc: "WETH_USDC_SPACING", aeroWeth: "AERO_WETH_SPACING", aeroUsdc: "AERO_USDC_SPACING" };

// Every fragment here is checked against the DEPLOYED Base ABIs in test/launch-night.test.js.
const ABI = {
  factory: ["function tickSpacings() view returns (int24[])", "function getPool(address,address,int24) view returns (address)"],
  pool: ["function token0() view returns (address)", "function token1() view returns (address)", "function tickSpacing() view returns (int24)",
    "function factory() view returns (address)", "function gauge() view returns (address)", "function liquidity() view returns (uint128)"],
  gauge: ["function pool() view returns (address)", "function nft() view returns (address)", "function voter() view returns (address)"],
  voter: ["function isActivated(address) view returns (bool)"],
  gaugeFactory: ["function emissionCap(address) view returns (uint128)"],
};

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
// A real revert: "execution reverted" from a node (CALL_EXCEPTION), "Transaction reverted" from Hardhat's own chain.
const isRevert = (e) => e && (e.code === "CALL_EXCEPTION" || /execution reverted|Transaction reverted/i.test(String(e.message)));

class Stop extends Error {}
class Wait extends Error {}

/// Reads one value. A revert is a real answer (STOP: the contract is not what we think); anything else (timeouts,
/// rate limits, a node a block behind) is WAIT and the next poll tries again.
async function read(label, fn) {
  try { return await fn(); } catch (e) {
    if (isRevert(e)) throw new Stop(`${label} reverted on chain: that contract does not answer like Aero's (${String(e.shortMessage || e.message).slice(0, 120)})`);
    throw new Wait(`could not read ${label} (${String(e.shortMessage || e.message).slice(0, 120)}); trying again next poll`);
  }
}

/**
 * Which pool to use out of the ones found for a pair. `found` = [{ spacing, pool, ... }].
 * Returns { pick } or { stop: sentence } or { wait: sentence }. Pure: unit-tested without a chain.
 */
function choosePool(kind, label, found, forced, extraOk = () => true) {
  const list = found.map((f) => `CL${f.spacing} ${f.pool}`).join(", ");
  if (forced !== undefined && forced !== null && forced !== "") {
    const s = Number(forced);
    const hit = found.find((f) => f.spacing === s);
    if (!hit) return { stop: `${ENV_SPACING[kind]}=${forced} was set, but there is no ${label} pool at tick spacing ${forced} (found: ${list || "none"}).` };
    return { pick: hit, note: `${label}: CL${s} chosen by ${ENV_SPACING[kind]} (found: ${list})` };
  }
  if (!found.length) return { wait: `no ${label} pool on Aero yet` };
  const pref = found.find((f) => f.spacing === PREFERRED[kind]);
  if (pref) {
    const others = found.filter((f) => f !== pref);
    if (!extraOk(pref)) return { wait: `${label} CL${pref.spacing} ${pref.pool} exists but has no liquidity yet${others.length ? ` (also found: ${others.map((f) => `CL${f.spacing} ${f.pool}`).join(", ")}; to use one of them instead set ${ENV_SPACING[kind]}=<spacing>)` : ""}` };
    return { pick: pref, note: others.length ? `${label}: CL${pref.spacing} chosen; also found ${others.map((f) => `CL${f.spacing} ${f.pool}`).join(", ")}` : undefined };
  }
  return { stop: `Aero's ${label} pool is not at tick spacing ${PREFERRED[kind]}. Found: ${list}. Nothing was written. ` +
    `Choose one with ${ENV_SPACING[kind]}=<spacing> and run again (a WETH/USDC pool at another spacing makes the deploy script re-express the guard rails).` };
}

/**
 * One read-only look. A = the six known Aero addresses (clFactory, gaugeFactory, positionManager, leafVoter, aero, ...).
 * Returns { state: "ready" | "waiting" | "stop", reasons: [...], notes: [...], found }.
 */
async function checkOnce(provider, A, env = process.env) {
  const notes = [];
  const at = (a, abi) => new ethers.Contract(a, abi, provider);
  const force = env.FORCE_INACTIVE_GAUGE === "1";
  try {
    const factory = at(A.clFactory, ABI.factory);
    const spacings = (await read("CLFactory.tickSpacings()", () => factory.tickSpacings())).map(Number);
    if (!spacings.length) throw new Stop("CLFactory.tickSpacings() is empty");
    notes.push(`tick spacings enabled on Aero's CLFactory: ${spacings.join(", ")}`);

    const pairPools = async (a, b, label) => {
      const out = [];
      for (const s of spacings) {
        const p = await read(`CLFactory.getPool(${label}, ${s})`, () => factory.getPool(a, b, s));
        if (p === ethers.ZeroAddress) continue;
        const pool = at(p, ABI.pool);
        const [t0, t1, ts, pf] = [await read(`${p}.token0()`, () => pool.token0()), await read(`${p}.token1()`, () => pool.token1()),
          await read(`${p}.tickSpacing()`, () => pool.tickSpacing()), await read(`${p}.factory()`, () => pool.factory())];
        if (!((eq(t0, a) && eq(t1, b)) || (eq(t0, b) && eq(t1, a)))) throw new Stop(`the factory's ${label} pool ${p} holds ${t0} / ${t1}, not ${label}`);
        if (Number(ts) !== s) throw new Stop(`the factory's ${label} pool ${p} reports tick spacing ${ts}, not ${s}`);
        if (!eq(pf, A.clFactory)) throw new Stop(`${label} pool ${p}.factory() is ${pf}, not Aero's CLFactory ${A.clFactory}`);
        out.push({ spacing: s, pool: ethers.getAddress(p), token0: ethers.getAddress(t0), token1: ethers.getAddress(t1), contract: pool });
      }
      return out;
    };

    // 1. WETH/USDC pool and its gauge.
    const wu = await pairPools(WETH, USDC, "WETH/USDC");
    const c1 = choosePool("wethUsdc", "WETH/USDC", wu, env.WETH_USDC_SPACING);
    if (c1.stop) return { state: "stop", reasons: [c1.stop], notes };
    if (c1.wait) return { state: "waiting", reasons: [c1.wait], notes };
    if (c1.note) notes.push(c1.note);
    const pool = c1.pick;
    const g = await read("pool.gauge()", () => pool.contract.gauge());
    if (g === ethers.ZeroAddress) return { state: "waiting", reasons: [`WETH/USDC CL${pool.spacing} pool ${pool.pool} exists; its gauge is not created yet`], notes };
    const gauge = at(g, ABI.gauge);
    const [gp, gn, gv] = [await read("gauge.pool()", () => gauge.pool()), await read("gauge.nft()", () => gauge.nft()), await read("gauge.voter()", () => gauge.voter())];
    if (!eq(gp, pool.pool)) throw new Stop(`pool.gauge() is ${g}, but that gauge's pool() is ${gp}, not the pool`);
    if (!eq(gn, A.positionManager)) throw new Stop(`gauge.nft() is ${gn}, not Aero's position manager ${A.positionManager}`);
    if (!eq(gv, A.leafVoter)) throw new Stop(`gauge.voter() is ${gv}, not Aero's LeafVoter ${A.leafVoter}`);
    const activated = await read("LeafVoter.isActivated(gauge)", () => at(A.leafVoter, ABI.voter).isActivated(g));
    const cap = await read("CLGaugeFactory.emissionCap(gauge)", () => at(A.gaugeFactory, ABI.gaugeFactory).emissionCap(g));
    notes.push(`WETH/USDC CL${pool.spacing} ${pool.pool}: gauge ${ethers.getAddress(g)}, activated ${activated}, emission cap ${cap}`);
    const inactive = [];
    if (!activated) inactive.push("the LeafVoter does not list the gauge as activated");
    if (cap === 0n) inactive.push("the gauge's emission cap is 0");
    if (inactive.length && !force) return { state: "waiting", reasons: [`WETH/USDC gauge ${ethers.getAddress(g)}: ${inactive.join(" and ")} (it would earn nothing; waiting for Aero)`], notes };
    if (inactive.length) notes.push(`FORCE_INACTIVE_GAUGE=1: going on although ${inactive.join(" and ")} (owner's choice)`);

    // 2. AERO/WETH and AERO/USDC pools: token order and liquidity.
    const found = { wethUsdcPool: pool.pool, wethUsdcGauge: ethers.getAddress(g), wethUsdcSpacing: pool.spacing, gaugeActivated: activated, emissionCap: cap.toString(), forced: inactive.length > 0 };
    for (const [kind, other, label, key] of [["aeroWeth", WETH, "AERO/WETH", "aeroWethPool"], ["aeroUsdc", USDC, "AERO/USDC", "aeroUsdcPool"]]) {
      const list = await pairPools(A.aero, other, label);
      for (const f of list) f.liquidity = await read(`${label} ${f.pool}.liquidity()`, () => f.contract.liquidity());
      // Owner decision 2026-10-21 20:10 ET: ALLOW_EMPTY_AERO_POOLS=1 deploys against an AERO pool that exists but is still
      // empty (the pool address is fixed from creation; auto-compound just skips until Aero seeds liquidity).
      const allowEmpty = env.ALLOW_EMPTY_AERO_POOLS === "1";
      const c = choosePool(kind, label, list, env[ENV_SPACING[kind]], (f) => allowEmpty || f.liquidity > 0n);
      if (c.stop) return { state: "stop", reasons: [c.stop], notes };
      if (c.wait) return { state: "waiting", reasons: [c.wait], notes };
      if (c.note) notes.push(c.note);
      if (!allowEmpty && c.pick.liquidity === 0n) return { state: "waiting", reasons: [`${label} CL${c.pick.spacing} ${c.pick.pool} has no liquidity yet`], notes };
      if (allowEmpty && c.pick.liquidity === 0n) notes.push(`${label} CL${c.pick.spacing} ${c.pick.pool} has NO liquidity yet: accepted by ALLOW_EMPTY_AERO_POOLS=1 (auto-compound skips until it is seeded)`);
      const aeroIs0 = eq(c.pick.token0, A.aero);
      notes.push(`${label} CL${c.pick.spacing} ${c.pick.pool}: token0 ${aeroIs0 ? "AERO" : label.slice(5)}, token1 ${aeroIs0 ? label.slice(5) : "AERO"}, liquidity ${c.pick.liquidity}`);
      found[key] = c.pick.pool;
      found[`${key.replace("Pool", "")}Spacing`] = c.pick.spacing;
      found[`${key.replace("Pool", "")}AeroIsToken0`] = aeroIs0;
      found[`${key.replace("Pool", "")}Liquidity`] = c.pick.liquidity.toString();
    }
    return { state: "ready", reasons: [], notes, found };
  } catch (e) {
    if (e instanceof Stop) return { state: "stop", reasons: [e.message], notes };
    if (e instanceof Wait) return { state: "waiting", reasons: [e.message], notes };
    throw e;
  }
}

/**
 * Polls checkOnce until ready (returns its result) or a stop (throws with the sentence). Prints a line when the
 * situation changes and a heartbeat every 10 polls. o: { pollSeconds, maxWaitMinutes, onPoll(n, result), log }.
 */
async function waitForAddresses(provider, A, o = {}) {
  const env = o.env || process.env;
  const log = o.log || console.log;
  const pollMs = Number(o.pollSeconds ?? env.POLL_SECONDS ?? 60) * 1000;
  const maxMin = Number(o.maxWaitMinutes ?? env.MAX_WAIT_MINUTES ?? 240);
  const start = Date.now();
  let last = "";
  for (let n = 1; ; n++) {
    const r = await checkOnce(provider, A, env);
    const line = `${r.state}: ${r.reasons.join("; ")}`;
    if (line !== last || n % 10 === 0) {
      log(`[${new Date().toISOString()}] poll ${n}: ${r.state === "ready" ? "READY" : line}`);
      if (line !== last) for (const x of r.notes) log(`    ${x}`);
      last = line;
    }
    if (o.onPoll) await o.onPoll(n, r);
    if (r.state === "ready") return r;
    if (r.state === "stop") throw new Error(`STOPPED at step (a): ${r.reasons.join(" ")}`);
    if ((Date.now() - start) / 60000 >= maxMin) throw new Error(`STOPPED at step (a): still waiting after ${maxMin} minutes (${r.reasons.join("; ")}). Nothing was written. Run again to keep waiting.`);
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

async function main() {
  const fs = require("fs");
  const path = require("path");
  const hre = require("hardhat");
  const file = process.env.AERO_FILE ? path.resolve(process.env.AERO_FILE) : path.join(__dirname, "..", "deployments", "aero-base.json");
  const A = JSON.parse(fs.readFileSync(file, "utf8"));
  const r = await checkOnce(hre.ethers.provider, A);
  console.log(`${r.state.toUpperCase()}${r.reasons.length ? ": " + r.reasons.join("; ") : ""}`);
  for (const n of r.notes) console.log(`  ${n}`);
  if (r.found) console.log(JSON.stringify(r.found, null, 2));
  if (r.state === "stop") process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { WETH, USDC, PREFERRED, ABI, choosePool, checkOnce, waitForAddresses };
