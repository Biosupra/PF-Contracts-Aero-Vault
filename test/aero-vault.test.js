// Level 1 tests for the Aero port of PandaVault, on the plain Hardhat network (no fork), against test-only stand-ins
// that behave like Aero's contracts as read from the public source (contracts/test/AeroMocks.sol): array `earned`,
// `claimEmissions`, auto-claim on withdraw, per-ACCOUNT deferred emissions, the early-unstake penalty window, per-block
// accrual (no rewardRate / periodFinish). The registry, timelock, fee policy v3 and referrals are the real contracts.
// (Review 2026-10-20: the deployed new AERO has no transfer lock; a refused payout reverts, see test/aero-review.test.js.)
// Run: npx hardhat test
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { E, DAY, RAILS, FAR, LO, HI, mine, increaseTime, path, fixture, mintedId, events, accrued, liqOf } = require("./aero-fixture");


describe("Aero vault: construction and consistency checks", function () {
  it("deploys against an Aero-shaped gauge and refuses mismatched addresses", async () => {
    const c = await fixture();
    expect(await c.vault.pool()).to.equal(c.pool.target);
    expect(await c.vault.tickSpacing()).to.equal(50n);
    const [tokens, spacings, pools] = await c.vault.compoundRoute();
    expect(tokens).to.deep.equal([c.aero.target, c.weth.target]);
    expect(spacings).to.deep.equal([200n]);
    expect(pools).to.deep.equal([c.aeroPool.target]);
    // a gauge that is not the pool's gauge
    const other = await (await ethers.getContractFactory("MockAeroGauge")).deploy(c.pool.target, c.nfpm.target, c.voter.target, c.gfac.target, 50, await c.pool.token0(), await c.pool.token1());
    await expect(c.deployVault({ gauge: other.target })).to.be.revertedWithCustomError(c.Vault, "InconsistentDeployment");
    // AERO may never be one side of the pair
    await expect(c.deployVault({ tokenA: c.aero.target })).to.be.revertedWithCustomError(c.Vault, "AeroPairUnsupported");
    // the compound route must exist in the same factory
    await expect(c.deployVault({ routeSpacings: [100] })).to.be.revertedWithCustomError(c.Vault, "InvalidRoute");
  });
});

describe("Aero vault: deposits, zap, top-up", function () {
  it("deposit: mints, stakes in the gauge, reserves what the range cannot take", async () => {
    const c = await fixture();
    const id = await c.deposit(c.alice, 10, 12);
    expect(await c.gauge.stakedContains(c.vault.target, id)).to.equal(true);
    expect((await c.vault.positionInfo(id)).owner).to.equal(c.alice.address);
    const r = await c.vault.reserves(id);
    expect(r.a).to.equal(0n);
    expect(r.b).to.equal(E(2));
    expect(await c.vault.openPositionCount()).to.equal(1n);
  });

  it("zap: token B only, part swapped through the caller's path", async () => {
    const c = await fixture();
    const tx = await c.vault.connect(c.bob).depositZap({ amountB: E(20), swapAmountIn: E(10), swapPath: path(c.usdc.target, 50, c.weth.target),
      tickLower: LO, tickUpper: HI, amountAMin: E(9), amount0MinMint: 0, amount1MinMint: 0, deadline: FAR, autoCompound: true });
    const id = mintedId(c.vault, await tx.wait());
    expect((await c.vault.positionInfo(id)).isZap).to.equal(true);
    expect(await liqOf(c, id)).to.equal(E(20));
  });

  it("top-up: same NFT, more liquidity; refused inside the early-unstake window; the unstake's AERO goes to the reserve", async () => {
    const c = await fixture();
    const id = await c.deposit(c.alice, 10, 10);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256", "bytes", "uint256", "uint256", "uint256", "uint256"],
      [E(5), E(5), 0, "0x", 0, 0, 0, FAR]);
    await expect(c.vault.connect(c.alice).topUp(id, data)).to.be.revertedWithCustomError(c.vaultLib, "StakeTooRecent");
    await mine(10);
    const tx = await c.vault.connect(c.alice).topUp(id, data);
    const rc = await tx.wait();
    expect(await liqOf(c, id)).to.equal(E(30));
    expect(await c.gauge.stakedContains(c.vault.target, id)).to.equal(true);
    const earned = events(c.topUpLib, rc, "RewardsEarned");
    expect(earned.length).to.equal(1);
    expect((await c.vault.reserves(id)).aero).to.equal(earned[0].aeroAmount);
    expect(await c.voter.forfeited()).to.equal(0n);
  });
});

