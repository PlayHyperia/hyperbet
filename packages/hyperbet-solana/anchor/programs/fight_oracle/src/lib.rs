#![allow(clippy::too_many_arguments)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

declare_id!("FHXu3csARjtD4hEcuw3WobxoEU98h6j2vVhXjwuJhnJu");

pub const ORACLE_CONFIG_SEED: &[u8] = b"oracle_config";
pub const DUEL_SEED: &[u8] = b"duel";
pub const PROPOSAL_SEED: &[u8] = b"proposal";
pub const RESULT_HASH_DOMAIN: &[u8] = b"hyperia-duel-result-v2";
pub const ACCOUNT_SCHEMA_VERSION: u16 = 2;

#[program]
pub mod fight_oracle {
    use super::*;

    pub fn initialize_oracle(
        ctx: Context<InitializeOracle>,
        reporter: Pubkey,
        finalizer: Pubkey,
        challenger: Pubkey,
        dispute_window_secs: i64,
    ) -> Result<()> {
        let program_data = &ctx.accounts.program_data;
        let upgrade_authority = program_data
            .upgrade_authority_address
            .ok_or(ErrorCode::UnauthorizedInitializer)?;
        require!(
            upgrade_authority != Pubkey::default(),
            ErrorCode::UnauthorizedInitializer
        );
        require_keys_eq!(
            upgrade_authority,
            ctx.accounts.authority.key(),
            ErrorCode::UnauthorizedInitializer
        );

        let oracle_config = &mut ctx.accounts.oracle_config;
        // WS2: One-time initialization only. No bootstrap fallback pattern.
        validate_uninitialized_oracle_config(oracle_config)?;
        oracle_config.authority = upgrade_authority;
        oracle_config.bump = ctx.bumps.oracle_config;
        oracle_config.account_schema_version = ACCOUNT_SCHEMA_VERSION;

        require!(reporter != Pubkey::default(), ErrorCode::InvalidReporter);
        require!(finalizer != Pubkey::default(), ErrorCode::InvalidFinalizer);
        require!(
            challenger != Pubkey::default(),
            ErrorCode::InvalidChallenger
        );
        require!(dispute_window_secs >= 60, ErrorCode::InvalidDisputeWindow);

        oracle_config.reporter = reporter;
        oracle_config.finalizer = finalizer;
        oracle_config.challenger = challenger;
        oracle_config.dispute_window_secs = dispute_window_secs;
        Ok(())
    }

    pub fn update_oracle_config(
        ctx: Context<UpdateOracleConfig>,
        authority: Pubkey,
        reporter: Pubkey,
        finalizer: Pubkey,
        challenger: Pubkey,
        dispute_window_secs: i64,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.oracle_config.authority,
            ctx.accounts.authority.key(),
            ErrorCode::Unauthorized
        );
        require!(
            !ctx.accounts.oracle_config.config_frozen,
            ErrorCode::ConfigFrozen
        );
        require!(
            authority == ctx.accounts.oracle_config.authority,
            ErrorCode::ConfigAuthorityImmutable
        );
        require!(authority != Pubkey::default(), ErrorCode::InvalidAuthority);
        require!(reporter != Pubkey::default(), ErrorCode::InvalidReporter);
        require!(finalizer != Pubkey::default(), ErrorCode::InvalidFinalizer);
        require!(
            challenger != Pubkey::default(),
            ErrorCode::InvalidChallenger
        );
        require!(dispute_window_secs >= 60, ErrorCode::InvalidDisputeWindow);

