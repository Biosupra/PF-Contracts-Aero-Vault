// Unit tests on the plain Hardhat network (no fork): registry bounds, bootstrap, timelock flow, the fee
// policy (tiers from token + Pass stakes), the vault's fee plumbing against hostile policies, and the
// "no admin fund-control surface" ABI checks. Run: npx hardhat test
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const DAY = 86400n;
const RAILS = { maxRebalanceSlippageBps: 100, twapWindow: 300, minRebalanceInterval: 3600, maxRangeSpacings: 40, maxTwapDeviationTicks: 100 };
const cfg = (o = {}) => ({
  keeper: o.keeper, daoTreasury: o.daoTreasury, safetyModule: o.safetyModule, emergencyAdmin: o.emergencyAdmin,
  guardRails: { ...RAILS, ...(o.guardRails || {}) },
});
const KIND = { REWARD: 0, DEPOSIT: 1, WITHDRAW: 2, ZAP_SWAP: 3, REBALANCE_SWAP: 4, COMPOUND_SWAP: 5, TIME: 6 };
const LAUNCH_BASE = [1900, 0, 0, 0, 0, 0, 0]; // Panda's rate per kind at launch (matches the live vault); time fee 0
// Owner's published company : treasury schedule (2026-10-01): Stage 1 15:4, from $50k 11:8, from $500k 8:11.
const STAGES = [
  { minVaultUsd: 0, companyWeight: 15, treasuryWeight: 4 },
  { minVaultUsd: 50000, companyWeight: 11, treasuryWeight: 8 },
  { minVaultUsd: 500000, companyWeight: 8, treasuryWeight: 11 },
];
// The reward-fee tiers the Pass / PANDA launch batch sets (Panda's part; the keeper's 1% comes on top):
// staked Pass 15% total, Pass + 1M PANDA 12%, Pass + 5M PANDA 10%, 2.5M PANDA without a Pass 15%, and a staked
// special-edition Pass (Pass level 2; owner 2026-10-03) 10% on its own.
// Every other kind 10000 = "no discount" (the tier never lowers it, so a later time fee or toll applies in full).
const TIER = (minStake, minPasses, reward) => ({ minStake: ethers.parseEther(String(minStake)), minPasses, pandaBps: [reward, 10000, 10000, 10000, 10000, 10000, 10000] });
const LAUNCH_TIERS = [TIER(0, 1, 1400), TIER(1_000_000, 1, 1100), TIER(5_000_000, 1, 900), TIER(2_500_000, 0, 1400), TIER(0, 2, 900)];

async function increaseTime(sec) {
  await network.provider.send("evm_increaseTime", [Number(sec)]);
  await network.provider.send("evm_mine");
}

async function impersonate(addr) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}

// Schedule + execute one call through the timelock as the multisig.
async function viaTimelock(timelock, safe, target, data, delay) {
  const salt = ethers.hexlify(ethers.randomBytes(32));
  await timelock.connect(safe).schedule(target, 0, data, ethers.ZeroHash, salt, delay);
  await increaseTime(delay);
  return timelock.connect(safe).execute(target, 0, data, ethers.ZeroHash, salt);
}

const writes = (iface) => iface.fragments
  .filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
  .map((f) => f.name).sort();

