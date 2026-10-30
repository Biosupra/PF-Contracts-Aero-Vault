# Panda Financial: Aero WETH/USDC vault contracts

The smart contracts behind the Panda Financial WETH/USDC vault on Base (https://pandafinancial.org). The vault holds
each depositor's concentrated-liquidity position on Aero's WETH/USDC pool, stakes it in Aero's gauge, keeps it in
range through a keeper with hard guard rails, and pays each position's AERO emissions to its owner (raw, swapped to
USDC, or compounded back into the position, the owner's choice).

The sources in `contracts/` are byte-for-byte the sources verified on Base for the deployed contracts below.

Read [SECURITY-MODEL.md](SECURITY-MODEL.md) first: what can change, what never can, and who controls what.
The October 2026 security review is in [docs/SECURITY-REVIEW-2026-10.md](docs/SECURITY-REVIEW-2026-10.md).

## Deployed on Base (chain id 8453)

| Contract | Address |
|---|---|
| PandaVault (Aero WETH/USDC) | [`0x9Af169BA394867c850F73B1262f370CD2107CC79`](https://basescan.org/address/0x9Af169BA394867c850F73B1262f370CD2107CC79#code) |
| PandaVaultLib | [`0x8Dce1c0a6836F5E1E341bA548af5626199b54f3a`](https://basescan.org/address/0x8Dce1c0a6836F5E1E341bA548af5626199b54f3a#code) |
| PandaTopUpLib | [`0xa96EF3a52C1AbdadBA036D91eF3A2cC59957Ff49`](https://basescan.org/address/0xa96EF3a52C1AbdadBA036D91eF3A2cC59957Ff49#code) |
| PandaRegistry | [`0x52643dCDdd95944b01f10A4949d2923a0ff69FCC`](https://basescan.org/address/0x52643dCDdd95944b01f10A4949d2923a0ff69FCC#code) |
| PandaTimelock (48 h) | [`0xe9A0A268aC8227659D0479472f5DC966C12f023a`](https://basescan.org/address/0xe9A0A268aC8227659D0479472f5DC966C12f023a#code) |
| PandaFeePolicyV3 (active) | [`0xB5A0728084fa97a2407FDabC94f64755a52BB291`](https://basescan.org/address/0xB5A0728084fa97a2407FDabC94f64755a52BB291#code) |
| PandaReferrals | [`0x9010e03A5F353E769509f3BA9DeE174b97a77Bb5`](https://basescan.org/address/0x9010e03A5F353E769509f3BA9DeE174b97a77Bb5#code) |
| PandaTvlReader | [`0xc658B4b01A01b34591c9BaF6910a243982dDd53c`](https://basescan.org/address/0xc658B4b01A01b34591c9BaF6910a243982dDd53c#code) |
| Team Safe (3-of-5): timelock proposer/executor, emergency admin, treasury | [`0x9eb619B3aB33192080FfA846820117e2f00EE9bA`](https://basescan.org/address/0x9eb619B3aB33192080FfA846820117e2f00EE9bA) |

Aero contracts the vault is bound to (immutable in the vault): pool `0x4A7af46bC8aBc00048c6c7920a1488DAF568366c`,
gauge `0x46a9dCa72D78366571bE583aa69C1DC16E6889fB`, position manager `0x4857DB576eE0e45F10525eC59527BfD10beeC60b`,
swap router `0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418`, AERO `0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee`.
Every address, with the deployment records, is in [`deployments/`](deployments/).

## Contracts

| Contract | Role |
|---|---|
| `PandaVault` (+ `PandaVaultLib`, `PandaTopUpLib`) | One vault per pool/gauge. One position NFT per deposit, staked in the gauge, rewards accounted per position. Deposit, zap, top-up, claim, withdraw, raw-NFT withdraw and one-click move to another Panda vault. Withdrawals and claims can never be paused. |
| `PandaRegistry` | Keeper per vault, keeper guard rails (range width, interval, slippage, price deviation), pause switches, the fee policy address, the emergency shutdown. Owned by the timelock. |
| `PandaTimelock` | OpenZeppelin `TimelockController`; every registry or fee change is public 48 hours before it can run. |
| `PandaFeePolicyV3` | Fee rates and recipients, with permanent ceilings enforced by the vault. Replaceable only through the timelock. |
| `PandaReferrals` | On-chain referral records read by the fee policy. |
| `PandaTvlReader` | The vaults' 30-day average size, which sets the fee stage. |
| `PandaFeePolicy` | The earlier (v2) fee policy, kept for reference; no longer active. |

## Build and test

Node 20+.

```
npm ci
npx hardhat compile
npx hardhat test
```

Compiler settings (they must match for verification): Solidity 0.8.24, EVM `cancun`, optimizer 200 runs, via-IR.

Fork rehearsals against Base use a public RPC, for example:

```
FORK=1 RPC_URL=https://mainnet.base.org npx hardhat run scripts/rehearse-aero-fork.js
```

`scripts/` also holds the deployment and launch tooling that was used on Base (deploy, Safe batch calldata, checks).
None of it needs to be run to read or test the contracts.

## Verifying the deployment yourself

Fetch the verified sources for any address above from BaseScan or Sourcify and compare them with `contracts/`; the
compiler settings are in `hardhat.config.cjs`. The last section of `SECURITY-MODEL.md` lists the tests and fork
rehearsals that check each of its claims.

## Contact

Security reports: through the contact form at https://pandafinancial.org.