describe("Aero vault: rewards stay exactly per position", function () {
  it("claim pays each position only its own emissions, across several positions and users, fee legs incl. the instant referral leg", async () => {
    const c = await fixture();
    await c.referrals.connect(c.alice).accept(c.referrer.address);
    const a1 = await c.deposit(c.alice, 10, 10);
    const b1 = await c.deposit(c.bob, 30, 30);
    const a2 = await c.deposit(c.alice, 5, 5);
    const c1 = await c.deposit(c.carol, 1, 1);
    const dep = {};
    for (const id of [a1, b1, a2, c1]) dep[id] = Number(await c.gauge.depositBlock(id));
    await mine(20);
    for (const [u, id] of [[c.bob, b1], [c.alice, a2], [c.carol, c1], [c.alice, a1]]) {
      const before = await c.aeroOf([u.address, ...c.feeRecipients]);
      const tx = await c.vault.connect(u).claimRewards({ tokenId: id, aeroToBPath: "0x", amountBMin: 0, deadline: FAR });
      const rc = await tx.wait();
      const gross = accrued(await liqOf(c, id), dep[id], rc.blockNumber);
      const after = await c.aeroOf([u.address, ...c.feeRecipients]);
      const got = after.map((x, i) => x - before[i]);
      const fee = got.slice(1).reduce((a, b) => a + b, 0n);
      expect(got[0] + fee).to.equal(gross); // every AERO this position earned, and nothing else
      expect(fee).to.equal(gross * 2000n / 10000n); // keeper 1% + Panda 19% (no rounding at these amounts)
      expect(got[5]).to.equal(u === c.alice ? gross * 20n / 10000n : 0n); // referrer: 1% of the 20% fee, in AERO, instantly
      expect(got[1]).to.equal(gross / 100n); // keeper leg
    }
    expect(await c.aero.balanceOf(c.vault.target)).to.equal(0n);
  });

  it("withdraw auto-claims only the withdrawn position; the other position keeps accruing for itself", async () => {
    const c = await fixture();
    const a1 = await c.deposit(c.alice, 10, 10);
    const b1 = await c.deposit(c.bob, 10, 10);
    await mine(10);
    const d = Number(await c.gauge.depositBlock(a1));
    const before = await c.aero.balanceOf(c.alice.address);
    const rc = await (await c.vault.connect(c.alice).withdrawPosition(c.withdrawParams(a1))).wait();
    const gross = accrued(E(20), d, rc.blockNumber);
    expect((await c.aero.balanceOf(c.alice.address)) - before).to.equal(gross - gross * 2000n / 10000n);
    expect(await c.weth.balanceOf(c.alice.address)).to.equal(E(10_000));
    expect(await c.usdc.balanceOf(c.alice.address)).to.equal(E(10_000));
    expect(await c.aero.balanceOf(c.vault.target)).to.equal(0n);
    const db = Number(await c.gauge.depositBlock(b1));
    const rc2 = await (await c.vault.connect(c.bob).claimRewards({ tokenId: b1, aeroToBPath: "0x", amountBMin: 0, deadline: FAR })).wait();
    const evt = events(c.vault, rc2, "RewardsEarned")[0];
    const g2 = accrued(E(20), db, rc2.blockNumber);
    expect(evt.aeroAmount).to.equal(g2 - g2 * 2000n / 10000n);
  });

  it("REGRESSION (\"the next claimer gets the whole pooled balance\"): emissions the gauge deferred for one position never land on another position's claim", async () => {
    const c = await fixture();
    const a1 = await c.deposit(c.alice, 10, 10);
    const b1 = await c.deposit(c.bob, 10, 10);
    await mine(10);
    // The voter cannot mint: Aero's gauge stores alice's position's emissions per ACCOUNT (the vault) on withdraw.
    await c.voter.setFailMint(true);
    const da = Number(await c.gauge.depositBlock(a1));
    const rcW = await (await c.vault.connect(c.alice).withdrawPosition(c.withdrawParams(a1))).wait();
    const deferred = accrued(E(20), da, rcW.blockNumber);
    expect(await c.gauge.deferredEmissions(c.vault.target)).to.equal(deferred);
    const p = await c.vault.pendingDeferred(a1);
    expect(p.owner).to.equal(c.alice.address);
    expect(p.gross).to.equal(deferred);
    expect(events(c.vaultLib, rcW, "RewardsDeferred")[0].grossAero).to.equal(deferred);
    // Principal came back in full; the withdraw did not revert.
    expect(await c.weth.balanceOf(c.alice.address)).to.equal(E(10_000));
    await c.voter.setFailMint(false);

    // Bob claims his own position: the gauge pays his emissions PLUS alice's deferred lump to the vault.
    const db = Number(await c.gauge.depositBlock(b1));
    const before = await c.aeroOf([c.bob.address, ...c.feeRecipients]);
    const rcB = await (await c.vault.connect(c.bob).claimRewards({ tokenId: b1, aeroToBPath: "0x", amountBMin: 0, deadline: FAR })).wait();
    const after = await c.aeroOf([c.bob.address, ...c.feeRecipients]);
    const bobGross = accrued(E(20), db, rcB.blockNumber);
    const got = after.map((x, i) => x - before[i]);
    expect(got.reduce((a, b) => a + b, 0n)).to.equal(bobGross); // bob + fees = exactly bob's emissions
    expect(await c.gauge.deferredEmissions(c.vault.target)).to.equal(0n);
    expect(await c.aero.balanceOf(c.vault.target)).to.equal(deferred); // alice's AERO waits in the vault, for her

    // Only alice can take it, and she gets all of it (reward fee applies as on any reward).
    await expect(c.vault.connect(c.bob).claimDeferred(a1)).to.be.revertedWithCustomError(c.vaultLib, "NotPendingOwner");
    const aBefore = await c.aeroOf([c.alice.address, ...c.feeRecipients]);
    await c.vault.connect(c.alice).claimDeferred(a1);
    const aAfter = await c.aeroOf([c.alice.address, ...c.feeRecipients]);
    const aGot = aAfter.map((x, i) => x - aBefore[i]);
    expect(aGot.reduce((a, b) => a + b, 0n)).to.equal(deferred);
    expect(aGot[0]).to.equal(deferred - deferred * 2000n / 10000n);
    expect(await c.aero.balanceOf(c.vault.target)).to.equal(0n);
    expect((await c.vault.pendingDeferred(a1)).owner).to.equal(ethers.ZeroAddress);
    await expect(c.vault.connect(c.alice).claimDeferred(a1)).to.be.revertedWithCustomError(c.vaultLib, "NotPendingOwner");
  });

  it("deferred emissions of several positions: each owner collects exactly theirs, straight from the gauge if nobody claimed since", async () => {
    const c = await fixture();
    const a1 = await c.deposit(c.alice, 10, 10);
    const b1 = await c.deposit(c.bob, 20, 20);
    const c1 = await c.deposit(c.carol, 5, 5);
    await mine(8);
    await c.voter.setFailMint(true);
    const exp = {};
    for (const [u, id, liq] of [[c.alice, a1, E(20)], [c.bob, b1, E(40)]]) {
      const d = Number(await c.gauge.depositBlock(id));
      const rc = await (await c.vault.connect(u).emergencyWithdraw(id)).wait();
      exp[id] = accrued(liq, d, rc.blockNumber);
    }
    // the carol position is rebalanced while minting fails: its deferred AERO is booked against its OLD token id
    await mine(5);
    const dc = Number(await c.gauge.depositBlock(c1));
    const rcR = await (await c.vault.connect(c.keeper).rebalance(c.rebalanceParams(c1))).wait();
    exp[c1] = accrued(E(10), dc, rcR.blockNumber);
    await c.voter.setFailMint(false);
    expect(await c.gauge.deferredEmissions(c.vault.target)).to.equal(exp[a1] + exp[b1] + exp[c1]);
    // a claim while minting fails reverts and books nothing twice
    for (const [u, id] of [[c.bob, b1], [c.carol, c1], [c.alice, a1]]) {
      const before = await c.aeroOf([u.address, ...c.feeRecipients]);
      await c.vault.connect(u).claimDeferred(id);
      const after = await c.aeroOf([u.address, ...c.feeRecipients]);
      expect(after.reduce((a, b, i) => a + b - before[i], 0n)).to.equal(exp[id]);
    }
    expect(await c.aero.balanceOf(c.vault.target)).to.equal(0n);
  });

  it("pendingUserAero reads one position (array earned) without the vault's deferred balance", async () => {
    const c = await fixture();
    const a1 = await c.deposit(c.alice, 10, 10);
    const b1 = await c.deposit(c.bob, 10, 10);
    await mine(10);
    await c.voter.setFailMint(true);
    await c.vault.connect(c.bob).emergencyWithdraw(b1);
    await c.voter.setFailMint(false);
    const d = Number(await c.gauge.depositBlock(a1));
    const now = await ethers.provider.getBlockNumber();
    const gross = accrued(E(20), d, now);
    expect(await c.vault.pendingUserAero(a1)).to.equal(gross - gross * 2000n / 10000n);
  });
});