describe("PandaRegistry + PandaTimelock", function () {
  let deployer, safe, keeper, treasury, safety, user, other, vaultA, vaultB;
  let timelock, registry;
  const DELAY = 2n * DAY;
  const rails = (o = {}) => ({ ...RAILS, ...o });

  beforeEach(async () => {
    [deployer, safe, keeper, treasury, safety, user, other, vaultA, vaultB] = await ethers.getSigners();
    timelock = await (await ethers.getContractFactory("PandaTimelock")).deploy(DELAY, [safe.address], [safe.address], ethers.ZeroAddress);
    registry = await (await ethers.getContractFactory("PandaRegistry")).deploy(
      timelock.target, cfg({ keeper: keeper.address, daoTreasury: treasury.address, safetyModule: safety.address, emergencyAdmin: safe.address }));
  });

  it("is owned by the timelock and rejects direct calls from the multisig or anyone else", async () => {
    expect(await registry.owner()).to.equal(timelock.target);
    expect(await registry.emergencyAdmin()).to.equal(safe.address);
    await expect(registry.connect(safe).setKeeper(other.address)).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    await expect(registry.connect(deployer).setKeeper(other.address)).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    await expect(registry.connect(safe).setDefaultGuardRails(rails())).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    await expect(registry.connect(safe).setEmergencyAdmin(other.address)).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
  });

  it("changes addresses only through a scheduled, delayed timelock operation", async () => {
    const data = registry.interface.encodeFunctionData("setKeeper", [other.address]);
    const salt = ethers.ZeroHash;
    await timelock.connect(safe).schedule(registry.target, 0, data, ethers.ZeroHash, salt, DELAY);
    await expect(timelock.connect(safe).execute(registry.target, 0, data, ethers.ZeroHash, salt))
      .to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    expect(await registry.keeper()).to.equal(keeper.address);
    await increaseTime(DELAY);
    await timelock.connect(safe).execute(registry.target, 0, data, ethers.ZeroHash, salt);
    expect(await registry.keeper()).to.equal(other.address);
    await viaTimelock(timelock, safe, registry.target, registry.interface.encodeFunctionData("setEmergencyAdmin", [other.address]), DELAY);
    expect(await registry.emergencyAdmin()).to.equal(other.address);
  });

  it("refuses a shorter delay than the timelock minimum and refuses schedules from non-proposers", async () => {
    const data = registry.interface.encodeFunctionData("setKeeper", [other.address]);
    await expect(timelock.connect(safe).schedule(registry.target, 0, data, ethers.ZeroHash, ethers.ZeroHash, DELAY - 1n))
      .to.be.revertedWithCustomError(timelock, "TimelockInsufficientDelay");
    await expect(timelock.connect(other).schedule(registry.target, 0, data, ethers.ZeroHash, ethers.ZeroHash, DELAY))
      .to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
  });

  it("enforces hard bounds on every guard rail, default and per vault, even for the owner", async () => {
    const tl = await impersonate(timelock.target);
    await registry.connect(deployer).addVault(vaultA.address);
    const bad = [
      { maxRebalanceSlippageBps: 301 }, { maxRebalanceSlippageBps: 0 }, { twapWindow: 59 }, { twapWindow: 3601 },
      { minRebalanceInterval: 86401 }, { minRebalanceInterval: 899 }, { minRebalanceInterval: 0 }, { maxRangeSpacings: 0 }, { maxRangeSpacings: 1001 },
      { maxTwapDeviationTicks: 0 }, { maxTwapDeviationTicks: 501 },
    ];
    for (const b of bad) {
      await expect(registry.connect(tl).setDefaultGuardRails(rails(b))).to.be.revertedWithCustomError(registry, "OutOfBounds");
      await expect(registry.connect(tl).setVaultGuardRails(vaultA.address, rails(b))).to.be.revertedWithCustomError(registry, "OutOfBounds");
    }
    await registry.connect(tl).setDefaultGuardRails(rails({ maxRebalanceSlippageBps: 300, twapWindow: 60, minRebalanceInterval: 900, maxRangeSpacings: 1000, maxTwapDeviationTicks: 500 }));
    expect((await registry.guardRailsOf(vaultA.address)).maxTwapDeviationTicks).to.equal(500);
    await expect(registry.connect(tl).setKeeper(ethers.ZeroAddress)).to.be.revertedWithCustomError(registry, "ZeroAddress");
  });

  it("per-vault keeper and guard rails, falling back to the defaults (BTC can differ from ETH)", async () => {
    const tl = await impersonate(timelock.target);
    await registry.connect(deployer).addVault(vaultA.address);
    await registry.connect(deployer).addVault(vaultB.address);
    expect(await registry.keeperOf(vaultA.address)).to.equal(keeper.address);
    await registry.connect(tl).setVaultKeeper(vaultB.address, other.address);
    expect(await registry.keeperOf(vaultB.address)).to.equal(other.address);
    expect(await registry.keeperOf(vaultA.address)).to.equal(keeper.address);
    await registry.connect(tl).setVaultGuardRails(vaultB.address, rails({ maxRangeSpacings: 80, maxTwapDeviationTicks: 200 }));
    expect((await registry.guardRailsOf(vaultB.address)).maxRangeSpacings).to.equal(80);
    expect((await registry.guardRailsOf(vaultA.address)).maxRangeSpacings).to.equal(40);
    await registry.connect(tl).clearVaultGuardRails(vaultB.address);
    expect((await registry.guardRailsOf(vaultB.address)).maxRangeSpacings).to.equal(40);
    await registry.connect(tl).setVaultKeeper(vaultB.address, ethers.ZeroAddress);
    expect(await registry.keeperOf(vaultB.address)).to.equal(keeper.address);
    await expect(registry.connect(tl).setVaultKeeper(user.address, other.address)).to.be.revertedWithCustomError(registry, "NotAVault");
  });

  it("rejects an out-of-bounds initial config in the constructor", async () => {
    const F = await ethers.getContractFactory("PandaRegistry");
    await expect(F.deploy(timelock.target, cfg({ keeper: keeper.address, daoTreasury: treasury.address, safetyModule: safety.address, emergencyAdmin: safe.address, guardRails: { maxTwapDeviationTicks: 0 } })))
      .to.be.revertedWithCustomError(F, "OutOfBounds");
    await expect(F.deploy(timelock.target, cfg({ keeper: ethers.ZeroAddress, daoTreasury: treasury.address, safetyModule: safety.address, emergencyAdmin: safe.address })))
      .to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(timelock.target, cfg({ keeper: keeper.address, daoTreasury: treasury.address, safetyModule: safety.address, emergencyAdmin: ethers.ZeroAddress })))
      .to.be.revertedWithCustomError(F, "ZeroAddress");
  });

  it("lets only the safety module or the timelock pause deposits and rebalances", async () => {
    await expect(registry.connect(user).setDepositsPaused(true)).to.be.revertedWithCustomError(registry, "Unauthorized");
    await registry.connect(safety).setDepositsPaused(true);
    expect(await registry.depositsPaused()).to.equal(true);
    await registry.connect(safety).setRebalancesPaused(true);
    expect(await registry.rebalancesPaused()).to.equal(true);
    await registry.connect(safety).setDepositsPaused(false);
    await registry.connect(safety).setRebalancesPaused(false);
    expect(await registry.depositsPaused()).to.equal(false);
  });

  it("KILL SWITCH: only the emergency admin (the Safe), no timelock; per vault or everything; permanent", async () => {
    await registry.connect(deployer).addVault(vaultA.address);
    await registry.connect(deployer).addVault(vaultB.address);
    const tl = await impersonate(timelock.target);
    for (const who of [tl, safety, keeper, user]) {
      await expect(registry.connect(who).shutdownVault(vaultA.address)).to.be.revertedWithCustomError(registry, "Unauthorized");
      await expect(registry.connect(who).shutdownAll()).to.be.revertedWithCustomError(registry, "Unauthorized");
    }
    await expect(registry.connect(safe).shutdownVault(vaultA.address)).to.emit(registry, "VaultShutdown").withArgs(vaultA.address, safe.address);
    expect(await registry.isShutdown(vaultA.address)).to.equal(true);
    expect(await registry.isShutdown(vaultB.address)).to.equal(false);
    expect(await registry.activeVaults()).to.deep.equal([vaultB.address]);
    await expect(registry.connect(safe).shutdownVault(vaultA.address)).to.be.revertedWithCustomError(registry, "AlreadyShutdown");
    await expect(registry.connect(safe).shutdownAll()).to.emit(registry, "PlatformShutdown").withArgs(safe.address);
    expect(await registry.isShutdown(vaultB.address)).to.equal(true);
    expect(await registry.activeVaults()).to.deep.equal([]);
    await expect(registry.connect(safe).shutdownAll()).to.be.revertedWithCustomError(registry, "AlreadyShutdown");
    // No function exists to undo it.
    const names = registry.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    for (const undo of ["unshutdown", "restart", "resume", "setShutdown", "reopen"]) expect(names).to.not.include(undo);
  });

  it("bootstrap: deployer can register vaults, per-vault settings and the fee policy until finishBootstrap", async () => {
    await registry.connect(deployer).addVault(other.address);
    expect(await registry.isVault(other.address)).to.equal(true);
    expect(await registry.activeVaults()).to.deep.equal([other.address]);
    await expect(registry.connect(deployer).addVault(other.address)).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    await expect(registry.connect(user).addVault(user.address)).to.be.revertedWithCustomError(registry, "Unauthorized");
    await registry.connect(deployer).setFeePolicy(user.address);
    await registry.connect(deployer).setVaultKeeper(other.address, user.address);
    await registry.connect(deployer).setVaultGuardRails(other.address, rails({ maxRangeSpacings: 60 }));
    await registry.connect(deployer).setVaultDepositsOpen(other.address, false);
    expect(await registry.activeVaults()).to.deep.equal([]);

    await registry.connect(deployer).finishBootstrap();
    expect(await registry.bootstrapper()).to.equal(ethers.ZeroAddress);
    await expect(registry.connect(deployer).addVault(user.address)).to.be.revertedWithCustomError(registry, "Unauthorized");
    await expect(registry.connect(deployer).setFeePolicy(other.address)).to.be.revertedWithCustomError(registry, "Unauthorized");
    await expect(registry.connect(deployer).setVaultKeeper(other.address, deployer.address)).to.be.revertedWithCustomError(registry, "Unauthorized");
    await expect(registry.connect(deployer).finishBootstrap()).to.be.revertedWithCustomError(registry, "Unauthorized");

    await viaTimelock(timelock, safe, registry.target, registry.interface.encodeFunctionData("setFeePolicy", [other.address]), DELAY);
    expect(await registry.feePolicy()).to.equal(other.address);
  });
});

