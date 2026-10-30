// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./interfaces/IPandaFeePolicy.sol";
import "./interfaces/IPandaRegistry.sol";
import "./interfaces/IPandaDiscountSources.sol";

/**
 * @title PandaFeePolicyV3
 * @notice PandaFeePolicy v2 plus on-chain referrals, a stakers' leg, automatic fee stages and a treasury minimum
 * (owner decisions 2026-10-10). Swapped in for v2 through the timelock (registry.setFeePolicy); no vault changes: a
 * vault reads up to six legs and this policy returns at most five. Every v2 view keeps its shape (tiers,
 * keeperRewardBps, tokenStaking, passStaking, basePandaBps, pandaBpsFor, discountBalances, activeStage, splitFor,
 * feeLegs) except `stages()`, whose entries gain `stakerShareBps` (v2's single `stakerShareBps()` is gone).
 *
 * Every fee is split into up to five legs, in this order:
 *  1. keeper    (REWARD only): `keeperRewardBps`, to the calling vault's keeper. Never discounted.
 *  2. company   the company wallet's part: the active stage's share of the BASE rate, the same for every user whatever
 *               their discount. It belongs to Nakamura Labs; nothing ever comes out of it (owner 2026-10-10): discounts,
 *               referrals and stakers are all paid from the treasury's part. The one exception: a staked special-edition
 *               Pass (Pass level 2) pays `specialPandaBps` or a lower tier at every stage, and for those wallets alone
 *               the company leg is what that rate leaves after the referral leg.
 *  3. treasury  what is left of Panda's rate after the two legs below, to registry.daoTreasury(). Never less than
 *               `minTreasuryBps` of the rewards (special-edition Passes excepted, below).
 *  4. stakers   (REWARD only): the active stage's `stakerShareBps` of the treasury part that remains after the referral
 *               leg, capped so the treasury's own leg never goes below `minTreasuryBps`, to `stakerRewards`
 *               (PandaStakerRewards: buys PANDA with it for stakers under its own rules). Rises with the stage
 *               (owner 2026-10-10: 10% / 15% / 20%).
 *  5. referral  (REWARD only): `referralShareBps` of the WHOLE reward fee (keeper + Panda) straight to the wallet that
 *               referred the user, read from PandaReferrals (`referrals`), paid instantly in AERO with every fee
 *               (owner 2026-10-10: referrals fully on chain, one flat rate, always AERO). No referrer = no leg.
 *               Capped by the treasury part, so it can never touch the company's or the keeper's legs.
 *
 * The ACTIVE STAGE comes from the TVL reader (`stageSource`, PandaTvlReader: the vaults' 30-day average measured on
 * chain, one step at a time) when one is set, else from the manual `activeStage` (timelock). If the reader cannot be
 * read, the manual stage is used. The Safe's override is setStageSource(address(0)) + setActiveStage, through the
 * timelock. The stage is read once per fee.
 *
 * Discounts: a staking tier lowers only the treasury's part. A user's Panda rate can never go below company + referrals
 * + `minTreasuryBps` (the treasury always keeps at least that much of every user's rewards; special-edition Passes
 * excepted, above), so the deepest discount at a stage is what the treasury's part leaves room for; `pandaBpsFor` and
 * `rateFor` return the rate actually paid (`tierPandaBps` the tier's own number).
 *
 * Rounding: company = floor(base * cw / (cw + tw)); referrals and stakers round down; the treasury takes the remainder,
 * so the legs always add up to keeper + the user's Panda rate exactly.
 */