describe("Aero vault: early-unstake penalty window", function () {
  it("exposes the window (library view), skips a claim inside it, refuses the keeper's rebalance inside it", async () => {
    const c = await fixture();
    const id = await c.deposit(c.alice, 10, 10);
    const d = await c.gauge.depositBlock(id);
    expect(await c.vaultLib.penaltyFreeBlock(c.gauge.target, id)).to.equal(d + 5n);
    // claim inside the window: nothing forfeited, nothing paid from the gauge
    const rc = await (await c.vault.connect(c.alice).claimRewards({ tokenId: id, aeroToBPath: "0x", amountBMin: 0, deadline: FAR })).wait();
    expect(events(c.vault, rc, "RewardsEarned").length).to.equal(0);
    expect(await c.voter.forfeited()).to.equal(0n);
    await expect(c.vault.connect(c.keeper).rebalance(c.rebalanceParams(id))).to.be.revertedWithCustomError(c.vaultLib, "StakeTooRecent");
    await mine(5);
    await c.vault.connect(c.keeper).rebalance(c.rebalanceParams(id));
    expect(await c.voter.forfeited()).to.equal(0n);
  });

  it("a rebalanced position starts a new window, already covered by the interval rail; a migrated-in position is guarded by the window", async () => {
    const c = await fixture();
    const id = await c.deposit(c.alice, 10, 10);
    await mine(6);
    const newId = mintedId(c.vault, await (await c.vault.connect(c.keeper).rebalance(c.rebalanceParams(id))).wait());
    expect(await c.vaultLib.penaltyFreeBlock(c.gauge.target, newId)).to.equal((await c.gauge.depositBlock(newId)) + 5n);
    await expect(c.vault.connect(c.keeper).rebalance(c.rebalanceParams(newId))).to.be.revertedWithCustomError(c.Vault, "RebalanceTooSoon");
    await increaseTime(RAILS.minRebalanceInterval); // one block later: the hour has passed, the window has not
    await expect(c.vault.connect(c.keeper).rebalance(c.rebalanceParams(newId))).to.be.revertedWithCustomError(c.vaultLib, "StakeTooRecent");
    await mine(5);
    await c.vault.connect(c.keeper).rebalance(c.rebalanceParams(newId));
    expect(await c.voter.forfeited()).to.equal(0n);
    // a position that just arrived by migration has no rebalance clock: only the window stops an instant rebalance
    const live = await (await ethers.getContractFactory("MockLiveVault")).deploy(c.weth.target, c.usdc.target);
    await c.registry.addVault(live.target);
    await c.weth.mint(live.target, E(5)); await c.usdc.mint(live.target, E(5));
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["int24", "int24", "bool", "uint256", "uint256", "uint256", "uint256", "uint256"], [LO, HI, false, 0, 0, 0, 0, FAR]);
    const mid = mintedId(c.vault, await (await live.migrateOut(c.vault.target, c.bob.address, E(5), E(5), false, data)).wait());
    await expect(c.vault.connect(c.keeper).rebalance(c.rebalanceParams(mid))).to.be.revertedWithCustomError(c.vaultLib, "StakeTooRecent");
  });

  it("never blocks an owner's exit: withdraw, emergency exit, raw NFT and migrate-out work inside the window (principal in full)", async () => {
    const c = await fixture();
    const v2 = await c.deployVault();
    await c.registry.addVault(v2.target);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await c.deposit(c.alice, 10, 10));
    // each exit inside its position's window
    await c.vault.connect(c.alice).withdrawPosition(c.withdrawParams(ids[3]));
    await c.vault.connect(c.alice).emergencyWithdraw(ids[2]);
    await c.vault.connect(c.alice).withdrawRawNft(ids[1]);
    expect(await c.nfpm.ownerOf(ids[1])).to.equal(c.alice.address);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["int24", "int24", "bool", "uint256", "uint256", "uint256", "uint256", "uint256"], [LO, HI, false, 0, 0, 0, 0, FAR]);
    await c.vault.connect(c.alice).migrate({ tokenId: ids[0], toVault: v2.target, decreaseAmount0Min: 0, decreaseAmount1Min: 0, receiveData: data, deadline: FAR });
    expect(await v2.openPositionCount()).to.equal(1n);
    expect(await c.weth.balanceOf(c.alice.address)).to.equal(E(10_000 - 20)); // 10 in v2, 10 inside the raw NFT
    expect(await c.vault.openPositionCount()).to.equal(0n);
  });

  it("an unreadable penalty config counts as no window and blocks nothing", async () => {
    const c = await fixture();
    const id = await c.deposit(c.alice, 10, 10);
    await c.gfac.setBroken(true);
    expect(await c.vaultLib.penaltyFreeBlock(c.gauge.target, id)).to.equal(0n);
    await c.gfac.setBroken(false);
    await c.gfac.setPenalty(0, 1e6);
    expect(await c.vaultLib.penaltyFreeBlock(c.gauge.target, id)).to.equal(0n);
    await c.vault.connect(c.keeper).rebalance(c.rebalanceParams(id));
  });
});

