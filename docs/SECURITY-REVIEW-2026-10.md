# Panda Financial Aero Vault Security Review, October 2026

Published by Panda Financial. Review dates: October 19 to 21, 2026. Status: complete for the vault contracts deployed at the Aero launch; the staking contracts are reviewed but not yet deployed.

## 1. Scope

| Contract | File | Deployed on Base (Aero launch, October 2026) |
|---|---|---|
| PandaVault | contracts/PandaVault.sol | [`0x9Af169BA394867c850F73B1262f370CD2107CC79`](https://basescan.org/address/0x9Af169BA394867c850F73B1262f370CD2107CC79#code) |
| PandaVaultLib | contracts/libraries/PandaVaultLib.sol | [`0x8Dce1c0a6836F5E1E341bA548af5626199b54f3a`](https://basescan.org/address/0x8Dce1c0a6836F5E1E341bA548af5626199b54f3a#code) |
| PandaTopUpLib | contracts/libraries/PandaTopUpLib.sol | [`0xa96EF3a52C1AbdadBA036D91eF3A2cC59957Ff49`](https://basescan.org/address/0xa96EF3a52C1AbdadBA036D91eF3A2cC59957Ff49#code) |
| PandaStakerRewards, AeroSwapper, AeroUpgrader, PandaStakerRevenue | staking repository (not in this repository) | Later, with the PANDA staking launch |

Out of scope: the registry, timelock, fee policy and referral contracts already live on Base since October 4 and October 12, 2026 (reviewed then), the keeper service, and the website.

Compiler for every build in this review: Solidity 0.8.24, EVM version cancun, optimizer on (200 runs), via-IR on. The deployed bytecode is produced with these settings and verified on BaseScan after deployment.

## 2. What was reviewed and how

This review was carried out by the Panda Financial team using third-party security tools, the Remix IDE security review (Remix AI attacker checklists) and the Slither static analyzer, together with AI-assisted code review, tests and fork rehearsals. It was not commissioned from an independent security firm.

1. **Static analysis.** Slither 0.11.6 run on the exact deploy sources and compiler settings. 102 detectors. Every finding was read and classified by hand.
2. **Attack-pattern review.** Remix AI "Attacker's Mindset" checklists on PandaVault: denial of service, donation, front-running, griefing, miner influence, price manipulation, re-entrancy and replay. The run covered PandaVault.sol by source reading; it did not compile the libraries, which the static analysis covers.
3. **Adversarial code review.** An independent AI review session (October 20) checked the vault and staking changes against Aero's deployed contract code on Base, not the public repository, with a reward-attribution invariant proven by test. Its one medium finding (a refused AERO payout that was booked instead of reverting) was fixed before this review.
4. **Tests.** 94 unit tests on the vault repository, 79 on the staking repository.
5. **Rehearsals on a fork of Base** with Aero's final contracts (October 21): the vault's full launch sequence (pool and gauge, deployment, Safe batch through the real timelock, a live position moved in, deposit, zap, top-up, rebalance, claim, deferred collection, withdraw, shutdown and force-exit); the staking flow (old AERO upgraded, PANDA buyback on a 2% fee pool); and the keeper's rebalance and auto-compound with the real keeper binary.

## 3. Findings: vault contracts

| Severity | Confirmed findings | Notes |
|---|---|---|
| Critical | 0 | |
| High | 0 | Three tool flags of "re-entrancy on balance" were examined. They mark the contract's deliberate pattern of calling Aero's swap router and then measuring its own balance change. Every state-changing entry point except one flag setter (no external call) carries a re-entrancy guard; the router and tokens are fixed at deployment. Not exploitable. |
| Medium | 0 | Tool flags for strict zero comparisons, unused return values and uninitialised locals were examined one by one: early-outs on zero amounts, partial decodes of pool state, set operations that are idempotent, and values measured by balance instead of trusted return values. No defect. |
| Low | 7 | Listed below with status. |
| Informational | 12 | Style and documentation. |

Low items and their status:

- No minimum deposit enforced in the contract itself. The website and the agent API enforce the minimum; the keeper bounds its own work per position. Accepted.
- Small residual amounts can remain in a position's reserve. Reserves belong to the position owner and are withdrawable at any time. By design.
- An owner whose wallet is blocklisted by the USDC issuer cannot withdraw until unblocked. Property of USDC, not of the vault. Documented here.
- The force-exit batch is unbounded. It is callable only after a shutdown, by the emergency admin, and a single failing transfer keeps that amount in the position's reserve rather than reverting the batch. Accepted.
- Block timestamps are used for the time-fee checkpoint and the rebalance interval. Both are capped; a validator's influence is seconds. Accepted.
- Prices come from the pool's time-weighted average; user swaps carry the user's own minimum output; the guard-rail sizes live in the registry. Confirmed; the Aero vault's rail is set at 3% to cover Aero's 2% pool fee on the compound route.
- Read-only re-entrancy would be possible only if AERO were a token with transfer hooks. The deployed AERO token is a plain ERC-20. Confirmed.

## 4. Properties confirmed

- Every state-changing function is protected against re-entrancy; checks happen before external calls.
- Accounting is per position. No position can draw on another's tokens or rewards.
- Withdrawals, raw NFT withdrawal, emergency withdrawal and reward claims cannot be paused by anyone.
- The pool, gauge, position manager, router and reward token are immutable. No admin can redirect funds.
- Registering the vault, changing its guard rails or closing it to new deposits goes through the team Safe and a 48-hour timelock. The Safe can shut the vault down and return every position to its owner, and only to its owner.
- Rebalances are keeper-only and bounded by guard rails: maximum range width, minimum interval, maximum swap slippage against the time-weighted price, and a maximum spot-to-average deviation.
- Reward swaps and compounding never revert for market reasons; a swap under the floor leaves the rewards in the position's reserve.

## 5. Accepted risks and dependencies

- **Aero's contracts.** The vault depends on Aero's gauge, pool and router. Their swap fees (0.3% on the vault pool, 2% on the AERO routes at the time of writing) are set by Aero and read live. Aero's gauge carries an emergency-withdraw function that Aero can enable; it cannot move funds away from the vault but could stop emissions.
- **Keeper.** One keeper wallet rebalances within the guard rails. It cannot withdraw, cannot change rails, and cannot act outside the registry's bounds.
- **Auto-compound.** Runs only when the compound swap clears the floor; otherwise rewards wait in the reserve and can be claimed raw.

## 6. Findings: staking contracts (not yet deployed)

Static analysis flagged the same balance-measurement pattern (guarded by re-entrancy protection) and the use of block randomness to vary the size of each PANDA buy. The randomness only changes how much of a round's budget one buy spends (50% to 150% of an even slice); it never changes who receives PANDA. Zero Critical, High or Medium findings confirmed. The fee-aware price floors added on October 21 were proven on a fork: a buy clears on a 2% fee pool and a fill 3% under the fee-adjusted average is refused. These contracts receive a further review before their own deployment.

## 7. Record

Raw tool output, the Remix reports, test logs and fork rehearsal logs are kept in Panda Financial's internal test archive. The three contracts above are verified on Base (Sourcify exact match); the sources in this repository are byte-for-byte the verified sources.

## 8. Limitations

Automated tools and AI-assisted review find classes of defects; they do not prove the absence of defects. This review was performed by the team with third-party tools (Remix, Slither) and was not commissioned from an independent security firm. Smart contracts carry risk, including risk from the third-party protocols they depend on. Nothing in this document is financial advice or a guarantee.