        let oracle_config = &mut ctx.accounts.oracle_config;
        oracle_config.reporter = reporter;
        oracle_config.finalizer = finalizer;
        oracle_config.challenger = challenger;
        oracle_config.dispute_window_secs = dispute_window_secs;
        Ok(())
    }

    /// One-way config freeze — after calling, update_oracle_config reverts permanently.
    /// Pause controls remain functional.
    pub fn freeze_oracle_config(ctx: Context<UpdateOracleConfig>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.oracle_config.authority,
            ctx.accounts.authority.key(),
            ErrorCode::Unauthorized
        );
        require!(
            !ctx.accounts.oracle_config.config_frozen,
            ErrorCode::ConfigFrozen
        );
        ctx.accounts.oracle_config.config_frozen = true;
        Ok(())
    }

    /// Emergency pause/unpause — remains functional even after config freeze.
    pub fn set_oracle_paused(ctx: Context<UpdateOracleConfig>, paused: bool) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.oracle_config.authority,
            ctx.accounts.authority.key(),
            ErrorCode::Unauthorized
        );
        ctx.accounts.oracle_config.paused = paused;
        Ok(())
    }

    pub fn upsert_duel(
        ctx: Context<UpsertDuel>,
        duel_key: [u8; 32],
        participant_a_hash: [u8; 32],
        participant_b_hash: [u8; 32],
        competitive_snapshot_version: u32,
        competitive_snapshot_digest: [u8; 32],
        bet_open_ts: i64,
        bet_close_ts: i64,
        duel_start_ts: i64,
        metadata_uri: String,
        status: DuelStatus,
    ) -> Result<()> {
        require!(!ctx.accounts.oracle_config.paused, ErrorCode::OraclePaused);
        // L-7: Validate metadata_uri fits in the 200-byte allocation
        require!(metadata_uri.len() <= 200, ErrorCode::MetadataUriTooLong);
        require!(
            status == DuelStatus::Scheduled
                || status == DuelStatus::BettingOpen
                || status == DuelStatus::Locked,
            ErrorCode::InvalidLifecycleTransition
        );
        if status != DuelStatus::Scheduled {
            require!(
                ctx.accounts.oracle_config.config_frozen,
                ErrorCode::ConfigNotFrozen
            );
        }
        require!(
            participant_a_hash != [0_u8; 32] && participant_b_hash != [0_u8; 32],
            ErrorCode::InvalidParticipants
        );
        require!(
            participant_a_hash != participant_b_hash,
            ErrorCode::InvalidParticipants
        );
        require!(
            competitive_snapshot_version > 0 && competitive_snapshot_digest != [0_u8; 32],
            ErrorCode::InvalidCompetitiveSnapshot
        );
        require!(bet_open_ts > 0, ErrorCode::InvalidBetWindow);
        require!(bet_close_ts > bet_open_ts, ErrorCode::InvalidBetWindow);
        require!(
            duel_start_ts >= bet_close_ts,
            ErrorCode::InvalidLifecycleTransition
        );
        if status == DuelStatus::Locked {
            require!(
                Clock::get()?.unix_timestamp >= bet_close_ts,
                ErrorCode::BettingWindowActive
            );
        }

        let duel_state = &mut ctx.accounts.duel_state;
        let is_initialized = classify_duel_initialization(duel_state)?;
        if is_initialized {
            require!(duel_state.duel_key == duel_key, ErrorCode::DuelKeyMismatch);
            require!(
                duel_state.status != DuelStatus::Resolved
                    && duel_state.status != DuelStatus::Cancelled,
                ErrorCode::DuelAlreadyFinalized
            );
            require!(
                duel_status_rank(status) >= duel_status_rank(duel_state.status),
                ErrorCode::InvalidLifecycleTransition
            );
        } else {
            duel_state.bump = ctx.bumps.duel_state;
            duel_state.account_schema_version = ACCOUNT_SCHEMA_VERSION;
            duel_state.winner = MarketSide::None;
        }

        // Lock participant identity and every published phase boundary once
        // betting opens. Moving duel_start_ts after users can hold positions
        // would desynchronize the game, stream, keeper, and result-time checks.
        if is_initialized
            && duel_status_rank(duel_state.status) >= duel_status_rank(DuelStatus::BettingOpen)
        {
            require!(
                participant_a_hash == duel_state.participant_a_hash,
                ErrorCode::ParticipantHashImmutable
            );
            require!(
                participant_b_hash == duel_state.participant_b_hash,
                ErrorCode::ParticipantHashImmutable
            );
            require!(
                competitive_snapshot_version == duel_state.competitive_snapshot_version
                    && competitive_snapshot_digest == duel_state.competitive_snapshot_digest,
                ErrorCode::CompetitiveSnapshotImmutable
            );
            require!(
                bet_open_ts == duel_state.bet_open_ts,
                ErrorCode::TimingImmutable
            );
            require!(
                bet_close_ts == duel_state.bet_close_ts,
                ErrorCode::TimingImmutable
            );
            require!(
                duel_start_ts == duel_state.duel_start_ts,
                ErrorCode::TimingImmutable
            );
        }

        duel_state.duel_key = duel_key;
        duel_state.participant_a_hash = participant_a_hash;
        duel_state.participant_b_hash = participant_b_hash;
        duel_state.competitive_snapshot_version = competitive_snapshot_version;
        duel_state.competitive_snapshot_digest = competitive_snapshot_digest;
        duel_state.bet_open_ts = bet_open_ts;
        duel_state.bet_close_ts = bet_close_ts;
        duel_state.duel_start_ts = duel_start_ts;
        duel_state.status = status;
        duel_state.active_proposal = [0_u8; 32];
        emit!(DuelUpserted {
            duel_key,
            status,
            bet_open_ts,
            bet_close_ts,
            duel_start_ts,
            competitive_snapshot_version,
            competitive_snapshot_digest,
            metadata_uri: metadata_uri.clone(),
        });
        duel_state.metadata_uri = metadata_uri;
        Ok(())
    }

    pub fn cancel_duel(
        ctx: Context<CancelDuel>,
        _duel_key: [u8; 32],
        metadata_uri: String,
    ) -> Result<()> {
        require!(!ctx.accounts.oracle_config.paused, ErrorCode::OraclePaused);
        require!(metadata_uri.len() <= 200, ErrorCode::MetadataUriTooLong);
        let duel_state = &mut ctx.accounts.duel_state;
        require!(
            duel_state.status != DuelStatus::Resolved && duel_state.status != DuelStatus::Cancelled,
            ErrorCode::DuelAlreadyFinalized
        );
        require!(
            duel_state.status == DuelStatus::Scheduled
                || duel_state.status == DuelStatus::BettingOpen
                || duel_state.status == DuelStatus::Locked,
            ErrorCode::InvalidLifecycleTransition
        );
        duel_state.status = DuelStatus::Cancelled;
        duel_state.active_proposal = [0_u8; 32];
        emit!(DuelCancelled {
            duel_key: duel_state.duel_key,
            metadata_uri: metadata_uri.clone(),
        });
        duel_state.metadata_uri = metadata_uri;
        Ok(())
    }

    pub fn propose_result(
        ctx: Context<ProposeResult>,
        _duel_key: [u8; 32],
        winner: MarketSide,
        seed: u64,
        replay_hash: [u8; 32],
        result_hash: [u8; 32],
        duel_end_ts: i64,
        metadata_uri: String,
    ) -> Result<()> {
        require!(!ctx.accounts.oracle_config.paused, ErrorCode::OraclePaused);
        require!(
            ctx.accounts.oracle_config.config_frozen,
            ErrorCode::ConfigNotFrozen
        );
        require!(metadata_uri.len() <= 200, ErrorCode::MetadataUriTooLong);
        require!(
            winner == MarketSide::A || winner == MarketSide::B,
            ErrorCode::InvalidWinner
        );
        let duel_state = &mut ctx.accounts.duel_state;
        require!(
            duel_state.status != DuelStatus::Cancelled,
            ErrorCode::DuelAlreadyCancelled
        );
        require!(
            duel_state.status == DuelStatus::Locked,
            ErrorCode::InvalidLifecycleTransition
        );
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= duel_state.bet_close_ts,
            ErrorCode::BettingWindowActive
        );
        validate_result_time(duel_state, duel_end_ts, clock.unix_timestamp)?;
        validate_replay_hash(replay_hash)?;
        require!(
            result_hash
                == result_hash_for(
                    duel_state.duel_key,
                    winner,
                    seed,
                    replay_hash,
                    duel_state.competitive_snapshot_version,
                    duel_state.competitive_snapshot_digest,
                ),
            ErrorCode::ResultHashMismatch
        );

        let proposal_id = proposal_id_for(duel_state.duel_key, result_hash, replay_hash);
        let proposal_record = &mut ctx.accounts.proposal_record;
        require!(
            proposal_record.proposal_id == [0_u8; 32],
            ErrorCode::ProposalExists
        );
        proposal_record.duel_key = duel_state.duel_key;
        proposal_record.proposal_id = proposal_id;
        proposal_record.result_hash = result_hash;
        proposal_record.replay_hash = replay_hash;
        proposal_record.winner = winner;
        proposal_record.seed = seed;
        proposal_record.duel_end_ts = duel_end_ts;
        proposal_record.proposed_at = clock.unix_timestamp;
        proposal_record.challenged = false;
        proposal_record.bump = ctx.bumps.proposal_record;

        duel_state.status = DuelStatus::Proposed;
        duel_state.active_proposal = proposal_id;
        duel_state.pending_winner = winner;
        duel_state.pending_seed = seed;
        duel_state.pending_result_hash = result_hash;
        duel_state.pending_replay_hash = replay_hash;
        duel_state.pending_duel_end_ts = duel_end_ts;
        duel_state.pending_proposed_at = clock.unix_timestamp;
        duel_state.pending_challenged = false;
        validate_proposal_record_identity(duel_state, proposal_record, false)?;

        emit!(ResultProposed {
            duel_key: duel_state.duel_key,
            proposal_id,
            winner,
            seed,
            duel_end_ts,
            result_hash,
            replay_hash,
            metadata_uri: metadata_uri.clone(),
        });
        duel_state.metadata_uri = metadata_uri;
        Ok(())
    }

    pub fn challenge_result(
        ctx: Context<ChallengeResult>,
        _duel_key: [u8; 32],
        metadata_uri: String,
    ) -> Result<()> {
        require!(!ctx.accounts.oracle_config.paused, ErrorCode::OraclePaused);
        require!(
            ctx.accounts.oracle_config.config_frozen,
            ErrorCode::ConfigNotFrozen
        );
        require!(metadata_uri.len() <= 200, ErrorCode::MetadataUriTooLong);
        let duel_state = &mut ctx.accounts.duel_state;
        let oracle_config = &ctx.accounts.oracle_config;
        require!(
            duel_state.status == DuelStatus::Proposed,
            ErrorCode::NotProposed
        );
        validate_proposal_record_identity(duel_state, &ctx.accounts.proposal_record, false)?;
        require!(!duel_state.pending_challenged, ErrorCode::AlreadyChallenged);
        require!(
            ctx.accounts.proposal_record.proposal_id == duel_state.active_proposal,
            ErrorCode::ProposalRecordMismatch
        );
        require!(
            !ctx.accounts.proposal_record.challenged,
            ErrorCode::AlreadyChallenged
        );

        let now = Clock::get()?.unix_timestamp;
        let challenge_deadline = duel_state
            .pending_proposed_at
            .checked_add(oracle_config.dispute_window_secs)
            .ok_or(ErrorCode::InvalidDisputeWindow)?;
        require!(now < challenge_deadline, ErrorCode::ChallengeWindowExpired);

        duel_state.pending_challenged = true;
        duel_state.status = DuelStatus::Challenged;
        ctx.accounts.proposal_record.challenged = true;

        emit!(ResultChallenged {
            duel_key: duel_state.duel_key,
            proposal_id: duel_state.active_proposal,
            metadata_uri: metadata_uri.clone(),
        });
        duel_state.metadata_uri = metadata_uri;
        Ok(())
    }

    // FIX-3: Resolution path for challenged duels — reporter submits new proposal
    pub fn repropose_result(
        ctx: Context<ReproposeResult>,
        _duel_key: [u8; 32],
        winner: MarketSide,
        seed: u64,
        replay_hash: [u8; 32],
        result_hash: [u8; 32],
        duel_end_ts: i64,
        metadata_uri: String,
    ) -> Result<()> {
        require!(!ctx.accounts.oracle_config.paused, ErrorCode::OraclePaused);
        require!(
            ctx.accounts.oracle_config.config_frozen,
            ErrorCode::ConfigNotFrozen
        );
        require!(metadata_uri.len() <= 200, ErrorCode::MetadataUriTooLong);
        let duel_state = &mut ctx.accounts.duel_state;
        require!(
            duel_state.status == DuelStatus::Challenged,
            ErrorCode::NotChallenged
        );
        validate_pending_proposal_identity(duel_state, true)?;
        require!(
            duel_state.status != DuelStatus::Resolved,
            ErrorCode::DuelAlreadyFinalized
        );
        require!(
            duel_state.status != DuelStatus::Cancelled,
            ErrorCode::DuelAlreadyCancelled
        );
        require!(
            winner == MarketSide::A || winner == MarketSide::B,
            ErrorCode::InvalidWinner
        );
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= duel_state.bet_close_ts,
            ErrorCode::BettingWindowActive
        );
        validate_result_time(duel_state, duel_end_ts, clock.unix_timestamp)?;
        validate_replay_hash(replay_hash)?;
        require!(
            result_hash
                == result_hash_for(
                    duel_state.duel_key,
                    winner,
                    seed,
                    replay_hash,
                    duel_state.competitive_snapshot_version,
                    duel_state.competitive_snapshot_digest,
                ),
            ErrorCode::ResultHashMismatch
        );

        let proposal_id = proposal_id_for(duel_state.duel_key, result_hash, replay_hash);
        let proposal_record = &mut ctx.accounts.proposal_record;
        require!(
            proposal_record.proposal_id == [0_u8; 32],
            ErrorCode::ProposalExists
        );
        proposal_record.duel_key = duel_state.duel_key;
        proposal_record.proposal_id = proposal_id;
        proposal_record.result_hash = result_hash;
        proposal_record.replay_hash = replay_hash;
        proposal_record.winner = winner;
        proposal_record.seed = seed;
        proposal_record.duel_end_ts = duel_end_ts;
        proposal_record.proposed_at = clock.unix_timestamp;
        proposal_record.challenged = false;
        proposal_record.bump = ctx.bumps.proposal_record;

        duel_state.status = DuelStatus::Proposed;
        duel_state.active_proposal = proposal_id;
        duel_state.pending_winner = winner;
        duel_state.pending_seed = seed;
        duel_state.pending_result_hash = result_hash;
        duel_state.pending_replay_hash = replay_hash;
        duel_state.pending_duel_end_ts = duel_end_ts;
        duel_state.pending_proposed_at = clock.unix_timestamp;
        duel_state.pending_challenged = false;
        validate_proposal_record_identity(duel_state, proposal_record, false)?;

        emit!(ResultProposed {
            duel_key: duel_state.duel_key,
            proposal_id,
            winner,
            seed,
            duel_end_ts,
            result_hash,
            replay_hash,
            metadata_uri: metadata_uri.clone(),
        });
        duel_state.metadata_uri = metadata_uri;
        Ok(())
    }

    pub fn finalize_result(
        ctx: Context<FinalizeResult>,
        _duel_key: [u8; 32],
        metadata_uri: String,
    ) -> Result<()> {
        require!(!ctx.accounts.oracle_config.paused, ErrorCode::OraclePaused);
        require!(
            ctx.accounts.oracle_config.config_frozen,
            ErrorCode::ConfigNotFrozen
        );
        require!(metadata_uri.len() <= 200, ErrorCode::MetadataUriTooLong);
        let duel_state = &mut ctx.accounts.duel_state;
        let oracle_config = &ctx.accounts.oracle_config;
        require!(
            duel_state.status == DuelStatus::Proposed,
            ErrorCode::NotProposed
        );
        validate_pending_proposal_identity(duel_state, false)?;
        require!(!duel_state.pending_challenged, ErrorCode::AlreadyChallenged);

        let now = Clock::get()?.unix_timestamp;
        let finalizable_at = duel_state
            .pending_proposed_at
            .checked_add(oracle_config.dispute_window_secs)
            .ok_or(ErrorCode::InvalidDisputeWindow)?;
        require!(now >= finalizable_at, ErrorCode::DisputeWindowActive);

        duel_state.status = DuelStatus::Resolved;
        duel_state.winner = duel_state.pending_winner;
        duel_state.seed = duel_state.pending_seed;
        duel_state.result_hash = duel_state.pending_result_hash;
        duel_state.replay_hash = duel_state.pending_replay_hash;
        duel_state.duel_end_ts = duel_state.pending_duel_end_ts;

        emit!(DuelResolved {
            duel_key: duel_state.duel_key,
            proposal_id: duel_state.active_proposal,
            winner: duel_state.winner,
            seed: duel_state.seed,
            duel_end_ts: duel_state.duel_end_ts,
            result_hash: duel_state.result_hash,
            replay_hash: duel_state.replay_hash,
            metadata_uri: metadata_uri.clone(),
        });
        duel_state.metadata_uri = metadata_uri;
        Ok(())
    }
}