describe("Aero vault: keeper rebalance and auto-compound", function () {
  it("rebalance: new range, same owner, rewards paid raw (fee taken), leftovers reserved, guard rails enforced", async () => {
    const c = await fixture();
    const id = await c.deposit(c.alice, 10, 12);
    await mine(10);
    await expect(c.vault.connect(c.bob).rebalance(c.rebalanceParams(id))).to.be.revertedWithCustomError(c.Vault, "Unauthorized");
    await expect(c.vault.connect(c.keeper).rebalance(c.rebalanceParams(id, { lo: -20050, hi: 20050 }))).to.be.revertedWithCustomError(c.vaultLib, "RangeTooWide");
    await c.pool.setSpot(150);
    await expect(c.vault.connect(c.keeper).rebalance(c.rebalanceParams(id))).to.be.revertedWithCustomError(c.vaultLib, "SpotFarFromTwap");
    await c.pool.setSpot(0);
    const d = Number(await c.gauge.depositBlock(id));
    const before = await c.aero.balanceOf(c.alice.address);
    const rc = await (await c.vault.connect(c.keeper).rebalance(c.rebalanceParams(id, { isAToB: false, swapIn: E(1) }))).wait();
    const newId = mintedId(c.vault, rc);
    const gross = accrued(E(20), d, rc.blockNumber);
    expect((await c.aero.balanceOf(c.alice.address)) - before).to.equal(gross - gross * 2000n / 10000n);
    expect((await c.vault.positionInfo(newId)).owner).to.equal(c.alice.address);
    expect((await c.vault.positionInfo(id)).owner).to.equal(ethers.ZeroAddress);
    expect(await c.gauge.stakedContains(c.vault.target, newId)).to.equal(true);
    expect(await c.vault.lastRebalanceAt(newId)).to.be.gt(0n);
  });

  it("auto-compound: the position's AERO is swapped along the fixed route into its own liquidity", async () => {
    const c = await fixture();
    const id = await c.deposit(c.alice, 10, 10, { ac: true });
    await mine(30);
    const rc = await (await c.vault.connect(c.keeper).rebalance(c.rebalanceParams(id))).wait();
    const comp = events(c.vault, rc, "RewardsCompounded");
    expect(comp.length).to.equal(1);
    expect(comp[0].amountOut).to.be.gt(0n);
    const newId = mintedId(c.vault, rc);
    expect(await liqOf(c, newId) + (await c.vault.reserves(newId)).a + (await c.vault.reserves(newId)).b).to.be.gt(E(20));
    expect(await c.aero.balanceOf(c.alice.address)).to.equal(0n);
  });

  it("pause switches are read from the registry: rebalances paused -> refused; deposits paused -> refused", async () => {
    const c = await fixture();
    const id = await c.deposit(c.alice, 10, 10);
    await mine(6);
    await c.registry.connect(c.safety).setRebalancesPaused(true);
    await expect(c.vault.connect(c.keeper).rebalance(c.rebalanceParams(id))).to.be.revertedWithCustomError(c.Vault, "RebalancesPaused");
    await c.registry.connect(c.safety).setDepositsPaused(true);
    await expect(c.deposit(c.alice, 1, 1)).to.be.revertedWithCustomError(c.Vault, "DepositsClosed");
    // withdrawals are never paused
    await c.vault.connect(c.alice).withdrawPosition(c.withdrawParams(id));
  });
});