contract PandaFeePolicyV3 is Ownable2Step, IPandaFeePolicy {
    uint8 public constant KINDS = 7; // REWARD, DEPOSIT, WITHDRAW, ZAP_SWAP, REBALANCE_SWAP, COMPOUND_SWAP, TIME
    uint8 public constant REWARD = 0;
    uint8 public constant TIME = 6;
    /// @notice Eight tiers at most: each tier a wallet qualifies for costs the fee call about 6,500 gas (three cold
    /// storage slots), and the vault gives the policy 150,000 gas in all; eight keep the heaviest wallet well inside it.
    uint256 public constant MAX_TIERS = 8;
    uint256 public constant MAX_STAGES = 8;
    uint16 public constant BPS = 10000;
    uint256 internal constant SOURCE_GAS = 50_000;
    uint256 public constant MAX_PASS_LEVEL = 2;
    /// @notice The referrals leg can never be set above 5% of the whole reward fee.
    uint16 public constant MAX_REFERRAL_SHARE_BPS = 500;
    /// @notice The treasury's guaranteed minimum can never be set above 5% of rewards.
    uint16 public constant MAX_MIN_TREASURY_BPS = 500;
    /// @notice keeper + Panda's reward rate can never be set above the vaults' compiled 20% reward-fee ceiling.
    uint16 public constant MAX_TOTAL_REWARD_BPS = 2000;

    IPandaRegistry public immutable registry;

    uint16 public keeperRewardBps;
    uint16[7] internal _basePandaBps;

    struct Tier {
        uint256 minStake;
        uint32 minPasses;
        uint16[7] pandaBps;
    }
    Tier[] internal _tiers;

    struct Stage {
        uint256 minVaultUsd;    // the vault size (30-day average, whole dollars) this stage is meant for; informational
        uint16 companyWeight;   // company : treasury split of Panda's rate
        uint16 treasuryWeight;
        uint16 stakerShareBps;  // the stakers' share of the treasury part (after the referral leg) at this stage
    }
    Stage[] internal _stages;
    uint256 internal _manualStage;
    /// @notice PandaTvlReader: when set, the active stage is its `stage()`; address(0) = the manual stage.
    address public stageSource;

    address public company;
    address public stakerRewards;
    /// @notice PandaReferrals: who referred whom. address(0) = no referral leg.
    address public referrals;
    uint16 public referralShareBps;
    /// @notice The least the treasury's own leg keeps of every user's rewards, in bps, after discounts and after the
    /// stakers' share (special-edition Passes excepted).
    uint16 public minTreasuryBps;
    /// @notice Panda's reward rate for a staked SPECIAL-EDITION Pass (Pass level 2), at every stage (owner 2026-10-10:
    /// "a few diamonds in the rough"). The one place a rate may go below the company's stage leg: for these five Passes
    /// only, the company leg shrinks to what the rate leaves (owner-approved exception). 0 = off.
    uint16 public specialPandaBps;

    address public tokenStaking;
    address public passStaking;

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
    event StakerRewardsSet(address recipient);
    event ReferralsSet(address referrals, uint16 shareBps);
    event StageSourceSet(address source);
    event MinTreasuryBpsSet(uint16 bps);
    event SpecialPandaBpsSet(uint16 bps);

    struct Config {
        address registry;
        address initialOwner;
        uint16 keeperRewardBps;
        uint16[7] basePandaBps;
        address company;
        Stage[] stages;
        uint256 activeStage;
        address stakerRewards;
        address referrals;
        uint16 referralShareBps;
        address stageSource;
        uint16 minTreasuryBps;
        uint16 specialPandaBps;
    }

    constructor(Config memory c) Ownable(c.initialOwner) {
        if (c.registry == address(0)) revert ZeroAddress();
        registry = IPandaRegistry(c.registry);
        _setKeeperRewardBps(c.keeperRewardBps);
        for (uint8 k = 0; k < KINDS; k++) _setBase(k, c.basePandaBps[k]);
        _setCompany(c.company);
        _setStages(c.stages, c.activeStage);
        _setStakerRewards(c.stakerRewards);
        _setReferrals(c.referrals, c.referralShareBps);
        _setStageSource(c.stageSource);
        _setMinTreasuryBps(c.minTreasuryBps);
        _setSpecialPandaBps(c.specialPandaBps);
    }

    // ==========================================
    // THE POLICY
    // ==========================================

    function feeLegs(uint8 kind, address user) external view returns (FeeLeg[] memory legs) {
        if (kind >= KINDS) return legs;
        (uint16 k, uint16 c, uint16 t, uint16 s, uint16 r) = splitForV3(kind, user);
        address referrer = r > 0 ? referrerOf(user) : address(0);
        if (referrer == address(0)) { t += r; r = 0; } // nobody to pay: the treasury keeps that part
        uint256 n = (k > 0 ? 1 : 0) + (c > 0 ? 1 : 0) + (t > 0 ? 1 : 0) + (s > 0 ? 1 : 0) + (r > 0 ? 1 : 0);
        legs = new FeeLeg[](n);
        uint256 i;
        if (k > 0) legs[i++] = FeeLeg({to: registry.keeperOf(msg.sender), bps: k});
        if (c > 0) legs[i++] = FeeLeg({to: company, bps: c});
        if (t > 0) legs[i++] = FeeLeg({to: registry.daoTreasury(), bps: t});
        if (s > 0) legs[i++] = FeeLeg({to: stakerRewards, bps: s});
        if (r > 0) legs[i] = FeeLeg({to: referrer, bps: r});
    }

    /// @notice The wallet that referred `user` (address(0) if none, or if referrals are off / unreadable).
    function referrerOf(address user) public view returns (address) {
        if (referrals == address(0)) return address(0);
        (bool ok, bytes memory ret) = referrals.staticcall{gas: SOURCE_GAS}(abi.encodeWithSignature("referrerOf(address)", user));
        if (!ok || ret.length < 32) return address(0);
        return abi.decode(ret, (address));
    }

    /// @notice The active stage: the TVL reader's, when one is set, else the manual one. If the reader cannot be read
    /// or names a stage this policy does not have, the manual stage is used.
    function activeStage() public view returns (uint256 st) {
        if (stageSource == address(0)) return _manualStage;
        (bool ok, bytes memory ret) = stageSource.staticcall{gas: SOURCE_GAS}(abi.encodeWithSignature("stage()"));
        if (!ok || ret.length < 32) return _manualStage;
        st = abi.decode(ret, (uint256));
        if (st >= _stages.length) st = _manualStage;
    }

    /// @notice How `user`'s fee on `kind` splits right now, in bps of the charged amount (TIME: per year).
    function splitForV3(uint8 kind, address user)
        public view returns (uint16 keeperBps, uint16 companyBps, uint16 treasuryBps, uint16 stakersBps, uint16 referralsBps)
    {
        if (kind >= KINDS) revert BadKind();
        keeperBps = kind == REWARD ? keeperRewardBps : 0;
        uint256 st = activeStage();
        (uint256 panda, uint256 c, uint256 r) = _rate(kind, user, keeperBps, st);
        uint256 rest = panda - c - r; // the treasury's part after the user's discount
        uint256 s;
        if (kind == REWARD && stakerRewards != address(0)) {
            // the stage's share of the treasury side, capped so the treasury's own leg never goes below its minimum
            s = (rest * _stages[st].stakerShareBps) / BPS;
            uint256 keep = rest > minTreasuryBps ? rest - minTreasuryBps : 0;
            if (s > keep) s = keep;
        }
        companyBps = uint16(c);
        referralsBps = uint16(r);
        stakersBps = uint16(s);
        treasuryBps = uint16(rest - s);
    }

    /// @notice v2's four-number view, kept for readers that use it: the treasury figure is AFTER the referrals leg.
    function splitFor(uint8 kind, address user)
        external view returns (uint16 keeperBps, uint16 companyBps, uint16 treasuryBps, uint16 stakersBps)
    {
        (keeperBps, companyBps, treasuryBps, stakersBps,) = splitForV3(kind, user);
    }

    /// @dev The company's leg (the stage's share of the BASE rate, never discounted) and the referrals leg (a share of the
    /// whole base fee, the most the program can owe), both fixed before any discount is applied.
    function _companyAndReferrals(uint8 kind, uint256 keeperBps, uint256 stage) internal view returns (uint256 c, uint256 r) {
        uint256 base = _basePandaBps[kind];
        Stage storage st = _stages[stage];
        c = (base * st.companyWeight) / (uint256(st.companyWeight) + st.treasuryWeight);
        if (kind == REWARD && referrals != address(0)) {
            r = ((keeperBps + base) * referralShareBps) / BPS;
            if (r > base - c) r = base - c;
        }
    }

    /// @dev The lowest Panda rate a discount may reach: company + referrals + the treasury's minimum (REWARD only), never
    /// above the base.
    function _floor(uint8 kind, uint256 c, uint256 r) internal view returns (uint256 f) {
        f = c + r + (kind == REWARD ? minTreasuryBps : 0);
        uint256 base = _basePandaBps[kind];
        if (f > base) f = base;
    }

    /// @dev The user's Panda rate and the company and referrals legs inside it. Normally the best tier's rate, raised to
    /// the floor (company + referrals + treasury minimum) so a discount never reaches the company. A staked special
    /// Pass instead pays `specialPandaBps` (or a lower tier) at every stage, and for those Passes alone the company leg
    /// is what is left after referrals. The staking contracts are read once, and not at all while no tier or special
    /// rate is set (the vault gives the policy a fixed gas budget).
    function _rate(uint8 kind, address user, uint256 keeperBps, uint256 stage) internal view returns (uint256 panda, uint256 c, uint256 r) {
        uint256 base = _basePandaBps[kind];
        if (base > 0 && (_tiers.length > 0 || (kind == REWARD && specialPandaBps > 0))) {
            (uint256 stake, uint256 passes) = discountBalances(user);
            return _rateFrom(kind, keeperBps, stake, passes, stage);
        }
        return _rateFrom(kind, keeperBps, 0, 0, stage);
    }

    /// @notice The Panda rate a holder of `stake` matured PANDA and Pass level `passLevel` (0 none, 1 Pass, 2 special)
    /// pays on `kind` at the current stage: the real rate the website shows for each tier, so the two can never disagree.
    function rateFor(uint8 kind, uint256 stake, uint256 passLevel) external view returns (uint16) {
        if (kind >= KINDS) revert BadKind();
        if (passLevel > MAX_PASS_LEVEL) passLevel = MAX_PASS_LEVEL;
        (uint256 panda,,) = _rateFrom(kind, kind == REWARD ? keeperRewardBps : 0, stake, passLevel, activeStage());
        return uint16(panda);
    }

    function _rateFrom(uint8 kind, uint256 keeperBps, uint256 stake, uint256 passes, uint256 stage) internal view returns (uint256 panda, uint256 c, uint256 r) {
        (c, r) = _companyAndReferrals(kind, keeperBps, stage);
        uint256 base = _basePandaBps[kind];
        panda = _tierRate(kind, base, stake, passes);
        bool special = kind == REWARD && specialPandaBps > 0 && passes >= MAX_PASS_LEVEL;
        if (special && specialPandaBps < panda) panda = specialPandaBps;
        if (special) {
            if (r > panda) r = panda;
            if (c > panda - r) c = panda - r;
        } else {
            uint256 f = _floor(kind, c, r);
            if (panda < f) panda = f;
        }
    }

    function _tierRate(uint8 kind, uint256 base, uint256 stake, uint256 passes) internal view returns (uint256 bps) {
        bps = base;
        uint256 n = _tiers.length;
        for (uint256 i = 0; i < n; i++) {
            Tier storage t = _tiers[i];
            if (stake >= t.minStake && passes >= t.minPasses && t.pandaBps[kind] < bps) bps = t.pandaBps[kind];
        }
    }

    /// @notice Panda's rate `user` actually pays on `kind` (keeper leg not included): the tier's rate, but never below
    /// the company's leg + the referrals leg. Never above the base.
    function pandaBpsFor(uint8 kind, address user) public view returns (uint16) {
        if (kind >= KINDS) revert BadKind();
        uint16 kb = kind == REWARD ? keeperRewardBps : 0;
        (uint256 panda,,) = _rate(kind, user, kb, activeStage());
        return uint16(panda);
    }

    /// @notice The rate the user's best staking tier names (before the company/referrals floor). Never above the base.
    function tierPandaBps(uint8 kind, address user) public view returns (uint16 bps) {
        if (kind >= KINDS) revert BadKind();
        bps = _basePandaBps[kind];
        if (_tiers.length == 0 || bps == 0) return bps;
        (uint256 stake, uint256 passes) = discountBalances(user);
        bps = uint16(_tierRate(kind, bps, stake, passes));
    }

    function discountBalances(address user) public view returns (uint256 stake, uint256 passes) {
        stake = _read(tokenStaking, abi.encodeCall(IPandaTokenStaking.activeStakeOf, (user)));
        passes = _read(passStaking, abi.encodeCall(IPandaPassStaking.activePassLevel, (user)));
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

    function setStages(Stage[] calldata newStages, uint256 active) external onlyOwner { _setStages(newStages, active); }

    /// @notice The manual stage (used only while no TVL reader is set).
    function setActiveStage(uint256 stage) external onlyOwner {
        if (stage >= _stages.length) revert BadStage();
        _manualStage = stage;
        emit ActiveStageSet(stage, _stages[stage].companyWeight, _stages[stage].treasuryWeight);
    }

    /// @notice The TVL reader that moves the stage on its own; address(0) returns control to the manual stage.
    function setStageSource(address source) external onlyOwner { _setStageSource(source); }

    function setCompany(address company_) external onlyOwner { _setCompany(company_); }

    /// @notice Where the stakers' leg goes (PandaStakerRewards). address(0) = off. The share is per stage (setStages).
    function setStakerRewards(address recipient) external onlyOwner { _setStakerRewards(recipient); }

    /// @notice The referral registry and the referrer's share of the whole reward fee (at most MAX_REFERRAL_SHARE_BPS).
    function setReferrals(address referrals_, uint16 shareBps) external onlyOwner { _setReferrals(referrals_, shareBps); }

    function _setKeeperRewardBps(uint16 bps) internal {
        if (bps > BPS || uint256(bps) + _basePandaBps[REWARD] > MAX_TOTAL_REWARD_BPS) revert RateTooHigh();
        keeperRewardBps = bps;
        emit KeeperRewardBpsSet(bps);
    }

    function _setBase(uint8 kind, uint16 bps) internal {
        if (kind >= KINDS) revert BadKind();
        if (bps > BPS) revert RateTooHigh();
        if (kind == REWARD && uint256(keeperRewardBps) + bps > MAX_TOTAL_REWARD_BPS) revert RateTooHigh();
        _basePandaBps[kind] = bps;
        emit BasePandaBpsSet(kind, bps);
    }

    function _setCompany(address company_) internal {
        if (company_ == address(0)) revert ZeroAddress();
        company = company_;
        emit CompanySet(company_);
    }

    function _setStakerRewards(address recipient) internal {
        stakerRewards = recipient;
        emit StakerRewardsSet(recipient);
    }

    function _setReferrals(address referrals_, uint16 shareBps) internal {
        if (shareBps > MAX_REFERRAL_SHARE_BPS) revert RateTooHigh();
        referrals = referrals_;
        referralShareBps = shareBps;
        emit ReferralsSet(referrals_, shareBps);
    }

    function _setStageSource(address source) internal {
        stageSource = source;
        emit StageSourceSet(source);
    }

    /// @notice Panda's reward rate for a staked special-edition Pass at every stage (0 = off; never above the base).
    function setSpecialPandaBps(uint16 bps) external onlyOwner { _setSpecialPandaBps(bps); }

    function _setSpecialPandaBps(uint16 bps) internal {
        if (bps > _basePandaBps[REWARD]) revert RateTooHigh();
        specialPandaBps = bps;
        emit SpecialPandaBpsSet(bps);
    }

    /// @notice The least the treasury's own leg keeps of every user's rewards after discounts and the stakers' share
    /// (bps of rewards, at most 5%; special-edition Passes excepted).
    function setMinTreasuryBps(uint16 bps) external onlyOwner { _setMinTreasuryBps(bps); }

    function _setMinTreasuryBps(uint16 bps) internal {
        if (bps > MAX_MIN_TREASURY_BPS) revert RateTooHigh();
        minTreasuryBps = bps;
        emit MinTreasuryBpsSet(bps);
    }

    function _setStages(Stage[] memory newStages, uint256 active) internal {
        if (newStages.length == 0 || newStages.length > MAX_STAGES || active >= newStages.length) revert BadStages();
        delete _stages;
        for (uint256 i = 0; i < newStages.length; i++) {
            if (uint256(newStages[i].companyWeight) + newStages[i].treasuryWeight == 0 || newStages[i].stakerShareBps > BPS) revert BadStages();
            _stages.push(newStages[i]);
        }
        _manualStage = active;
        emit StagesSet(newStages.length);
        emit ActiveStageSet(active, newStages[active].companyWeight, newStages[active].treasuryWeight);
    }
}
