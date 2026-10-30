// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IPandaFeePolicy.sol";
import "./interfaces/IPandaRegistry.sol";
import "./interfaces/IPandaDiscountSources.sol";

/**
 * @title PandaFeePolicy (v2)
 * @notice Decides fee rates, staking discounts and recipients for every Panda vault. Owned by the timelock.
 *
 * Whole policy contracts are replaceable (registry.setFeePolicy through the timelock), so a completely different
 * fee structure is a new policy, not a new vault. Whatever a policy answers, each vault clamps it to the ceilings
 * compiled into that vault (rewards 20%, deposit 2.00%, withdrawal 2.00%, each swap kind 1.00%, time 2.00% a year).
 *
 * Every fee is split into up to four legs, in this order:
 *  1. keeper   (REWARD only): `keeperRewardBps`, paid to the calling vault's keeper (registry.keeperOf(vault)). The
 *              same on every tier: a discount never reduces what pays for the vault's gas.
 *  2. company  the company wallet's part of Panda's rate (`company`).
 *  3. treasury the rest of Panda's rate, to registry.daoTreasury().
 *  4. stakers  (REWARD only): `stakerShareBps` of the treasury part, to `stakerRewards` (the contract that turns it into
 *              USDC for PANDA stakers). Off (0) until the owner switches it on.
 *
 * Panda's rate for a user on a fee kind = the lowest of the kind's base rate and the rate of every tier the user
 * qualifies for. A tier qualifies when the user's MATURED token stake >= minStake and MATURED Pass level >= minPasses.
 * The Pass level is 0 (no staked Pass), 1 (a staked Panda Pass) or 2 (a staked special-edition Pass, one of the five
 * the Pass contract gives to milestone mints); a wallet counts at most ONE Pass. So `minPasses` 1 = any Pass,
 * 2 = a special edition. The staking contracts only count stake that has stayed staked for their warm-up, and
 * unstaking removes it at once.
 *
 * The company / treasury split follows the ACTIVE STAGE: two weights (e.g. 15 : 4) applied to Panda's rate, so a tier
 * discount is shared by both sides in the same ratio. The stages are published on-chain with the vault size each is
 * meant for (`minVaultUsd`, informational); the owner (the timelock, so every change is public 48 h ahead) moves the
 * active stage when the vaults' 30-day average crosses a line.
 *
 * TIME (kind 6) rates are PER YEAR of a position's liquidity; the vault pro-rates them. 0 at launch (dormant).
 *
 * Launch configuration: REWARD keeper 1% + Panda 19% (Stage 1: company 15%, treasury 4%), every other kind 0,
 * no tiers, stakers off.
 */