describe("Aero vault: migrations", function () {
  it("accepts a migration from a live-vault-shaped caller (same call the deployed 0x6198...93a8 makes)", async () => {
    const c = await fixture();
    const live = await (await ethers.getContractFactory("MockLiveVault")).deploy(c.weth.target, c.usdc.target);
    await c.weth.mint(live.target, E(7));
    await c.usdc.mint(live.target, E(9));
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["int24", "int24", "bool", "uint256", "uint256", "uint256", "uint256", "uint256"], [LO, HI, false, E(1), 0, 0, 0, FAR]);
    // not registered yet: refused
    await expect(live.migrateOut(c.vault.target, c.carol.address, E(7), E(9), true, data)).to.be.revertedWithCustomError(c.Vault, "Unauthorized");
    await c.registry.addVault(live.target);
    const before = await c.usdc.balanceOf(c.carol.address);
    const rc = await (await live.migrateOut(c.vault.target, c.carol.address, E(7), E(9), true, data)).wait();
    const id = mintedId(c.vault, rc);
    const info = await c.vault.positionInfo(id);
    expect(info.owner).to.equal(c.carol.address);
    expect(info.autoCompound).to.equal(true);
    expect(events(c.vault, rc, "MigratedIn")[0].fromVault).to.equal(live.target);
    expect(await liqOf(c, id)).to.equal(E(16)); // 8 + 8 after the balancing swap at TWAP
    expect(await c.usdc.balanceOf(c.carol.address)).to.equal(before);
    // deposits closed on the new vault -> the live vault's migrate() reverts as a whole (nothing moves)
    await c.registry.setVaultDepositsOpen(c.vault.target, false);
    await c.weth.mint(live.target, E(1)); await c.usdc.mint(live.target, E(1));
    await expect(live.migrateOut(c.vault.target, c.carol.address, E(1), E(1), false, data)).to.be.revertedWithCustomError(c.Vault, "DepositsClosed");
  });

  it("migrate out to another registered vault: rewards paid, no deposit/withdraw toll, the other vault opens the position", async () => {
    const c = await fixture();
    const v2 = await c.deployVault();
    await c.registry.addVault(v2.target);
    const id = await c.deposit(c.alice, 10, 10, { ac: true });
    await mine(10);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["int24", "int24", "bool", "uint256", "uint256", "uint256", "uint256", "uint256"], [LO, HI, false, 0, 0, 0, 0, FAR]);
    const rc = await (await c.vault.connect(c.alice).migrate({ tokenId: id, toVault: v2.target, decreaseAmount0Min: 0, decreaseAmount1Min: 0, receiveData: data, deadline: FAR })).wait();
    expect(events(c.vault, rc, "MigratedOut").length).to.equal(1);
    expect(await c.aero.balanceOf(c.alice.address)).to.be.gt(0n);
    expect(await v2.openPositionCount()).to.equal(1n);
    expect((await v2.positionInfo(await v2.openPositionAt(0))).autoCompound).to.equal(true);
  });
});

