// The safety wallet's four switches for the Aero launch, on the registry (deployments/base.json registry), read from
// the compiled PandaRegistry ABI (artifacts/, `npx hardhat compile` first):
//   before launch:            setDepositsPaused(true), setRebalancesPaused(true)
//   after the timelock batch: setDepositsPaused(false), setRebalancesPaused(false)
// The registry accepts them from its safety module (deployments/base.json safetyModule = 0x3e1f...1919) or its owner.
// Withdrawals are never paused by these. Prints calldata and the scripts/pause.js commands that send them through the
// owner's browser wallet (the usual way); nothing is sent here.
//
//   node scripts/aero-pause-calldata.js
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function registryAbi(root = path.join(__dirname, "..")) {
  const f = path.join(root, "artifacts", "contracts", "PandaRegistry.sol", "PandaRegistry.json");
  if (!fs.existsSync(f)) throw new Error(`${f} is missing: run "npx hardhat compile" first`);
  return JSON.parse(fs.readFileSync(f, "utf8")).abi;
}

function pauseCalls(dep, abi) {
  const reg = new ethers.Interface(abi);
  const call = (fn, on, when) => ({ to: ethers.getAddress(dep.registry), value: "0", fn: `${fn}(${on})`, when, data: reg.encodeFunctionData(fn, [on]) });
  return [
    call("setDepositsPaused", true, "before launch (tonight, or Wednesday before 8 PM EDT)"),
    call("setRebalancesPaused", true, "before launch (the live keeper then idles)"),
    call("setDepositsPaused", false, "after the Safe has EXECUTED the timelock batch (+48 h)"),
    call("setRebalancesPaused", false, "after the Safe has EXECUTED the timelock batch (+48 h)"),
  ];
}

function commands(dep) {
  const base = `WALLET=browser DEPLOYER=${ethers.getAddress(dep.safetyModule)}`;
  const cmd = (what, action) => `${base} WHAT=${what} ACTION=${action} npx hardhat run scripts/pause.js --network base`;
  return { pause: [cmd("deposits", "pause"), cmd("rebalances", "pause")], unpause: [cmd("deposits", "unpause"), cmd("rebalances", "unpause")] };
}

function main(log = console.log) {
  const root = path.join(__dirname, "..");
  const dep = JSON.parse(fs.readFileSync(path.join(root, "deployments", "base.json"), "utf8"));
  const calls = pauseCalls(dep, registryAbi(root));
  log(`Registry ${dep.registry}; safety wallet (safety module) ${dep.safetyModule}. Withdrawals are never affected.`);
  for (const c of calls) log(`\n${c.fn}  [${c.when}]\n  from ${dep.safetyModule} to ${c.to}, value 0\n  data ${c.data}`);
  const k = commands(dep);
  log("\nSend them with the browser wallet (pause.js checks the wallet is the safety module, skips a switch already set, reads it back):");
  log("  before launch:\n    " + k.pause.join("\n    "));
  log("  after the timelock batch executed:\n    " + k.unpause.join("\n    "));
  return { calls, commands: k };
}

if (require.main === module) { try { main(); } catch (e) { console.error(`STOPPED: ${e.message}`); process.exit(1); } }
module.exports = { registryAbi, pauseCalls, commands, main };
