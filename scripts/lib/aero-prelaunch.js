// Helpers for the PRE-LAUNCH fork rehearsals (scripts/rehearse-aero-fork-prelaunch.js): on a Base fork, create the
// Aero pools and gauge that do not exist before 2026-10-22, against Aero's REAL deployed contracts, impersonating
// exactly the roles the verified sources require. Nothing here can run against a live network (every step needs
// hardhat_impersonateAccount). Addresses: facts checked on chain 2026-10-20 (app.aero.xyz/docs/security + Sourcify).
//
// Every ABI fragment used here is listed in FRAGMENTS so test/aero-review.test.js can check each one against the
// signatures of the DEPLOYED Base contracts (test/fixtures/aero-base-abi.json) without a node.
const { ethers, network } = require("hardhat");

const ADDR = {
  clFactory: "0x9CB220581b91b0C83223012FE69688b92aD07a76",
  gaugeFactory: "0xf437f62053ACB121665b8fDBfeA8F214FB8E589d",
  positionManager: "0x4857DB576eE0e45F10525eC59527BfD10beeC60b",
  swapRouter: "0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418",
  leafVoter: "0x382409fad8503FbCdbB27A4211551fa03e884078",
  gaugeManager: "0xbF234b32c5e58868243A4a14831626f3EdE7b183",
  factoryRegistry: "0x7b2A2c12dC5Ea2a31455952a05031C3E4BB28F3E",
  aero: "0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee",          // NEW AERO
  migration: "0x22a2F7340a3fB4C7C389D91eE954766B12476721",     // AerodromeMigration: holds ~2.01B new AERO
  rootVoter: "0x49d7d4f17Ec56Ef8fA04E464AF5D1A4942CC31e6",     // Aero's root Voter (Base is the root chain)
  minter: "0x59268A34ba897e82368feE39839FFC661D4f9C97",
  volatileFactory: "0x8E6a9FCd1d638CC760Ffba397605Fe3355dE76D2", // basic pools (PANDA/WETH)
  oldAero: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  aeroWethUsdcCl50: "0x3FE04A59Ebd38cF06080a6F60a98D124eb59392A", // Aerodrome (old) WETH/USDC CL50: price source + USDC source
  aeroAeroWethCl200: "0x4e506648d493C8870f55e870480f92f2F33ecE51", // Aerodrome (old) AERO/WETH CL200: AERO price source
};
const BASE_CHAIN_ID = 8453n;
const LAUNCH = 1792627200; // 2026-10-22 00:00 UTC: Aero launch; also AerodromeMigration's liquid open (epochNext(MIGRATION_OPEN))
const FULL_RANGE = 887200; // divisible by every enabled spacing (1, 50, 100, 200, 2000)