fn duel_status_rank(status: DuelStatus) -> u8 {
    match status {
        DuelStatus::Scheduled => 0,
        DuelStatus::BettingOpen => 1,
        DuelStatus::Locked => 2,
        DuelStatus::Proposed => 3,
        DuelStatus::Challenged => 4,
        DuelStatus::Resolved => 5,
        DuelStatus::Cancelled => 6,
    }
}

fn classify_duel_initialization(duel_state: &DuelState) -> Result<bool> {
    if duel_state.account_schema_version == ACCOUNT_SCHEMA_VERSION {
        return Ok(true);
    }
    require!(
        duel_state.account_schema_version == 0
            && duel_state.duel_key == [0_u8; 32]
            && duel_state.participant_a_hash == [0_u8; 32]
            && duel_state.participant_b_hash == [0_u8; 32]
            && duel_state.status == DuelStatus::Scheduled
            && duel_state.winner == MarketSide::None
            && duel_state.bet_open_ts == 0
            && duel_state.bet_close_ts == 0
            && duel_state.duel_start_ts == 0
            && duel_state.duel_end_ts == 0
            && duel_state.seed == 0
            && duel_state.result_hash == [0_u8; 32]
            && duel_state.replay_hash == [0_u8; 32]
            && duel_state.active_proposal == [0_u8; 32]
            && duel_state.pending_winner == MarketSide::None
            && duel_state.pending_seed == 0
            && duel_state.pending_result_hash == [0_u8; 32]
            && duel_state.pending_replay_hash == [0_u8; 32]
            && duel_state.pending_duel_end_ts == 0
            && duel_state.pending_proposed_at == 0
            && !duel_state.pending_challenged
            && duel_state.metadata_uri.is_empty()
            && duel_state.bump == 0
            && duel_state.competitive_snapshot_version == 0
            && duel_state.competitive_snapshot_digest == [0_u8; 32],
        ErrorCode::UnsupportedAccountSchema
    );
    Ok(false)
}