describe("Aero vault: shutdown and forceExit", function () {
  it("after shutdown: no deposits, no rebalances, no fees; forceExit pushes tokens + AERO to each owner", async () => {
    const c = await fixture();
    const a1 = await c.deposit(c.alice, 10, 12);
    const b1 = await c.deposit(c.bob, 5, 5);
    await mine(10);
    await c.registry.connect(c.safe).shutdownVault(c.vault.target);
    await expect(c.deposit(c.carol, 1, 1)).to.be.revertedWithCustomError(c.Vault, "DepositsClosed");
    await expect(c.vault.connect(c.keeper).rebalance(c.rebalanceParams(a1))).to.be.revertedWithCustomError(c.Vault, "VaultIsShutdown");
    await expect(c.vault.connect(c.bob).forceExit([a1])).to.be.revertedWithCustomError(c.Vault, "Unauthorized");
    const fees = await c.aeroOf(c.feeRecipients);
    const da = Number(await c.gauge.depositBlock(a1)), db = Number(await c.gauge.depositBlock(b1));
    const rc = await (await c.vault.connect(c.safe).forceExit([a1, b1, 999])).wait();
    expect(events(c.vault, rc, "ForceExited").length).to.equal(2);
    expect(await c.aero.balanceOf(c.alice.address)).to.equal(accrued(E(20), da, rc.blockNumber));
    expect(await c.aero.balanceOf(c.bob.address)).to.equal(accrued(E(10), db, rc.blockNumber));
    expect(await c.aeroOf(c.feeRecipients)).to.deep.equal(fees);
    expect(await c.weth.balanceOf(c.alice.address)).to.equal(E(10_000));
    expect(await c.usdc.balanceOf(c.alice.address)).to.equal(E(10_000));
    expect(await c.vault.openPositionCount()).to.equal(0n);
  });
});