const FRAGMENTS = {
  CLFactory: [
    "function getPool(address,address,int24) view returns (address)",
    "function createPool(address,address,int24,uint160) returns (address)",
    "function tickSpacingToFee(int24) view returns (uint24)",
    "function voter() view returns (address)",
    "function factoryRegistry() view returns (address)",
    "function positionManager() view returns (address)",
  ],
  CLPool: [
    "function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function tickSpacing() view returns (int24)",
    "function gauge() view returns (address)",
    "function increaseObservationCardinalityNext(uint16)",
    "function observe(uint32[]) view returns (int56[],uint160[])",
    "function stakedLiquidity() view returns (uint128)",
    "function liquidity() view returns (uint128)",
    "function fee() view returns (uint24)",
  ],
  CLGaugeFactory: [
    "function gaugeManager() view returns (address)",
    "function emissionCap(address) view returns (uint128)",
    "function setEmissionCap(address,uint128)",
    "function CAP_ADMIN_ROLE() view returns (bytes32)",
    "function PENALTY_ADMIN_ROLE() view returns (bytes32)",
    "function getRoleMember(bytes32,uint256) view returns (address)",
    "function getRoleMemberCount(bytes32) view returns (uint256)",
    "function effectivePenaltyConfig(address) view returns ((uint256,uint256))",
    "function setMinStakeBlocks(address,uint256)",
    "function maxMinStakeBlocks() view returns (uint256)",
    "function isGauge(address) view returns (bool)",
    "function computeGaugeAddress(address) view returns (address)",
  ],
  CLGauge: [
    "function voter() view returns (address)",
    "function pool() view returns (address)",
    "function earned(address,uint256[]) view returns (uint256)",
    "function deferredEmissions(address) view returns (uint256)",
    "function stakedContains(address,uint256) view returns (bool)",
    "function depositBlock(uint256) view returns (uint256)",
  ],
  LeafVoter: [
    "function isActivated(address) view returns (bool)",
    "function gaugeStates(address) view returns (uint128,uint128,uint48,bool,bool,uint128,uint256,uint256,(int128,int128,uint48,uint128))",
    "function projectedCumulativeRewardShare(address) view returns (uint256)",
    "function GAUGE_MANAGER() view returns (address)",
    "function EMISSIONS_HANDLER() view returns (address)",
    "function ORCHESTRATOR() view returns (address)",
    "function RECEIPT_TOKEN() view returns (address)",
    "function chainStatus() view returns (uint8)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function getRoleMember(bytes32,uint256) view returns (address)",
    "function getRoleMemberCount(bytes32) view returns (uint256)",
  ],
  // GaugeManager (0xbF23...b183) is not in the Sourcify set: shape from Dromos-Labs/metadex-public GaugeManager.sol,
  // the contract CLGaugeFactory.gaugeManager() and LeafVoter.GAUGE_MANAGER() point at. Checked on the fork at run time.
  GaugeManager: [
    "function createGauge((address creator,address gaugeFactory,address target,bytes factoryData,bool activate)) returns (address)",
    "function activateGauge(address)",
    "function registerModule(address)",
    "function modules() view returns (address[])",
    "function isModule(address) view returns (bool)",
  ],
  FactoryRegistry: [
    "function targetToGauge(address) view returns (address)",
    "function isTargetFactoryApproved(address) view returns (bool)",
    "function targetFactoryToGaugeFactory(address) view returns (address)",
  ],
  // Root Voter (0x49d7...31e6): shape from metadex-public Voter.sol (donate / donatedBuffer / chainStates).
  RootVoter: [
    "function donate(uint256,uint256)",
    "function donatedBuffer(uint256) view returns (uint256)",
  ],
  Minter: ["function ACTIVATION_TIMESTAMP() view returns (uint48)", "function emissionRate() view returns (uint256)", "function VOTER() view returns (address)"],
  NonfungiblePositionManager: [
    "function mint((address token0,address token1,int24 tickSpacing,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline,uint160 sqrtPriceX96)) payable returns (uint256,uint128,uint256,uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    "function positions(uint256) view returns (uint96,address,address,address,int24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
  ],
  SwapRouter: ["function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256)"],
  Token: ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function MINTER() view returns (address)"],
  AerodromeMigration: ["function remaining() view returns (uint256)", "function paused() view returns (bool)", "function MIGRATION_OPEN() view returns (uint48)"],
  VolatilePoolFactory: ["function getPool(address,address) view returns (address)", "function createPool(address,address) returns (address)", "function isPaused() view returns (bool)"],
  VolatilePool: [
    "function mint(address) returns (uint256)",
    "function sync()",
    "function getReserves() view returns (uint256,uint256,uint256)",
    "function observe(uint32[]) view returns (uint256[],uint256[])",
    "function observationBuffer() view returns (uint16,uint16,uint16)",
    "function increaseObservationCardinalityNext(uint16)",
    "function getAmountOutWithTotalFee(uint256,address) view returns (uint256)",
    "function swap(uint256,uint256,address,bytes)",
    "function token0() view returns (address)",
  ],
  WETH: ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"],
};

const FAR = 2n ** 40n;
const E = (x) => ethers.parseEther(String(x));
const at = (addr, frags, signer) => new ethers.Contract(addr, frags, signer || ethers.provider);
const role = (name) => ethers.id(name);

async function as(addr) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.send("hardhat_setBalance", [addr, "0x56BC75E2D63100000"]);
  return ethers.getSigner(addr);
}
const mine = (n) => network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
async function later(sec) { await network.provider.send("evm_increaseTime", [sec]); await network.provider.send("evm_mine"); }
async function nowTs() { return (await ethers.provider.getBlock("latest")).timestamp; }