describe("PandaFeePolicy (v2): keeper / company / treasury / stakers, stages, tiers, dormant time fee", function () {
  let owner, keeper, treasury, company, stakers, user, other, registry, policy, src;
  const M = (n) => ethers.parseEther(String(n)); // token amounts
  const NO = 10000; // a tier rate at 100% never lowers anything ("no discount on this kind")
  const bps7 = (x) => [x.reward ?? NO, x.dw ?? NO, x.dw ?? NO, x.zap ?? NO, x.zap ?? NO, x.zap ?? NO, x.time ?? NO];
  const legsOf = async (k, u) => (await policy.feeLegs(k, u)).map((l) => [l.to, Number(l.bps)]);

  beforeEach(async () => {
    [owner, keeper, treasury, company, stakers, user, other] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("MockFeeRegistry")).deploy();
    policy = await (await ethers.getContractFactory("PandaFeePolicy")).deploy(registry.target, owner.address, 100, LAUNCH_BASE, company.address, STAGES, 0);
    await registry.set(policy.target, keeper.address, treasury.address);
    src = await (await ethers.getContractFactory("MockDiscountSource")).deploy();
  });

  it("launch = the live 20%: keeper 1%, then the 19% split Stage 1 (company 15%, treasury 4%); nothing else, time fee dormant", async () => {
    expect(await legsOf(KIND.REWARD, user.address)).to.deep.equal([[keeper.address, 100], [company.address, 1500], [treasury.address, 400]]);
    for (const k of [1, 2, 3, 4, 5, 6]) expect((await policy.feeLegs(k, user.address)).length).to.equal(0);
    expect((await policy.feeLegs(7, user.address)).length).to.equal(0); // unknown kind: no fee, no revert
    const st = await policy.stages();
    expect(st.map((s) => [Number(s.minVaultUsd), Number(s.companyWeight), Number(s.treasuryWeight)])).to.deep.equal([[0, 15, 4], [50000, 11, 8], [500000, 8, 11]]);
  });

  it("stages move the company / treasury split (published schedule; only the owner moves it)", async () => {
    await policy.setActiveStage(1);
    expect(await legsOf(KIND.REWARD, user.address)).to.deep.equal([[keeper.address, 100], [company.address, 1100], [treasury.address, 800]]);
    await policy.setActiveStage(2);
    expect(await legsOf(KIND.REWARD, user.address)).to.deep.equal([[keeper.address, 100], [company.address, 800], [treasury.address, 1100]]);
    await expect(policy.setActiveStage(3)).to.be.revertedWithCustomError(policy, "BadStage");
    await expect(policy.connect(other).setActiveStage(0)).to.be.revertedWithCustomError(policy, "OwnableUnauthorizedAccount");
    await policy.setStages([{ minVaultUsd: 0, companyWeight: 1, treasuryWeight: 0 }], 0); // everything to the company
    expect(await legsOf(KIND.REWARD, user.address)).to.deep.equal([[keeper.address, 100], [company.address, 1900]]);
    for (const bad of [[[], 0], [Array(9).fill({ minVaultUsd: 0, companyWeight: 1, treasuryWeight: 1 }), 0], [[{ minVaultUsd: 0, companyWeight: 0, treasuryWeight: 0 }], 0], [STAGES, 3]]) {
      await expect(policy.setStages(...bad)).to.be.revertedWithCustomError(policy, "BadStages");
    }
  });

  it("recipients: treasury follows the registry, company is set by the owner (never zero)", async () => {
    await registry.set(policy.target, keeper.address, other.address);
    expect((await legsOf(KIND.REWARD, user.address))[2][0]).to.equal(other.address);
    await policy.setCompany(other.address);
    expect((await legsOf(KIND.REWARD, user.address))[1][0]).to.equal(other.address);
    await expect(policy.setCompany(ethers.ZeroAddress)).to.be.revertedWithCustomError(policy, "ZeroAddress");
  });

  it("owner's tier table (Pass 15%, Pass + 1M 12%, Pass + 5M 10%, 2.5M tokens alone 15%, special edition 10%): keeper keeps 1%, the discount is shared company : treasury in the stage ratio", async () => {
    await policy.setTiers(LAUNCH_TIERS);
    await policy.setDiscountSources(src.target, src.target);
    await policy.setActiveStage(1); // 11 : 8
    const total = async () => (await policy.feeLegs(0, user.address)).reduce((a, l) => a + Number(l.bps), 0);
    const cases = [
      [0, 0, 2000, [100, 1100, 800]],
      [M(2_499_999), 0, 2000, [100, 1100, 800]],
      [M(2_500_000), 0, 1500, [100, 810, 590]],
      [0, 1, 1500, [100, 810, 590]],
      [M(1_000_000), 1, 1200, [100, 636, 464]],
      [M(5_000_000), 1, 1000, [100, 521, 379]],
      [0, 2, 1000, [100, 521, 379]],              // a staked special edition alone: 10%
      [M(1_000_000), 2, 1000, [100, 521, 379]],   // the special's 10% is already the best tier
      [M(2_500_000), 2, 1000, [100, 521, 379]],
      [0, 50, 1000, [100, 521, 379]],             // a source reporting more is clamped to level 2 (one Pass, a special)
    ];
    for (const [stake, passes, tot, split] of cases) {
      await src.set(user.address, stake, passes);
      expect(await total()).to.equal(tot);
      expect((await legsOf(0, user.address)).map((l) => l[1])).to.deep.equal(split);
    }
    // Tier rates of 100% on the other kinds mean "no discount": the dormant time fee stays whatever the base says.
    await policy.setBasePandaBps(KIND.TIME, 200);
    expect((await policy.splitFor(KIND.TIME, user.address)).map(Number)).to.deep.equal([0, 115, 85, 0]);
  });

  it("stakers' share: a cut of the TREASURY part of reward fees only, off until switched on", async () => {
    await policy.setActiveStage(2); // 8 : 11
    await policy.setStakerRewards(stakers.address, 1000); // 10% of the treasury part
    expect(await legsOf(0, user.address)).to.deep.equal([[keeper.address, 100], [company.address, 800], [treasury.address, 990], [stakers.address, 110]]);
    await policy.setBasePandaBps(KIND.TIME, 200);
    expect((await policy.feeLegs(KIND.TIME, user.address)).map((l) => l.to)).to.not.include(stakers.address);
    await policy.setStakerRewards(ethers.ZeroAddress, 1000); // recipient 0 = off whatever the share says
    expect(await legsOf(0, user.address)).to.deep.equal([[keeper.address, 100], [company.address, 800], [treasury.address, 1100]]);
    await expect(policy.setStakerRewards(stakers.address, 10001)).to.be.revertedWithCustomError(policy, "RateTooHigh");
  });

  it("the dormant time fee: per-year rate, split company / treasury, no keeper leg", async () => {
    await policy.setBasePandaBps(KIND.TIME, 200);
    expect(await legsOf(KIND.TIME, user.address)).to.deep.equal([[company.address, 157], [treasury.address, 43]]);
  });

  it("a tier can never raise a fee above the base rate; lowering the base wins", async () => {
    await policy.setTiers([{ minStake: 0, minPasses: 0, pandaBps: bps7({ reward: 1950, dw: 200, zap: 100 }) }]);
    await policy.setDiscountSources(src.target, ethers.ZeroAddress);
    expect(await policy.pandaBpsFor(KIND.REWARD, user.address)).to.equal(1900);
    await policy.setBasePandaBps(KIND.REWARD, 1000);
    expect(await policy.pandaBpsFor(KIND.REWARD, user.address)).to.equal(1000);
  });

  it("only MATURED stake counts (the staking contracts report it); a broken source only costs the discount", async () => {
    await policy.setTiers([{ minStake: M(1000), minPasses: 0, pandaBps: bps7({ reward: 1000 }) }]);
    await policy.setDiscountSources(src.target, src.target);
    expect(await policy.pandaBpsFor(KIND.REWARD, user.address)).to.equal(1900);
    await src.set(user.address, M(1000), 0);
    expect(await policy.pandaBpsFor(KIND.REWARD, user.address)).to.equal(1000);
    await src.set(user.address, 0, 0);
    expect(await policy.pandaBpsFor(KIND.REWARD, user.address)).to.equal(1900);
    await policy.setDiscountSources(other.address, registry.target); // EOA / contract without the view
    expect(await policy.pandaBpsFor(KIND.REWARD, user.address)).to.equal(1900);
  });

  it("only the owner (timelock) configures it, and rates above 100% are refused", async () => {
    for (const call of [
      policy.connect(other).setKeeperRewardBps(0), policy.connect(other).setBasePandaBps(1, 1),
      policy.connect(other).setTiers([]), policy.connect(other).setDiscountSources(src.target, src.target),
      policy.connect(other).setStages(STAGES, 0), policy.connect(other).setCompany(other.address),
      policy.connect(other).setStakerRewards(other.address, 1),
    ]) await expect(call).to.be.revertedWithCustomError(policy, "OwnableUnauthorizedAccount");
    await expect(policy.setBasePandaBps(1, 10001)).to.be.revertedWithCustomError(policy, "RateTooHigh");
    await expect(policy.setBasePandaBps(7, 1)).to.be.revertedWithCustomError(policy, "BadKind");
    await expect(policy.setTiers(Array(13).fill({ minStake: 0, minPasses: 0, pandaBps: bps7({}) })))
      .to.be.revertedWithCustomError(policy, "TooManyTiers");
    await expect(policy.setTiers([{ minStake: 0, minPasses: 0, pandaBps: [10001, 0, 0, 0, 0, 0, 0] }])).to.be.revertedWithCustomError(policy, "RateTooHigh");
  });
});