fn validate_uninitialized_oracle_config(config: &OracleConfig) -> Result<()> {
    require!(
        config.authority == Pubkey::default()
            && config.reporter == Pubkey::default()
            && config.finalizer == Pubkey::default()
            && config.challenger == Pubkey::default()
            && config.dispute_window_secs == 0
            && !config.paused
            && !config.config_frozen
            && config.bump == 0
            && config.account_schema_version == 0,
        ErrorCode::AlreadyInitialized
    );
    Ok(())
}

fn validate_pending_proposal_identity(
    duel_state: &DuelState,
    expected_challenged: bool,
) -> Result<()> {
    let expected_status = if expected_challenged {
        DuelStatus::Challenged
    } else {
        DuelStatus::Proposed
    };
    require!(
        duel_state.status == expected_status
            && duel_state.pending_challenged == expected_challenged,
        ErrorCode::ProposalRecordMismatch
    );
    require!(
        duel_state.pending_winner == MarketSide::A || duel_state.pending_winner == MarketSide::B,
        ErrorCode::InvalidWinner
    );
    require!(
        duel_state.pending_proposed_at > 0,
        ErrorCode::ProposalRecordMismatch
    );
    validate_result_time(
        duel_state,
        duel_state.pending_duel_end_ts,
        duel_state.pending_proposed_at,
    )?;
    validate_replay_hash(duel_state.pending_replay_hash)?;
    let expected_result_hash = result_hash_for(
        duel_state.duel_key,
        duel_state.pending_winner,
        duel_state.pending_seed,
        duel_state.pending_replay_hash,
        duel_state.competitive_snapshot_version,
        duel_state.competitive_snapshot_digest,
    );
    require!(
        duel_state.pending_result_hash == expected_result_hash,
        ErrorCode::ResultHashMismatch
    );
    require!(
        duel_state.active_proposal
            == proposal_id_for(
                duel_state.duel_key,
                duel_state.pending_result_hash,
                duel_state.pending_replay_hash,
            ),
        ErrorCode::ProposalRecordMismatch
    );
    Ok(())
}

fn validate_proposal_record_identity(
    duel_state: &DuelState,
    proposal_record: &ProposalRecord,
    expected_challenged: bool,
) -> Result<()> {
    validate_pending_proposal_identity(duel_state, expected_challenged)?;
    require!(
        proposal_record.duel_key == duel_state.duel_key
            && proposal_record.proposal_id == duel_state.active_proposal
            && proposal_record.result_hash == duel_state.pending_result_hash
            && proposal_record.replay_hash == duel_state.pending_replay_hash
            && proposal_record.winner == duel_state.pending_winner
            && proposal_record.seed == duel_state.pending_seed
            && proposal_record.duel_end_ts == duel_state.pending_duel_end_ts
            && proposal_record.proposed_at == duel_state.pending_proposed_at
            && proposal_record.challenged == expected_challenged,
        ErrorCode::ProposalRecordMismatch
    );
    Ok(())
}

fn proposal_id_for(duel_key: [u8; 32], result_hash: [u8; 32], replay_hash: [u8; 32]) -> [u8; 32] {
    solana_keccak_hasher::hashv(&[&duel_key, &result_hash, &replay_hash]).to_bytes()
}

fn result_hash_for(
    duel_key: [u8; 32],
    winner: MarketSide,
    seed: u64,
    replay_hash: [u8; 32],
    competitive_snapshot_version: u32,
    competitive_snapshot_digest: [u8; 32],
) -> [u8; 32] {
    let winner_tag = match winner {
        MarketSide::None => 0_u8,
        MarketSide::A => 1_u8,
        MarketSide::B => 2_u8,
    };
    solana_sha256_hasher::hashv(&[
        RESULT_HASH_DOMAIN,
        &duel_key,
        &[winner_tag],
        &seed.to_le_bytes(),
        &replay_hash,
        &competitive_snapshot_version.to_le_bytes(),
        &competitive_snapshot_digest,
    ])
    .to_bytes()
}

fn validate_result_time(duel_state: &DuelState, duel_end_ts: i64, now: i64) -> Result<()> {
    require!(
        duel_end_ts >= duel_state.bet_close_ts
            && duel_end_ts >= duel_state.duel_start_ts
            && duel_end_ts <= now,
        ErrorCode::InvalidResultTime
    );
    Ok(())
}

fn validate_replay_hash(replay_hash: [u8; 32]) -> Result<()> {
    require!(replay_hash != [0_u8; 32], ErrorCode::ResultHashMismatch);
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeOracle<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + OracleConfig::INIT_SPACE,
        seeds = [ORACLE_CONFIG_SEED],
        bump,
    )]
    pub oracle_config: Account<'info, OracleConfig>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key()) @ ErrorCode::UnauthorizedInitializer
    )]
    pub program: Program<'info, crate::program::FightOracle>,
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateOracleConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ORACLE_CONFIG_SEED],
        bump = oracle_config.bump,
        constraint = oracle_config.account_schema_version == ACCOUNT_SCHEMA_VERSION @ ErrorCode::UnsupportedAccountSchema,
    )]
    pub oracle_config: Account<'info, OracleConfig>,
}