/// Jumps the fork to just after Aero's launch time if it is still before it (the Migration's liquid upgrade and the
/// first vote allocation only exist after it). Returns the timestamp now.
async function warpToLaunch(log = console.log) {
  const t = await nowTs();
  if (t < LAUNCH + 60) {
    await network.provider.send("evm_setNextBlockTimestamp", [LAUNCH + 60]);
    await network.provider.send("evm_mine");
    log(`  time moved from ${new Date(t * 1000).toISOString()} to ${new Date((LAUNCH + 60) * 1000).toISOString()} (just after launch)`);
  }
  return nowTs();
}

const sqrtBig = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
const Q96 = 2n ** 96n;
/// sqrtPriceX96 of "num of token1 per den of token0" (raw units).
const sqrtPriceX96 = (num, den) => sqrtBig((num << 192n) / den);
/// The inverse price's sqrtPriceX96 (token order flipped).
const invertSqrtPrice = (sqrtP) => (Q96 * Q96) / sqrtP;
/// Price of `amount` token0 in token1 at sqrtP (raw units).
const priceOut = (sqrtP, amountIn, zeroForOne) => zeroForOne
  ? (amountIn * sqrtP * sqrtP) / (Q96 * Q96)
  : (amountIn * Q96 * Q96) / (sqrtP * sqrtP);

/// What `liquidity` in [lower, upper] is worth at sqrtPriceX96, in raw token1, plus raw reserves (token0 reserve priced
/// at the spot). Float arithmetic: for comparing a position's holdings before and after a compound, not for sending.
function holdingsInToken1(sqrtPriceX96, lower, upper, liquidity, reserve0 = 0n, reserve1 = 0n) {
  const p = Number(sqrtPriceX96) / 2 ** 96;
  const sa = Math.pow(1.0001, lower / 2), sb = Math.pow(1.0001, upper / 2);
  const L = Number(liquidity);
  let amount0 = 0, amount1 = 0;
  if (p <= sa) amount0 = L * (sb - sa) / (sa * sb);
  else if (p >= sb) amount1 = L * (sb - sa);
  else { amount0 = L * (sb - p) / (p * sb); amount1 = L * (p - sa); }
  return (amount0 + Number(reserve0)) * p * p + amount1 + Number(reserve1);
}

/// Creates (or finds) a CL pool on Aero's real factory at `sqrtP`, raises its observation buffer, returns its address.
async function ensureClPool(tokenA, tokenB, spacing, sqrtP, signer, log = console.log) {
  const factory = at(ADDR.clFactory, FRAGMENTS.CLFactory, signer);
  if ((await factory.tickSpacingToFee(spacing)) === 0n) throw new Error(`tick spacing ${spacing} is not enabled on Aero's CLFactory`);
  let pool = await factory.getPool(tokenA, tokenB, spacing);
  if (pool === ethers.ZeroAddress) {
    await (await factory["createPool(address,address,int24,uint160)"](tokenA, tokenB, spacing, sqrtP)).wait();
    pool = await factory.getPool(tokenA, tokenB, spacing);
    log(`  created CL${spacing} pool ${pool} (permissionless createPool, as anyone can on launch day)`);
  } else log(`  CL${spacing} pool exists already: ${pool}`);
  const p = at(pool, FRAGMENTS.CLPool, signer);
  await (await p.increaseObservationCardinalityNext(600)).wait();
  return pool;
}

