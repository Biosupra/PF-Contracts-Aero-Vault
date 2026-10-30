// Unit tests (plain Hardhat network, no fork) for the fee policy v3 companions: PandaReferrals' bounded position check
// and PandaTvlReader's paginated daily sample. The fork tests (staking repo e2e_rewards_fork.js, this repo's
// rehearse-v3-fork.js) cover them against the real vault; these cover the edges a fork can't reach cheaply (over a
// thousand positions, positions moving mid-sample, a stale sample, several vaults). Run: npx hardhat test
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const LINE_AT = [0, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000];
const ENTER_AT = [0, 26_563, 53_334, 115_385, 295_455, 550_000, 1_111_112, 2_812_500];
const H = 3600;
async function bump(sec) { await network.provider.send("evm_increaseTime", [sec]); await network.provider.send("evm_mine"); }
// test setup in batches (one transaction can't write a thousand positions)
async function addMany(v, firstId, count, owner) { for (let i = 0; i < count; i += 200) await v.addMany(firstId + i, Math.min(200, count - i), owner); }

async function world(vaultSpecs) {
  const [deployer, owner, a, b, c] = await ethers.getSigners();
  const list = await (await ethers.getContractFactory("MockVaultList")).deploy();
  const nfpm = await (await ethers.getContractFactory("MockNfpm")).deploy();
  const tokenB = await (await ethers.getContractFactory("MockToken6")).deploy();
  const vaults = [];
  for (const spec of vaultSpecs) {
    const v = await (await ethers.getContractFactory("MockVaultPositions")).deploy(nfpm.target, tokenB.target, spec.twap ?? 0);
    await list.add(v.target);
    vaults.push(v);
  }
  return { deployer, owner, a, b, c, list, nfpm, tokenB, vaults };
}

describe("PandaReferrals: the position check is bounded", function () {
  this.timeout(600000);

  it("enforces the rule in full up to 1,000 positions and stops reading after that", async function () {
    const w = await world([{}]);
    const v = w.vaults[0];
    // 1,005 open positions; a at index 3, b at index 1,003 (past the bound)
    await addMany(v, 1, 3, w.c.address);
    await v.addPosition(4, w.a.address, 0, 0);
    await addMany(v, 5, 999, w.c.address); // indexes 4..1002
    await v.addPosition(2000, w.b.address, 0, 0); // index 1003
    await v.addPosition(2001, w.c.address, 0, 0);
    expect(await v.openPositionCount()).to.equal(1005n);
    const refs = await (await ethers.getContractFactory("PandaReferrals")).deploy(w.list.target, [], []);
    expect(await refs.MAX_CHECKED_POSITIONS()).to.equal(1000n);
    expect(await refs.hasPosition(w.a.address)).to.equal(true);
    expect(await refs.hasPosition(w.b.address)).to.equal(false); // beyond the bound: not read
    await expect(refs.connect(w.a).accept(w.owner.address)).to.be.revertedWithCustomError(refs, "AlreadyDeposited");
    const tx = await refs.connect(w.b).accept(w.owner.address);
    const r = await tx.wait();
    expect(r.gasUsed).to.be.lessThan(16_777_216n);
    expect(await refs.referrerOf(w.b.address)).to.equal(w.owner.address);
    // the worst case reads exactly 1,000 positions, inside Base's per-transaction cap
    const fresh = ethers.Wallet.createRandom().address;
    const g = await refs.hasPosition.estimateGas(fresh);
    expect(g).to.be.lessThan(16_777_216n);
  });

  it("counts positions across vaults toward the same bound, in registry order", async function () {
    const w = await world([{}, {}]);
    await addMany(w.vaults[0], 1, 600, w.c.address);
    await addMany(w.vaults[1], 10_000, 399, w.c.address);
    await w.vaults[1].addPosition(20_000, w.a.address, 0, 0); // the 1,000th position read: still checked
    await w.vaults[1].addPosition(20_001, w.b.address, 0, 0); // the 1,001st: not read
    const refs = await (await ethers.getContractFactory("PandaReferrals")).deploy(w.list.target, [], []);
    expect(await refs.hasPosition(w.a.address)).to.equal(true);
    expect(await refs.hasPosition(w.b.address)).to.equal(false);
  });

  it("keeps the seed rules and the other accept rules", async function () {
    const w = await world([{}]);
    const F = await ethers.getContractFactory("PandaReferrals");
    await expect(F.deploy(w.list.target, [w.a.address], [w.a.address])).to.be.revertedWithCustomError(F, "BadReferrer");
    await expect(F.deploy(w.list.target, [w.a.address, w.b.address], [w.b.address, w.a.address])).to.be.revertedWithCustomError(F, "BadReferrer");
    await expect(F.deploy(w.list.target, [w.a.address, w.a.address], [w.b.address, w.c.address])).to.be.revertedWithCustomError(F, "AlreadyReferred");
    const refs = await F.deploy(w.list.target, [w.a.address], [w.b.address]);
    expect(await refs.totalReferrals()).to.equal(1n);
    await expect(refs.connect(w.a).accept(w.c.address)).to.be.revertedWithCustomError(refs, "AlreadyReferred");
    await expect(refs.connect(w.b).accept(w.a.address)).to.be.revertedWithCustomError(refs, "BadReferrer"); // mutual
    await expect(refs.connect(w.c).accept(w.c.address)).to.be.revertedWithCustomError(refs, "BadReferrer"); // self
    await expect(refs.connect(w.c).accept(ethers.ZeroAddress)).to.be.revertedWithCustomError(refs, "BadReferrer");
  });
});