contract PandaFeePolicy is Ownable2Step, IPandaFeePolicy {
    uint8 public constant KINDS = 7; // REWARD, DEPOSIT, WITHDRAW, ZAP_SWAP, REBALANCE_SWAP, COMPOUND_SWAP, TIME
    uint8 public constant REWARD = 0;
    uint8 public constant TIME = 6;
    uint256 public constant MAX_TIERS = 12;
    uint256 public constant MAX_STAGES = 8;
    uint16 public constant BPS = 10000;
    uint256 internal constant SOURCE_GAS = 50_000;
    /// @notice Highest Pass level a source can report: 2 = a staked special edition.
    uint256 public constant MAX_PASS_LEVEL = 2;

    IPandaRegistry public immutable registry;

    uint16 public keeperRewardBps;
    uint16[7] internal _basePandaBps;

    struct Tier {
        uint256 minStake;     // matured staked tokens (wei) required
        uint32 minPasses;     // matured staked Pass LEVEL required: 0 none, 1 any Pass, 2 a special edition
        uint16[7] pandaBps;   // Panda's rate per kind for users in this tier (keeper leg not included)
    }
    Tier[] internal _tiers;

    struct Stage {
        uint256 minVaultUsd;    // the vault size (30-day average, whole dollars) this stage is meant for; informational
        uint16 companyWeight;   // company : treasury split of Panda's rate
        uint16 treasuryWeight;
    }
    Stage[] internal _stages;
    uint256 public activeStage;

    /// @notice The company wallet: pays the platform's running costs.
    address public company;
    /// @notice Receives the stakers' leg (PandaStakerRevenue: sells it for USDC and streams it to PANDA stakers).
    address public stakerRewards;
    /// @notice Share of the treasury part of REWARD fees sent to `stakerRewards`, in bps (0 = off).
    uint16 public stakerShareBps;

    address public tokenStaking; // IPandaTokenStaking, address(0) = no token discounts
    address public passStaking;  // IPandaPassStaking, address(0) = no Pass discounts

    error ZeroAddress();
    error BadKind();
    error RateTooHigh();
    error TooManyTiers();
    error BadStages();
    error BadStage();

    event KeeperRewardBpsSet(uint16 bps);
    event BasePandaBpsSet(uint8 indexed kind, uint16 bps);
    event TiersSet(uint256 count);
    event DiscountSourcesSet(address tokenStaking, address passStaking);
    event StagesSet(uint256 count);
    event ActiveStageSet(uint256 indexed stage, uint16 companyWeight, uint16 treasuryWeight);
    event CompanySet(address company);
    event StakerRewardsSet(address recipient, uint16 shareBps);

    constructor(
        address registry_,
        address initialOwner,
        uint16 keeperRewardBps_,
        uint16[7] memory basePandaBps_,
        address company_,
        Stage[] memory stages_,
        uint256 activeStage_
    ) Ownable(initialOwner) {
        if (registry_ == address(0)) revert ZeroAddress();
        registry = IPandaRegistry(registry_);
        _setKeeperRewardBps(keeperRewardBps_);
        for (uint8 k = 0; k < KINDS; k++) _setBase(k, basePandaBps_[k]);
        _setCompany(company_);
        _setStages(stages_, activeStage_);
    }

    // ==========================================
    // THE POLICY
    // ==========================================

    function feeLegs(uint8 kind, address user) external view returns (FeeLeg[] memory legs) {
        if (kind >= KINDS) return legs;
        (uint16 k, uint16 c, uint16 t, uint16 s) = splitFor(kind, user);
        uint256 n = (k > 0 ? 1 : 0) + (c > 0 ? 1 : 0) + (t > 0 ? 1 : 0) + (s > 0 ? 1 : 0);
        legs = new FeeLeg[](n);
        uint256 i;
        // The calling vault is msg.sender (it calls the policy directly), so its own keeper gets the keeper leg.
        if (k > 0) legs[i++] = FeeLeg({to: registry.keeperOf(msg.sender), bps: k});
        if (c > 0) legs[i++] = FeeLeg({to: company, bps: c});
        if (t > 0) legs[i++] = FeeLeg({to: registry.daoTreasury(), bps: t});
        if (s > 0) legs[i] = FeeLeg({to: stakerRewards, bps: s});
    }

    /// @notice How `user`'s fee on `kind` splits right now, in bps of the charged amount (TIME: per year).
    function splitFor(uint8 kind, address user)
        public view returns (uint16 keeperBps, uint16 companyBps, uint16 treasuryBps, uint16 stakersBps)
    {
        if (kind >= KINDS) revert BadKind();
        keeperBps = kind == REWARD ? keeperRewardBps : 0;
        uint256 panda = pandaBpsFor(kind, user);
        Stage storage st = _stages[activeStage];
        uint256 c = (panda * st.companyWeight) / (uint256(st.companyWeight) + st.treasuryWeight);
        uint256 rest = panda - c;
        uint256 s = (kind == REWARD && stakerRewards != address(0)) ? (rest * stakerShareBps) / BPS : 0;
        companyBps = uint16(c);
        stakersBps = uint16(s);
        treasuryBps = uint16(rest - s);
    }

    /// @notice Panda's rate for `user` on `kind` after tier discounts (keeper leg not included). Never above the base.
    function pandaBpsFor(uint8 kind, address user) public view returns (uint16 bps) {
        if (kind >= KINDS) revert BadKind();
        bps = _basePandaBps[kind];
        uint256 n = _tiers.length;
        if (n == 0 || bps == 0) return bps;
        (uint256 stake, uint256 passes) = discountBalances(user);
        for (uint256 i = 0; i < n; i++) {
            Tier storage t = _tiers[i];
            if (stake >= t.minStake && passes >= t.minPasses && t.pandaBps[kind] < bps) bps = t.pandaBps[kind];
        }
    }

    /// @notice The matured stake and Pass level (0 none, 1 Pass, 2 special edition) the tiers use. A broken staking
    /// contract only costs the discount.
    function discountBalances(address user) public view returns (uint256 stake, uint256 passes) {
        stake = _read(tokenStaking, abi.encodeCall(IPandaTokenStaking.activeStakeOf, (user)));
        passes = _read(passStaking, abi.encodeCall(IPandaPassStaking.activePassLevel, (user)));
        // One Pass per wallet (owner rule): the level is about WHICH Pass, never how many; nothing above a special.
        if (passes > MAX_PASS_LEVEL) passes = MAX_PASS_LEVEL;
    }

    function _read(address source, bytes memory data) internal view returns (uint256) {
        if (source == address(0)) return 0;
        (bool ok, bytes memory ret) = source.staticcall{gas: SOURCE_GAS}(data);
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    // ==========================================
    // VIEWS
    // ==========================================

    function basePandaBps(uint8 kind) external view returns (uint16) {
        if (kind >= KINDS) revert BadKind();
        return _basePandaBps[kind];
    }

    function tiers() external view returns (Tier[] memory) { return _tiers; }
    function stages() external view returns (Stage[] memory) { return _stages; }

    // ==========================================
    // OWNER (timelock) CONFIGURATION
    // ==========================================

    function setKeeperRewardBps(uint16 bps) external onlyOwner { _setKeeperRewardBps(bps); }

    function setBasePandaBps(uint8 kind, uint16 bps) external onlyOwner { _setBase(kind, bps); }

    /// @notice Replace all discount tiers (any order; the lowest rate a user qualifies for wins).
    function setTiers(Tier[] calldata newTiers) external onlyOwner {
        if (newTiers.length > MAX_TIERS) revert TooManyTiers();
        delete _tiers;
        for (uint256 i = 0; i < newTiers.length; i++) {
            for (uint8 k = 0; k < KINDS; k++) if (newTiers[i].pandaBps[k] > BPS) revert RateTooHigh();
            _tiers.push(newTiers[i]);
        }
        emit TiersSet(newTiers.length);
    }

    function setDiscountSources(address tokenStaking_, address passStaking_) external onlyOwner {
        tokenStaking = tokenStaking_;
        passStaking = passStaking_;
        emit DiscountSourcesSet(tokenStaking_, passStaking_);
    }

    /// @notice Replace the published stage schedule and choose the active stage.
    function setStages(Stage[] calldata newStages, uint256 active) external onlyOwner { _setStages(newStages, active); }

    /// @notice Move to another published stage (e.g. the vaults' 30-day average crossed $50,000).
    function setActiveStage(uint256 stage) external onlyOwner {
        if (stage >= _stages.length) revert BadStage();
        activeStage = stage;
        emit ActiveStageSet(stage, _stages[stage].companyWeight, _stages[stage].treasuryWeight);
    }

    function setCompany(address company_) external onlyOwner { _setCompany(company_); }

    /// @notice Switch the stakers' share on or off. `recipient` 0 = off whatever `shareBps` says.
    function setStakerRewards(address recipient, uint16 shareBps) external onlyOwner {
        if (shareBps > BPS) revert RateTooHigh();
        stakerRewards = recipient;
        stakerShareBps = shareBps;
        emit StakerRewardsSet(recipient, shareBps);
    }

    function _setKeeperRewardBps(uint16 bps) internal {
        if (bps > BPS) revert RateTooHigh();
        keeperRewardBps = bps;
        emit KeeperRewardBpsSet(bps);
    }

    function _setBase(uint8 kind, uint16 bps) internal {
        if (kind >= KINDS) revert BadKind();
        if (bps > BPS) revert RateTooHigh();
        _basePandaBps[kind] = bps;
        emit BasePandaBpsSet(kind, bps);
    }

    function _setCompany(address company_) internal {
        if (company_ == address(0)) revert ZeroAddress();
        company = company_;
        emit CompanySet(company_);
    }

    function _setStages(Stage[] memory newStages, uint256 active) internal {
        if (newStages.length == 0 || newStages.length > MAX_STAGES || active >= newStages.length) revert BadStages();
        delete _stages;
        for (uint256 i = 0; i < newStages.length; i++) {
            if (uint256(newStages[i].companyWeight) + newStages[i].treasuryWeight == 0) revert BadStages();
            _stages.push(newStages[i]);
        }
        activeStage = active;
        emit StagesSet(newStages.length);
        emit ActiveStageSet(active, newStages[active].companyWeight, newStages[active].treasuryWeight);
    }
}