/// Full-range liquidity from `signer` (who must hold both tokens; approvals set here). Returns the token id.
async function seedClPool(pool, amountA, amountB, signer, log = console.log) {
  const p = at(pool, FRAGMENTS.CLPool);
  const [t0, t1, spacing] = [await p.token0(), await p.token1(), Number(await p.tickSpacing())];
  const nfpm = at(ADDR.positionManager, FRAGMENTS.NonfungiblePositionManager, signer);
  const lower = -Math.floor(FULL_RANGE / spacing) * spacing, upper = Math.floor(FULL_RANGE / spacing) * spacing;
  const [a0, a1] = t0.toLowerCase() === amountA.token.toLowerCase() ? [amountA.amount, amountB.amount] : [amountB.amount, amountA.amount];
  for (const [t, a] of [[t0, a0], [t1, a1]]) await (await at(t, FRAGMENTS.WETH, signer).approve(ADDR.positionManager, a)).wait();
  const tx = await nfpm.mint({ token0: t0, token1: t1, tickSpacing: spacing, tickLower: lower, tickUpper: upper, amount0Desired: a0, amount1Desired: a1,
    amount0Min: 0, amount1Min: 0, recipient: signer.address, deadline: FAR, sqrtPriceX96: 0 });
  const rc = await tx.wait();
  const transfer = rc.logs.map((l) => { try { return nfpm.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Transfer");
  const id = transfer ? transfer.args[2] : undefined;
  log(`  seeded ${pool} full range: liquidity ${(await p.liquidity()).toString()} (NFT ${id})`);
  return id;
}

/// A few small swaps spaced in time so the pool's TWAP over `window` seconds can be read.
async function warmTwap(pool, tokenIn, amountIn, signer, window = 300, log = console.log) {
  const p = at(pool, FRAGMENTS.CLPool);
  const [t0, t1, spacing] = [await p.token0(), await p.token1(), Number(await p.tickSpacing())];
  const tokenOut = tokenIn.toLowerCase() === t0.toLowerCase() ? t1 : t0;
  const router = at(ADDR.swapRouter, FRAGMENTS.SwapRouter, signer);
  await (await at(tokenIn, FRAGMENTS.WETH, signer).approve(ADDR.swapRouter, amountIn * 4n)).wait();
  for (let i = 0; i < 3; i++) {
    await later(Math.ceil(window / 2) + 60);
    await (await router.exactInput({ path: ethers.solidityPacked(["address", "int24", "address"], [tokenIn, spacing, tokenOut]), recipient: signer.address, deadline: FAR, amountIn, amountOutMinimum: 0 })).wait();
  }
  await later(30);
  await p.observe([window, 0]);
  log(`  ${pool}: TWAP over ${window} s readable`);
}

/// The gauge for `pool`: created through the real GaugeManager by a registered module (registering the caller as a
/// module with the LeafVoter's MODULE_ADMIN_ROLE holder if none exists), activated, with a non-zero emission cap.
/// Falls back to impersonating the GaugeManager itself only if the module path is refused.
async function ensureGauge(pool, signer, log = console.log) {
  const gf = at(ADDR.gaugeFactory, FRAGMENTS.CLGaugeFactory);
  const gm = at(await gf.gaugeManager(), FRAGMENTS.GaugeManager);
  const clFactory = at(ADDR.clFactory, FRAGMENTS.CLFactory);
  const fr = at(await clFactory.factoryRegistry(), FRAGMENTS.FactoryRegistry);
  const lv = at(await clFactory.voter(), FRAGMENTS.LeafVoter);
  if ((await lv.GAUGE_MANAGER()).toLowerCase() !== gm.target.toLowerCase()) throw new Error(`LeafVoter.GAUGE_MANAGER ${await lv.GAUGE_MANAGER()} != CLGaugeFactory.gaugeManager ${gm.target}`);
  log(`  GaugeManager ${gm.target}, FactoryRegistry ${fr.target}, LeafVoter ${lv.target}`);
  if (!(await fr.isTargetFactoryApproved(ADDR.clFactory))) log("  WARNING: the CLFactory is not an approved target factory in the registry");
  let gauge = await fr.targetToGauge(pool);
  if (gauge === ethers.ZeroAddress) {
    let modules = await gm.modules();
    let module = modules[0];
    if (!module) {
      const n = Number(await lv.getRoleMemberCount(role("MODULE_ADMIN_ROLE")));
      if (n === 0) throw new Error("no MODULE_ADMIN_ROLE holder on the LeafVoter: cannot register a gauge-creation module");
      const admin = await lv.getRoleMember(role("MODULE_ADMIN_ROLE"), 0);
      await (await gm.connect(await as(admin)).registerModule(signer.address)).wait();
      module = signer.address;
      log(`  no gauge-creation module registered yet: MODULE_ADMIN ${admin} registered ${module} as one (fork only)`);
    }
    const req = { creator: signer.address, gaugeFactory: ADDR.gaugeFactory, target: pool, factoryData: "0x", activate: true };
    try {
      await (await gm.connect(await as(module)).createGauge(req)).wait();
      log(`  gauge created through GaugeManager.createGauge by module ${module} (activate: true)`);
    } catch (e) {
      log(`  GaugeManager.createGauge refused (${(e.shortMessage || e.message).slice(0, 120)}); falling back to the factory + voter calls as the GaugeManager`);
      const gmSigner = await as(gm.target);
      const gfW = at(ADDR.gaugeFactory, ["function createGauge(address,bytes) returns (address,address)"], gmSigner);
      const [g, rewards] = await gfW.createGauge.staticCall(pool, "0x");
      await (await gfW.createGauge(pool, "0x")).wait();
      await (await at(fr.target, ["function registerGauge(address,address,address,address)"], gmSigner).registerGauge(g, ADDR.gaugeFactory, rewards, pool)).wait();
      await (await at(lv.target, ["function registerGauge(address,bool)"], gmSigner).registerGauge(g, true)).wait();
    }
    gauge = await fr.targetToGauge(pool);
  } else log(`  gauge exists already: ${gauge}`);
  const poolGauge = await at(pool, FRAGMENTS.CLPool).gauge();
  if (poolGauge.toLowerCase() !== gauge.toLowerCase()) throw new Error(`pool.gauge() ${poolGauge} != registry gauge ${gauge}`);
  if (!(await lv.isActivated(gauge))) {
    const gov = await lv.getRoleMember(role("GOVERNANCE_ROLE"), 0);
    await (await gm.connect(await as(gov)).activateGauge(gauge)).wait();
    log(`  gauge activated by GOVERNANCE_ROLE holder ${gov}`);
  }
  let cap = await gf.emissionCap(gauge);
  if (cap === 0n) {
    const capAdmin = await gf.getRoleMember(await gf.CAP_ADMIN_ROLE(), 0);
    await (await gf.connect(await as(capAdmin)).setEmissionCap(gauge, 10n ** 30n)).wait();
    cap = await gf.emissionCap(gauge);
    log(`  emission cap was 0: CAP_ADMIN ${capAdmin} set ${cap}`);
  }
  const pen = await gf.effectivePenaltyConfig(gauge);
  log(`  gauge ${gauge}: activated ${await lv.isActivated(gauge)}, emission cap ${cap}, early-unstake window ${pen[0]} blocks at ${Number(pen[1]) / 1e4}%`);
  return { gauge, leafVoter: lv.target, gaugeFactory: gf.target };
}

/// Sets the gauge's early-unstake window on the fork (PENALTY_ADMIN_ROLE holder impersonated).
async function setPenaltyWindow(gauge, blocks, log = console.log) {
  const gf = at(ADDR.gaugeFactory, FRAGMENTS.CLGaugeFactory);
  const max = await gf.maxMinStakeBlocks();
  if (BigInt(blocks) > max) throw new Error(`window ${blocks} > maxMinStakeBlocks ${max}`);
  const admin = await gf.getRoleMember(await gf.PENALTY_ADMIN_ROLE(), 0);
  await (await gf.connect(await as(admin)).setMinStakeBlocks(gauge, blocks)).wait();
  log(`  PENALTY_ADMIN ${admin} set the gauge's window to ${blocks} blocks (max ${max})`);
}

/// Locates gaugeStates[gauge] in the LeafVoter's storage by checking the slot's content against the public getter
/// (LeafStorage sits at slot 2 per the verified source; gaugeStates is its 7th member, slot 8; ceiling and claimed
/// share the struct's first word). Probes other base slots if the layout differs.
async function findGaugeStateSlot(lv, gauge) {
  const st = await lv.gaugeStates(gauge);
  const [ceiling, claimed] = [st[0], st[1]];
  const mask = (1n << 128n) - 1n;
  const candidates = [8, ...Array.from({ length: 60 }, (_, i) => i).filter((i) => i !== 8)];
  for (const base of candidates) {
    const slot = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [gauge, base])));
    const word = BigInt(await network.provider.send("eth_getStorageAt", [lv.target, ethers.toBeHex(slot, 32), "latest"]));
    if ((word & mask) !== ceiling || (word >> 128n) !== claimed) continue;
    // write-probe: bump the ceiling by 1, confirm through the getter, restore
    const probe = ethers.toBeHex((word & ~mask) | ((ceiling + 1n) & mask), 32);
    await network.provider.send("hardhat_setStorageAt", [lv.target, ethers.toBeHex(slot, 32), probe]);
    const seen = (await lv.gaugeStates(gauge))[0];
    await network.provider.send("hardhat_setStorageAt", [lv.target, ethers.toBeHex(slot, 32), ethers.toBeHex(word, 32)]);
    if (seen === ceiling + 1n) return { slot, word, ceiling, claimed };
  }
  throw new Error("could not locate gaugeStates[gauge] in the LeafVoter's storage (layout differs from the verified source)");
}

