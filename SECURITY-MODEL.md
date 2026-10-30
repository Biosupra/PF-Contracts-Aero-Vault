# Security model: what can change, what never can

This document is the contract between Panda Financial and its users for the upgradeable platform. Every
statement here is enforced by the contract code in this repository, not by policy.

## The one-line version

**Nobody, including the team, the multisig or the timelock, can move, claim, freeze or redirect a user's
funds.** The things that can change after launch are role addresses, which pools accept new deposits, the fee
policy (always clamped to ceilings compiled into each vault), and guard rails that limit what each keeper may do.
The one emergency power, the kill switch, can only send each position's funds to that position's own owner.

The platform is many vaults, one per pool (WETH/USDC, cbBTC/USDC, ...), all deployed from the same audited
`PandaVault` template and all read from one registry. A problem in one vault cannot reach another vault's funds.

## Why there is no proxy

A proxy (UUPS / Transparent) lets the admin replace all of the code, which would let a future upgrade drain
every position. That is incompatible with the requirement above, so this platform does not use one. Instead:

- `PandaVault` (with its linked `PandaVaultLib`) and `PandaRegistry` are ordinary, non-upgradeable contracts.
- Everything that needs to be adjustable is either a bounded parameter in `PandaRegistry` or the replaceable
  fee policy, whose answers every vault clamps to its own ceilings.
- Targeting a new pool, gauge or router means deploying a **new** `PandaVault` and registering it. Old
  vaults keep working forever for the users in them; only their *new deposits* can be switched off.
- The vault constructor checks that the router, position manager, pool, gauge and every compound-route hop come
  from one Slipstream deployment, and **refuses any pair that contains AERO** (`AeroPairUnsupported`): rewards are
  measured as the rise in the vault's AERO balance, so an AERO pair would count principal as rewards.

`PandaVaultLib` exists only to keep the vault under the 24 KB contract size limit. Its address is fixed into
the vault's bytecode at deploy; it holds no state, and its state-changing functions only run by DELEGATECALL from
a vault (calling them directly reverts). It is part of the vault's code, not an upgrade lever.

## Who controls what

| Actor | Can | Cannot |
|---|---|---|
| Multisig (Safe) | Schedule and, after the delay, execute registry and fee-policy changes through the timelock; as the registry's `emergencyAdmin`, pull the kill switch directly (below) | Call the registry's other setters or the fee policy directly, move any user funds anywhere except back to their owners |
| Timelock | Everything listed under "changeable parameters", only after `minDelay` | Anything else. It has no function on `PandaVault` at all, and no fee it sets can exceed a vault's ceilings |
| Safety module | Pause **new deposits** and **rebalances** immediately, and unpause them | Pause withdrawals, claims, emergency exits; change anything else |
| Keeper (one per vault: `registry.keeperOf(vault)`, default fallback) | Call `rebalance` on its vault within that vault's guard rails (below); after a shutdown, call `forceExit` on its vault (spot-near-TWAP check applies) | Choose swap paths for user rewards, route a swap outside the vault's own pool (or, for auto-compounding, outside the vault's fixed 1-3 hop compound route), act while spot is far from the TWAP, park a range away from the price, rebalance faster than the cooldown, move a reserve to another position, turn auto-compounding on or off, receive anything but its fee leg |
| Position owner | Deposit, add money to an existing position (`topUp`), claim, withdraw (`withdrawPosition`), `emergencyWithdraw`, `withdrawRawNft`, switch auto-compounding (`setAutoCompound`), pull the position's reserve (`withdrawReserves`), move the position to another registered vault (`migrate`) | Act on another user's position or reserve |
| Deployer | Register the first vault(s) and the fee policy, then call `finishBootstrap` | Anything after `finishBootstrap` (the address is zeroed) |

The PANDA token and token / Panda Pass staking live in their own repositories. The vault never calls
them; only the fee policy reads the staking contracts' matured-stake views for discounts.

## Emergency kill switch (no timelock, permanent)

The registry's `emergencyAdmin` (the team Safe, set and changeable only through the timelock) can, immediately:

- `shutdownVault(vault)`: shut one vault down, or
- `shutdownAll()`: shut every vault down.

Both are permanent (there is no function to undo them; a retired vault is replaced by registering a new one).
From that moment, in every affected vault:

- no deposits and no rebalances (they revert);
- **every fee is zero**, for forced exits and for owners exiting themselves (enforced in one place,
  `PandaVaultLib.getLegs`, so no path can miss it);
- `forceExit(tokenIds)` may be called by the emergency admin or that vault's keeper (the keeper only while spot is
  near TWAP, so nobody can time a forced exit into a pushed price). For each open position it unstakes, removes all
  liquidity and sends **that position's owner** its tokens, its reserve and its unclaimed AERO, raw, no swaps.
  Nothing can be sent anywhere else;