describe("PandaTvlReader: paginated daily sample", function () {
  this.timeout(600000);

  async function readerWith(vaultSpecs, fill) {
    const w = await world(vaultSpecs);
    await fill(w);
    const R = await ethers.getContractFactory("PandaTvlReader");
    const reader = await R.deploy(w.list.target, w.deployer.address, LINE_AT, ENTER_AT, 0);
    return { w, reader };
  }
  // positions worth ~$1,000 each in token B (6 decimals) at twap 0 (price 1): liquidity 0, reserves only, so values are exact
  const fillReserves = (counts) => async (w) => {
    for (let v = 0; v < counts.length; v++) for (let i = 0; i < counts[v]; i++) await w.vaults[v].addPosition(v * 100_000 + i + 1, w.c.address, 0, 1_000_000_000n);
  };

  it("a sample taken in pieces equals the one-shot sample and the view, to the unit", async function () {
    const { reader } = await readerWith([{}, {}, {}], fillReserves([23, 0, 17]));
    expect(await reader.totalValue()).to.equal(40_000n);
    // pieces of 7 positions: 6 transactions (23 + 17 = 40 positions; the empty vault costs nothing)
    let done = false, n = 0, events = 0;
    while (!done) {
      const r = await (await reader["poke(uint256)"](7)).wait();
      n++;
      const s = r.logs.map((l) => { try { return reader.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
      events += s.filter((e) => e.name === "SweepProgress").length;
      done = s.some((e) => e.name === "Sampled");
      if (n > 10) throw new Error("did not finish");
    }
    expect(n).to.equal(6);
    expect(events).to.equal(5);
    expect(await reader.lastTotal()).to.equal(40_000n);
    expect(await reader.sampleCount()).to.equal(1n);
    const [inProgress] = await reader.sweeping();
    expect(inProgress).to.equal(false);
    // the next sample can't start for 20 h; one-shot poke() then gives the same total
    await expect(reader["poke()"]()).to.be.revertedWithCustomError(reader, "TooSoon");
    await expect(reader["poke(uint256)"](5)).to.be.revertedWithCustomError(reader, "TooSoon");
    await bump(20 * H);
    await reader["poke()"]();
    expect(await reader.lastTotal()).to.equal(40_000n);
    expect(await reader.sampleCount()).to.equal(2n);
  });

  it("a sample in progress continues without waiting, a stale one restarts, and a zero batch is refused", async function () {
    const { w, reader } = await readerWith([{}], fillReserves([30]));
    await expect(reader["poke(uint256)"](0)).to.be.revertedWithCustomError(reader, "ZeroBatch");
    await reader["poke(uint256)"](10); // 10 of 30
    expect((await reader.sweeping())[0]).to.equal(true);
    expect(await reader.sampleCount()).to.equal(0n);
    await reader["poke(uint256)"](10); // 20 of 30: continuing never waits for the 20 h
    await bump(6 * H + 60); // stale: the next call throws the partial sample away and starts again
    await reader["poke(uint256)"](10);
    const [, vi, pi] = await reader.sweeping();
    expect(vi).to.equal(0n);
    expect(pi).to.equal(10n);
    await reader["poke(uint256)"](100);
    expect(await reader.sampleCount()).to.equal(1n);
    expect(await reader.lastTotal()).to.equal(30_000n);
  });

  it("positions closed mid-sample are counted at most once; opened ones once", async function () {
    const { w, reader } = await readerWith([{}], fillReserves([10]));
    await reader["poke(uint256)"](5); // counted ids 1..5
    await w.vaults[0].removeAt(2); // closes id 3 (counted); id 10 moves into index 2 (already passed): missed
    await w.vaults[0].addPosition(99, w.c.address, 0, 1_000_000_000n); // opened: counted at the end
    await reader["poke(uint256)"](100);
    // counted 1..5 (5) + indexes 5..9 of the new list: ids 6,7,8,9,99 (5) = 10 positions; id 10 missed, id 3 counted once
    expect(await reader.lastTotal()).to.equal(10_000n);
  });

  it("values liquidity at the TWAP and refuses a sample when a vault's TWAP can't be read", async function () {
    const { w, reader } = await readerWith([{ twap: 0 }], async (w) => {
      await w.vaults[0].addPosition(1, w.c.address, 0, 0);
      await w.nfpm.set(1, -1000, 1000, 10n ** 12n); // in range at tick 0: both tokens
    });
    const v = await reader.totalValue();
    expect(v).to.be.greaterThan(0n);
    await w.vaults[0].setTwapBroken(true);
    await expect(reader["poke()"]()).to.be.revertedWith("TwapUnavailable");
    expect(await reader.sampleCount()).to.equal(0n); // nothing recorded; the stage simply doesn't move
  });

  it("the stage rules are unchanged: seven samples, recovery level up, line down, one step a week", async function () {
    const { w, reader } = await readerWith([{}], fillReserves([30])); // $30,000 each sample
    for (let i = 0; i < 6; i++) { await reader["poke(uint256)"](11); await reader["poke(uint256)"](11); await reader["poke(uint256)"](11); await bump(20 * H); }
    expect(await reader.sampleCount()).to.equal(6n);
    expect(await reader.stage()).to.equal(0n);
    await reader["poke()"](); // 7th sample: average $30,000 >= $26,563 -> stage 1
    expect(await reader.stage()).to.equal(1n);
    await bump(20 * H);
    await reader["poke()"](); // not above $53,334 anyway, and inside the week
    expect(await reader.stage()).to.equal(1n);
    // the vault shrinks below the $25,000 line: down one step, but only a week after the last step
    for (let i = 0; i < 10; i++) await w.vaults[0].removeAt(0);
    for (let d = 0; d < 30; d++) { await bump(20 * H); await reader["poke()"](); if ((await reader.stage()) === 0n) break; }
    expect(await reader.stage()).to.equal(0n);
  });
});