/// Makes emissions flow to the gauge's stakers on the fork: raises the gauge's settled cumulative reward share
/// (`ceiling`) in the LeafVoter by `amount` (the voter's walk would add exactly this once root allocates), and funds
/// Base's chain buffer on the root Voter with `amount` AERO through its public `donate` (the Migration contract's
/// AERO, impersonated) so the mint on claim is paid even before the Minter activates (2026-10-29 00:00 UTC).
/// MUST run after liquidity is STAKED in the gauge: the pool credits the delta to the staked liquidity at the next
/// settle, and banks it into rollover (forfeited) if nothing is staked.
async function fundEmissions(gauge, amount, log = console.log) {
  const lv = at(ADDR.leafVoter, FRAGMENTS.LeafVoter);
  const pool = at(await at(gauge, FRAGMENTS.CLGauge).pool(), FRAGMENTS.CLPool);
  if ((await pool.stakedLiquidity()) === 0n) throw new Error("fundEmissions: nothing is staked in the gauge yet; stake first or the emissions are forfeited");
  const { slot, word, ceiling, claimed } = await findGaugeStateSlot(lv, gauge);
  const mask = (1n << 128n) - 1n;
  const bumped = ethers.toBeHex((word & ~mask) | ((ceiling + amount) & mask), 32);
  await network.provider.send("hardhat_setStorageAt", [lv.target, ethers.toBeHex(slot, 32), bumped]);
  const after = await lv.gaugeStates(gauge);
  if (after[0] !== ceiling + amount || after[1] !== claimed) throw new Error("ceiling bump not visible through gaugeStates()");
  log(`  LeafVoter gaugeStates[${gauge}].ceiling ${ceiling} -> ${after[0]} (claimed ${claimed}); projected share now ${await lv.projectedCumulativeRewardShare(gauge)}`);

  const minter = at(ADDR.minter, FRAGMENTS.Minter);
  const rootVoter = at(await minter.VOTER(), FRAGMENTS.RootVoter);
  const activation = Number(await minter.ACTIVATION_TIMESTAMP());
  log(`  Minter ${minter.target} activates ${new Date(activation * 1000).toISOString()}; root Voter ${rootVoter.target}, Base buffer ${await rootVoter.donatedBuffer(BASE_CHAIN_ID)}`);
  const mig = await as(ADDR.migration);
  const aero = at(ADDR.aero, FRAGMENTS.Token, mig);
  await (await aero.approve(rootVoter.target, amount)).wait();
  await (await rootVoter.connect(mig).donate(BASE_CHAIN_ID, amount)).wait();
  log(`  root Voter.donate(8453, ${ethers.formatEther(amount)} AERO) from the Migration's balance: buffer now ${ethers.formatEther(await rootVoter.donatedBuffer(BASE_CHAIN_ID))} AERO`);
}