#[derive(Accounts)]
#[instruction(duel_key: [u8; 32])]
pub struct UpsertDuel<'info> {
    #[account(mut)]
    pub reporter: Signer<'info>,
    #[account(
        seeds = [ORACLE_CONFIG_SEED],
        bump = oracle_config.bump,
        constraint = oracle_config.reporter == reporter.key() @ ErrorCode::Unauthorized,
        constraint = oracle_config.account_schema_version == ACCOUNT_SCHEMA_VERSION @ ErrorCode::UnsupportedAccountSchema,
    )]
    pub oracle_config: Account<'info, OracleConfig>,
    #[account(
        init_if_needed,
        payer = reporter,
        space = 8 + DuelState::INIT_SPACE,
        seeds = [DUEL_SEED, duel_key.as_ref()],
        bump,
    )]
    pub duel_state: Account<'info, DuelState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(duel_key: [u8; 32])]
pub struct CancelDuel<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [ORACLE_CONFIG_SEED],
        bump = oracle_config.bump,
        // M-4: Allow authority OR reporter to cancel (parity with EVM PAUSER_ROLE)
        constraint = (oracle_config.authority == authority.key() || oracle_config.reporter == authority.key()) @ ErrorCode::Unauthorized,
        constraint = oracle_config.account_schema_version == ACCOUNT_SCHEMA_VERSION @ ErrorCode::UnsupportedAccountSchema,
    )]
    pub oracle_config: Account<'info, OracleConfig>,
    #[account(
        mut,
        seeds = [DUEL_SEED, duel_key.as_ref()],
        bump = duel_state.bump,
        constraint = duel_state.account_schema_version == ACCOUNT_SCHEMA_VERSION @ ErrorCode::UnsupportedAccountSchema,
    )]
    pub duel_state: Account<'info, DuelState>,
}

#[derive(Accounts)]
#[instruction(
    duel_key: [u8; 32],
    _winner: MarketSide,
    _seed: u64,
    replay_hash: [u8; 32],
    result_hash: [u8; 32]
)]
pub struct ProposeResult<'info> {
    #[account(mut)]
    pub reporter: Signer<'info>,
    #[account(
        seeds = [ORACLE_CONFIG_SEED],
        bump = oracle_config.bump,
        constraint = oracle_config.reporter == reporter.key() @ ErrorCode::Unauthorized,
        constraint = oracle_config.account_schema_version == ACCOUNT_SCHEMA_VERSION @ ErrorCode::UnsupportedAccountSchema,
    )]
    pub oracle_config: Account<'info, OracleConfig>,
    #[account(
        mut,
        seeds = [DUEL_SEED, duel_key.as_ref()],
        bump = duel_state.bump,
        constraint = duel_state.account_schema_version == ACCOUNT_SCHEMA_VERSION @ ErrorCode::UnsupportedAccountSchema,
    )]
    pub duel_state: Account<'info, DuelState>,
    #[account(
        init_if_needed,
        payer = reporter,
        space = 8 + ProposalRecord::INIT_SPACE,
        seeds = [
            PROPOSAL_SEED,
            duel_key.as_ref(),
            result_hash.as_ref(),
            replay_hash.as_ref(),
        ],
        bump,
    )]
    pub proposal_record: Account<'info, ProposalRecord>,
    pub system_program: Program<'info, System>,
}

// FIX-3: Accounts for reproposing after a challenge
#[derive(Accounts)]
#[instruction(
    duel_key: [u8; 32],
    _winner: MarketSide,
    _seed: u64,
    replay_hash: [u8; 32],
    result_hash: [u8; 32]
)]
pub struct ReproposeResult<'info> {
    #[account(mut)]
    pub reporter: Signer<'info>,
    #[account(
        seeds = [ORACLE_CONFIG_SEED],
        bump = oracle_config.bump,
        constraint = oracle_config.reporter == reporter.key() @ ErrorCode::Unauthorized,
        constraint = oracle_config.account_schema_version == ACCOUNT_SCHEMA_VERSION @ ErrorCode::UnsupportedAccountSchema,
    )]
    pub oracle_config: Account<'info, OracleConfig>,
    #[account(
        mut,
        seeds = [DUEL_SEED, duel_key.as_ref()],
        bump = duel_state.bump,
        constraint = duel_state.account_schema_version == ACCOUNT_SCHEMA_VERSION @ ErrorCode::UnsupportedAccountSchema,
    )]
    pub duel_state: Account<'info, DuelState>,
    #[account(
        init_if_needed,
        payer = reporter,
        space = 8 + ProposalRecord::INIT_SPACE,
        seeds = [
            PROPOSAL_SEED,
            duel_key.as_ref(),
            result_hash.as_ref(),
            replay_hash.as_ref(),
        ],
        bump,
    )]
    pub proposal_record: Account<'info, ProposalRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(duel_key: [u8; 32])]
pub struct ChallengeResult<'info> {
    pub challenger: Signer<'info>,
    #[account(
        seeds = [ORACLE_CONFIG_SEED],
        bump = oracle_config.bump,
        constraint = oracle_config.challenger == challenger.key() @ ErrorCode::Unauthorized,
        constraint = oracle_config.account_schema_version == ACCOUNT_SCHEMA_VERSION @ ErrorCode::UnsupportedAccountSchema,
    )]
    pub oracle_config: Account<'info, OracleConfig>,
    #[account(
        mut,
        seeds = [DUEL_SEED, duel_key.as_ref()],
        bump = duel_state.bump,
        constraint = duel_state.account_schema_version == ACCOUNT_SCHEMA_VERSION @ ErrorCode::UnsupportedAccountSchema,
    )]
    pub duel_state: Account<'info, DuelState>,
    #[account(
        mut,
        seeds = [
            PROPOSAL_SEED,
            duel_state.duel_key.as_ref(),
            duel_state.pending_result_hash.as_ref(),
            duel_state.pending_replay_hash.as_ref(),
        ],
        bump = proposal_record.bump,
        constraint = proposal_record.duel_key == duel_state.duel_key @ ErrorCode::ProposalRecordMismatch,
    )]
    pub proposal_record: Account<'info, ProposalRecord>,
}

#[derive(Accounts)]
#[instruction(duel_key: [u8; 32])]
pub struct FinalizeResult<'info> {
    pub finalizer: Signer<'info>,
    #[account(
        seeds = [ORACLE_CONFIG_SEED],
        bump = oracle_config.bump,
        constraint = oracle_config.finalizer == finalizer.key() @ ErrorCode::Unauthorized,
        constraint = oracle_config.account_schema_version == ACCOUNT_SCHEMA_VERSION @ ErrorCode::UnsupportedAccountSchema,
    )]
    pub oracle_config: Account<'info, OracleConfig>,
    #[account(
        mut,
        seeds = [DUEL_SEED, duel_key.as_ref()],
        bump = duel_state.bump,
        constraint = duel_state.account_schema_version == ACCOUNT_SCHEMA_VERSION @ ErrorCode::UnsupportedAccountSchema,
    )]
    pub duel_state: Account<'info, DuelState>,
}