describe("Aero vault: fee legs on principal (when the policy sets them)", function () {
  it("deposit, withdraw and swap fees follow the live policy's legs and the vault's ceilings", async () => {
    const c = await fixture();
    await c.policy.setBasePandaBps(1, 50); // deposit 0.50%
    await c.policy.setBasePandaBps(2, 500); // withdraw 5% asked, vault ceiling 2.00%
    const tBefore = await c.weth.balanceOf(c.treasury.address), cBefore = await c.weth.balanceOf(c.company.address);
    const id = await c.deposit(c.alice, 100, 100);
    const depFee = (await c.weth.balanceOf(c.treasury.address)) - tBefore + (await c.weth.balanceOf(c.company.address)) - cBefore;
    expect(depFee).to.equal(E(100) * 50n / 10000n);
    expect(await c.vault.feeBps(2, c.alice.address)).to.equal(200n);
    await c.vault.connect(c.alice).withdrawPosition(c.withdrawParams(id));
    const total = (await c.weth.balanceOf(c.treasury.address)) - tBefore + (await c.weth.balanceOf(c.company.address)) - cBefore;
    expect(total - depFee).to.equal((E(100) - depFee) * 200n / 10000n);
  });
});

describe("Contract sizes (EIP-170: 24,576 bytes deployed)", function () {
  it("every contract and library is under the limit", async () => {
    const names = ["PandaVault", "PandaVaultLib", "PandaTopUpLib", "PandaRegistry", "PandaFeePolicyV3", "PandaReferrals", "PandaTimelock", "PandaTvlReader", "PandaFeePolicy"];
    for (const n of names) {
      const art = await hre.artifacts.readArtifact(n);
      const size = (art.deployedBytecode.length - 2) / 2;
      console.log(`      ${n.padEnd(18)} ${size} bytes (${24576 - size} free)`);
      expect(size).to.be.lte(24576);
    }
  });
});
