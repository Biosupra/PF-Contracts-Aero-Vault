// Old AERO -> new AERO, one for one, for Panda's own wallets (Aero's AerodromeMigration, depositLiquid). Two calls:
//   1. approve(AerodromeMigration, amount)       on old AERO 0x9401...8631
//   2. depositLiquid(amount, recipient)          on AerodromeMigration 0x22a2...6721 (payable in the ABI: send value 0)
// Liquid upgrades open at 2026-10-22 00:00 UTC: before that depositLiquid reverts MigrationNotOpen (verified source:
// Migration.depositLiquid checks _LIQUID_MIGRATION_OPEN = epochNext(MIGRATION_OPEN), MIGRATION_OPEN = 1792620000 =
// 2026-10-21 22:00 UTC, so liquid opens at the next week boundary, 1792627200).
//
//   node scripts/aero-upgrade-calldata.js                 writes docs/safe-aero-upgrade.json (the Safe's Transaction
//                                                         Builder file, amount left as a placeholder) and prints the calls
//   AMOUNT=<wei> node scripts/aero-upgrade-calldata.js    also prints the exact calldata for that amount, for the Safe
//                                                         and for the company wallet, and writes the Safe file filled in
//                                                         (deployments/safe-aero-upgrade-filled.json)
//   AMOUNT=balance RPC_URL=<Base RPC> node scripts/aero-upgrade-calldata.js
//                                                         reads each wallet's old AERO balance (read-only eth_call) and
//                                                         uses it: the Safe's for the Safe file, the company's for its own
//
// Nothing is sent: the Safe signs the file in Safe{Wallet} > Transaction Builder, the company wallet (an EOA) sends the
// two printed transactions from its own wallet (or uses Aero's upgrade page, https://aero.xyz/aero-upgrade/).
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { safeTxBuilder, writeJsonAtomic } = require("./lib/launch-night-files");

const OLD_AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const MIGRATION = "0x22a2F7340a3fB4C7C389D91eE954766B12476721";
const SAFE = "0x9eb619B3aB33192080FfA846820117e2f00EE9bA";     // the team Safe = the fee treasury (deployments/base.json safe, treasury)
const COMPANY = "0x090646B5da23d102d08fAe6166F37678b135A221";  // the company wallet (deployments/base.json company), an EOA
const LIQUID_OPEN = 1792627200;                                 // 2026-10-22 00:00 UTC
const PLACEHOLDER = "<OLD AERO BALANCE OF THE SAFE, IN WEI (18 decimals)>";
// Fragments of the VERIFIED AerodromeMigration (facts/sourcify/migration.json; test/fixtures/aero-base-abi.json) and the
// standard ERC-20 approve of old AERO. test/aero-kit.test.js checks both against the verified ABI.
const APPROVE = { name: "approve", payable: false, inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }] };
const DEPOSIT = { name: "depositLiquid", payable: true, inputs: [{ name: "_amount", type: "uint256" }, { name: "_recipient", type: "address" }] };
const iface = new ethers.Interface(["function approve(address spender, uint256 amount) returns (bool)", "function depositLiquid(uint256 _amount, address _recipient) payable",
  "function balanceOf(address) view returns (uint256)"]);

/** The two calls for `amount` (wei) upgraded to `recipient`, as { to, value, data, what }. */
function upgradeCalls(amount, recipient) {
  const a = BigInt(amount);
  if (a <= 0n) throw new Error("the amount must be above 0 (depositLiquid reverts ZeroAmount)");
  const r = ethers.getAddress(recipient);
  return [
    { to: OLD_AERO, value: "0", data: iface.encodeFunctionData("approve", [MIGRATION, a]), what: `old AERO.approve(AerodromeMigration, ${a})` },
    { to: MIGRATION, value: "0", data: iface.encodeFunctionData("depositLiquid", [a, r]), what: `AerodromeMigration.depositLiquid(${a}, ${r})` },
  ];
}