- if a transfer is refused (for example an address blocked by the token issuer), that amount stays in the
  position's reserve and the owner collects it later with `withdrawReserves`; the rest of the batch continues;
- owners can still use every exit themselves (`withdrawPosition`, `emergencyWithdraw`, `withdrawRawNft`,
  `withdrawReserves`, `claimRewards`).

`test/aero-vault.test.js` ("shutdown and forceExit") and `scripts/rehearse-aero-fork.js` (step 5, on a Base fork
with Aero's real contracts) prove it.

## One-click upgrade to another vault (opt-in, owner only)

`migrate(tokenId, toVault, ...)` lets a position's OWNER move it into another Panda vault in one transaction:
- only the owner can call it; nobody (team, Safe, keeper) can move a position for them;
- the target must be registered in the registry (registration goes through the timelock, so a new vault is public
  for the whole delay before anyone can move into it) and hold the same token pair; it must be open for deposits;
- the source vault unwinds the position and hands its tokens and leftovers to the target (`receiveMigration`, callable
  only by a registered vault), which opens a new position for the same owner with the same auto-compound choice,
  optionally after a balancing swap through its own pool floored at TWAP; whatever the target does not take goes
  straight back to the owner;
- no withdrawal or deposit toll on the move; rewards earned before it are paid to the owner (normal reward fee);
- it works from a shut-down vault too (then with no fees at all).

`test/aero-vault.test.js` ("migrations") proves it, and `scripts/rehearse-aero-fork.js` moves a real position from the
earlier vault into this one on a Base fork.

## Fees: replaceable policy, permanent ceilings

Seven fee kinds exist in every vault. The **ceilings are constants in `PandaVault`/`PandaVaultLib`** and can only
change by deploying a new vault that users choose to move to:

| Kind | Charged on | Ceiling |
|---|---|---|
| 0 REWARD | AERO rewards, each time they are collected | 20% |
| 1 DEPOSIT | principal deposited (each token), by a deposit or a `topUp` | 2.00% |
| 2 WITHDRAW | principal leaving the vault: liquidity and reserve, in `withdrawPosition`, `emergencyWithdraw`, `withdrawReserves`, and a slice of the NFT's liquidity in `withdrawRawNft` | 2.00% |
| 3 ZAP_SWAP | a swap the owner asked for (zap-in, WETH to USDC out, AERO rewards to USDC) | 1.00% of the amount swapped |
| 4 REBALANCE_SWAP | the keeper's rebalance swap | 1.00% |
| 5 COMPOUND_SWAP | the auto-compounding AERO to WETH swap | 1.00% |
| 6 TIME | a position's liquidity when it leaves the position (rebalance, `withdrawPosition`, `emergencyWithdraw`, `migrate`, a slice in `withdrawRawNft`), pro rata for the time since the position's last mint, **at most 30 days per charge** so switching it on can never bill a long stretch at 0; never on reserves or rewards | 2.00% a year. Dormant: 0 at launch |

Rates, discounts and recipients come from the fee policy named in `registry.feePolicy()` (replaceable through
the timelock). The vault treats the policy as untrusted:

- It reads at most 6 legs straight from the return data (no decoding that could revert, no unbounded copy),
  drops legs with a zero recipient, the vault itself as recipient, or zero bps, and clamps the total to the
  ceiling for that kind.
- If the policy reverts, runs out of gas or returns malformed data, the fee is **zero**. A policy can never
  block a withdrawal, claim or rebalance.
- The vault refuses to start the policy call without enough gas for it, so a caller cannot starve that call
  to skip fees.
- A fee leg whose transfer fails (for example a USDC-blacklisted recipient) is simply not charged.
- `withdrawRawNft` takes its fee by removing the fee share of the NFT's liquidity, each step in try/catch; if
  the position manager is broken, no fee is taken and the NFT still reaches its owner.

Launch policy (`PandaFeePolicy` v2) = the live vault's 20%: REWARD 1% to the vault's keeper + 19% Panda, split
company : treasury by the published stage (Stage 0 at launch: 15% to the company wallet, 4% to the treasury, the
team Safe); the stakers' leg and every other kind 0. Its owner (the timelock) can set per-kind base rates, a keeper
reward rate, the stages, and up to 12 discount tiers keyed on matured staked tokens and the matured staked Pass
level (2 = a special edition) (the staking contracts count a stake only after
its 7-day warm-up, and drop it the moment it is unstaked). A tier can only lower a rate, never raise it above the
base. Every fee actually paid emits `FeeCharged(user, kind, token, to, amount)`.

## Changeable parameters (all through the timelock) and their hard caps

| Parameter | Hard cap in code | Effect if changed maliciously |
|---|---|---|
| `keeper` (default) / `setVaultKeeper(vault, k)` | must be non-zero / a registered vault | The new keeper can rebalance badly inside every guard rail: a bounded loss per rebalance (KNOWN-RISKS §1), never a transfer of funds elsewhere |
| `emergencyAdmin` | must be non-zero | A new address gets the kill switch, which can only return funds to their owners |
| `daoTreasury` | must be non-zero | Redirects the protocol's own fee share, not user funds |
| `safetyModule` | must be non-zero | A new address gets the pause powers above |
| `feePolicy` | any address; every vault clamps it | Fees up to each vault's ceilings, never more; a broken policy means no fees |
| fee policy rates / tiers / discount sources | rates at most 100% in the policy, then clamped by the vault | As above |
| guard rails (`setDefaultGuardRails`, `setVaultGuardRails(vault, ...)`): |  | |
| `maxRebalanceSlippageBps` | 1 to 300 (3%) | A keeper swap can never return less than TWAP price minus this |
| `twapWindow` | 60 to 3600 seconds | Shorter windows are easier to manipulate but still bounded by the caps |
| `minRebalanceInterval` | 15 minutes to 24 hours (`MIN_MIN_REBALANCE_INTERVAL` / `MAX_MIN_REBALANCE_INTERVAL`) | Limits how often the keeper may act on a position; the 15-minute floor stops a compromised keeper from churning a position many times per block |
| `maxRangeSpacings` | 1 to 1000 tick spacings | Only limits how wide a keeper-chosen range may be |
| `maxTwapDeviationTicks` | 1 to 500 ticks (~5%) | Only limits when the keeper may act |
| `depositsPaused` / `rebalancesPaused` | boolean | Stops new deposits / keeper activity. Never affects any exit path |
| `addVault` / `setVaultDepositsOpen` | registered vaults only | Opens or closes new deposits for a pool |

Nothing in the registry can be set outside these caps: the setters revert, and the constructor applies the
same checks to the initial configuration.

## Keeper guard rails, enforced in `PandaVault.rebalance`

The keeper is the only non-owner address that can act on a position, so it gets the most scrutiny. Every
degree of freedom it has is bounded:

1. **Rewards.** The position's pending AERO is measured with before/after balance deltas (per position, no
   pooled dust) and the reward fee is taken. If the owner has auto-compounding off, their share is transferred
   to them as raw AERO. If it is on, the share (plus any AERO already in the position's reserve) is sold along
   the vault's compound route (1 to 3 hops ending in token A or B, fixed in the constructor, no setter), each hop
   floored at its own pool's TWAP minus `maxRebalanceSlippageBps`, and the proceeds go into the new range. The keeper never supplies a reward swap path or a minimum.
2. **Swap venue.** The rebalance swap path is built on-chain as `tokenIn / tickSpacing / tokenOut`, i.e. a
   single hop through the vault's own pool. The keeper cannot name a path.
3. **Swap price.** The vault reads the pool's TWAP over `twapWindow`, computes the output that price implies,
   and refuses any fill worse than `maxRebalanceSlippageBps` below it, whatever minimum the keeper passed.
4. **Spot near TWAP.** The keeper may only act while the pool's spot tick is within `maxTwapDeviationTicks` of
   the TWAP tick. Right after someone pushes the price, the vault refuses to start a rebalance. The check runs
   once, before the position's own swap; the new range is minted at the spot that swap leaves (KNOWN-RISKS F-21).
5. **Range.** The new range must be tick-spacing aligned, must contain the current pool tick, and must be at
   most `maxRangeSpacings` wide. The keeper cannot park a position out of range to stop it earning.
6. **Frequency.** A position cannot be rebalanced again before `minRebalanceInterval` has passed, and that
   interval can never be set below 15 minutes. (A new or migrated position has no previous rebalance, so its
   first rebalance is not delayed.)
7. **Amounts.** The swap input is capped at what the position owns (released liquidity + its reserve +
   compounded output), and the keeper's own minimum is scaled down pro rata if it was capped; whatever the mint
   does not consume is recorded in the new token id's reserve (see below).
8. **Ownership.** The new NFT is credited to the same owner with the same settings.

What remains: a malicious keeper could stop rebalancing (liveness) or, at most, cost a position the capped
slippage and swap fee per rebalance, no more often than the cooldown allows (at least 15 minutes per position), while the multisig replaces it
through the timelock. It cannot send user funds anywhere.

## Per-position reserves (leftovers and auto-compounding AERO)

A deposit or rebalance rarely fits every last unit into the range. The deployed vault sends that remainder to
the owner's wallet; this vault keeps it, recorded against the position:

- `reserves(tokenId)` holds token A, token B (e.g. WETH, USDC) and AERO (owner's share, reward fee already taken) that belong to that
  position but are outside its NFT. At the next rebalance the whole reserve goes back into the same position,
  and whatever still does not fit is recorded against the new token id. Deposit leftovers go in the same way.
- AERO waits in the reserve when auto-compounding is on and the pot is under `MIN_COMPOUND_AERO` (0.01 AERO),
  or when the TWAP of any compound-route hop cannot be read or the swap fails. Compounding never blocks a rebalance.
- A reserve is only ever re-used by the SAME position (inside `rebalance` of that token id) or paid to that
  position's owner (`claimRewards` pays the AERO part, `withdrawReserves` pays all of it, and every exit
  pays all of it). No function reads "whatever the vault holds": every amount is either a reserve entry or a
  before/after balance delta measured for the position being acted on. So a position cannot pick up another
  position's reserve, and tokens sent straight to the vault are credited to nobody.
- `topUp(tokenId, data)` (owner only, closed whenever deposits are; body in the external library
  `PandaTopUpLib`, linked like `PandaVaultLib`): deposit fee, optional zap swap, then the SAME NFT is unstaked,
  increased and restaked. Amounts are balance deltas inside the call; what the range cannot take and the AERO the
  unstake paid (reward fee taken) go to that position's reserve. It never touches another position. Known effects:
  the gauge's minStakeTime restarts on a restake (10 s on Base today, so at most 10 s of rewards are at stake), and
  the dormant time fee's checkpoint is not moved, so if that fee is ever switched on, money added by a top-up is
  billed from the position's last checkpoint (at most 30 days per charge).
- `totalReservedA/B/Aero` always equal the sum of all reserves, and the vault's balances equal those
  totals plus anything sent to it directly. `test/aero-review.test.js` checks the reward accounting through
  withdraw, top-up, rebalance, migrate-out, two claims in one block, deferred collection, shutdown and forceExit.

## Exit paths, none of which can be paused, delayed or gated

- `claimRewards`: claim AERO (pending + reserved), optionally swapped to USDC along a path the owner chooses.
- `withdrawReserves`: pay the position's whole reserve (WETH, USDC, AERO) to the owner, position untouched.
- `withdrawPosition`: unstake, remove liquidity, claim, pay the reserve, optionally swap WETH to USDC along an
  owner-chosen path.
- `emergencyWithdraw`: same without any swap, so a broken router can never trap funds.
- `withdrawRawNft`: unstake and hand the Slipstream NFT itself to the owner (reserve and rewards paid raw), so
  even a broken position manager `decreaseLiquidity` cannot trap funds.
- `setAutoCompound`: the owner's switch; also never pausable.

Fees apply to these exits as described above, but a fee can never stop one.

## Things that were deliberately left out

- No `rescueTokens` / `sweep` / `recoverERC20` on any contract. Such functions are exactly the "send funds
  somewhere" lever the platform promises not to have. (Consequence: tokens sent straight to a vault by mistake
  stay there, credited to nobody.)
