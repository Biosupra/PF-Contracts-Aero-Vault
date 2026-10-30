// Independent review of the Aero vault (2026-10-20) against Aero's DEPLOYED Base contracts: the new AERO has no
// transfer lock, the early-unstake window is 0 blocks today and admin-changeable, and Aero's gauge keeps deferred
// emissions per ACCOUNT. These tests were written to fail on the reviewed commit where a fix was needed and to pass
// after it. Same harness as test/aero-vault.test.js (test/aero-fixture.js). Run: npx hardhat test
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { E, DAY, RAILS, FAR, LO, HI, mine, increaseTime, fixture, mintedId, events, accrued, liqOf } = require("./aero-fixture");

const claimParams = (tokenId) => ({ tokenId, aeroToBPath: "0x", amountBMin: 0, deadline: FAR });
const migrateData = ethers.AbiCoder.defaultAbiCoder().encode(["int24", "int24", "bool", "uint256", "uint256", "uint256", "uint256", "uint256"], [LO, HI, false, 0, 0, 0, 0, FAR]);
const topUpData = (a, b) => ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256", "bytes", "uint256", "uint256", "uint256", "uint256"], [E(a), E(b), 0, "0x", 0, 0, 0, FAR]);
const sum = (xs) => xs.reduce((a, b) => a + b, 0n);

/// The per-position book's total must equal what the vault holds for it plus what the gauge still owes it:
///   sum over ids of pendingDeferred(id).gross == gauge.deferredEmissions(vault) + (vault AERO - per-position reserves).
/// Every AERO in the vault is either a position's reserve or booked AERO, so the right-hand side is observable.
async function expectBookBalanced(c, ids, label) {
  const gross = sum(await Promise.all(ids.map(async (id) => (await c.vault.pendingDeferred(id)).gross)));
  const atGauge = await c.gauge.deferredEmissions(c.vault.target);
  const held = (await c.aero.balanceOf(c.vault.target)) - (await c.vault.totalReservedAero());
  expect(gross, `book total ${label}`).to.equal(atGauge + held);
  return { gross, atGauge, held };
}

describe("Review: a refused AERO transfer is never booked as if the vault held it", function () {
  it("an AERO payout the token refuses reverts the call (as on main); nothing is booked, principal stays put", async () => {
    const c = await fixture();
    const a1 = await c.deposit(c.alice, 10, 10);
    await mine(10);
    // The deployed new AERO has no transfer lock: the only transfer it ever refuses is one the vault cannot cover.
    // Booking such a failure would let the position collect later out of OTHER positions' AERO. It must revert.
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await c.aero.setTransfersEnabledAt(now + 7 * DAY);
    await expect(c.vault.connect(c.alice).withdrawPosition(c.withdrawParams(a1))).to.be.reverted;
    await expect(c.vault.connect(c.alice).claimRewards(claimParams(a1))).to.be.reverted;
    expect((await c.vault.pendingDeferred(a1)).owner).to.equal(ethers.ZeroAddress);
    expect(await c.vault.openPositionCount()).to.equal(1n);
    expect(await c.gauge.stakedContains(c.vault.target, a1)).to.equal(true);
    await expectBookBalanced(c, [a1], "after the refused payout");
    // Once the token sends again, the same exit pays everything it earned: nothing was lost or double-booked.
    await c.aero.setTransfersEnabledAt(0);
    const d = Number(await c.gauge.depositBlock(a1));
    const rc = await (await c.vault.connect(c.alice).withdrawPosition(c.withdrawParams(a1))).wait();
    const gross = accrued(E(20), d, rc.blockNumber);
    expect(await c.aero.balanceOf(c.alice.address)).to.equal(gross - (gross * 2000n) / 10000n);
    expect(await c.aero.balanceOf(c.vault.target)).to.equal(0n);
    expect((await c.vault.pendingDeferred(a1)).gross).to.equal(0n);
  });

  it("the book only ever holds gauge-deferred emissions (gross, fee still to take): no second kind of entry", async () => {
    const c = await fixture();
    const a1 = await c.deposit(c.alice, 10, 10);
    await mine(5);
    await c.voter.setFailMint(true);
    await c.vault.connect(c.alice).emergencyWithdraw(a1);
    await c.voter.setFailMint(false);
    const p = await c.vault.pendingDeferred(a1);
    expect(p.owner).to.equal(c.alice.address);
    expect(p.gross).to.be.gt(0n);
    expect(Object.keys(p.toObject())).to.deep.equal(["owner", "gross"]);
  });
});