/** The Safe's Transaction Builder file; amount = wei string, or the placeholder. */
function safeFile(amount, createdAt) {
  const v = String(amount);
  return safeTxBuilder({
    chainId: 8453, safe: SAFE, createdAt,
    name: "Old AERO -> new AERO (Aero upgrade, 1:1)",
    description: `Two calls, same amount: approve AerodromeMigration ${MIGRATION} on old AERO ${OLD_AERO}, then depositLiquid(amount, Safe). ` +
      "Amount = the Safe's whole old AERO balance in wei. Opens 2026-10-22 00:00 UTC (reverts MigrationNotOpen before).",
    txs: [
      { to: OLD_AERO, value: "0", method: APPROVE, values: { spender: MIGRATION, amount: v } },
      { to: MIGRATION, value: "0", method: DEPOSIT, values: { _amount: v, _recipient: SAFE } },
    ],
  });
}

async function balanceOf(rpc, who) {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: OLD_AERO, data: iface.encodeFunctionData("balanceOf", [who]) }, "latest"] }) });
  const j = await res.json();
  if (j.error || !j.result || j.result === "0x") throw new Error(`balanceOf(${who}) on ${rpc}: ${JSON.stringify(j.error || j.result)}`);
  return BigInt(j.result);
}

async function main(env = process.env, log = console.log) {
  const root = path.join(__dirname, "..");
  const template = env.TEMPLATE_OUT ? path.resolve(env.TEMPLATE_OUT) : path.join(root, "docs", "safe-aero-upgrade.json");
  writeJsonAtomic(template, safeFile(PLACEHOLDER, 0));
  log(`written ${path.relative(process.cwd(), template)}: the Safe's two transactions, amount = placeholder (replace both "${PLACEHOLDER}" with the same number before importing)`);
  log(`Liquid upgrades open ${new Date(LIQUID_OPEN * 1000).toISOString()} (2026-10-21 8:00 PM EDT); before that the second call reverts MigrationNotOpen.`);
  if (!env.AMOUNT) {
    log("Set AMOUNT=<wei> (or AMOUNT=balance with RPC_URL) to print the exact calldata.");
    return { template };
  }
  const amounts = {};
  if (env.AMOUNT === "balance") {
    if (!env.RPC_URL) throw new Error("AMOUNT=balance needs RPC_URL (read-only)");
    amounts.safe = await balanceOf(env.RPC_URL, SAFE);
    amounts.company = await balanceOf(env.RPC_URL, COMPANY);
    log(`old AERO balances read from ${env.RPC_URL}: Safe ${ethers.formatEther(amounts.safe)}, company ${ethers.formatEther(amounts.company)}`);
  } else {
    if (!/^\d+$/.test(env.AMOUNT)) throw new Error(`AMOUNT must be a whole number of wei (18 decimals), got ${env.AMOUNT}`);
    amounts.safe = amounts.company = BigInt(env.AMOUNT);
  }
  const out = {};
  for (const [who, addr] of [["safe", SAFE], ["company", COMPANY]]) {
    if (amounts[who] === 0n) { log(`\n${who}: no old AERO, nothing to upgrade`); continue; }
    const calls = upgradeCalls(amounts[who], addr);
    out[who] = calls;
    log(`\n${who === "safe" ? `Safe ${SAFE} (Transaction Builder file below)` : `Company wallet ${COMPANY} (an EOA: two normal transactions, value 0, in this order)`}: ${ethers.formatEther(amounts[who])} old AERO`);
    calls.forEach((c, i) => log(`  ${i + 1}. to ${c.to}  value 0  ${c.what}\n     data ${c.data}`));
  }
  if (out.safe) {
    const filled = env.FILLED_OUT ? path.resolve(env.FILLED_OUT) : path.join(root, "deployments", "safe-aero-upgrade-filled.json");
    writeJsonAtomic(filled, safeFile(amounts.safe.toString(), Date.now()));
    log(`\nwritten ${path.relative(process.cwd(), filled)}: the Safe file with the amount filled in`);
    out.filled = filled;
  }
  return { template, ...out };
}

if (require.main === module) main().catch((e) => { console.error(`STOPPED: ${e.message}`); process.exit(1); });
module.exports = { OLD_AERO, MIGRATION, SAFE, COMPANY, LIQUID_OPEN, PLACEHOLDER, APPROVE, DEPOSIT, upgradeCalls, safeFile, main };