#[account]
#[derive(InitSpace)]
pub struct OracleConfig {
    pub authority: Pubkey,
    pub reporter: Pubkey,
    pub finalizer: Pubkey,
    pub challenger: Pubkey,
    pub dispute_window_secs: i64,
    pub paused: bool,
    pub config_frozen: bool,
    pub bump: u8,
    pub account_schema_version: u16,
}

#[account]
#[derive(InitSpace)]
pub struct DuelState {
    pub duel_key: [u8; 32],
    pub participant_a_hash: [u8; 32],
    pub participant_b_hash: [u8; 32],
    pub status: DuelStatus,
    pub winner: MarketSide,
    pub bet_open_ts: i64,
    pub bet_close_ts: i64,
    pub duel_start_ts: i64,
    pub duel_end_ts: i64,
    pub seed: u64,
    pub result_hash: [u8; 32],
    pub replay_hash: [u8; 32],
    pub active_proposal: [u8; 32],
    pub pending_winner: MarketSide,
    pub pending_seed: u64,
    pub pending_result_hash: [u8; 32],
    pub pending_replay_hash: [u8; 32],
    pub pending_duel_end_ts: i64,
    pub pending_proposed_at: i64,
    pub pending_challenged: bool,
    #[max_len(200)]
    pub metadata_uri: String,
    pub bump: u8,
    pub competitive_snapshot_version: u32,
    pub competitive_snapshot_digest: [u8; 32],
    pub account_schema_version: u16,
}

#[account]
#[derive(InitSpace)]
pub struct ProposalRecord {
    pub duel_key: [u8; 32],
    pub proposal_id: [u8; 32],
    pub result_hash: [u8; 32],
    pub replay_hash: [u8; 32],
    pub winner: MarketSide,
    pub seed: u64,
    pub duel_end_ts: i64,
    pub proposed_at: i64,
    pub challenged: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq, InitSpace)]
pub enum DuelStatus {
    Scheduled,
    BettingOpen,
    Locked,
    Proposed,
    Challenged,
    Resolved,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq, InitSpace)]
pub enum MarketSide {
    None,
    A,
    B,
}

#[event]
pub struct DuelUpserted {
    pub duel_key: [u8; 32],
    pub status: DuelStatus,
    pub bet_open_ts: i64,
    pub bet_close_ts: i64,
    pub duel_start_ts: i64,
    pub competitive_snapshot_version: u32,
    pub competitive_snapshot_digest: [u8; 32],
    pub metadata_uri: String,
}

#[event]
pub struct DuelCancelled {
    pub duel_key: [u8; 32],
    pub metadata_uri: String,
}

#[event]
pub struct ResultProposed {
    pub duel_key: [u8; 32],
    pub proposal_id: [u8; 32],
    pub winner: MarketSide,
    pub seed: u64,
    pub duel_end_ts: i64,
    pub result_hash: [u8; 32],
    pub replay_hash: [u8; 32],
    pub metadata_uri: String,
}

#[event]
pub struct ResultChallenged {
    pub duel_key: [u8; 32],
    pub proposal_id: [u8; 32],
    pub metadata_uri: String,
}