describe("Review: the early-unstake window as deployed on Base (0 blocks), 5 blocks, and a change in between", function () {
  it("0 blocks (today's factory default): nothing is gated, nothing is forfeited, claims pay at once", async () => {
    const c = await fixture();
    await c.gfac.setPenalty(0, 1e6);
    const a1 = await c.deposit(c.alice, 10, 10);
    expect(await c.vaultLib.penaltyFreeBlock(c.gauge.target, a1)).to.equal(0n);
    // next block: top-up, claim and the keeper's rebalance all go through
    await c.vault.connect(c.alice).topUp(a1, topUpData(1, 1));
    const d = Number(await c.gauge.depositBlock(a1));
    const rc = await (await c.vault.connect(c.alice).claimRewards(claimParams(a1))).wait();
    const gross = accrued(E(22), d, rc.blockNumber);
    expect(events(c.vault, rc, "RewardsEarned")[0].aeroAmount).to.equal(gross - (gross * 2000n) / 10000n);
    const newId = mintedId(c.vault, await (await c.vault.connect(c.keeper).rebalance(c.rebalanceParams(a1))).wait());
    expect(await c.gauge.stakedContains(c.vault.target, newId)).to.equal(true);
    expect(await c.voter.forfeited()).to.equal(0n);
    // a rate of 0 with a non-zero block count is no window either (Aero's _applyPenalty needs both)
    await c.gfac.setPenalty(5, 0);
    const b1 = await c.deposit(c.bob, 10, 10);
    expect(await c.vaultLib.penaltyFreeBlock(c.gauge.target, b1)).to.equal(0n);
    await c.vault.connect(c.keeper).rebalance(c.rebalanceParams(b1));
    expect(await c.voter.forfeited()).to.equal(0n);
  });

  it("the window is raised AFTER a deposit (admin change): the position is gated until depositBlock + window; exits never revert", async () => {
    const c = await fixture();
    await c.gfac.setPenalty(0, 1e6);
    const a1 = await c.deposit(c.alice, 10, 10);
    const b1 = await c.deposit(c.bob, 10, 10);
    await c.gfac.setPenalty(8, 1e6); // Aero's PENALTY_ADMIN_ROLE raises the window two blocks after alice's deposit
    const d = await c.gauge.depositBlock(a1);
    expect(await c.vaultLib.penaltyFreeBlock(c.gauge.target, a1)).to.equal(d + 8n);
    await expect(c.vault.connect(c.keeper).rebalance(c.rebalanceParams(a1))).to.be.revertedWithCustomError(c.vaultLib, "StakeTooRecent");
    await expect(c.vault.connect(c.alice).topUp(a1, topUpData(1, 1))).to.be.revertedWithCustomError(c.vaultLib, "StakeTooRecent");
    // a claim inside the window is skipped: nothing paid, nothing forfeited
    const rc = await (await c.vault.connect(c.alice).claimRewards(claimParams(a1))).wait();
    expect(events(c.vault, rc, "RewardsEarned").length).to.equal(0);
    expect(await c.voter.forfeited()).to.equal(0n);
    // an exit inside the window goes through; the gauge keeps those few blocks' emissions (Aero's rule), never principal
    await c.vault.connect(c.bob).withdrawPosition(c.withdrawParams(b1));
    expect(await c.weth.balanceOf(c.bob.address)).to.equal(E(10_000));
    expect(await c.usdc.balanceOf(c.bob.address)).to.equal(E(10_000));
    expect(await c.voter.forfeited()).to.be.gt(0n);
    expect(await c.aero.balanceOf(c.bob.address)).to.equal(0n);
    // once past depositBlock + window everything is free again, and the window going back to 0 frees it at once
    while ((await ethers.provider.getBlockNumber()) + 1 < Number(d) + 8) await mine(1);
    await c.vault.connect(c.keeper).rebalance(c.rebalanceParams(a1));
    const c1 = await c.deposit(c.carol, 10, 10);
    await expect(c.vault.connect(c.keeper).rebalance(c.rebalanceParams(c1))).to.be.revertedWithCustomError(c.vaultLib, "StakeTooRecent");
    await c.gfac.setPenalty(0, 1e6);
    await c.vault.connect(c.keeper).rebalance(c.rebalanceParams(c1));
  });

  it("the window is lowered after a deposit: the shorter window applies at once", async () => {
    const c = await fixture();
    await c.gfac.setPenalty(50, 1e6);
    const a1 = await c.deposit(c.alice, 10, 10);
    await mine(5);
    await expect(c.vault.connect(c.keeper).rebalance(c.rebalanceParams(a1))).to.be.revertedWithCustomError(c.vaultLib, "StakeTooRecent");
    await c.gfac.setPenalty(3, 1e6);
    await c.vault.connect(c.keeper).rebalance(c.rebalanceParams(a1));
    expect(await c.voter.forfeited()).to.equal(0n);
  });
});

