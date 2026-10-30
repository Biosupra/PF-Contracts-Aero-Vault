// Level 2 rehearsal on a Base FORK (launch day, once deployments/aero-base.json is filled): the real registry, timelock,
// Safe, safety module, live vault and Aero's real Base contracts. Nothing reaches Base.
//
//   FORK=1 RPC_URL=https://mainnet.base.org [FORK_BLOCK=<recent block>] npx hardhat run scripts/rehearse-aero-fork.js
//
// Steps: scripts/deploy-aero-vault.js (preflight, deploy, batch JSON) -> the Safe schedules and executes the batch
// through the REAL timelock (impersonated, +48 h) -> the safety module lifts the pauses -> the owner of a REAL open
// position in the live vault migrates it into the Aero vault -> deposit, zap, top-up, keeper rebalance, emissions,
// claim, withdraw -> the Safe shuts the new vault down and forceExits what is left.
//
// WRITTEN 2026-10-20 BUT NOT RUN: the cloud session that wrote it could not reach a public Base node, and Aero's Base
// addresses do not exist before launch day. scripts/rehearse-aero-local.js runs the same flow against Aero's real
// contracts on a local chain and passed. Public RPC only, gently; cache the fork block with FORK_BLOCK.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers, network } = require("hardhat");

const LIVE_VAULT = "0x61986AFae9B07314d855E7C54949E30A866c93a8";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FAR = 2n ** 40n;
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`); if (!cond) failures++; };
const later = async (sec) => { await network.provider.send("evm_increaseTime", [sec]); await network.provider.send("evm_mine"); };
const mine = (n) => network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
async function as(addr) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}
const minted = (vault, rc) => {
  for (const l of rc.logs) { try { const p = vault.interface.parseLog(l); if (p && p.name === "PositionMinted") return p.args.tokenId; } catch (e) {} }
  throw new Error("no PositionMinted");
};

/// `hooks.afterStaked({ vault, gauge, pool })` runs once positions are staked (the pre-launch rehearsal funds emissions
/// there); with `hooks.expectEmissions` the claim must bring AERO (paid or gauge-deferred and booked) or the run fails.
async function main(hooks = {}) {
  if (process.env.FORK !== "1" || Number((await ethers.provider.getNetwork()).chainId) !== 31337) throw new Error("run with FORK=1 on the Hardhat network (a Base fork)");
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "base.json"), "utf8"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "panda-aero-fork-"));
  Object.assign(process.env, { NETWORK: "base", RECORD: "0", BATCH_OUT: path.join(tmp, "batch.json") });
  console.log("=== 1. Deploy script (preflight, deploy, batch) on the fork ===");
  const res = await require("./deploy-aero-vault.js").main();
  const vault = await ethers.getContractAt("PandaVault", res.vault);
  const registry = await ethers.getContractAt("PandaRegistry", dep.registry);
  const gauge = new ethers.Contract(await vault.gauge(), ["function depositBlock(uint256) view returns (uint256)", "function stakedContains(address,uint256) view returns (bool)"], ethers.provider);
  const aero = await ethers.getContractAt("IERC20", await vault.aeroToken());

  console.log("=== 2. The Safe batch through the REAL timelock, then the safety module ===");
  const b = JSON.parse(fs.readFileSync(path.join(tmp, "batch.json"), "utf8"));
  const safe = await as(dep.safe);
  await (await safe.sendTransaction({ to: b.schedule.to, data: b.schedule.data })).wait();
  await later(b.delaySeconds + 1);
  await (await safe.sendTransaction({ to: b.execute.to, data: b.execute.data })).wait();
  const safety = await as(dep.safetyModule);
  for (const c of b.afterExecute.calls) await (await safety.sendTransaction({ to: c.to, data: c.data })).wait();
  ok(await registry.isVault(vault.target), "new vault registered in the REAL registry");
  ok(!(await registry.vaultDepositsOpen(LIVE_VAULT)), "live vault: new deposits closed");
  ok(!(await registry.depositsPaused()) && !(await registry.rebalancesPaused()), "global pauses lifted");

  console.log("=== 3. A REAL live position migrates into the Aero vault ===");
  const live = await ethers.getContractAt("PandaVault", LIVE_VAULT); // the live vault's ABI is the same contract on main
  const n = await live.openPositionCount();
  if (n === 0n) throw new Error("the live vault has no open position to migrate on this fork block");
  const oldId = await live.openPositionAt(0);
  const owner = await as((await live.positionInfo(oldId)).owner);
  const pool = await ethers.getContractAt("ICLPool", await vault.pool());
  const spacing = Number(await vault.tickSpacing());
  const tick = Number((await pool.slot0())[1]);
  const LO = Math.floor(tick / spacing) * spacing - 20 * spacing, HI = Math.floor(tick / spacing) * spacing + 20 * spacing;
  const data = ethers.AbiCoder.defaultAbiCoder().encode(["int24", "int24", "bool", "uint256", "uint256", "uint256", "uint256", "uint256"], [LO, HI, false, 0, 0, 0, 0, FAR]);
  const rcM = await (await live.connect(owner).migrate({ tokenId: oldId, toVault: vault.target, decreaseAmount0Min: 0, decreaseAmount1Min: 0, receiveData: data, deadline: FAR })).wait();
  const p1 = minted(vault, rcM);
  ok((await vault.positionInfo(p1)).owner === owner.address && await gauge.stakedContains(vault.target, p1), `live position ${oldId} -> Aero position ${p1}, same owner, staked`);

  console.log("=== 4. Deposit, zap, top-up, rebalance, claim, withdraw ===");
  const [user] = await ethers.getSigners();
  const weth = new ethers.Contract(WETH, ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], user);
  const usdc = new ethers.Contract(USDC, ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], user);
  await (await weth.deposit({ value: ethers.parseEther("4") })).wait();
  const router = new ethers.Contract(await vault.swapRouter(), ["function exactInput((bytes,address,uint256,uint256,uint256)) payable returns (uint256)"], user);
  await (await weth.approve(router.target, ethers.MaxUint256)).wait();
  await (await router.exactInput([ethers.solidityPacked(["address", "int24", "address"], [WETH, spacing, USDC]), user.address, FAR, ethers.parseEther("2"), 0])).wait();
  await (await weth.approve(vault.target, ethers.MaxUint256)).wait();
  await (await usdc.approve(vault.target, ethers.MaxUint256)).wait();
  const usdcBal = await usdc.balanceOf(user.address);
  const p2 = minted(vault, await (await vault.connect(user).depositAndStake({ amountA: ethers.parseEther("1"), amountB: usdcBal / 2n, tickLower: LO, tickUpper: HI, amount0Min: 0, amount1Min: 0, deadline: FAR, autoCompound: true })).wait());
  const p3 = minted(vault, await (await vault.connect(user).depositZap({ amountB: usdcBal / 4n, swapAmountIn: usdcBal / 8n, swapPath: ethers.solidityPacked(["address", "int24", "address"], [USDC, spacing, WETH]),
    tickLower: LO, tickUpper: HI, amountAMin: 0, amount0MinMint: 0, amount1MinMint: 0, deadline: FAR, autoCompound: false })).wait());
  ok(await gauge.stakedContains(vault.target, p2) && await gauge.stakedContains(vault.target, p3), `deposit ${p2} and zap ${p3} staked`);
  if (hooks.afterStaked) await hooks.afterStaked({ vault, gauge: gauge.target, pool: pool.target });
  await mine(10);
  const tdata = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256", "bytes", "uint256", "uint256", "uint256", "uint256"], [ethers.parseEther("0.2"), 0, 0, "0x", 0, 0, 0, FAR]);
  await (await vault.connect(user).topUp(p3, tdata)).wait();
  ok(true, "top-up went through");
  await later(1800);
  await mine(10);
  const keeper = await as(await registry.keeperOf(vault.target));
  const rcR = await (await vault.connect(keeper).rebalance({ tokenId: p2, isAToB: false, rebalanceAmountIn: 0, rebalanceAmountOutMin: 0, newTickLower: LO + spacing, newTickUpper: HI + spacing,
    amount0MinMint: 0, amount1MinMint: 0, decreaseAmount0Min: 0, decreaseAmount1Min: 0, deadline: FAR })).wait();
  const p2b = minted(vault, rcR);
  ok((await vault.positionInfo(p2b)).owner === user.address, `keeper rebalance ${p2} -> ${p2b}`);
  console.log(`  emissions so far: position ${p3} pending ${ethers.formatEther(await vault.pendingUserAero(p3))} AERO (0 if Aero's voter has not allocated to this gauge yet)`);
  const before = await aero.balanceOf(user.address);
  try {
    await (await vault.connect(user).claimRewards({ tokenId: p3, aeroToBPath: "0x", amountBMin: 0, deadline: FAR })).wait();
  } catch (e) {
    // Aero's gauge mints on claim with no fallback: a voter that cannot mint (chain paused, Minter not active and no
    // chain buffer) reverts the claim. Exits still work (the gauge defers, the vault books). Reported, not fatal.
    ok(false, `claimRewards reverted: ${(e.shortMessage || e.message).slice(0, 160)}`);
  }
  const booked = await vault.pendingDeferred(p3);
  const claimedAero = (await aero.balanceOf(user.address)) - before;
  console.log(`  claimed ${ethers.formatEther(claimedAero)} AERO, gauge-deferred and booked ${ethers.formatEther(booked.gross)}`);
  if (hooks.expectEmissions) ok(claimedAero > 0n || booked.gross > 0n, `the claim brought AERO (paid ${ethers.formatEther(claimedAero)}, booked ${ethers.formatEther(booked.gross)})`);
  if (hooks.afterClaim) await hooks.afterClaim({ vault, user, p2: p2b, p3, claimedAero, booked: booked.gross });
  await (await vault.connect(user).withdrawPosition({ tokenId: p3, aeroToBPath: "0x", amountBMinReward: 0, amount0Min: 0, amount1Min: 0, aToBPath: "0x", amountBMinReturned: 0, deadline: FAR })).wait();
  ok(!(await gauge.stakedContains(vault.target, p3)), "withdraw went through");

  console.log("=== 5. Shutdown (the Safe) and forceExit ===");
  await (await registry.connect(safe).shutdownVault(vault.target)).wait();
  const open = [];
  for (let i = 0n; i < (await vault.openPositionCount()); i++) open.push(await vault.openPositionAt(i));
  await (await vault.connect(safe).forceExit(open)).wait();
  ok((await vault.openPositionCount()) === 0n, `forceExit returned ${open.length} position(s) to their owners`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL FORK CHECKS PASSED");
  if (failures) process.exitCode = 1;
  return { vault: vault.target, failures };
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main };