/// New AERO for `to` from the Migration contract (holds the unmigrated supply), WETH from ETH, USDC from the
/// Aerodrome WETH/USDC pool's balance. Fork only.
async function fund(to, { aero, weth, usdc }, log = console.log) {
  if (aero) await (await at(ADDR.aero, FRAGMENTS.Token, await as(ADDR.migration)).transfer(to, aero)).wait();
  if (weth) {
    const w = await as(to);
    await network.provider.send("hardhat_setBalance", [to, ethers.toBeHex(weth + E(10))]);
    await (await at(ADDR.weth, FRAGMENTS.WETH, w).deposit({ value: weth })).wait();
  }
  if (usdc) {
    const src = await as(ADDR.aeroWethUsdcCl50);
    const bal = await at(ADDR.usdc, FRAGMENTS.Token).balanceOf(ADDR.aeroWethUsdcCl50);
    if (bal < usdc) throw new Error(`the Aerodrome WETH/USDC pool holds only ${bal} USDC at this block`);
    await (await at(ADDR.usdc, FRAGMENTS.Token, src).transfer(to, usdc)).wait();
  }
  log(`  funded ${to}: ${aero ? ethers.formatEther(aero) + " AERO " : ""}${weth ? ethers.formatEther(weth) + " WETH " : ""}${usdc ? ethers.formatUnits(usdc, 6) + " USDC" : ""}`);
}