describe("Review: the per-position AERO book (invariant: book total == vault-held booked AERO + what the gauge still owes)", function () {
  it("holds through withdraw, top-up, rebalance, migrate-out, two claims in one block, claimDeferred, shutdown and forceExit", async () => {
    const c = await fixture();
    const v2 = await c.deployVault();
    await c.registry.addVault(v2.target);
    const a1 = await c.deposit(c.alice, 10, 10);
    const a2 = await c.deposit(c.alice, 5, 5);
    const b1 = await c.deposit(c.bob, 10, 10);
    const c1 = await c.deposit(c.carol, 10, 10, { ac: true });
    const ids = [a1, a2, b1, c1];
    await mine(10);
    await expectBookBalanced(c, ids, "before anything is deferred");

    // 1. The voter cannot mint: every unstake path defers, each booked against the position that earned it.
    await c.voter.setFailMint(true);
    const exp = {};
    const dA1 = Number(await c.gauge.depositBlock(a1));
    let rc = await (await c.vault.connect(c.alice).withdrawPosition(c.withdrawParams(a1))).wait();
    exp[a1] = accrued(E(20), dA1, rc.blockNumber);
    await expectBookBalanced(c, ids, "after a deferred withdraw");
    const dB1 = Number(await c.gauge.depositBlock(b1));
    rc = await (await c.vault.connect(c.bob).topUp(b1, topUpData(1, 1))).wait(); // unstake defers, same id restaked
    exp[b1] = accrued(E(20), dB1, rc.blockNumber);
    expect(await c.gauge.stakedContains(c.vault.target, b1)).to.equal(true);
    await expectBookBalanced(c, ids, "after a deferred top-up");
    const dC1 = Number(await c.gauge.depositBlock(c1));
    rc = await (await c.vault.connect(c.keeper).rebalance(c.rebalanceParams(c1))).wait();
    exp[c1] = accrued(E(20), dC1, rc.blockNumber);
    const c1b = mintedId(c.vault, rc);
    ids.push(c1b);
    await expectBookBalanced(c, ids, "after a deferred rebalance");
    const dA2 = Number(await c.gauge.depositBlock(a2));
    rc = await (await c.vault.connect(c.alice).migrate({ tokenId: a2, toVault: v2.target, decreaseAmount0Min: 0, decreaseAmount1Min: 0, receiveData: migrateData, deadline: FAR })).wait();
    exp[a2] = accrued(E(10), dA2, rc.blockNumber);
    await expectBookBalanced(c, ids, "after a deferred migrate-out");
    for (const id of [a1, a2, b1, c1]) {
      const p = await c.vault.pendingDeferred(id);
      expect(p.gross, `book of ${id}`).to.equal(exp[id]);
    }
    expect(await c.gauge.deferredEmissions(c.vault.target)).to.equal(exp[a1] + exp[a2] + exp[b1] + exp[c1]);
    await c.voter.setFailMint(false);

    // 2. Two owners claim in the SAME block. The first claim sweeps the vault's whole deferred balance into the book;
    //    neither claimer receives a wei of it, each gets exactly its own position's emissions.
    await mine(5);
    const feesBefore = sum(await c.aeroOf(c.feeRecipients));
    const dB = Number(await c.gauge.depositBlock(b1)), dC = Number(await c.gauge.depositBlock(c1b));
    await network.provider.send("evm_setAutomine", [false]);
    const txB = await c.vault.connect(c.bob).claimRewards(claimParams(b1));
    const txC = await c.vault.connect(c.carol).claimRewards(claimParams(c1b));
    await network.provider.send("evm_mine");
    await network.provider.send("evm_setAutomine", [true]);
    const rcB = await txB.wait(), rcC = await txC.wait();
    expect(rcB.blockNumber).to.equal(rcC.blockNumber);
    const liqB = await liqOf(c, b1), liqC = await liqOf(c, c1b);
    const grossB = accrued(liqB, dB, rcB.blockNumber), grossC = accrued(liqC, dC, rcC.blockNumber);
    expect(events(c.vault, rcB, "RewardsEarned")[0].aeroAmount).to.equal(grossB - (grossB * 2000n) / 10000n);
    expect(events(c.vault, rcC, "RewardsEarned")[0].aeroAmount).to.equal(grossC - (grossC * 2000n) / 10000n);
    expect(await c.aero.balanceOf(c.bob.address)).to.equal(grossB - (grossB * 2000n) / 10000n);
    expect(await c.aero.balanceOf(c.carol.address)).to.equal(grossC - (grossC * 2000n) / 10000n);
    expect(sum(await c.aeroOf(c.feeRecipients)) - feesBefore).to.equal((grossB * 2000n) / 10000n + (grossC * 2000n) / 10000n);
    expect(await c.gauge.deferredEmissions(c.vault.target)).to.equal(0n);
    const s = await expectBookBalanced(c, ids, "after two claims in one block");
    expect(s.held).to.equal(exp[a1] + exp[a2] + exp[b1] + exp[c1]); // all of it waits in the vault, booked per position

    // 3. Each owner collects exactly what their position earned (reward fee applies), nobody else can.
    await expect(c.vault.connect(c.bob).claimDeferred(a1)).to.be.revertedWithCustomError(c.vaultLib, "NotPendingOwner");
    for (const [u, id] of [[c.alice, a1], [c.bob, b1], [c.carol, c1], [c.alice, a2]]) {
      const before = await c.aeroOf([u.address, ...c.feeRecipients]);
      await c.vault.connect(u).claimDeferred(id);
      const got = (await c.aeroOf([u.address, ...c.feeRecipients])).map((x, i) => x - before[i]);
      expect(sum(got), `collected for ${id}`).to.equal(exp[id]);
      expect(got[0]).to.equal(exp[id] - (exp[id] * 2000n) / 10000n);
      await expectBookBalanced(c, ids, `after claimDeferred(${id})`);
    }
    expect((await expectBookBalanced(c, ids, "book drained")).gross).to.equal(0n);
    expect(await c.aero.balanceOf(c.vault.target)).to.equal(await c.vault.totalReservedAero());

    // 4. Shutdown + forceExit while the voter cannot mint: booked with no fee, collected in full later.
    await mine(3);
    await c.registry.connect(c.safe).shutdownVault(c.vault.target);
    await c.voter.setFailMint(true);
    rc = await (await c.vault.connect(c.safe).forceExit([c1b, b1])).wait();
    const grossC2 = accrued(liqC, rcC.blockNumber, rc.blockNumber); // since carol's claim in step 2
    const grossB2 = accrued(liqB, rcB.blockNumber, rc.blockNumber);
    expect((await c.vault.pendingDeferred(c1b)).gross).to.equal(grossC2);
    expect((await c.vault.pendingDeferred(b1)).gross).to.equal(grossB2);
    await expectBookBalanced(c, ids, "after a deferred forceExit");
    await c.voter.setFailMint(false);
    const before = await c.aero.balanceOf(c.carol.address);
    await c.vault.connect(c.carol).claimDeferred(c1b);
    expect((await c.aero.balanceOf(c.carol.address)) - before).to.equal(grossC2); // no fee once shut down
    const bBefore = await c.aero.balanceOf(c.bob.address);
    await c.vault.connect(c.bob).claimDeferred(b1);
    expect((await c.aero.balanceOf(c.bob.address)) - bBefore).to.equal(grossB2);
    expect((await expectBookBalanced(c, ids, "the end")).gross).to.equal(0n);
    expect(await c.vault.openPositionCount()).to.equal(0n);
  });

  it("a gauge that pays nothing (cap 0 / not activated yet): claims and exits work, nothing is booked", async () => {
    const c = await fixture();
    await c.gauge.setRatePerBlock(0);
    const a1 = await c.deposit(c.alice, 10, 10);
    await mine(10);
    const rc = await (await c.vault.connect(c.alice).claimRewards(claimParams(a1))).wait();
    expect(events(c.vault, rc, "RewardsEarned").length).to.equal(0);
    expect(await c.vault.pendingUserAero(a1)).to.equal(0n);
    await c.vault.connect(c.alice).topUp(a1, topUpData(1, 1));
    await c.vault.connect(c.alice).withdrawPosition(c.withdrawParams(a1));
    expect(await c.weth.balanceOf(c.alice.address)).to.equal(E(10_000));
    await expectBookBalanced(c, [a1], "zero-rate gauge");
    expect(await c.aero.balanceOf(c.vault.target)).to.equal(0n);
  });

  it("the voter pays a claim 1 wei short (Aero's sub-1e6-wei holdback): the booked positions are never short-changed", async () => {
    const c = await fixture();
    const a1 = await c.deposit(c.alice, 10, 10);
    const b1 = await c.deposit(c.bob, 10, 10);
    await mine(10);
    await c.voter.setFailMint(true);
    const dA = Number(await c.gauge.depositBlock(a1));
    let rc = await (await c.vault.connect(c.alice).withdrawPosition(c.withdrawParams(a1))).wait();
    const X = accrued(E(20), dA, rc.blockNumber);
    await c.voter.setFailMint(false);
    await c.voter.setHoldback(1);
    const dB = Number(await c.gauge.depositBlock(b1));
    const before = await c.aeroOf([c.bob.address, ...c.feeRecipients]);
    rc = await (await c.vault.connect(c.bob).claimRewards(claimParams(b1))).wait();
    const R = accrued(E(20), dB, rc.blockNumber);
    const got = (await c.aeroOf([c.bob.address, ...c.feeRecipients])).map((x, i) => x - before[i]);
    expect(sum(got)).to.equal(R - 1n); // the claimer absorbs the wei the handler held back, the book stays whole
    const s = await expectBookBalanced(c, [a1, b1], "after a short mint");
    expect(s.held).to.equal(X);
    const aBefore = await c.aeroOf([c.alice.address, ...c.feeRecipients]);
    await c.vault.connect(c.alice).claimDeferred(a1);
    expect(sum((await c.aeroOf([c.alice.address, ...c.feeRecipients])).map((x, i) => x - aBefore[i]))).to.equal(X);
    // the short mint hits a direct collection from the gauge instead: the entry is clamped to what arrived, never more
    await c.voter.setFailMint(true);
    const claimedAt = rc.blockNumber; // b1 accrues again from bob's claim, not from its deposit
    rc = await (await c.vault.connect(c.bob).emergencyWithdraw(b1)).wait();
    const Y = accrued(E(20), claimedAt, rc.blockNumber);
    await c.voter.setFailMint(false);
    await c.voter.setHoldback(1);
    const bBefore = await c.aeroOf([c.bob.address, ...c.feeRecipients]);
    await c.vault.connect(c.bob).claimDeferred(b1);
    expect(sum((await c.aeroOf([c.bob.address, ...c.feeRecipients])).map((x, i) => x - bBefore[i]))).to.equal(Y - 1n);
    expect(await c.aero.balanceOf(c.vault.target)).to.equal(0n);
    expect((await expectBookBalanced(c, [a1, b1], "after a short direct collection")).gross).to.equal(0n);
  });
});