describe("Vault fee plumbing (PandaVaultLib) against hostile fee policies", function () {
  let lib, registry, harness, token, a, b, c, user;
  const KINDS_CAPS = [[0, 2000], [1, 200], [2, 200], [3, 100], [4, 100], [5, 100], [6, 200]];

  async function usePolicy(legs) {
    const p = await (await ethers.getContractFactory("MockFeePolicy")).deploy();
    await p.setLegs(legs);
    await registry.set(p.target, ethers.ZeroAddress, ethers.ZeroAddress);
    return p;
  }
  async function useContract(name) {
    const p = await (await ethers.getContractFactory(name)).deploy();
    await registry.set(p.target, ethers.ZeroAddress, ethers.ZeroAddress);
  }

  beforeEach(async () => {
    [, a, b, c, user] = await ethers.getSigners();
    lib = await (await ethers.getContractFactory("PandaVaultLib")).deploy();
    registry = await (await ethers.getContractFactory("MockFeeRegistry")).deploy();
    harness = await (await ethers.getContractFactory("FeeHarness", { libraries: { PandaVaultLib: lib.target } })).deploy(registry.target);
    token = await (await ethers.getContractFactory("BlockingERC20")).deploy();
    await token.mint(harness.target, ethers.parseEther("1000"));
  });

  it("once the vault is shut down (kill switch) every fee is zero, whatever the policy says", async () => {
    await usePolicy([{ to: a.address, bps: 5000 }]);
    expect((await harness.legs(0, user.address)).totalBps).to.equal(2000);
    await registry.setShutdown(true);
    for (const [k] of KINDS_CAPS) expect((await harness.legs(k, user.address)).n).to.equal(0);
    const before = await token.balanceOf(harness.target);
    await harness.charge(2, user.address, token.target, ethers.parseEther("1"));
    expect(await token.balanceOf(harness.target)).to.equal(before);
  });

  it("no policy = no fee", async () => {
    const L = await harness.legs(0, user.address);
    expect(L.n).to.equal(0);
  });

  it("clamps any policy to the vault's ceilings: rewards 20%, deposit/withdraw 2.00%, swaps 1.00%, time 2.00% a year", async () => {
    await usePolicy([{ to: a.address, bps: 5000 }, { to: b.address, bps: 5000 }]);
    for (const [k, cap] of KINDS_CAPS) expect((await harness.legs(k, user.address)).totalBps).to.equal(cap);
    expect((await harness.legs(7, user.address)).totalBps).to.equal(0); // unknown kind has a 0 ceiling
    // clamping keeps legs in order: first leg gets all it can
    const L = await harness.legs(1, user.address);
    expect([L.n, L.bps[0], L.to[0]]).to.deep.equal([1n, 200n, a.address]);
  });

  it("charges exactly what the legs say, and a leg the token refuses is simply not charged", async () => {
    await usePolicy([{ to: a.address, bps: 100 }, { to: b.address, bps: 1900 }]);
    const amt = ethers.parseEther("10");
    await expect(harness.charge(0, user.address, token.target, amt)).to.changeTokenBalances(token, [a, b], [amt / 100n, amt * 19n / 100n]);
    await token.setBlocked(b.address);
    const before = await token.balanceOf(harness.target);
    await harness.charge(0, user.address, token.target, amt);
    expect(before - (await token.balanceOf(harness.target))).to.equal(amt / 100n); // only the working leg
  });

  it("ignores zero/self recipients, zero bps and legs beyond the 6th", async () => {
    await usePolicy([
      { to: ethers.ZeroAddress, bps: 10 }, { to: harness.target, bps: 10 }, { to: a.address, bps: 0 },
      { to: b.address, bps: 10 }, { to: c.address, bps: 11 }, { to: a.address, bps: 12 },
      { to: b.address, bps: 13 }, { to: c.address, bps: 14 },
    ]);
    const L = await harness.legs(0, user.address);
    // only the first six legs are read; of those b, c and a (legs 4-6) are valid
    expect([L.n, L.totalBps, L.to[0], L.to[1], L.to[2]]).to.deep.equal([3n, 33n, b.address, c.address, a.address]);
  });

  it("time fee: legs are per-year rates, charged pro rata since the checkpoint, at most 30 days, then the checkpoint clears", async () => {
    await usePolicy([{ to: a.address, bps: 150 }, { to: b.address, bps: 50 }]); // 2.00% a year
    const t2 = await (await ethers.getContractFactory("BlockingERC20")).deploy();
    await t2.mint(harness.target, ethers.parseEther("1000"));
    const YEAR = 365n * DAY;
    const amtA = ethers.parseEther("100"), amtB = ethers.parseEther("50");
    const ts = async () => BigInt((await ethers.provider.getBlock("latest")).timestamp);
    const exp = (amt, bps, secs) => (amt * secs / YEAR) * bps / 10000n;
    // 10 days owed (the charge is mined at exactly checkpoint + 10 days)
    const cp1 = (await ts()) + 100n;
    await harness.setCheckpoint(1, cp1);
    await network.provider.send("evm_setNextBlockTimestamp", [Number(cp1 + 10n * DAY)]);
    await expect(harness.chargeTime(1, user.address, token.target, t2.target, amtA, amtB))
      .to.changeTokenBalances(token, [a, b], [exp(amtA, 150n, 10n * DAY), exp(amtA, 50n, 10n * DAY)]);
    expect(await harness.timeFeeCheckpoint(1)).to.equal(0n);
    // 100 days since the checkpoint: capped at 30 days
    const cp2 = (await ts()) + 100n;
    await harness.setCheckpoint(2, cp2);
    await network.provider.send("evm_setNextBlockTimestamp", [Number(cp2 + 100n * DAY)]);
    await expect(harness.chargeTime(2, user.address, token.target, t2.target, amtA, amtB))
      .to.changeTokenBalances(t2, [a, b], [exp(amtB, 150n, 30n * DAY), exp(amtB, 50n, 30n * DAY)]);
    // no checkpoint: nothing owed
    await expect(harness.chargeTime(3, user.address, token.target, t2.target, amtA, amtB)).to.changeTokenBalances(token, [a, b], [0, 0]);
    // shut down: no fee, but the checkpoint still clears
    await harness.setCheckpoint(4, (await ts()) - 10n * DAY);
    await registry.setShutdown(true);
    await expect(harness.chargeTime(4, user.address, token.target, t2.target, amtA, amtB)).to.changeTokenBalances(token, [a, b], [0, 0]);
    expect(await harness.timeFeeCheckpoint(4)).to.equal(0n);
  });

  it("a reverting, gas-burning, garbage or huge-return policy means no fee and no revert", async () => {
    for (const name of ["RevertingPolicy", "GasBurnerPolicy", "GarbagePolicy", "HugeReturnPolicy"]) {
      await useContract(name);
      const L = await harness.legs(2, user.address, { gasLimit: 3_000_000 });
      expect(L.n, name).to.equal(0);
      await harness.charge(2, user.address, token.target, ethers.parseEther("1"), { gasLimit: 3_000_000 });
    }
  });

  it("refuses to run the fee check with too little gas (a caller cannot starve the policy to skip fees)", async () => {
    await usePolicy([{ to: a.address, bps: 100 }]);
    await expect(harness.charge(0, user.address, token.target, ethers.parseEther("1"), { gasLimit: 120_000 }))
      .to.be.reverted;
  });
});