/// Current prices from the Aerodrome (old) pools: sqrtPriceX96 values for the NEW pools' token orders.
async function launchPrices() {
  const wu = at(ADDR.aeroWethUsdcCl50, FRAGMENTS.CLPool);
  const aw = at(ADDR.aeroAeroWethCl200, FRAGMENTS.CLPool);
  const sWU = (await wu.slot0())[0];                 // WETH (token0) / USDC (token1): USDC per WETH, as in the new pool
  const sOld = (await aw.slot0())[0];                // old AERO/WETH: token order by address
  const oldAeroIs0 = (await aw.token0()).toLowerCase() === ADDR.oldAero.toLowerCase();
  const newAeroIs0 = BigInt(ADDR.aero) < BigInt(ADDR.weth);
  // sqrt price of "WETH per AERO" if AERO is token0, else "AERO per WETH"
  const sAW = oldAeroIs0 === newAeroIs0 ? sOld : invertSqrtPrice(sOld);
  // AERO/USDC: USDC per AERO = (WETH per AERO) x (USDC per WETH); the new AERO (0x3f5b) sorts before USDC (0x8335)
  const sWethPerAero = newAeroIs0 ? sAW : invertSqrtPrice(sAW);
  const sAU = (sWethPerAero * sWU) / Q96;
  return { wethUsdc: sWU, aeroWeth: sAW, aeroUsdc: sAU, newAeroIs0 };
}

module.exports = { ADDR, BASE_CHAIN_ID, LAUNCH, FRAGMENTS, FAR, E, at, as, mine, later, nowTs, warpToLaunch, sqrtPriceX96, invertSqrtPrice, priceOut, Q96,
  holdingsInToken1, ensureClPool, seedClPool, warmTwap, ensureGauge, setPenaltyWindow, fundEmissions, fund, launchPrices, role };