- No admin path to migrate positions between vaults. Owners move themselves: `migrate` (one owner-signed
  transaction into another registered vault), or withdraw and deposit.
- No owner on `PandaVault` at all; it only *reads* the registry and the fee policy.
- No router setter. A new Aerodrome router means a new vault, registered through the timelock.
- **No gas / automation fee, by construction** (owner decision, 2026-09-27). The vault only ever charges the seven kinds above, none of which is tied to gas, and the keeper cannot take anything from a position. No fee policy can add a gas markup; that would need a new vault users opt into.

## Verifying the claims yourself

- `test/governance.test.js` asserts the write-function surface of `PandaVault`, `PandaRegistry` and
  `PandaFeePolicy`, checks the library cannot be called directly, and attacks the fee plumbing with reverting,
  gas-burning, garbage, huge-return and over-cap policies and a recipient that refuses transfers.
- `test/aero-vault.test.js` exercises deposit, top-up, rebalance with every guard rail, the early-unstake window,
  migrations, shutdown and forceExit; `scripts/rehearse-aero-fork.js` runs the whole life of a position on a Base
  fork against Aero's real pool, gauge and router.
- Every fund movement in `PandaVault`/`PandaVaultLib` goes to one of: the position owner (`msg.sender` or
  `info.owner`), a fee leg (clamped as above), the router (swap, measured in and out), the position manager
  (mint, approval reset to zero), or the gauge (stake). Grep for `safeTransfer(` and `_tryTransfer(` to confirm.