describe("ABI surface (no admin fund-control functions)", function () {
  it("vault exposes only user, keeper and view functions", async () => {
    const art = await hre.artifacts.readArtifact("PandaVault");
    expect(writes(new ethers.Interface(art.abi))).to.deep.equal([
      "claimDeferred", "claimRewards", "depositAndStake", "depositZap", "emergencyWithdraw", "forceExit", "migrate", "onERC721Received",
      "rebalance", "receiveMigration", "setAutoCompound", "topUp", "withdrawPosition", "withdrawRawNft", "withdrawReserves",
    ]);
  });
  it("the top-up library cannot be used directly either", async () => {
    const lib = await (await ethers.getContractFactory("PandaVaultLib")).deploy();
    const top = await (await ethers.getContractFactory("PandaTopUpLib", { libraries: { PandaVaultLib: lib.target } })).deploy();
    const art = await hre.artifacts.readArtifact("PandaTopUpLib");
    expect(writes(new ethers.Interface(art.abi))).to.deep.equal([]);
    const [signer] = await ethers.getSigners();
    const data = new ethers.Interface(["function topUp(uint256,bytes)"]).encodeFunctionData("topUp", [1, "0x"]);
    await expect(signer.sendTransaction({ to: top.target, data, gasLimit: 500000 })).to.be.reverted;
  });
  it("the vault's library cannot be used directly: its state-changing functions only run by delegatecall from a vault", async () => {
    const lib = await (await ethers.getContractFactory("PandaVaultLib")).deploy();
    const art = await hre.artifacts.readArtifact("PandaVaultLib");
    expect(writes(new ethers.Interface(art.abi))).to.deep.equal([]); // Solidity keeps them out of the library ABI
    const [signer, u] = await ethers.getSigners();
    const iface = new ethers.Interface(["function chargeKind(address,uint8,address,address,uint256)", "function swapExactIn(address,address,address,bytes,uint256,uint256,uint256)"]);
    for (const data of [
      iface.encodeFunctionData("chargeKind", [u.address, 0, u.address, u.address, 1]),
      iface.encodeFunctionData("swapExactIn", [u.address, u.address, u.address, "0x", 1, 0, 0]),
    ]) await expect(signer.sendTransaction({ to: lib.target, data, gasLimit: 500000 })).to.be.reverted;
  });
  it("registry and fee policy have only configuration writes", async () => {
    const reg = await hre.artifacts.readArtifact("PandaRegistry");
    expect(writes(new ethers.Interface(reg.abi))).to.deep.equal([
      "acceptOwnership", "addVault", "clearVaultGuardRails", "finishBootstrap", "renounceOwnership", "setDaoTreasury",
      "setDefaultGuardRails", "setDepositsPaused", "setEmergencyAdmin", "setFeePolicy", "setKeeper", "setRebalancesPaused",
      "setSafetyModule", "setVaultDepositsOpen", "setVaultGuardRails", "setVaultKeeper", "shutdownAll", "shutdownVault",
      "transferOwnership",
    ]);
    const pol = await hre.artifacts.readArtifact("PandaFeePolicy");
    expect(writes(new ethers.Interface(pol.abi))).to.deep.equal([
      "acceptOwnership", "renounceOwnership", "setActiveStage", "setBasePandaBps", "setCompany", "setDiscountSources",
      "setKeeperRewardBps", "setStages", "setStakerRewards", "setTiers", "transferOwnership",
    ]);
  });
});