describe("Review: launch-day scripts against the live registry ABI and Aero's verified ABIs", function () {
  const live = { maxRebalanceSlippageBps: 100, twapWindow: 300, minRebalanceInterval: 3600, maxRangeSpacings: 40, maxTwapDeviationTicks: 100 };

  it("railsFor keeps the same price width when Aero's pool spacing differs (rounded down, never wider)", () => {
    const { railsFor } = require("../scripts/deploy-aero-vault.js");
    expect(railsFor(live, 50)).to.deep.equal(live);
    expect(railsFor(live, 100).maxRangeSpacings).to.equal(20);
    expect(railsFor(live, 200).maxRangeSpacings).to.equal(10);
    expect(railsFor(live, 2000).maxRangeSpacings).to.equal(1);
    expect(railsFor(live, 1).maxRangeSpacings).to.equal(1000); // the registry's cap
    expect(railsFor({ ...live, maxRangeSpacings: 7 }, 100).maxRangeSpacings).to.equal(3);
    for (const k of ["maxRebalanceSlippageBps", "twapWindow", "minRebalanceInterval", "maxTwapDeviationTicks"]) expect(railsFor(live, 100)[k]).to.equal(live[k]);
  });

  it("the Safe batch calldata decodes against the live registry and timelock ABIs, in the runbook's order", async () => {
    const reg = (await ethers.getContractFactory("PandaRegistry")).interface;
    const tl = (await ethers.getContractFactory("PandaTimelock")).interface;
    const vault = "0x000000000000000000000000000000000000dEaD", keeper = "0x5fb0abf6CC6D0Aa7ee1F3311b2e76D014eD3af60", liveVault = "0x61986AFae9B07314d855E7C54949E30A866c93a8";
    const r = live;
    const regI = new ethers.Interface(["function addVault(address)", "function setVaultKeeper(address,address)",
      "function setVaultGuardRails(address,(uint16,uint32,uint32,uint24,uint24))", "function setVaultDepositsOpen(address,bool)",
      "function setDepositsPaused(bool)", "function setRebalancesPaused(bool)"]);
    const calls = [
      regI.encodeFunctionData("addVault", [vault]), regI.encodeFunctionData("setVaultKeeper", [vault, keeper]),
      regI.encodeFunctionData("setVaultGuardRails", [vault, [r.maxRebalanceSlippageBps, r.twapWindow, r.minRebalanceInterval, r.maxRangeSpacings, r.maxTwapDeviationTicks]]),
      regI.encodeFunctionData("setVaultDepositsOpen", [liveVault, false]),
    ];
    const names = calls.map((d) => reg.parseTransaction({ data: d }).name);
    expect(names).to.deep.equal(["addVault", "setVaultKeeper", "setVaultGuardRails", "setVaultDepositsOpen"]);
    const rails = reg.parseTransaction({ data: calls[2] }).args[1];
    expect(rails.map(Number)).to.deep.equal([100, 300, 3600, 40, 100]);
    expect(reg.parseTransaction({ data: calls[3] }).args[1]).to.equal(false);
    const tlI = new ethers.Interface(["function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)", "function executeBatch(address[],uint256[],bytes[],bytes32,bytes32)"]);
    const reg0 = "0x52643dCDdd95944b01f10A4949d2923a0ff69FCC";
    const args = [calls.map(() => reg0), calls.map(() => 0), calls, ethers.ZeroHash, ethers.id("salt")];
    expect(tl.parseTransaction({ data: tlI.encodeFunctionData("scheduleBatch", [...args, 172800]) }).name).to.equal("scheduleBatch");
    expect(tl.parseTransaction({ data: tlI.encodeFunctionData("executeBatch", args) }).name).to.equal("executeBatch");
    for (const d of [regI.encodeFunctionData("setDepositsPaused", [false]), regI.encodeFunctionData("setRebalancesPaused", [false])]) expect(reg.parseTransaction({ data: d }).name).to.match(/Paused$/);
  });

  it("deploy-aero-vault.js refuses an address file with any empty field", () => {
    const { loadAero } = require("../scripts/deploy-aero-vault.js");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aero-review-")), "aero-base.json");
    // The committed file is filled since the launch; rebuild its pre-launch state (the four slots empty).
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "aero-base.json"), "utf8"));
    for (const k of ["wethUsdcPool", "wethUsdcGauge", "aeroUsdcPool", "aeroWethPool"]) real[k] = null;
    fs.writeFileSync(file, JSON.stringify(real));
    expect(() => loadAero(file)).to.throw(/not filled in yet: wethUsdcPool, wethUsdcGauge, aeroUsdcPool, aeroWethPool/);
    const filled = { ...real, wethUsdcPool: ethers.ZeroAddress, wethUsdcGauge: ethers.ZeroAddress, aeroUsdcPool: ethers.ZeroAddress, aeroWethPool: ethers.ZeroAddress };
    fs.writeFileSync(file, JSON.stringify(filled));
    expect(loadAero(file).clFactory).to.equal("0x9CB220581b91b0C83223012FE69688b92aD07a76");
  });

  it("every ABI fragment the vault, the deploy script and both fork rehearsals use exists on Aero's DEPLOYED Base contracts", async () => {
    const verified = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "aero-base-abi.json"), "utf8"));
    const has = (contract, fragment) => {
      const f = ethers.Fragment.from(fragment);
      const sig = f.format("sighash");
      const outs = f.outputs ? `(${f.outputs.map((o) => o.format("sighash")).join(",")})` : "()";
      const hit = verified[contract].functions.find((x) => x.startsWith(sig + "->"));
      expect(hit, `${contract}: ${sig} is not on the deployed contract`).to.not.equal(undefined);
      if (f.outputs && f.outputs.length) expect(hit.slice(sig.length + 2), `${contract}: ${sig} return shape`).to.equal(outs);
    };
    // the vault's own interfaces (contracts/interfaces/IAerodrome.sol), gauge-side
    const gauge = ["function deposit(uint256)", "function withdraw(uint256)", "function claimEmissions(address,address,uint256[])",
      "function earned(address,uint256[]) view returns (uint256)", "function deferredEmissions(address) view returns (uint256)",
      "function depositBlock(uint256) view returns (uint256)", "function gaugeFactory() view returns (address)", "function voter() view returns (address)",
      "function tickSpacing() view returns (int24)", "function pool() view returns (address)", "function nft() view returns (address)",
      "function stakedContains(address,uint256) view returns (bool)"];
    gauge.forEach((f) => has("CLGauge", f));
    // effectivePenaltyConfig returns a struct of two uint256: ABI-identical to the (uint256,uint256) the vault decodes
    has("CLGaugeFactory", "function effectivePenaltyConfig(address) view returns ((uint256,uint256))");
    ["function isGauge(address) view returns (bool)", "function nft() view returns (address)", "function emissionCap(address) view returns (uint128)",
      "function minStakeBlocks(address) view returns (uint256)", "function maxMinStakeBlocks() view returns (uint256)",
      "function createGauge(address,bytes) returns (address,address)", "function setEmissionCap(address,uint128)", "function computeGaugeAddress(address) view returns (address)",
      "function CAP_ADMIN_ROLE() view returns (bytes32)", "function getRoleMember(bytes32,uint256) view returns (address)"].forEach((f) => has("CLGaugeFactory", f));
    ["function getPool(address,address,int24) view returns (address)", "function createPool(address,address,int24,uint160) returns (address)",
      "function tickSpacingToFee(int24) view returns (uint24)", "function voter() view returns (address)", "function allPoolsLength() view returns (uint256)"].forEach((f) => has("CLFactory", f));
    ["function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)", "function token0() view returns (address)", "function token1() view returns (address)",
      "function tickSpacing() view returns (int24)", "function factory() view returns (address)", "function gauge() view returns (address)", "function nft() view returns (address)",
      "function observe(uint32[]) view returns (int56[],uint160[])", "function increaseObservationCardinalityNext(uint16)",
      "function stakedLiquidity() view returns (uint128)", "function rewardGrowthGlobalX128() view returns (uint256)"].forEach((f) => has("CLPool", f));
    ["function mint((address,address,int24,int24,int24,uint256,uint256,uint256,uint256,address,uint256,uint160)) payable returns (uint256,uint128,uint256,uint256)",
      "function increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256)) payable returns (uint128,uint256,uint256)",
      "function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256)) payable returns (uint256,uint256)",
      "function collect((uint256,address,uint128,uint128)) payable returns (uint256,uint256)",
      "function positions(uint256) view returns (uint96,address,address,address,int24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
      "function approve(address,uint256)", "function safeTransferFrom(address,address,uint256)", "function ownerOf(uint256) view returns (address)",
      "function factory() view returns (address)"].forEach((f) => has("NonfungiblePositionManager", f));
    ["function exactInput((bytes,address,uint256,uint256,uint256)) payable returns (uint256)", "function factory() view returns (address)"].forEach((f) => has("SwapRouter", f));
    ["function isActivated(address) view returns (bool)", "function registerGauge(address,bool)", "function activateGauge(address)",
      "function gaugeStates(address) view returns (uint128,uint128,uint48,bool,bool,uint128,uint256,uint256,(int128,int128,uint48,uint128))",
      "function projectedCumulativeRewardShare(address) view returns (uint256)", "function GAUGE_MANAGER() view returns (address)",
      "function EMISSIONS_HANDLER() view returns (address)", "function ORCHESTRATOR() view returns (address)", "function hasRole(bytes32,address) view returns (bool)",
      "function getRoleMember(bytes32,uint256) view returns (address)", "function chainStatus() view returns (uint8)"].forEach((f) => has("LeafVoter", f));
    ["function remaining() view returns (uint256)", "function paused() view returns (bool)", "function MIGRATION_OPEN() view returns (uint48)",
      "function depositLiquid(uint256,address) payable", "function V2_TOKEN() view returns (address)", "function V3_TOKEN() view returns (address)"].forEach((f) => has("AerodromeMigration", f));
    ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function MINTER() view returns (address)",
      "function MIGRATION() view returns (address)"].forEach((f) => has("Token", f));
    // what the deployed token does NOT have: the first-week transfer lock the reviewed branch was written for
    expect(verified.Token.functions.find((x) => x.startsWith("TRANSFERS_ENABLED_AT("))).to.equal(undefined);
    expect(verified.CLGauge.functions.find((x) => x.startsWith("getReward(") || x.startsWith("rewardRate(") || x.startsWith("rewardToken("))).to.equal(undefined);
    // the prelaunch rehearsal's own fragments
    const { FRAGMENTS } = require("../scripts/rehearse-aero-fork-prelaunch.js");
    for (const [contract, frags] of Object.entries(FRAGMENTS)) {
      if (!verified[contract]) continue; // Panda's own contracts and ERC-20s are not in the Aero fixture
      frags.filter((f) => f.startsWith("function ")).forEach((f) => has(contract, f));
    }
  });
});
