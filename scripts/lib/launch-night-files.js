// File writes for launch night (scripts/launch-night.js), kept apart so each one is unit-tested
// (test/launch-night.test.js): the four Aero slots of deployments/aero-base.json, the launch result file, and Safe
// Transaction Builder JSON files. Every write goes to a temporary file first and is then renamed, so a stop halfway
// never leaves half a file. Nothing here reads the chain or sends anything.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const AERO_SLOTS = ["wethUsdcPool", "wethUsdcGauge", "aeroUsdcPool", "aeroWethPool"];

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Writes the four launch-day addresses into aero-base.json, keeping every other key, its order and the '_' notes.
 * Idempotent: a slot that already holds the same address is left alone. A slot that holds a DIFFERENT address is never
 * overwritten: it throws, and nothing is written. Returns { written: [slots written], same: [slots already equal] }.
 */
function fillAeroFile(file, found, stamp) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const written = [], same = [], conflicts = [];
  for (const k of AERO_SLOTS) {
    if (!ethers.isAddress(found[k])) throw new Error(`launch-night: no address for ${k}`);
    const want = ethers.getAddress(found[k]);
    if (raw[k] === null || raw[k] === undefined || raw[k] === "") { raw[k] = want; written.push(k); }
    else if (ethers.isAddress(raw[k]) && ethers.getAddress(raw[k]) === want) same.push(k);
    else conflicts.push(`${k}: the file says ${raw[k]}, the chain says ${want}`);
  }
  if (conflicts.length) {
    throw new Error(`STOPPED at step (b): ${path.basename(file)} already holds other addresses than the chain shows (${conflicts.join("; ")}). ` +
      "Nothing was written. Check which is right before going on; to start over, set those fields back to null.");
  }
  if (written.length) {
    raw._launchNight = stamp;
    writeJsonAtomic(file, raw);
  }
  return { written, same };
}

/**
 * The launch result (deployments/aero-launch-result.json): everything the website and staking fill-ins and the
 * keeper need, plus the Safe batch. `rec` = deployments/<network>.json `aeroVault` (written by deploy-aero-vault.js),
 * `batch` = its batch JSON, `found` = the launch-night addresses.
 */
function buildResult({ network, chainId, rec, batch, found, keeper }) {
  if (!rec || !batch) throw new Error("launch-night: no deploy record or batch to build the result from");
  if (!ethers.isAddress(rec.address) || !eq(batch.vault, rec.address)) throw new Error(`launch-night: the batch is for ${batch.vault}, the record for ${rec.address}`);
  return {
    _readme: "Written by scripts/launch-night.js after the Aero vault deploy. Input for dapp-config/scripts/fill-aero-config.mjs, " +
      "staking/scripts/fill-aero-addresses.js and the keeper's Railway variables (docs/aero-keeper-railway.md). Public addresses only.",
    network, chainId: Number(chainId),
    vault: rec.address, startBlock: Number(rec.deployBlock), vaultLib: rec.vaultLib, topUpLib: rec.topUpLib,
    pool: rec.pool, gauge: rec.gauge, tickSpacing: Number(rec.tickSpacing),
    aeroWethPool: found.aeroWethPool, aeroWethSpacing: found.aeroWethSpacing,
    aeroUsdcPool: found.aeroUsdcPool, aeroUsdcSpacing: found.aeroUsdcSpacing,
    aero: rec.aero, keeper: keeper || rec.keeper, guardRails: rec.guardRails, route: rec.route,
    salt: batch.salt, batch,
  };
}
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Safe Transaction Builder file (Safe{Wallet} > Apps > Transaction Builder > drag the file in). `txs` items are either
 * { to, value, data } (raw calldata) or { to, value, method: { name, payable, inputs: [{ name, type }] }, values: {...} }
 * (the builder encodes it; use this when the owner fills a value in, like an amount).
 */
function safeTxBuilder({ chainId, safe, name, description, txs, createdAt = Date.now() }) {
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt,
    meta: { name, description, txBuilderVersion: "1.16.5", createdFromSafeAddress: ethers.getAddress(safe), createdFromOwnerAddress: "" },
    transactions: txs.map((t) => t.method
      ? { to: ethers.getAddress(t.to), value: String(t.value || "0"), data: null,
        contractMethod: { inputs: t.method.inputs.map((i) => ({ internalType: i.type, name: i.name, type: i.type })), name: t.method.name, payable: !!t.method.payable },
        contractInputsValues: t.values }
      : { to: ethers.getAddress(t.to), value: String(t.value || "0"), data: t.data, contractMethod: null, contractInputsValues: null }),
  };
}

module.exports = { AERO_SLOTS, writeJsonAtomic, fillAeroFile, buildResult, safeTxBuilder };