#[event]
pub struct DuelResolved {
    pub duel_key: [u8; 32],
    pub proposal_id: [u8; 32],
    pub winner: MarketSide,
    pub seed: u64,
    pub duel_end_ts: i64,
    pub result_hash: [u8; 32],
    pub replay_hash: [u8; 32],
    pub metadata_uri: String,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized oracle action")]
    Unauthorized,
    #[msg("Only the current upgrade authority can initialize the oracle")]
    UnauthorizedInitializer,
    #[msg("Reporter pubkey cannot be the default address")]
    InvalidReporter,
    #[msg("Authority pubkey cannot be the default address")]
    InvalidAuthority,
    #[msg("Finalizer pubkey cannot be the default address")]
    InvalidFinalizer,
    #[msg("Challenger pubkey cannot be the default address")]
    InvalidChallenger,
    #[msg("Dispute window must be positive")]
    InvalidDisputeWindow,
    #[msg("Betting window is invalid")]
    InvalidBetWindow,
    #[msg("Participants must be present and distinct")]
    InvalidParticipants,
    #[msg("Duel lifecycle transition is invalid")]
    InvalidLifecycleTransition,
    #[msg("The provided duel key does not match the stored duel")]
    DuelKeyMismatch,
    #[msg("The duel is already finalized")]
    DuelAlreadyFinalized,
    #[msg("The duel was cancelled and cannot be resolved")]
    DuelAlreadyCancelled,
    #[msg("Winner must be side A or side B")]
    InvalidWinner,
    #[msg("No active proposal exists")]
    NotProposed,
    #[msg("Proposal already challenged")]
    AlreadyChallenged,
    #[msg("Challenge window already expired")]
    ChallengeWindowExpired,
    #[msg("Dispute window still active")]
    DisputeWindowActive,
    #[msg("Config authority is immutable")]
    ConfigAuthorityImmutable,
    #[msg("Cannot propose result while betting window is still active")]
    BettingWindowActive,
    #[msg("Duel must be in Challenged status for reproposal")]
    NotChallenged,
    #[msg("Result timestamp must be at or after duel start and no later than chain time")]
    InvalidResultTime,
    #[msg("Proposal evidence identity has already been used")]
    ProposalExists,
    #[msg("Proposal record does not match the duel's active proposal")]
    ProposalRecordMismatch,
    #[msg("Participant hashes are immutable after betting opens")]
    ParticipantHashImmutable,
    #[msg("Duel timing is immutable after betting opens")]
    TimingImmutable,
    #[msg("Competitive snapshot version and digest must be present")]
    InvalidCompetitiveSnapshot,
    #[msg("Competitive snapshot commitment is immutable after betting opens")]
    CompetitiveSnapshotImmutable,
    #[msg("Result hash does not match the canonical duel outcome commitment")]
    ResultHashMismatch,
    #[msg("Account schema version is unsupported; use a fresh v2 program identity")]
    UnsupportedAccountSchema,
    #[msg("Config is already initialized")]
    AlreadyInitialized,
    #[msg("Oracle operations are paused")]
    OraclePaused,
    #[msg("Config is permanently frozen")]
    ConfigFrozen,
    #[msg("Metadata URI exceeds 200 byte limit")]
    MetadataUriTooLong,
    #[msg("Oracle config must be permanently frozen before betting opens")]
    ConfigNotFrozen,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(AnchorSerialize)]
    struct LegacyOracleConfigV1 {
        authority: Pubkey,
        reporter: Pubkey,
        finalizer: Pubkey,
        challenger: Pubkey,
        dispute_window_secs: i64,
        paused: bool,
        config_frozen: bool,
        bump: u8,
    }

    #[derive(AnchorSerialize)]
    struct LegacyDuelStateV1 {
        duel_key: [u8; 32],
        participant_a_hash: [u8; 32],
        participant_b_hash: [u8; 32],
        status: DuelStatus,
        winner: MarketSide,
        bet_open_ts: i64,
        bet_close_ts: i64,
        duel_start_ts: i64,
        duel_end_ts: i64,
        seed: u64,
        result_hash: [u8; 32],
        replay_hash: [u8; 32],
        active_proposal: [u8; 32],
        pending_winner: MarketSide,
        pending_seed: u64,
        pending_result_hash: [u8; 32],
        pending_replay_hash: [u8; 32],
        pending_duel_end_ts: i64,
        pending_proposed_at: i64,
        pending_challenged: bool,
        metadata_uri: String,
        bump: u8,
    }

    fn serialize<T: AnchorSerialize>(value: &T) -> Vec<u8> {
        let mut bytes = Vec::new();
        value.serialize(&mut bytes).unwrap();
        bytes
    }

    fn zeroed_duel_state() -> DuelState {
        DuelState {
            duel_key: [0; 32],
            participant_a_hash: [0; 32],
            participant_b_hash: [0; 32],
            status: DuelStatus::Scheduled,
            winner: MarketSide::None,
            bet_open_ts: 0,
            bet_close_ts: 0,
            duel_start_ts: 0,
            duel_end_ts: 0,
            seed: 0,
            result_hash: [0; 32],
            replay_hash: [0; 32],
            active_proposal: [0; 32],
            pending_winner: MarketSide::None,
            pending_seed: 0,
            pending_result_hash: [0; 32],
            pending_replay_hash: [0; 32],
            pending_duel_end_ts: 0,
            pending_proposed_at: 0,
            pending_challenged: false,
            metadata_uri: String::new(),
            bump: 0,
            competitive_snapshot_version: 0,
            competitive_snapshot_digest: [0; 32],
            account_schema_version: 0,
        }
    }

    fn zeroed_oracle_config() -> OracleConfig {
        OracleConfig {
            authority: Pubkey::default(),
            reporter: Pubkey::default(),
            finalizer: Pubkey::default(),
            challenger: Pubkey::default(),
            dispute_window_secs: 0,
            paused: false,
            config_frozen: false,
            bump: 0,
            account_schema_version: 0,
        }
    }

    fn proposed_duel_fixture(challenged: bool) -> (DuelState, ProposalRecord) {
        let duel_key = [11; 32];
        let replay_hash = [12; 32];
        let snapshot_digest = [13; 32];
        let winner = MarketSide::A;
        let seed = 99;
        let result_hash = result_hash_for(duel_key, winner, seed, replay_hash, 3, snapshot_digest);
        let proposal_id = proposal_id_for(duel_key, result_hash, replay_hash);
        let proposed_at = 500;
        let duel_end_ts = 450;
        let duel = DuelState {
            duel_key,
            participant_a_hash: [1; 32],
            participant_b_hash: [2; 32],
            status: if challenged {
                DuelStatus::Challenged
            } else {
                DuelStatus::Proposed
            },
            winner: MarketSide::None,
            bet_open_ts: 100,
            bet_close_ts: 200,
            duel_start_ts: 300,
            duel_end_ts: 0,
            seed: 0,
            result_hash: [0; 32],
            replay_hash: [0; 32],
            active_proposal: proposal_id,
            pending_winner: winner,
            pending_seed: seed,
            pending_result_hash: result_hash,
            pending_replay_hash: replay_hash,
            pending_duel_end_ts: duel_end_ts,
            pending_proposed_at: proposed_at,
            pending_challenged: challenged,
            metadata_uri: String::new(),
            bump: 0,
            competitive_snapshot_version: 3,
            competitive_snapshot_digest: snapshot_digest,
            account_schema_version: ACCOUNT_SCHEMA_VERSION,
        };
        let proposal = ProposalRecord {
            duel_key,
            proposal_id,
            result_hash,
            replay_hash,
            winner,
            seed,
            duel_end_ts,
            proposed_at,
            challenged,
            bump: 0,
        };
        (duel, proposal)
    }

    #[test]
    fn pending_proposal_identity_rejects_every_terminal_commitment_drift() {
        let (proposed, proposal) = proposed_duel_fixture(false);
        assert!(validate_proposal_record_identity(&proposed, &proposal, false).is_ok());
        let (challenged, challenged_record) = proposed_duel_fixture(true);
        assert!(validate_proposal_record_identity(&challenged, &challenged_record, true).is_ok());

        let (mut wrong_status, _) = proposed_duel_fixture(false);
        wrong_status.status = DuelStatus::Locked;
        assert!(validate_pending_proposal_identity(&wrong_status, false).is_err());
        let (mut wrong_challenge, _) = proposed_duel_fixture(false);
        wrong_challenge.pending_challenged = true;
        assert!(validate_pending_proposal_identity(&wrong_challenge, false).is_err());
        let (mut wrong_winner, _) = proposed_duel_fixture(false);
        wrong_winner.pending_winner = MarketSide::None;
        assert!(validate_pending_proposal_identity(&wrong_winner, false).is_err());
        let (mut wrong_result, _) = proposed_duel_fixture(false);
        wrong_result.pending_result_hash = [21; 32];
        assert!(validate_pending_proposal_identity(&wrong_result, false).is_err());
        let (mut wrong_proposal, _) = proposed_duel_fixture(false);
        wrong_proposal.active_proposal = [22; 32];
        assert!(validate_pending_proposal_identity(&wrong_proposal, false).is_err());
        let (mut wrong_time, _) = proposed_duel_fixture(false);
        wrong_time.pending_duel_end_ts = wrong_time.pending_proposed_at + 1;
        assert!(validate_pending_proposal_identity(&wrong_time, false).is_err());
        let (mut absent_replay, _) = proposed_duel_fixture(false);
        absent_replay.pending_replay_hash = [0; 32];
        absent_replay.pending_result_hash = result_hash_for(
            absent_replay.duel_key,
            absent_replay.pending_winner,
            absent_replay.pending_seed,
            absent_replay.pending_replay_hash,
            absent_replay.competitive_snapshot_version,
            absent_replay.competitive_snapshot_digest,
        );
        absent_replay.active_proposal = proposal_id_for(
            absent_replay.duel_key,
            absent_replay.pending_result_hash,
            absent_replay.pending_replay_hash,
        );
        assert!(validate_pending_proposal_identity(&absent_replay, false).is_err());
        let (valid, mut wrong_record) = proposed_duel_fixture(false);
        wrong_record.seed += 1;
        assert!(validate_proposal_record_identity(&valid, &wrong_record, false).is_err());
    }

    #[test]
    fn oracle_config_initialization_rejects_every_partial_field() {
        assert!(validate_uninitialized_oracle_config(&zeroed_oracle_config()).is_ok());
        let mutations: &[fn(&mut OracleConfig)] = &[
            |value| value.authority = Pubkey::new_unique(),
            |value| value.reporter = Pubkey::new_unique(),
            |value| value.finalizer = Pubkey::new_unique(),
            |value| value.challenger = Pubkey::new_unique(),
            |value| value.dispute_window_secs = 1,
            |value| value.paused = true,
            |value| value.config_frozen = true,
            |value| value.bump = 1,
            |value| value.account_schema_version = 1,
        ];
        for mutate in mutations {
            let mut partial = zeroed_oracle_config();
            mutate(&mut partial);
            assert!(validate_uninitialized_oracle_config(&partial).is_err());
        }
    }

    #[test]
    fn zero_bump_v2_duel_remains_initialized_and_partial_zero_state_rejects() {
        assert!(!classify_duel_initialization(&zeroed_duel_state()).unwrap());

        let mut valid_zero_bump = zeroed_duel_state();
        valid_zero_bump.duel_key = [1; 32];
        valid_zero_bump.status = DuelStatus::Resolved;
        valid_zero_bump.account_schema_version = ACCOUNT_SCHEMA_VERSION;
        assert!(classify_duel_initialization(&valid_zero_bump).unwrap());

        let mut partial_duel = zeroed_duel_state();
        partial_duel.duel_key = [1; 32];
        assert!(classify_duel_initialization(&partial_duel).is_err());

        let mut partial_proposal = zeroed_duel_state();
        partial_proposal.pending_result_hash = [2; 32];
        assert!(classify_duel_initialization(&partial_proposal).is_err());

        let mut unsupported = zeroed_duel_state();
        unsupported.account_schema_version = ACCOUNT_SCHEMA_VERSION + 1;
        assert!(classify_duel_initialization(&unsupported).is_err());
    }

    #[test]
    fn result_hash_matches_the_cross_runtime_v2_vector() {
        assert_eq!(
            result_hash_for([0xab; 32], MarketSide::A, 42, [0xcd; 32], 3, [0xef; 32],),
            [
                40, 5, 238, 202, 136, 81, 40, 158, 140, 237, 248, 145, 123, 1, 88, 201, 23, 160,
                61, 7, 89, 216, 102, 155, 65, 168, 106, 166, 190, 186, 64, 214,
            ],
        );
    }

    #[test]
    fn account_schema_v2_is_an_append_only_extension_of_v1() {
        assert_eq!(8 + OracleConfig::INIT_SPACE, 149);
        assert_eq!(8 + DuelState::INIT_SPACE, 575);

        let legacy_oracle = LegacyOracleConfigV1 {
            authority: Pubkey::new_from_array([1; 32]),
            reporter: Pubkey::new_from_array([2; 32]),
            finalizer: Pubkey::new_from_array([3; 32]),
            challenger: Pubkey::new_from_array([4; 32]),
            dispute_window_secs: 60,
            paused: false,
            config_frozen: true,
            bump: 254,
        };
        let oracle_v2 = OracleConfig {
            authority: legacy_oracle.authority,
            reporter: legacy_oracle.reporter,
            finalizer: legacy_oracle.finalizer,
            challenger: legacy_oracle.challenger,
            dispute_window_secs: legacy_oracle.dispute_window_secs,
            paused: legacy_oracle.paused,
            config_frozen: legacy_oracle.config_frozen,
            bump: legacy_oracle.bump,
            account_schema_version: ACCOUNT_SCHEMA_VERSION,
        };
        let legacy_oracle_bytes = serialize(&legacy_oracle);
        let oracle_v2_bytes = serialize(&oracle_v2);
        assert_eq!(legacy_oracle_bytes.len(), 139);
        assert_eq!(oracle_v2_bytes.len(), 141);
        assert_eq!(
            &oracle_v2_bytes[..legacy_oracle_bytes.len()],
            legacy_oracle_bytes
        );
        assert_eq!(
            u16::from_le_bytes(oracle_v2_bytes[139..141].try_into().unwrap()),
            ACCOUNT_SCHEMA_VERSION
        );

        let legacy_duel = LegacyDuelStateV1 {
            duel_key: [5; 32],
            participant_a_hash: [6; 32],
            participant_b_hash: [7; 32],
            status: DuelStatus::Locked,
            winner: MarketSide::None,
            bet_open_ts: 100,
            bet_close_ts: 200,
            duel_start_ts: 200,
            duel_end_ts: 0,
            seed: 0,
            result_hash: [0; 32],
            replay_hash: [0; 32],
            active_proposal: [0; 32],
            pending_winner: MarketSide::None,
            pending_seed: 0,
            pending_result_hash: [0; 32],
            pending_replay_hash: [0; 32],
            pending_duel_end_ts: 0,
            pending_proposed_at: 0,
            pending_challenged: false,
            metadata_uri: "meta".to_owned(),
            bump: 253,
        };
        let duel_v2 = DuelState {
            duel_key: legacy_duel.duel_key,
            participant_a_hash: legacy_duel.participant_a_hash,
            participant_b_hash: legacy_duel.participant_b_hash,
            status: legacy_duel.status,
            winner: legacy_duel.winner,
            bet_open_ts: legacy_duel.bet_open_ts,
            bet_close_ts: legacy_duel.bet_close_ts,
            duel_start_ts: legacy_duel.duel_start_ts,
            duel_end_ts: legacy_duel.duel_end_ts,
            seed: legacy_duel.seed,
            result_hash: legacy_duel.result_hash,
            replay_hash: legacy_duel.replay_hash,
            active_proposal: legacy_duel.active_proposal,
            pending_winner: legacy_duel.pending_winner,
            pending_seed: legacy_duel.pending_seed,
            pending_result_hash: legacy_duel.pending_result_hash,
            pending_replay_hash: legacy_duel.pending_replay_hash,
            pending_duel_end_ts: legacy_duel.pending_duel_end_ts,
            pending_proposed_at: legacy_duel.pending_proposed_at,
            pending_challenged: legacy_duel.pending_challenged,
            metadata_uri: legacy_duel.metadata_uri.clone(),
            bump: legacy_duel.bump,
            competitive_snapshot_version: 3,
            competitive_snapshot_digest: [8; 32],
            account_schema_version: ACCOUNT_SCHEMA_VERSION,
        };
        let legacy_duel_bytes = serialize(&legacy_duel);
        let duel_v2_bytes = serialize(&duel_v2);
        assert_eq!(&duel_v2_bytes[..legacy_duel_bytes.len()], legacy_duel_bytes);
        assert_eq!(
            u32::from_le_bytes(
                duel_v2_bytes[legacy_duel_bytes.len()..legacy_duel_bytes.len() + 4]
                    .try_into()
                    .unwrap()
            ),
            3
        );
        assert_eq!(
            u16::from_le_bytes(duel_v2_bytes[duel_v2_bytes.len() - 2..].try_into().unwrap()),
            ACCOUNT_SCHEMA_VERSION
        );
    }
}
