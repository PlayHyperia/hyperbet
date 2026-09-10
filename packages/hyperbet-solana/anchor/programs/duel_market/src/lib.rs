#![allow(clippy::too_many_arguments)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use fight_oracle::{
    self, DuelState as OracleDuelState, DuelStatus as OracleDuelStatus, MarketSide,
};

declare_id!("7fFo9jtxpCZKTuGGrxFekGE7EGGkD3LvcsrPzxBjnApG");

const CONFIG_SEED: &[u8] = b"config";
const MARKET_SEED: &[u8] = b"market";
const LEVEL_SEED: &[u8] = b"level";
const ORDER_SEED: &[u8] = b"order";
const BALANCE_SEED: &[u8] = b"balance";
const VAULT_SEED: &[u8] = b"vault";

const SIDE_BID: u8 = 1;
const SIDE_ASK: u8 = 2;
const MARKET_KIND_DUEL_WINNER: u8 = 1;
const BITMAP_WORDS: usize = 16;
const MAX_MATCHES_PER_TX: u32 = 50;
const ORDER_BEHAVIOR_GTC: u8 = 0;
const ORDER_BEHAVIOR_IOC: u8 = 1;
const ORDER_BEHAVIOR_POST_ONLY: u8 = 2;

#[program]
pub mod duel_market {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        market_operator: Pubkey,
        treasury: Pubkey,
        market_maker: Pubkey,
        trade_treasury_fee_bps: u16,
        trade_market_maker_fee_bps: u16,
        winnings_market_maker_fee_bps: u16,
    ) -> Result<()> {
        validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
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

        validate_fee_config(
            trade_treasury_fee_bps,
            trade_market_maker_fee_bps,
            winnings_market_maker_fee_bps,
        )?;
        require!(
            market_operator != Pubkey::default(),
            ErrorCode::InvalidOperator
        );
        require!(treasury != Pubkey::default(), ErrorCode::InvalidFeeAccount);
        require!(
            market_maker != Pubkey::default(),
            ErrorCode::InvalidFeeAccount
        );

        let config = &mut ctx.accounts.config;
        // WS2: One-time initialization only. No bootstrap fallback pattern.
        validate_uninitialized_market_config(config)?;
        config.authority = upgrade_authority;
        config.bump = ctx.bumps.config;

        config.market_operator = market_operator;
        config.treasury = treasury;
        config.market_maker = market_maker;
        config.trade_treasury_fee_bps = trade_treasury_fee_bps;
        config.trade_market_maker_fee_bps = trade_market_maker_fee_bps;
        config.winnings_market_maker_fee_bps = winnings_market_maker_fee_bps;
        Ok(())
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        authority: Pubkey,
        market_operator: Pubkey,
        treasury: Pubkey,
        market_maker: Pubkey,
        trade_treasury_fee_bps: u16,
        trade_market_maker_fee_bps: u16,
        winnings_market_maker_fee_bps: u16,
    ) -> Result<()> {
        validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
        require_keys_eq!(
            ctx.accounts.config.authority,
            ctx.accounts.authority.key(),
            ErrorCode::UnauthorizedConfigAuthority
        );
        require!(!ctx.accounts.config.config_frozen, ErrorCode::ConfigFrozen);
        require!(
            authority == ctx.accounts.config.authority,
            ErrorCode::ConfigAuthorityImmutable
        );
        validate_fee_config(
            trade_treasury_fee_bps,
            trade_market_maker_fee_bps,
            winnings_market_maker_fee_bps,
        )?;
        require!(authority != Pubkey::default(), ErrorCode::InvalidAuthority);
        require!(
            market_operator != Pubkey::default(),
            ErrorCode::InvalidOperator
        );
        require!(treasury != Pubkey::default(), ErrorCode::InvalidFeeAccount);
        require!(
            market_maker != Pubkey::default(),
            ErrorCode::InvalidFeeAccount
        );

        let config = &mut ctx.accounts.config;
        config.market_operator = market_operator;
        config.treasury = treasury;
        config.market_maker = market_maker;
        config.trade_treasury_fee_bps = trade_treasury_fee_bps;
        config.trade_market_maker_fee_bps = trade_market_maker_fee_bps;
        config.winnings_market_maker_fee_bps = winnings_market_maker_fee_bps;
        Ok(())
    }

    /// One-way config freeze — after calling, update_config reverts permanently.
    /// Pause controls remain functional.
    pub fn freeze_config(ctx: Context<UpdateConfig>) -> Result<()> {
        validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
        require_keys_eq!(
            ctx.accounts.config.authority,
            ctx.accounts.authority.key(),
            ErrorCode::UnauthorizedConfigAuthority
        );
        require!(!ctx.accounts.config.config_frozen, ErrorCode::ConfigFrozen);
        ctx.accounts.config.config_frozen = true;
        Ok(())
    }

    /// Emergency pause/unpause for market creation and order placement.
    /// Remains functional even after config freeze.
    pub fn set_market_paused(
        ctx: Context<UpdateConfig>,
        order_placement_paused: bool,
        market_creation_paused: bool,
    ) -> Result<()> {
        validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
        require_keys_eq!(
            ctx.accounts.config.authority,
            ctx.accounts.authority.key(),
            ErrorCode::UnauthorizedConfigAuthority
        );
        let config = &mut ctx.accounts.config;
        config.order_placement_paused = order_placement_paused;
        config.market_creation_paused = market_creation_paused;
        Ok(())
    }

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        duel_key: [u8; 32],
        market_kind: u8,
    ) -> Result<()> {
        validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
        require!(
            !ctx.accounts.config.market_creation_paused,
            ErrorCode::MarketCreationPaused
        );
        require!(
            market_kind == MARKET_KIND_DUEL_WINNER,
            ErrorCode::InvalidMarketKind
        );
        require!(
            ctx.accounts.operator.key() == ctx.accounts.config.authority
                || ctx.accounts.operator.key() == ctx.accounts.config.market_operator,
            ErrorCode::UnauthorizedMarketOperator
        );
        require!(
            ctx.accounts.duel_state.duel_key == duel_key,
            ErrorCode::DuelMismatch
        );
        require!(
            ctx.accounts.duel_state.status == OracleDuelStatus::BettingOpen
                || ctx.accounts.duel_state.status == OracleDuelStatus::Locked,
            ErrorCode::MarketCreationClosed
        );
        validate_duel_sync_identity(
            ctx.accounts.duel_state.key(),
            duel_key,
            ctx.accounts.duel_state.key(),
            ctx.accounts.duel_state.duel_key,
            ctx.accounts.duel_state.bump,
            ctx.accounts.duel_state.account_schema_version,
            ctx.accounts.duel_state.status,
            ctx.accounts.duel_state.winner,
        )?;
        validate_market_fee_configuration(
            ctx.accounts.vault.key(),
            ctx.accounts.config.treasury,
            ctx.accounts.config.market_maker,
            ctx.accounts.config.trade_treasury_fee_bps,
            ctx.accounts.config.trade_market_maker_fee_bps,
            ctx.accounts.config.winnings_market_maker_fee_bps,
        )?;

        let market_state = &mut ctx.accounts.market_state;
        market_state.bump = ctx.bumps.market_state;
        market_state.vault_bump = ctx.bumps.vault;
        market_state.duel_state = ctx.accounts.duel_state.key();
        market_state.duel_key = duel_key;
        market_state.market_kind = market_kind;
        market_state.status = map_duel_status(ctx.accounts.duel_state.status);
        market_state.trade_treasury_fee_bps_snapshot = ctx.accounts.config.trade_treasury_fee_bps;
        market_state.trade_market_maker_fee_bps_snapshot =
            ctx.accounts.config.trade_market_maker_fee_bps;
        market_state.winnings_market_maker_fee_bps_snapshot =
            ctx.accounts.config.winnings_market_maker_fee_bps;
        market_state.next_order_id = 1;
        market_state.best_ask = 1000;
        market_state.authority = ctx.accounts.operator.key();
        market_state.treasury = ctx.accounts.config.treasury;
        market_state.market_maker = ctx.accounts.config.market_maker; // FIX-7
        market_state.accrued_trade_treasury_fee_lamports = 0;
        market_state.accrued_trade_market_maker_fee_lamports = 0;
        emit!(MarketCreated {
            duel_key,
            market_key: market_state.key(),
            market_kind,
        });
        Ok(())
    }

    /// M-7: Intentionally NOT pause-gated. Market status must sync from oracle
    /// even during pause so that resolved/cancelled markets can transition and
    /// users can claim funds. Blocking sync during pause would lock user funds.
    pub fn sync_market_from_duel(ctx: Context<SyncMarketFromDuel>) -> Result<()> {
        validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
        let market_key = ctx.accounts.market_state.key();
        let duel_key = ctx.accounts.duel_state.key();
        sync_market_status(
            &mut ctx.accounts.market_state,
            &ctx.accounts.duel_state,
            market_key,
            duel_key,
        )
    }

    // Solana's pinned SBF Rust 1.84 toolchain predates u64::is_multiple_of.
    #[allow(clippy::manual_is_multiple_of)]
    pub fn place_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, PlaceOrder<'info>>,
        order_id: u64,
        side: u8,
        price: u16,
        amount: u64,
        order_behavior: u8,
    ) -> Result<()> {
        require!(
            !ctx.accounts.config.order_placement_paused,
            ErrorCode::OrderPlacementPaused
        );
        validate_side(side)?;
        validate_order_behavior(order_behavior)?;
        require!(price > 0 && price < 1000, ErrorCode::InvalidPrice);
        require!(amount > 0 && amount % 1000 == 0, ErrorCode::InvalidAmount);

        let market_key = ctx.accounts.market_state.key();
        let duel_key = ctx.accounts.duel_state.key();
        let market_state = &mut ctx.accounts.market_state;
        sync_market_status(market_state, &ctx.accounts.duel_state, market_key, duel_key)?;
        require!(
            market_state.status == MarketStatus::Open,
            ErrorCode::MarketNotOpen
        );
        require!(
            Clock::get()?.unix_timestamp < ctx.accounts.duel_state.bet_close_ts,
            ErrorCode::BettingClosed
        );
        require!(
            order_id == market_state.next_order_id,
            ErrorCode::InvalidOrderId
        );
        if order_behavior == ORDER_BEHAVIOR_POST_ONLY {
            require!(
                !order_would_cross(market_state, side, price),
                ErrorCode::PostOnlyWouldCross
            );
        }
        market_state.next_order_id = market_state
            .next_order_id
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;

        prepare_resting_level(
            &mut ctx.accounts.resting_level,
            market_key,
            side,
            price,
            ctx.accounts.user.key(),
            ctx.bumps.resting_level,
        )?;

        emit!(OrderPlaced {
            market_key: market_state.key(),
            order_id,
            maker: ctx.accounts.user.key(),
            side,
            price,
            amount,
        });

        let cost = quote_cost(side, price, amount)?;
        let user_balance = &mut ctx.accounts.user_balance;
        prepare_user_balance(user_balance, market_state.key(), ctx.accounts.user.key())?;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            cost,
        )?;

        let market_key = market_state.key();
        let vault_bump = market_state.vault_bump;
        let match_outcome = execute_matches(
            market_state,
            market_key,
            &mut ctx.accounts.user_balance,
            ctx.remaining_accounts,
            ctx.accounts.user.key(),
            order_id,
            side,
            price,
            amount,
        )?;
        validate_match_outcome_conservation(side, price, amount, &match_outcome)?;

        escrow_trade_fees(
            &ctx.accounts.system_program,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.vault.to_account_info(),
            market_state,
            &mut ctx.accounts.user_balance,
            order_id,
            ctx.accounts.user.key(),
            match_outcome.executed_cost,
        )?;

        if match_outcome.total_improvement > 0 {
            transfer_from_vault(
                &ctx.accounts.system_program,
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.user.to_account_info(),
                &market_key,
                vault_bump,
                match_outcome.total_improvement,
            )?;
        }

        let requires_continuation =
            continuation_required(order_behavior, match_outcome.stop_reason);
        let should_rest = match_outcome.remaining_amount > 0
            && !requires_continuation
            && !match_outcome.self_trade_prevented
            && order_behavior != ORDER_BEHAVIOR_IOC;

        if should_rest {
            persist_resting_order(
                &mut ctx.accounts.new_order,
                market_key,
                ctx.accounts.user.key(),
                order_id,
                side,
                price,
                match_outcome.remaining_amount,
                order_behavior,
                ctx.bumps.new_order,
                ctx.accounts.resting_level.tail_order_id,
            );

            if ctx.accounts.resting_level.tail_order_id != 0 {
                let tail_info = ctx
                    .remaining_accounts
                    .get(match_outcome.account_idx)
                    .ok_or(ErrorCode::MissingTailOrder)?;
                let expected_tail_key =
                    derive_order_key(&market_key, ctx.accounts.resting_level.tail_order_id);
                require_keys_eq!(
                    tail_info.key(),
                    expected_tail_key,
                    ErrorCode::InvalidRemainingAccount
                );
                let mut tail_order: Account<Order> =
                    Account::try_from(tail_info).map_err(|_| ErrorCode::InvalidRemainingAccount)?;
                validate_append_tail(&ctx.accounts.resting_level, Some(&tail_order), order_id)?;
                tail_order.next_order_id = order_id;
                tail_order.exit(&crate::ID)?;
            } else {
                validate_append_tail(&ctx.accounts.resting_level, None, order_id)?;
                ctx.accounts.resting_level.head_order_id = order_id;
            }

            ctx.accounts.resting_level.tail_order_id = order_id;
            ctx.accounts.resting_level.total_open = ctx
                .accounts
                .resting_level
                .total_open
                .checked_add(match_outcome.remaining_amount)
                .ok_or(ErrorCode::MathOverflow)?;
            set_price_bit(market_state, side, price, true);
            update_best_prices(market_state);
        } else if requires_continuation {
            persist_pending_order(
                &mut ctx.accounts.new_order,
                market_key,
                ctx.accounts.user.key(),
                order_id,
                side,
                price,
                match_outcome.remaining_amount,
                order_behavior,
                ctx.bumps.new_order,
            );
        } else {
            if match_outcome.remaining_amount > 0 {
                transfer_from_vault(
                    &ctx.accounts.system_program,
                    &ctx.accounts.vault.to_account_info(),
                    &ctx.accounts.user.to_account_info(),
                    &market_key,
                    vault_bump,
                    quote_cost(side, price, match_outcome.remaining_amount)?,
                )?;
            }
            ctx.accounts
                .new_order
                .close(ctx.accounts.user.to_account_info())?;
            close_empty_price_level_if_recipient(
                &mut ctx.accounts.resting_level,
                &ctx.accounts.user,
            )?;
        }

        Ok(())
    }

    pub fn continue_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, ContinueOrder<'info>>,
        order_id: u64,
    ) -> Result<()> {
        require!(
            !ctx.accounts.config.order_placement_paused,
            ErrorCode::OrderPlacementPaused
        );
        let market_state = &mut ctx.accounts.market_state;
        let market_key = market_state.key();
        let duel_key = ctx.accounts.duel_state.key();
        sync_market_status(market_state, &ctx.accounts.duel_state, market_key, duel_key)?;
        require!(
            market_state.status == MarketStatus::Open,
            ErrorCode::MarketNotOpen
        );
        require!(
            Clock::get()?.unix_timestamp < ctx.accounts.duel_state.bet_close_ts,
            ErrorCode::BettingClosed
        );

        let market_key = market_state.key();
        let vault_bump = market_state.vault_bump;
        let order = &mut ctx.accounts.order;
        require!(order.id == order_id, ErrorCode::InvalidOrderId);
        require!(
            order.maker == ctx.accounts.user.key(),
            ErrorCode::NotOrderMaker
        );
        let remaining = validate_continuation_pending_order(order, market_key)?;
        require_keys_eq!(
            ctx.accounts.user_balance.market_state,
            market_key,
            ErrorCode::InvalidRemainingAccount
        );
        require_keys_eq!(
            ctx.accounts.user_balance.user,
            ctx.accounts.user.key(),
            ErrorCode::InvalidRemainingAccount
        );

        prepare_resting_level(
            &mut ctx.accounts.resting_level,
            market_key,
            order.side,
            order.price,
            ctx.accounts.user.key(),
            ctx.bumps.resting_level,
        )?;

        let match_outcome = execute_matches(
            market_state,
            market_key,
            &mut ctx.accounts.user_balance,
            ctx.remaining_accounts,
            ctx.accounts.user.key(),
            order.id,
            order.side,
            order.price,
            remaining,
        )?;
        validate_match_outcome_conservation(order.side, order.price, remaining, &match_outcome)?;

        escrow_trade_fees(
            &ctx.accounts.system_program,
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.vault.to_account_info(),
            market_state,
            &mut ctx.accounts.user_balance,
            order.id,
            ctx.accounts.user.key(),
            match_outcome.executed_cost,
        )?;

        if match_outcome.total_improvement > 0 {
            transfer_from_vault(
                &ctx.accounts.system_program,
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.user.to_account_info(),
                &market_key,
                vault_bump,
                match_outcome.total_improvement,
            )?;
        }

        let requires_continuation =
            continuation_required(order.order_behavior, match_outcome.stop_reason);
        let should_rest = match_outcome.remaining_amount > 0
            && !requires_continuation
            && !match_outcome.self_trade_prevented;

        if should_rest {
            persist_resting_order(
                order,
                market_key,
                ctx.accounts.user.key(),
                order.id,
                order.side,
                order.price,
                match_outcome.remaining_amount,
                order.order_behavior,
                order.bump,
                ctx.accounts.resting_level.tail_order_id,
            );

            if ctx.accounts.resting_level.tail_order_id != 0 {
                let tail_info = ctx
                    .remaining_accounts
                    .get(match_outcome.account_idx)
                    .ok_or(ErrorCode::MissingTailOrder)?;
                let expected_tail_key =
                    derive_order_key(&market_key, ctx.accounts.resting_level.tail_order_id);
                require_keys_eq!(
                    tail_info.key(),
                    expected_tail_key,
                    ErrorCode::InvalidRemainingAccount
                );
                let mut tail_order: Account<Order> =
                    Account::try_from(tail_info).map_err(|_| ErrorCode::InvalidRemainingAccount)?;
                validate_append_tail(&ctx.accounts.resting_level, Some(&tail_order), order.id)?;
                tail_order.next_order_id = order.id;
                tail_order.exit(&crate::ID)?;
            } else {
                validate_append_tail(&ctx.accounts.resting_level, None, order.id)?;
                ctx.accounts.resting_level.head_order_id = order.id;
            }

            ctx.accounts.resting_level.tail_order_id = order.id;
            ctx.accounts.resting_level.total_open = ctx
                .accounts
                .resting_level
                .total_open
                .checked_add(match_outcome.remaining_amount)
                .ok_or(ErrorCode::MathOverflow)?;
            set_price_bit(market_state, order.side, order.price, true);
            update_best_prices(market_state);
        } else if requires_continuation {
            persist_pending_order(
                order,
                market_key,
                ctx.accounts.user.key(),
                order.id,
                order.side,
                order.price,
                match_outcome.remaining_amount,
                order.order_behavior,
                order.bump,
            );
        } else {
            if match_outcome.remaining_amount > 0 {
                transfer_from_vault(
                    &ctx.accounts.system_program,
                    &ctx.accounts.vault.to_account_info(),
                    &ctx.accounts.user.to_account_info(),
                    &market_key,
                    vault_bump,
                    quote_cost(order.side, order.price, match_outcome.remaining_amount)?,
                )?;
            }
            ctx.accounts
                .order
                .close(ctx.accounts.user.to_account_info())?;
            close_empty_price_level_if_recipient(
                &mut ctx.accounts.resting_level,
                &ctx.accounts.user,
            )?;
        }

        Ok(())
    }

    pub fn cancel_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, CancelOrder<'info>>,
        order_id: u64,
        side: u8,
        price: u16,
    ) -> Result<()> {
        validate_side(side)?;
        require!(price > 0 && price < 1000, ErrorCode::InvalidPrice);

        let market_key = ctx.accounts.market_state.key();
        let duel_key = ctx.accounts.duel_state.key();
        let market_state = &mut ctx.accounts.market_state;
        sync_market_status(market_state, &ctx.accounts.duel_state, market_key, duel_key)?;
        require!(
            market_state.status == MarketStatus::Open,
            ErrorCode::MarketNotOpen
        );

        let order = &mut ctx.accounts.order;
        require!(order.id == order_id, ErrorCode::InvalidOrderId);
        require!(order.side == side, ErrorCode::OrderSideMismatch);
        require!(order.price == price, ErrorCode::OrderPriceMismatch);
        require!(
            order.maker == ctx.accounts.user.key(),
            ErrorCode::NotOrderMaker
        );

        let remaining = order
            .amount
            .checked_sub(order.filled)
            .ok_or(ErrorCode::MathOverflow)?;
        let continuation_pending = order.continuation_pending;
        if order.active {
            require!(remaining > 0, ErrorCode::InvalidRemainingAccount);

            if continuation_pending {
                validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
                validate_continuation_pending_order(order, market_key)?;
            } else {
                let mut price_level = load_existing_price_level(
                    ctx.accounts.price_level.as_ref(),
                    market_key,
                    side,
                    price,
                    ctx.bumps.price_level,
                )?;
                let mut cursor = 0_usize;
                // A filled head can advance the canonical PriceLevel without the
                // successor account being present in the match instruction. In
                // that case the successor retains its older prev pointer until
                // its next unlink. The PriceLevel head is authoritative, so no
                // stale predecessor account is required for that safe cleanup.
                let previous_order_id = if price_level.head_order_id == order.id {
                    0
                } else {
                    order.prev_order_id
                };
                let mut prev_order = load_adjacent_order(
                    ctx.remaining_accounts,
                    &mut cursor,
                    market_state.key(),
                    previous_order_id,
                )?;
                let mut next_order = load_adjacent_order(
                    ctx.remaining_accounts,
                    &mut cursor,
                    market_state.key(),
                    order.next_order_id,
                )?;
                require!(
                    cursor == ctx.remaining_accounts.len(),
                    ErrorCode::InvalidRemainingAccount
                );

                unlink_order(
                    market_state,
                    &mut price_level,
                    order,
                    prev_order.as_mut(),
                    next_order.as_mut(),
                    remaining,
                )?;

                if let Some(prev) = prev_order.as_mut() {
                    prev.exit(&crate::ID)?;
                }
                if let Some(next) = next_order.as_mut() {
                    next.exit(&crate::ID)?;
                }
                persist_price_level(ctx.accounts.price_level.as_ref(), &price_level)?;
            }
        } else {
            validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
            require!(
                remaining == 0
                    && !order.continuation_pending
                    && order.prev_order_id == 0
                    && order.next_order_id == 0,
                ErrorCode::InvalidRemainingAccount
            );
        }

        if remaining > 0 {
            transfer_from_vault(
                &ctx.accounts.system_program,
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.user.to_account_info(),
                &market_state.key(),
                market_state.vault_bump,
                quote_cost(side, price, remaining)?,
            )?;
        }

        // Direct lamport mutation must follow the final CPI. Closing the
        // optional PDA before transfer_from_vault would make the System
        // Program observe a destination balance change whose source account is
        // outside that CPI account set, and the runtime rejects the imbalance.
        if continuation_pending
            && close_pending_price_level_if_present(
                ctx.accounts.price_level.as_ref(),
                &ctx.accounts.user.to_account_info(),
                market_key,
                side,
                price,
                ctx.bumps.price_level,
            )?
        {
            emit!(PriceLevelClosed {
                market_key,
                side,
                price,
                rent_recipient: ctx.accounts.user.key(),
                closer: ctx.accounts.user.key(),
            });
        }

        order.active = false;
        order.continuation_pending = false;
        order.prev_order_id = 0;
        order.next_order_id = 0;
        order.filled = order.amount;
        emit!(OrderCancelled {
            market_key: market_state.key(),
            order_id,
        });
        Ok(())
    }

    /// Returns an inactive, fully filled Order PDA's rent to its original maker.
    /// This instruction deliberately has no vault or PriceLevel account: it cannot
    /// move collateral or shared-book rent, and is valid in every market lifecycle.
    pub fn close_filled_order(ctx: Context<CloseFilledOrder>, order_id: u64) -> Result<()> {
        validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
        let market_key = ctx.accounts.market_state.key();
        let order = &ctx.accounts.order;

        require!(order.id == order_id, ErrorCode::InvalidOrderId);
        require_keys_eq!(
            order.market_state,
            market_key,
            ErrorCode::OrderMarketMismatch
        );
        require!(
            order.maker == ctx.accounts.user.key(),
            ErrorCode::NotOrderMaker
        );
        require!(!order.active, ErrorCode::OrderStillActive);
        require!(order.filled == order.amount, ErrorCode::OrderNotFullyFilled);
        require!(
            order.prev_order_id == 0 && order.next_order_id == 0 && !order.continuation_pending,
            ErrorCode::OrderStillLinked
        );

        emit!(FilledOrderClosed {
            market_key,
            order_id,
            maker: order.maker,
        });
        Ok(())
    }

    /// Returns an empty UserBalance PDA's rent to its owner. Resting-order
    /// placement initializes this account before any match occurs, so a user
    /// who later cancels or reclaims only unmatched liquidity can otherwise be
    /// left with a permanently empty account. This instruction is deliberately
    /// valid once matching has stopped and cannot move market custody. Keeping
    /// it unavailable while open prevents an active maker order from losing
    /// the balance account required by a later fill.
    pub fn close_empty_user_balance(ctx: Context<CloseEmptyUserBalance>) -> Result<()> {
        validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
        require!(
            ctx.accounts.market_state.status != MarketStatus::Open,
            ErrorCode::MarketStillOpen
        );
        validate_empty_user_balance(&ctx.accounts.user_balance)?;

        emit!(EmptyUserBalanceClosed {
            market_key: ctx.accounts.market_state.key(),
            user: ctx.accounts.user.key(),
        });
        Ok(())
    }

    /// Closes an empty shared PriceLevel only to the wallet that originally
    /// funded the account. Any signer may submit cleanup, but cannot redirect
    /// the recorded recipient or close a level that still contains book state.
    pub fn close_empty_price_level(
        ctx: Context<CloseEmptyPriceLevel>,
        side: u8,
        price: u16,
    ) -> Result<()> {
        validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
        validate_side(side)?;
        require!(price > 0 && price < 1000, ErrorCode::InvalidPrice);

        let market_key = ctx.accounts.market_state.key();
        let price_level = &ctx.accounts.price_level;
        require_keys_eq!(
            price_level.market_state,
            market_key,
            ErrorCode::PriceLevelMismatch
        );
        require!(price_level.side == side, ErrorCode::PriceLevelMismatch);
        require!(price_level.price == price, ErrorCode::PriceLevelMismatch);
        require!(
            price_level.rent_recipient != Pubkey::default(),
            ErrorCode::InvalidPriceLevelRentRecipient
        );
        require_keys_eq!(
            price_level.rent_recipient,
            ctx.accounts.rent_recipient.key(),
            ErrorCode::InvalidPriceLevelRentRecipient
        );
        require!(
            should_close_price_level(price_level),
            ErrorCode::PriceLevelNotEmpty
        );

        emit!(PriceLevelClosed {
            market_key,
            side,
            price,
            rent_recipient: price_level.rent_recipient,
            closer: ctx.accounts.closer.key(),
        });
        Ok(())
    }

    pub fn reclaim_resting_order<'info>(
        ctx: Context<'_, '_, 'info, 'info, ReclaimRestingOrder<'info>>,
        order_id: u64,
        side: u8,
        price: u16,
    ) -> Result<()> {
        validate_side(side)?;
        require!(price > 0 && price < 1000, ErrorCode::InvalidPrice);

        let market_key = ctx.accounts.market_state.key();
        let duel_key = ctx.accounts.duel_state.key();
        let market_state = &mut ctx.accounts.market_state;
        sync_market_status(market_state, &ctx.accounts.duel_state, market_key, duel_key)?;
        require!(
            market_state.status != MarketStatus::Open,
            ErrorCode::MarketStillOpen
        );

        let order = &mut ctx.accounts.order;
        require!(order.id == order_id, ErrorCode::InvalidOrderId);
        require!(order.side == side, ErrorCode::OrderSideMismatch);
        require!(order.price == price, ErrorCode::OrderPriceMismatch);
        require!(
            order.maker == ctx.accounts.user.key(),
            ErrorCode::NotOrderMaker
        );
        require!(order.active, ErrorCode::NothingToReclaim);

        let remaining = order
            .amount
            .checked_sub(order.filled)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(remaining > 0, ErrorCode::NothingToReclaim);

        let continuation_pending = order.continuation_pending;
        if continuation_pending {
            validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
            validate_continuation_pending_order(order, market_key)?;
        } else {
            let mut price_level = load_existing_price_level(
                ctx.accounts.price_level.as_ref(),
                market_key,
                side,
                price,
                ctx.bumps.price_level,
            )?;
            let mut cursor = 0_usize;
            // See cancel_order: a matched-out predecessor is normalized lazily
            // from the canonical PriceLevel head during the next unlink.
            let previous_order_id = if price_level.head_order_id == order.id {
                0
            } else {
                order.prev_order_id
            };
            let mut prev_order = load_adjacent_order(
                ctx.remaining_accounts,
                &mut cursor,
                market_state.key(),
                previous_order_id,
            )?;
            let mut next_order = load_adjacent_order(
                ctx.remaining_accounts,
                &mut cursor,
                market_state.key(),
                order.next_order_id,
            )?;
            require!(
                cursor == ctx.remaining_accounts.len(),
                ErrorCode::InvalidRemainingAccount
            );

            unlink_order(
                market_state,
                &mut price_level,
                order,
                prev_order.as_mut(),
                next_order.as_mut(),
                remaining,
            )?;

            if let Some(prev) = prev_order.as_mut() {
                prev.exit(&crate::ID)?;
            }
            if let Some(next) = next_order.as_mut() {
                next.exit(&crate::ID)?;
            }
            persist_price_level(ctx.accounts.price_level.as_ref(), &price_level)?;
        }

        transfer_from_vault(
            &ctx.accounts.system_program,
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            &market_state.key(),
            market_state.vault_bump,
            quote_cost(side, price, remaining)?,
        )?;

        // Keep every CPI before the optional direct-lamport close. See the
        // corresponding cancellation path for the runtime conservation rule.
        if continuation_pending
            && close_pending_price_level_if_present(
                ctx.accounts.price_level.as_ref(),
                &ctx.accounts.user.to_account_info(),
                market_key,
                side,
                price,
                ctx.bumps.price_level,
            )?
        {
            emit!(PriceLevelClosed {
                market_key,
                side,
                price,
                rent_recipient: ctx.accounts.user.key(),
                closer: ctx.accounts.user.key(),
            });
        }

        order.active = false;
        order.continuation_pending = false;
        order.prev_order_id = 0;
        order.next_order_id = 0;
        order.filled = order.amount;
        emit!(RestingOrderReclaimed {
            market_key: market_state.key(),
            order_id,
        });
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
        let market_key = ctx.accounts.market_state.key();
        let duel_key = ctx.accounts.duel_state.key();
        let market_state = &mut ctx.accounts.market_state;
        sync_market_status(market_state, &ctx.accounts.duel_state, market_key, duel_key)?;

        let user_balance = &mut ctx.accounts.user_balance;
        validate_user_balance_identity(user_balance, market_key, ctx.accounts.user.key())?;
        let mut refunded_trade_treasury_fee_lamports = 0_u64;
        let mut refunded_trade_market_maker_fee_lamports = 0_u64;
        let (fee, payout) = if market_state.status == MarketStatus::Cancelled {
            refunded_trade_treasury_fee_lamports = user_balance.trade_treasury_fee_lamports;
            refunded_trade_market_maker_fee_lamports = user_balance.trade_market_maker_fee_lamports;
            let refund_lamports = user_balance
                .a_locked_lamports
                .checked_add(user_balance.b_locked_lamports)
                .and_then(|value| value.checked_add(refunded_trade_treasury_fee_lamports))
                .and_then(|value| value.checked_add(refunded_trade_market_maker_fee_lamports))
                .ok_or(ErrorCode::MathOverflow)?;
            require!(refund_lamports > 0, ErrorCode::NothingToClaim);
            market_state.accrued_trade_treasury_fee_lamports = market_state
                .accrued_trade_treasury_fee_lamports
                .checked_sub(refunded_trade_treasury_fee_lamports)
                .ok_or(ErrorCode::FeeEscrowInvariantViolation)?;
            market_state.accrued_trade_market_maker_fee_lamports = market_state
                .accrued_trade_market_maker_fee_lamports
                .checked_sub(refunded_trade_market_maker_fee_lamports)
                .ok_or(ErrorCode::FeeEscrowInvariantViolation)?;
            user_balance.a_shares = 0;
            user_balance.b_shares = 0;
            user_balance.a_locked_lamports = 0;
            user_balance.b_locked_lamports = 0;
            user_balance.trade_treasury_fee_lamports = 0;
            user_balance.trade_market_maker_fee_lamports = 0;
            (0, refund_lamports)
        } else {
            require!(
                market_state.status == MarketStatus::Resolved,
                ErrorCode::MarketNotResolved
            );
            let winning_shares = if market_state.winner == MarketSide::A {
                user_balance.a_shares
            } else if market_state.winner == MarketSide::B {
                user_balance.b_shares
            } else {
                0
            };
            require!(winning_shares > 0, ErrorCode::NothingToClaim);
            let fee = bps_fee(
                winning_shares,
                market_state.winnings_market_maker_fee_bps_snapshot,
            )?;
            let payout = winning_shares
                .checked_sub(fee)
                .ok_or(ErrorCode::MathOverflow)?;
            if fee > 0 {
                validate_fee_recipient_not_vault(
                    ctx.accounts.vault.key(),
                    ctx.accounts.market_maker.key(),
                )?;
            }
            user_balance.a_shares = 0;
            user_balance.b_shares = 0;
            user_balance.a_locked_lamports = 0;
            user_balance.b_locked_lamports = 0;
            user_balance.trade_treasury_fee_lamports = 0;
            user_balance.trade_market_maker_fee_lamports = 0;
            (fee, payout)
        };

        let market_key = market_state.key();
        let vault_bump = market_state.vault_bump;
        let seeds: &[&[u8]] = &[VAULT_SEED, market_key.as_ref(), &[vault_bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        if fee > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.market_maker.to_account_info(),
                    },
                    signer_seeds,
                ),
                fee,
            )?;
        }

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
        )?;

        emit!(ClaimSettled {
            market_key,
            user: ctx.accounts.user.key(),
            status: market_state.status,
            winner: market_state.winner,
            payout_lamports: payout,
            winnings_fee_lamports: fee,
            refunded_trade_treasury_fee_lamports,
            refunded_trade_market_maker_fee_lamports,
        });

        // L-5: Close user_balance PDA to reclaim rent (~0.002 SOL per account).
        // All shares and locked lamports are already zeroed above.
        ctx.accounts
            .user_balance
            .close(ctx.accounts.user.to_account_info())?;

        Ok(())
    }

    pub fn close_losing_balance(ctx: Context<CloseLosingBalance>) -> Result<()> {
        validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
        let market_key = ctx.accounts.market_state.key();
        let duel_key = ctx.accounts.duel_state.key();
        let market_state = &mut ctx.accounts.market_state;
        sync_market_status(market_state, &ctx.accounts.duel_state, market_key, duel_key)?;

        let (a_shares, b_shares, a_locked_lamports, b_locked_lamports) = {
            let user_balance = &mut ctx.accounts.user_balance;
            validate_losing_balance_cleanup(
                market_state.status,
                market_state.winner,
                user_balance.a_shares,
                user_balance.b_shares,
                user_balance.a_locked_lamports,
                user_balance.b_locked_lamports,
            )?;

            let snapshot = (
                user_balance.a_shares,
                user_balance.b_shares,
                user_balance.a_locked_lamports,
                user_balance.b_locked_lamports,
            );
            user_balance.a_shares = 0;
            user_balance.b_shares = 0;
            user_balance.a_locked_lamports = 0;
            user_balance.b_locked_lamports = 0;
            user_balance.trade_treasury_fee_lamports = 0;
            user_balance.trade_market_maker_fee_lamports = 0;
            snapshot
        };

        emit!(LosingBalanceClosed {
            market_key,
            user: ctx.accounts.user.key(),
            a_shares,
            b_shares,
            a_locked_lamports,
            b_locked_lamports,
        });

        // This instruction never moves market funds. It only returns the
        // user-owned account rent after proving no winning entitlement exists.
        ctx.accounts
            .user_balance
            .close(ctx.accounts.user.to_account_info())?;

        Ok(())
    }

    /// Releases escrowed execution fees only after the canonical duel resolves.
    /// Any signer may submit the transaction, but the snapshotted recipients
    /// are immutable and the submitter cannot redirect or receive market funds.
    pub fn withdraw_resolved_trade_fees(ctx: Context<WithdrawResolvedTradeFees>) -> Result<()> {
        validate_fixed_account_cardinality(ctx.remaining_accounts.len())?;
        let market_key = ctx.accounts.market_state.key();
        let duel_key = ctx.accounts.duel_state.key();
        let market_state = &mut ctx.accounts.market_state;
        sync_market_status(market_state, &ctx.accounts.duel_state, market_key, duel_key)?;
        require!(
            market_state.status == MarketStatus::Resolved,
            ErrorCode::MarketNotResolved
        );
        let treasury_fee_lamports = market_state.accrued_trade_treasury_fee_lamports;
        let market_maker_fee_lamports = market_state.accrued_trade_market_maker_fee_lamports;
        require!(
            treasury_fee_lamports > 0 || market_maker_fee_lamports > 0,
            ErrorCode::NothingToWithdraw
        );
        if treasury_fee_lamports > 0 {
            validate_fee_recipient_not_vault(
                ctx.accounts.vault.key(),
                ctx.accounts.treasury.key(),
            )?;
        }
        if market_maker_fee_lamports > 0 {
            validate_fee_recipient_not_vault(
                ctx.accounts.vault.key(),
                ctx.accounts.market_maker.key(),
            )?;
        }

        market_state.accrued_trade_treasury_fee_lamports = 0;
        market_state.accrued_trade_market_maker_fee_lamports = 0;

        transfer_from_vault(
            &ctx.accounts.system_program,
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            &market_key,
            market_state.vault_bump,
            treasury_fee_lamports,
        )?;
        transfer_from_vault(
            &ctx.accounts.system_program,
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.market_maker.to_account_info(),
            &market_key,
            market_state.vault_bump,
            market_maker_fee_lamports,
        )?;

        emit!(ResolvedTradeFeesWithdrawn {
            market_key,
            treasury: ctx.accounts.treasury.key(),
            market_maker: ctx.accounts.market_maker.key(),
            treasury_fee_lamports,
            market_maker_fee_lamports,
            submitter: ctx.accounts.submitter.key(),
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + MarketConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, MarketConfig>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key()) @ ErrorCode::UnauthorizedInitializer
    )]
    pub program: Program<'info, crate::program::DuelMarket>,
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, MarketConfig>,
}

#[derive(Accounts)]
#[instruction(duel_key: [u8; 32], market_kind: u8)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, MarketConfig>,
    #[account(
        constraint = duel_state.duel_key == duel_key @ ErrorCode::DuelMismatch,
    )]
    pub duel_state: Account<'info, OracleDuelState>,
    #[account(
        init,
        payer = operator,
        space = 8 + MarketState::INIT_SPACE,
        seeds = [MARKET_SEED, duel_state.key().as_ref(), &[market_kind]],
        bump,
    )]
    pub market_state: Account<'info, MarketState>,
    /// CHECK: Native SOL vault PDA for this market
    #[account(
        mut,
        seeds = [VAULT_SEED, market_state.key().as_ref()],
        bump,
    )]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SyncMarketFromDuel<'info> {
    #[account(mut)]
    pub market_state: Account<'info, MarketState>,
    #[account(address = market_state.duel_state @ ErrorCode::DuelMismatch)]
    pub duel_state: Account<'info, OracleDuelState>,
}

#[derive(Accounts)]
#[instruction(order_id: u64, side: u8, price: u16)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub market_state: Box<Account<'info, MarketState>>,
    #[account(address = market_state.duel_state @ ErrorCode::DuelMismatch)]
    pub duel_state: Box<Account<'info, OracleDuelState>>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserBalance::INIT_SPACE,
        seeds = [BALANCE_SEED, market_state.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub user_balance: Box<Account<'info, UserBalance>>,
    #[account(
        init,
        payer = user,
        space = 8 + Order::INIT_SPACE,
        seeds = [ORDER_SEED, market_state.key().as_ref(), &order_id.to_le_bytes()],
        bump,
    )]
    pub new_order: Box<Account<'info, Order>>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + PriceLevel::INIT_SPACE,
        seeds = [LEVEL_SEED, market_state.key().as_ref(), &[side], &price.to_le_bytes()],
        bump,
    )]
    pub resting_level: Box<Account<'info, PriceLevel>>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, MarketConfig>>,
    /// CHECK: Snapshotted treasury recipient; execution fees remain in escrow.
    #[account(
        address = market_state.treasury @ ErrorCode::InvalidFeeAccount,
    )]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: Snapshotted market-maker recipient; execution fees remain in escrow.
    #[account(
        address = market_state.market_maker @ ErrorCode::InvalidFeeAccount,
    )]
    pub market_maker: UncheckedAccount<'info>,
    /// CHECK: Native SOL vault PDA
    #[account(
        mut,
        seeds = [VAULT_SEED, market_state.key().as_ref()],
        bump = market_state.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct ContinueOrder<'info> {
    #[account(mut)]
    pub market_state: Box<Account<'info, MarketState>>,
    #[account(address = market_state.duel_state @ ErrorCode::DuelMismatch)]
    pub duel_state: Box<Account<'info, OracleDuelState>>,
    #[account(
        mut,
        seeds = [BALANCE_SEED, market_state.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = user_balance.user == user.key() @ ErrorCode::InvalidUserBalance,
        constraint = user_balance.market_state == market_state.key() @ ErrorCode::InvalidUserBalance,
    )]
    pub user_balance: Box<Account<'info, UserBalance>>,
    #[account(
        mut,
        seeds = [ORDER_SEED, market_state.key().as_ref(), &order_id.to_le_bytes()],
        bump = order.bump,
    )]
    pub order: Box<Account<'info, Order>>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + PriceLevel::INIT_SPACE,
        seeds = [LEVEL_SEED, market_state.key().as_ref(), &[order.side], &order.price.to_le_bytes()],
        bump,
    )]
    pub resting_level: Box<Account<'info, PriceLevel>>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, MarketConfig>>,
    /// CHECK: Snapshotted treasury recipient; execution fees remain in escrow.
    #[account(
        address = market_state.treasury @ ErrorCode::InvalidFeeAccount,
    )]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: Snapshotted market-maker recipient; execution fees remain in escrow.
    #[account(
        address = market_state.market_maker @ ErrorCode::InvalidFeeAccount,
    )]
    pub market_maker: UncheckedAccount<'info>,
    /// CHECK: Native SOL vault PDA
    #[account(
        mut,
        seeds = [VAULT_SEED, market_state.key().as_ref()],
        bump = market_state.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: u64, side: u8, price: u16)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub market_state: Box<Account<'info, MarketState>>,
    #[account(address = market_state.duel_state @ ErrorCode::DuelMismatch)]
    pub duel_state: Box<Account<'info, OracleDuelState>>,
    #[account(
        mut,
        seeds = [ORDER_SEED, market_state.key().as_ref(), &order_id.to_le_bytes()],
        bump = order.bump,
        close = user,
    )]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: The PDA is allowed to be absent only for a validated, unlinked
    /// continuation-pending order. Existing levels are owner/discriminator,
    /// identity, and bump checked in the instruction before any book mutation.
    #[account(
        mut,
        seeds = [LEVEL_SEED, market_state.key().as_ref(), &[side], &price.to_le_bytes()],
        bump,
    )]
    pub price_level: UncheckedAccount<'info>,
    /// CHECK: Native SOL vault PDA
    #[account(
        mut,
        seeds = [VAULT_SEED, market_state.key().as_ref()],
        bump = market_state.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct CloseFilledOrder<'info> {
    pub market_state: Box<Account<'info, MarketState>>,
    #[account(
        mut,
        seeds = [ORDER_SEED, market_state.key().as_ref(), &order_id.to_le_bytes()],
        bump = order.bump,
        close = user,
    )]
    pub order: Box<Account<'info, Order>>,
    #[account(mut)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseEmptyUserBalance<'info> {
    pub market_state: Box<Account<'info, MarketState>>,
    #[account(
        mut,
        seeds = [BALANCE_SEED, market_state.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = user_balance.user == user.key() @ ErrorCode::InvalidUserBalance,
        constraint = user_balance.market_state == market_state.key() @ ErrorCode::InvalidUserBalance,
        close = user,
    )]
    pub user_balance: Box<Account<'info, UserBalance>>,
    #[account(mut)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(side: u8, price: u16)]
pub struct CloseEmptyPriceLevel<'info> {
    pub market_state: Box<Account<'info, MarketState>>,
    #[account(
        mut,
        seeds = [LEVEL_SEED, market_state.key().as_ref(), &[side], &price.to_le_bytes()],
        bump = price_level.bump,
        close = rent_recipient,
    )]
    pub price_level: Box<Account<'info, PriceLevel>>,
    /// CHECK: Constrained to the immutable first payer recorded by PriceLevel.
    #[account(
        mut,
        address = price_level.rent_recipient @ ErrorCode::InvalidPriceLevelRentRecipient,
    )]
    pub rent_recipient: UncheckedAccount<'info>,
    pub closer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(order_id: u64, side: u8, price: u16)]
pub struct ReclaimRestingOrder<'info> {
    #[account(mut)]
    pub market_state: Box<Account<'info, MarketState>>,
    #[account(address = market_state.duel_state @ ErrorCode::DuelMismatch)]
    pub duel_state: Box<Account<'info, OracleDuelState>>,
    #[account(
        mut,
        seeds = [ORDER_SEED, market_state.key().as_ref(), &order_id.to_le_bytes()],
        bump = order.bump,
        close = user,
    )]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: The PDA is allowed to be absent only for a validated, unlinked
    /// continuation-pending order. Existing levels are owner/discriminator,
    /// identity, and bump checked in the instruction before any book mutation.
    #[account(
        mut,
        seeds = [LEVEL_SEED, market_state.key().as_ref(), &[side], &price.to_le_bytes()],
        bump,
    )]
    pub price_level: UncheckedAccount<'info>,
    /// CHECK: Native SOL vault PDA
    #[account(
        mut,
        seeds = [VAULT_SEED, market_state.key().as_ref()],
        bump = market_state.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub market_state: Box<Account<'info, MarketState>>,
    #[account(address = market_state.duel_state @ ErrorCode::DuelMismatch)]
    pub duel_state: Box<Account<'info, OracleDuelState>>,
    #[account(
        mut,
        seeds = [BALANCE_SEED, market_state.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = user_balance.user == user.key() @ ErrorCode::InvalidUserBalance,
        constraint = user_balance.market_state == market_state.key() @ ErrorCode::InvalidUserBalance,
    )]
    pub user_balance: Box<Account<'info, UserBalance>>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, MarketConfig>>,
    /// CHECK: Market maker wallet for winnings fee — validated against snapshot, not live config
    #[account(
        mut,
        address = market_state.market_maker @ ErrorCode::InvalidFeeAccount, // FIX-7: Use snapshot
    )]
    pub market_maker: UncheckedAccount<'info>,
    /// CHECK: Native SOL vault PDA
    #[account(
        mut,
        seeds = [VAULT_SEED, market_state.key().as_ref()],
        bump = market_state.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseLosingBalance<'info> {
    #[account(mut)]
    pub market_state: Box<Account<'info, MarketState>>,
    #[account(address = market_state.duel_state @ ErrorCode::DuelMismatch)]
    pub duel_state: Box<Account<'info, OracleDuelState>>,
    #[account(
        mut,
        seeds = [BALANCE_SEED, market_state.key().as_ref(), user.key().as_ref()],
        bump,
        constraint = user_balance.user == user.key() @ ErrorCode::InvalidUserBalance,
        constraint = user_balance.market_state == market_state.key() @ ErrorCode::InvalidUserBalance,
    )]
    pub user_balance: Box<Account<'info, UserBalance>>,
    #[account(mut)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawResolvedTradeFees<'info> {
    #[account(mut)]
    pub market_state: Box<Account<'info, MarketState>>,
    #[account(address = market_state.duel_state @ ErrorCode::DuelMismatch)]
    pub duel_state: Box<Account<'info, OracleDuelState>>,
    /// CHECK: Constrained to the immutable recipient snapshotted at market creation.
    #[account(
        mut,
        address = market_state.treasury @ ErrorCode::InvalidFeeAccount,
    )]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: Constrained to the immutable recipient snapshotted at market creation.
    #[account(
        mut,
        address = market_state.market_maker @ ErrorCode::InvalidFeeAccount,
    )]
    pub market_maker: UncheckedAccount<'info>,
    /// CHECK: Native SOL vault PDA for this market.
    #[account(
        mut,
        seeds = [VAULT_SEED, market_state.key().as_ref()],
        bump = market_state.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,
    pub submitter: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct MarketConfig {
    pub authority: Pubkey,
    pub market_operator: Pubkey,
    pub treasury: Pubkey,
    pub market_maker: Pubkey,
    pub trade_treasury_fee_bps: u16,
    pub trade_market_maker_fee_bps: u16,
    pub winnings_market_maker_fee_bps: u16,
    pub order_placement_paused: bool,
    pub market_creation_paused: bool,
    pub config_frozen: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MarketState {
    pub duel_state: Pubkey,
    pub duel_key: [u8; 32],
    pub market_kind: u8,
    pub status: MarketStatus,
    pub winner: MarketSide,
    pub trade_treasury_fee_bps_snapshot: u16,
    pub trade_market_maker_fee_bps_snapshot: u16,
    pub winnings_market_maker_fee_bps_snapshot: u16,
    pub next_order_id: u64,
    pub best_bid: u16,
    pub best_ask: u16,
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub market_maker: Pubkey, // FIX-7: Snapshot for claim fee routing
    pub accrued_trade_treasury_fee_lamports: u64,
    pub accrued_trade_market_maker_fee_lamports: u64,
    pub bid_bitmap: [u64; BITMAP_WORDS],
    pub ask_bitmap: [u64; BITMAP_WORDS],
    pub vault_bump: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PriceLevel {
    pub market_state: Pubkey,
    pub rent_recipient: Pubkey,
    pub side: u8,
    pub price: u16,
    pub head_order_id: u64,
    pub tail_order_id: u64,
    pub total_open: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Order {
    pub market_state: Pubkey,
    pub id: u64,
    pub side: u8,
    pub price: u16,
    pub order_behavior: u8,
    pub maker: Pubkey,
    pub amount: u64,
    pub filled: u64,
    pub prev_order_id: u64,
    pub next_order_id: u64,
    pub active: bool,
    pub continuation_pending: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserBalance {
    pub user: Pubkey,
    pub market_state: Pubkey,
    pub a_shares: u64,
    pub b_shares: u64,
    pub a_locked_lamports: u64,
    pub b_locked_lamports: u64,
    pub trade_treasury_fee_lamports: u64,
    pub trade_market_maker_fee_lamports: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, PartialEq, InitSpace)]
pub enum MarketStatus {
    Open,
    Locked,
    Resolved,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MatchStopReason {
    Filled,
    NonCrossing,
    MatchLimit,
    SelfTradePrevented,
}

struct MatchOutcome {
    remaining_amount: u64,
    executed_cost: u64,
    total_improvement: u64,
    account_idx: usize,
    stop_reason: MatchStopReason,
    self_trade_prevented: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MatchLevelState {
    Empty,
    Active,
}

fn validate_fixed_account_cardinality(remaining_account_count: usize) -> Result<()> {
    require!(
        remaining_account_count == 0,
        ErrorCode::InvalidRemainingAccount
    );
    Ok(())
}

fn validate_fee_config(
    trade_treasury_fee_bps: u16,
    trade_market_maker_fee_bps: u16,
    winnings_market_maker_fee_bps: u16,
) -> Result<()> {
    let combined_trade_fee_bps = u32::from(trade_treasury_fee_bps)
        .checked_add(u32::from(trade_market_maker_fee_bps))
        .ok_or(ErrorCode::MathOverflow)?;
    require!(combined_trade_fee_bps <= 10_000, ErrorCode::FeeTooHigh);
    require!(
        winnings_market_maker_fee_bps <= 10_000,
        ErrorCode::FeeTooHigh
    );
    Ok(())
}

fn validate_uninitialized_market_config(config: &MarketConfig) -> Result<()> {
    require!(
        config.authority == Pubkey::default()
            && config.market_operator == Pubkey::default()
            && config.treasury == Pubkey::default()
            && config.market_maker == Pubkey::default()
            && config.trade_treasury_fee_bps == 0
            && config.trade_market_maker_fee_bps == 0
            && config.winnings_market_maker_fee_bps == 0
            && !config.order_placement_paused
            && !config.market_creation_paused
            && !config.config_frozen
            && config.bump == 0,
        ErrorCode::AlreadyInitialized
    );
    Ok(())
}

fn bps_fee(amount: u64, fee_bps: u16) -> Result<u64> {
    require!(fee_bps <= 10_000, ErrorCode::FeeTooHigh);
    mul_div_floor(amount, u64::from(fee_bps), 10_000)
}

/// Multiplies before dividing without imposing an artificial u64 intermediate
/// ceiling. The quotient must still fit in u64, which is guaranteed by every
/// launch call site because `multiplier <= denominator`.
fn mul_div_floor(amount: u64, multiplier: u64, denominator: u64) -> Result<u64> {
    require!(denominator > 0, ErrorCode::MathOverflow);
    let quotient = u128::from(amount)
        .checked_mul(u128::from(multiplier))
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(u128::from(denominator))
        .ok_or(ErrorCode::MathOverflow)?;
    u64::try_from(quotient).map_err(|_| ErrorCode::MathOverflow.into())
}

fn validate_losing_balance_cleanup(
    status: MarketStatus,
    winner: MarketSide,
    a_shares: u64,
    b_shares: u64,
    a_locked_lamports: u64,
    b_locked_lamports: u64,
) -> Result<()> {
    require!(
        status == MarketStatus::Resolved,
        ErrorCode::MarketNotResolved
    );
    require!(
        winner == MarketSide::A || winner == MarketSide::B,
        ErrorCode::MarketHasNoWinner
    );
    require!(
        a_shares > 0 || b_shares > 0 || a_locked_lamports > 0 || b_locked_lamports > 0,
        ErrorCode::NothingToClose
    );

    let has_winning_balance = if winner == MarketSide::A {
        a_shares > 0 || a_locked_lamports > 0
    } else {
        b_shares > 0 || b_locked_lamports > 0
    };
    require!(
        !has_winning_balance,
        ErrorCode::WinningBalanceCannotBeClosed
    );
    Ok(())
}

fn validate_empty_user_balance(user_balance: &UserBalance) -> Result<()> {
    require!(
        user_balance.a_shares == 0
            && user_balance.b_shares == 0
            && user_balance.a_locked_lamports == 0
            && user_balance.b_locked_lamports == 0
            && user_balance.trade_treasury_fee_lamports == 0
            && user_balance.trade_market_maker_fee_lamports == 0,
        ErrorCode::UserBalanceNotEmpty
    );
    Ok(())
}

fn validate_side(side: u8) -> Result<()> {
    require!(side == SIDE_BID || side == SIDE_ASK, ErrorCode::InvalidSide);
    Ok(())
}

fn validate_order_behavior(order_behavior: u8) -> Result<()> {
    require!(
        matches!(
            order_behavior,
            ORDER_BEHAVIOR_GTC | ORDER_BEHAVIOR_IOC | ORDER_BEHAVIOR_POST_ONLY
        ),
        ErrorCode::InvalidOrderBehavior
    );
    Ok(())
}

// Solana's pinned SBF Rust 1.84 toolchain predates u64::is_multiple_of.
#[allow(clippy::manual_is_multiple_of)]
fn quote_cost(side: u8, price: u16, amount: u64) -> Result<u64> {
    let price_component = if side == SIDE_BID {
        price as u64
    } else {
        1000_u64
            .checked_sub(price as u64)
            .ok_or(ErrorCode::MathOverflow)?
    };
    let total = u128::from(amount)
        .checked_mul(u128::from(price_component))
        .ok_or(ErrorCode::MathOverflow)?;
    require!(total % 1000 == 0, ErrorCode::PrecisionError);
    let cost = u64::try_from(total.checked_div(1000).ok_or(ErrorCode::MathOverflow)?)
        .map_err(|_| ErrorCode::MathOverflow)?;
    require!(cost > 0, ErrorCode::CostTooLow);
    Ok(cost)
}

fn map_duel_status(status: OracleDuelStatus) -> MarketStatus {
    match status {
        OracleDuelStatus::Scheduled => MarketStatus::Locked,
        OracleDuelStatus::BettingOpen => MarketStatus::Open,
        OracleDuelStatus::Locked => MarketStatus::Locked,
        OracleDuelStatus::Proposed => MarketStatus::Locked,
        OracleDuelStatus::Challenged => MarketStatus::Locked,
        OracleDuelStatus::Resolved => MarketStatus::Resolved,
        OracleDuelStatus::Cancelled => MarketStatus::Cancelled,
    }
}

fn sync_market_status(
    market_state: &mut MarketState,
    duel_state: &OracleDuelState,
    market_pubkey: Pubkey,
    duel_pubkey: Pubkey,
) -> Result<()> {
    validate_market_identity(
        market_pubkey,
        market_state.bump,
        market_state.vault_bump,
        market_state.market_kind,
        duel_pubkey,
    )?;
    validate_duel_sync_identity(
        market_state.duel_state,
        market_state.duel_key,
        duel_pubkey,
        duel_state.duel_key,
        duel_state.bump,
        duel_state.account_schema_version,
        duel_state.status,
        duel_state.winner,
    )?;
    market_state.status = map_duel_status(duel_state.status);
    market_state.winner = if duel_state.status == OracleDuelStatus::Resolved {
        duel_state.winner
    } else {
        MarketSide::None
    };
    emit!(MarketSynced {
        duel_key: market_state.duel_key,
        market_key: market_pubkey,
        status: market_state.status,
        winner: market_state.winner,
    });
    Ok(())
}

fn validate_market_identity(
    market_pubkey: Pubkey,
    market_bump: u8,
    vault_bump: u8,
    market_kind: u8,
    duel_pubkey: Pubkey,
) -> Result<()> {
    require!(
        market_kind == MARKET_KIND_DUEL_WINNER,
        ErrorCode::InvalidMarketKind
    );
    let (expected_market, expected_bump) = Pubkey::find_program_address(
        &[MARKET_SEED, duel_pubkey.as_ref(), &[market_kind]],
        &crate::ID,
    );
    require_keys_eq!(market_pubkey, expected_market, ErrorCode::DuelMismatch);
    require!(market_bump == expected_bump, ErrorCode::DuelMismatch);
    let (_, expected_vault_bump) =
        Pubkey::find_program_address(&[VAULT_SEED, market_pubkey.as_ref()], &crate::ID);
    require!(vault_bump == expected_vault_bump, ErrorCode::DuelMismatch);
    Ok(())
}

fn validate_duel_sync_identity(
    market_duel_pubkey: Pubkey,
    market_duel_key: [u8; 32],
    duel_pubkey: Pubkey,
    duel_key: [u8; 32],
    duel_bump: u8,
    account_schema_version: u16,
    duel_status: OracleDuelStatus,
    duel_winner: MarketSide,
) -> Result<()> {
    require_keys_eq!(market_duel_pubkey, duel_pubkey, ErrorCode::DuelMismatch);
    require!(market_duel_key == duel_key, ErrorCode::DuelMismatch);
    let (expected_duel_pubkey, expected_duel_bump) = Pubkey::find_program_address(
        &[fight_oracle::DUEL_SEED, duel_key.as_ref()],
        &fight_oracle::ID,
    );
    require_keys_eq!(duel_pubkey, expected_duel_pubkey, ErrorCode::DuelMismatch);
    require!(duel_bump == expected_duel_bump, ErrorCode::DuelMismatch);
    require!(
        account_schema_version == fight_oracle::ACCOUNT_SCHEMA_VERSION,
        ErrorCode::DuelMismatch
    );
    if duel_status == OracleDuelStatus::Resolved {
        require!(
            duel_winner == MarketSide::A || duel_winner == MarketSide::B,
            ErrorCode::MarketHasNoWinner
        );
    } else {
        require!(duel_winner == MarketSide::None, ErrorCode::DuelMismatch);
    }
    Ok(())
}

fn boundary_price(market_state: &MarketState, side: u8) -> u16 {
    if side == SIDE_BID {
        market_state.best_ask
    } else {
        market_state.best_bid
    }
}

fn price_crosses_limit(side: u8, limit_price: u16, boundary_price: u16) -> bool {
    if side == SIDE_BID {
        boundary_price <= limit_price && boundary_price < 1000
    } else {
        boundary_price >= limit_price && boundary_price > 0
    }
}

fn order_would_cross(market_state: &MarketState, side: u8, price: u16) -> bool {
    price_crosses_limit(side, price, boundary_price(market_state, side))
}

fn continuation_required(order_behavior: u8, stop_reason: MatchStopReason) -> bool {
    order_behavior == ORDER_BEHAVIOR_GTC && stop_reason == MatchStopReason::MatchLimit
}

fn prepare_resting_level(
    level: &mut PriceLevel,
    market_key: Pubkey,
    side: u8,
    price: u16,
    payer: Pubkey,
    bump: u8,
) -> Result<()> {
    if level.market_state == Pubkey::default() {
        require!(
            level.rent_recipient == Pubkey::default()
                && level.side == 0
                && level.price == 0
                && level.head_order_id == 0
                && level.tail_order_id == 0
                && level.total_open == 0
                && level.bump == 0,
            ErrorCode::InvalidRemainingAccount
        );
        level.market_state = market_key;
        level.rent_recipient = payer;
        level.side = side;
        level.price = price;
        level.bump = bump;
    } else {
        require_keys_eq!(
            level.market_state,
            market_key,
            ErrorCode::PriceLevelMismatch
        );
        require!(level.side == side, ErrorCode::PriceLevelMismatch);
        require!(level.price == price, ErrorCode::PriceLevelMismatch);
        require!(level.bump == bump, ErrorCode::PriceLevelMismatch);
        require!(
            level.rent_recipient != Pubkey::default(),
            ErrorCode::InvalidPriceLevelRentRecipient
        );
    }
    validate_match_level_state(level)?;
    Ok(())
}

fn prepare_user_balance(
    user_balance: &mut UserBalance,
    market_key: Pubkey,
    user_key: Pubkey,
) -> Result<()> {
    if user_balance.user == Pubkey::default() && user_balance.market_state == Pubkey::default() {
        require!(
            user_balance.a_shares == 0
                && user_balance.b_shares == 0
                && user_balance.a_locked_lamports == 0
                && user_balance.b_locked_lamports == 0
                && user_balance.trade_treasury_fee_lamports == 0
                && user_balance.trade_market_maker_fee_lamports == 0,
            ErrorCode::InvalidUserBalance
        );
        user_balance.user = user_key;
        user_balance.market_state = market_key;
    } else {
        validate_user_balance_identity(user_balance, market_key, user_key)?;
    }
    Ok(())
}

fn validate_user_balance_identity(
    user_balance: &UserBalance,
    market_key: Pubkey,
    user_key: Pubkey,
) -> Result<()> {
    require_keys_eq!(user_balance.user, user_key, ErrorCode::InvalidUserBalance);
    require_keys_eq!(
        user_balance.market_state,
        market_key,
        ErrorCode::InvalidUserBalance
    );
    Ok(())
}

fn validate_fee_recipient_not_vault(vault_key: Pubkey, recipient_key: Pubkey) -> Result<()> {
    require!(
        recipient_key != Pubkey::default() && recipient_key != vault_key,
        ErrorCode::InvalidFeeAccount
    );
    Ok(())
}

fn validate_market_fee_configuration(
    vault_key: Pubkey,
    treasury: Pubkey,
    market_maker: Pubkey,
    trade_treasury_fee_bps: u16,
    trade_market_maker_fee_bps: u16,
    winnings_market_maker_fee_bps: u16,
) -> Result<()> {
    validate_fee_config(
        trade_treasury_fee_bps,
        trade_market_maker_fee_bps,
        winnings_market_maker_fee_bps,
    )?;
    if trade_treasury_fee_bps > 0 {
        validate_fee_recipient_not_vault(vault_key, treasury)?;
    }
    if trade_market_maker_fee_bps > 0 || winnings_market_maker_fee_bps > 0 {
        validate_fee_recipient_not_vault(vault_key, market_maker)?;
    }
    Ok(())
}

fn should_close_price_level(level: &PriceLevel) -> bool {
    level.total_open == 0 && level.head_order_id == 0 && level.tail_order_id == 0
}

fn load_existing_price_level(
    level_info: &AccountInfo<'_>,
    market_key: Pubkey,
    side: u8,
    price: u16,
    bump: u8,
) -> Result<PriceLevel> {
    require_keys_eq!(
        *level_info.owner,
        crate::ID,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        level_info.data_len() == 8 + PriceLevel::INIT_SPACE,
        ErrorCode::InvalidRemainingAccount
    );
    let level = {
        let data = level_info
            .try_borrow_data()
            .map_err(|_| ErrorCode::InvalidRemainingAccount)?;
        let mut data_slice: &[u8] = &data;
        PriceLevel::try_deserialize(&mut data_slice)
            .map_err(|_| ErrorCode::InvalidRemainingAccount)?
    };
    require_keys_eq!(
        level.market_state,
        market_key,
        ErrorCode::InvalidRemainingAccount
    );
    require!(level.side == side, ErrorCode::InvalidRemainingAccount);
    require!(level.price == price, ErrorCode::InvalidRemainingAccount);
    require!(level.bump == bump, ErrorCode::InvalidRemainingAccount);
    require!(
        level.rent_recipient != Pubkey::default(),
        ErrorCode::InvalidRemainingAccount
    );
    Ok(level)
}

fn close_pending_price_level_if_present<'info>(
    level_info: &AccountInfo<'info>,
    recipient_info: &AccountInfo<'info>,
    market_key: Pubkey,
    side: u8,
    price: u16,
    bump: u8,
) -> Result<bool> {
    if level_info.owner == &system_program::ID
        && level_info.lamports() == 0
        && level_info.data_is_empty()
    {
        return Ok(false);
    }

    let level = load_existing_price_level(level_info, market_key, side, price, bump)?;
    if !should_close_price_level(&level) || level.rent_recipient != recipient_info.key() {
        return Ok(false);
    }

    require!(
        level_info.is_writable
            && recipient_info.is_writable
            && level_info.key() != recipient_info.key(),
        ErrorCode::InvalidRemainingAccount
    );
    let recipient_lamports = recipient_info
        .lamports()
        .checked_add(level_info.lamports())
        .ok_or(ErrorCode::MathOverflow)?;
    **recipient_info
        .try_borrow_mut_lamports()
        .map_err(|_| ErrorCode::InvalidRemainingAccount)? = recipient_lamports;
    **level_info
        .try_borrow_mut_lamports()
        .map_err(|_| ErrorCode::InvalidRemainingAccount)? = 0;
    level_info.assign(&system_program::ID);
    level_info
        .resize(0)
        .map_err(|_| ErrorCode::InvalidRemainingAccount)?;
    Ok(true)
}

fn persist_price_level(level_info: &AccountInfo<'_>, level: &PriceLevel) -> Result<()> {
    require_keys_eq!(
        *level_info.owner,
        crate::ID,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        level_info.is_writable && level_info.data_len() == 8 + PriceLevel::INIT_SPACE,
        ErrorCode::InvalidRemainingAccount
    );
    let mut data = level_info
        .try_borrow_mut_data()
        .map_err(|_| ErrorCode::InvalidRemainingAccount)?;
    level
        .try_serialize(&mut &mut data[..])
        .map_err(|_| ErrorCode::InvalidRemainingAccount)?;
    Ok(())
}

fn close_empty_price_level_if_recipient<'info>(
    level: &mut Account<'info, PriceLevel>,
    user: &Signer<'info>,
) -> Result<()> {
    if should_close_price_level(level) && level.rent_recipient == user.key() {
        level.close(user.to_account_info())?;
    }
    Ok(())
}

fn persist_resting_order(
    order: &mut Account<Order>,
    market_key: Pubkey,
    maker: Pubkey,
    order_id: u64,
    side: u8,
    price: u16,
    amount: u64,
    order_behavior: u8,
    bump: u8,
    prev_order_id: u64,
) {
    order.market_state = market_key;
    order.id = order_id;
    order.side = side;
    order.price = price;
    order.order_behavior = order_behavior;
    order.maker = maker;
    order.amount = amount;
    order.filled = 0;
    order.prev_order_id = prev_order_id;
    order.next_order_id = 0;
    order.active = true;
    order.continuation_pending = false;
    order.bump = bump;
}

#[allow(clippy::manual_is_multiple_of)]
fn validate_continuation_pending_order(order: &Order, market_key: Pubkey) -> Result<u64> {
    require_keys_eq!(
        order.market_state,
        market_key,
        ErrorCode::InvalidRemainingAccount
    );
    require!(order.id > 0, ErrorCode::InvalidRemainingAccount);
    validate_side(order.side)?;
    require!(
        order.price > 0 && order.price < 1000,
        ErrorCode::InvalidPrice
    );
    require!(order.active, ErrorCode::OrderNotContinuable);
    require!(
        order.continuation_pending && order.order_behavior == ORDER_BEHAVIOR_GTC,
        ErrorCode::OrderNotContinuable
    );
    require!(
        order.prev_order_id == 0 && order.next_order_id == 0,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        order.amount > 0 && order.amount % 1000 == 0 && order.filled == 0,
        ErrorCode::InvalidRemainingAccount
    );
    Ok(order.amount)
}

fn persist_pending_order(
    order: &mut Account<Order>,
    market_key: Pubkey,
    maker: Pubkey,
    order_id: u64,
    side: u8,
    price: u16,
    amount: u64,
    order_behavior: u8,
    bump: u8,
) {
    order.market_state = market_key;
    order.id = order_id;
    order.side = side;
    order.price = price;
    order.order_behavior = order_behavior;
    order.maker = maker;
    order.amount = amount;
    order.filled = 0;
    order.prev_order_id = 0;
    order.next_order_id = 0;
    order.active = true;
    order.continuation_pending = true;
    order.bump = bump;
}

fn transfer_from_vault<'info>(
    system_program: &Program<'info, System>,
    vault: &AccountInfo<'info>,
    recipient: &AccountInfo<'info>,
    market_key: &Pubkey,
    vault_bump: u8,
    lamports: u64,
) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }

    let seeds: &[&[u8]] = &[VAULT_SEED, market_key.as_ref(), &[vault_bump]];
    let signer_seeds: &[&[&[u8]]] = &[seeds];
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            system_program::Transfer {
                from: vault.clone(),
                to: recipient.clone(),
            },
            signer_seeds,
        ),
        lamports,
    )?;
    Ok(())
}

fn escrow_trade_fees<'info>(
    system_program: &Program<'info, System>,
    user: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    market_state: &mut Account<'info, MarketState>,
    user_balance: &mut Account<'info, UserBalance>,
    order_id: u64,
    payer: Pubkey,
    executed_cost: u64,
) -> Result<()> {
    validate_market_fee_configuration(
        vault.key(),
        market_state.treasury,
        market_state.market_maker,
        market_state.trade_treasury_fee_bps_snapshot,
        market_state.trade_market_maker_fee_bps_snapshot,
        market_state.winnings_market_maker_fee_bps_snapshot,
    )?;
    let trade_treasury_fee = bps_fee(executed_cost, market_state.trade_treasury_fee_bps_snapshot)?;
    let trade_market_maker_fee = bps_fee(
        executed_cost,
        market_state.trade_market_maker_fee_bps_snapshot,
    )?;
    let total_trade_fee = trade_treasury_fee
        .checked_add(trade_market_maker_fee)
        .ok_or(ErrorCode::MathOverflow)?;

    market_state.accrued_trade_treasury_fee_lamports = market_state
        .accrued_trade_treasury_fee_lamports
        .checked_add(trade_treasury_fee)
        .ok_or(ErrorCode::MathOverflow)?;
    market_state.accrued_trade_market_maker_fee_lamports = market_state
        .accrued_trade_market_maker_fee_lamports
        .checked_add(trade_market_maker_fee)
        .ok_or(ErrorCode::MathOverflow)?;
    user_balance.trade_treasury_fee_lamports = user_balance
        .trade_treasury_fee_lamports
        .checked_add(trade_treasury_fee)
        .ok_or(ErrorCode::MathOverflow)?;
    user_balance.trade_market_maker_fee_lamports = user_balance
        .trade_market_maker_fee_lamports
        .checked_add(trade_market_maker_fee)
        .ok_or(ErrorCode::MathOverflow)?;

    if total_trade_fee > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program.to_account_info(),
                system_program::Transfer {
                    from: user.clone(),
                    to: vault.clone(),
                },
            ),
            total_trade_fee,
        )?;
    }

    if executed_cost > 0 {
        emit!(TradeFeesEscrowed {
            market_key: market_state.key(),
            order_id,
            payer,
            executed_cost_lamports: executed_cost,
            treasury_fee_lamports: trade_treasury_fee,
            market_maker_fee_lamports: trade_market_maker_fee,
        });
    }

    Ok(())
}

#[allow(clippy::manual_is_multiple_of)]
fn validate_match_outcome_conservation(
    side: u8,
    limit_price: u16,
    input_amount: u64,
    outcome: &MatchOutcome,
) -> Result<()> {
    validate_side(side)?;
    require!(
        limit_price > 0 && limit_price < 1000,
        ErrorCode::InvalidPrice
    );
    require!(
        input_amount > 0
            && input_amount % 1000 == 0
            && outcome.remaining_amount <= input_amount
            && outcome.remaining_amount % 1000 == 0,
        ErrorCode::InvalidRemainingAccount
    );

    let matched_amount = input_amount
        .checked_sub(outcome.remaining_amount)
        .ok_or(ErrorCode::MathOverflow)?;
    if matched_amount == 0 {
        require!(
            outcome.executed_cost == 0 && outcome.total_improvement == 0,
            ErrorCode::InvalidRemainingAccount
        );
    } else {
        require!(
            outcome.executed_cost > 0,
            ErrorCode::InvalidRemainingAccount
        );
    }

    match outcome.stop_reason {
        MatchStopReason::Filled => require!(
            outcome.remaining_amount == 0 && !outcome.self_trade_prevented,
            ErrorCode::InvalidRemainingAccount
        ),
        MatchStopReason::SelfTradePrevented => require!(
            outcome.remaining_amount > 0 && outcome.self_trade_prevented,
            ErrorCode::InvalidRemainingAccount
        ),
        MatchStopReason::NonCrossing | MatchStopReason::MatchLimit => require!(
            outcome.remaining_amount > 0 && !outcome.self_trade_prevented,
            ErrorCode::InvalidRemainingAccount
        ),
    }

    let initial_cost = quote_cost(side, limit_price, input_amount)?;
    let remaining_cost = if outcome.remaining_amount == 0 {
        0
    } else {
        quote_cost(side, limit_price, outcome.remaining_amount)?
    };
    let accounted_cost = outcome
        .executed_cost
        .checked_add(outcome.total_improvement)
        .and_then(|value| value.checked_add(remaining_cost))
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        accounted_cost == initial_cost,
        ErrorCode::InvalidRemainingAccount
    );
    Ok(())
}

fn execute_matches<'info>(
    market_state: &mut MarketState,
    market_key: Pubkey,
    user_balance: &mut Account<'info, UserBalance>,
    remaining_accounts: &'info [AccountInfo<'info>],
    taker: Pubkey,
    taker_order_id: u64,
    side: u8,
    price: u16,
    amount: u64,
) -> Result<MatchOutcome> {
    let opposite_side = if side == SIDE_BID { SIDE_ASK } else { SIDE_BID };
    let mut remaining_amount = amount;
    let mut executed_cost = 0_u64;
    let mut total_improvement = 0_u64;
    let mut matches_count = 0_u32;
    let mut account_idx = 0_usize;
    let mut self_trade_prevented = false;

    while remaining_amount > 0 && matches_count < MAX_MATCHES_PER_TX {
        let current_boundary = boundary_price(market_state, side);
        if !price_crosses_limit(side, price, current_boundary) {
            break;
        }

        let level_info = remaining_accounts
            .get(account_idx)
            .ok_or(ErrorCode::MissingMatchAccounts)?;
        let expected_level_key = derive_level_key(&market_key, opposite_side, current_boundary);
        require_keys_eq!(
            level_info.key(),
            expected_level_key,
            ErrorCode::InvalidRemainingAccount
        );
        account_idx += 1;
        let mut level: Account<PriceLevel> =
            Account::try_from(level_info).map_err(|_| ErrorCode::InvalidRemainingAccount)?;
        require_keys_eq!(
            level.market_state,
            market_key,
            ErrorCode::InvalidRemainingAccount
        );
        require!(
            level.side == opposite_side,
            ErrorCode::InvalidRemainingAccount
        );
        require!(
            level.price == current_boundary,
            ErrorCode::InvalidRemainingAccount
        );

        match validate_match_level_state(&level)? {
            MatchLevelState::Empty => {
                set_price_bit(market_state, opposite_side, current_boundary, false);
                update_best_prices(market_state);
                level.exit(&crate::ID)?;
                continue;
            }
            MatchLevelState::Active => {}
        }

        let maker_order_info = remaining_accounts
            .get(account_idx)
            .ok_or(ErrorCode::MissingMatchAccounts)?;
        let expected_order_key = derive_order_key(&market_key, level.head_order_id);
        require_keys_eq!(
            maker_order_info.key(),
            expected_order_key,
            ErrorCode::InvalidRemainingAccount
        );
        account_idx += 1;
        let mut maker_order: Account<Order> =
            Account::try_from(maker_order_info).map_err(|_| ErrorCode::InvalidRemainingAccount)?;

        let maker_balance_info = remaining_accounts
            .get(account_idx)
            .ok_or(ErrorCode::MissingMatchAccounts)?;
        account_idx += 1;
        let mut maker_balance: Account<UserBalance> = Account::try_from(maker_balance_info)
            .map_err(|_| ErrorCode::InvalidRemainingAccount)?;

        let maker_remaining = validate_match_head(&level, &maker_order)?;
        validate_match_balance(
            market_key,
            &maker_order,
            maker_balance_info.key(),
            &maker_balance,
        )?;

        let fill_amount = std::cmp::min(remaining_amount, maker_remaining);
        if maker_order.maker == taker {
            msg!("policy=cancel-taker prevented=true");
            emit!(SelfTradePolicyTriggered {
                market_ref: market_key,
                maker_authority: maker_order.maker,
                taker_authority: taker,
                maker_order_id: maker_order.id,
                taker_order_id,
            });
            self_trade_prevented = true;
            break;
        }

        maker_order.filled = maker_order
            .filled
            .checked_add(fill_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        remaining_amount = remaining_amount
            .checked_sub(fill_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        level.total_open = level
            .total_open
            .checked_sub(fill_amount)
            .ok_or(ErrorCode::MathOverflow)?;

        if side == SIDE_BID {
            let maker_locked = quote_cost(SIDE_ASK, current_boundary, fill_amount)?;
            let taker_locked = quote_cost(SIDE_BID, current_boundary, fill_amount)?;
            maker_balance.b_shares = maker_balance
                .b_shares
                .checked_add(fill_amount)
                .ok_or(ErrorCode::MathOverflow)?;
            maker_balance.b_locked_lamports = maker_balance
                .b_locked_lamports
                .checked_add(maker_locked)
                .ok_or(ErrorCode::MathOverflow)?;
            user_balance.a_shares = user_balance
                .a_shares
                .checked_add(fill_amount)
                .ok_or(ErrorCode::MathOverflow)?;
            user_balance.a_locked_lamports = user_balance
                .a_locked_lamports
                .checked_add(taker_locked)
                .ok_or(ErrorCode::MathOverflow)?;
            executed_cost = executed_cost
                .checked_add(taker_locked)
                .ok_or(ErrorCode::MathOverflow)?;

            if price > current_boundary {
                total_improvement = total_improvement
                    .checked_add(mul_div_floor(
                        fill_amount,
                        u64::from(price - current_boundary),
                        1000,
                    )?)
                    .ok_or(ErrorCode::MathOverflow)?;
            }
        } else {
            let maker_locked = quote_cost(SIDE_BID, current_boundary, fill_amount)?;
            let taker_locked = quote_cost(SIDE_ASK, current_boundary, fill_amount)?;
            maker_balance.a_shares = maker_balance
                .a_shares
                .checked_add(fill_amount)
                .ok_or(ErrorCode::MathOverflow)?;
            maker_balance.a_locked_lamports = maker_balance
                .a_locked_lamports
                .checked_add(maker_locked)
                .ok_or(ErrorCode::MathOverflow)?;
            user_balance.b_shares = user_balance
                .b_shares
                .checked_add(fill_amount)
                .ok_or(ErrorCode::MathOverflow)?;
            user_balance.b_locked_lamports = user_balance
                .b_locked_lamports
                .checked_add(taker_locked)
                .ok_or(ErrorCode::MathOverflow)?;
            executed_cost = executed_cost
                .checked_add(taker_locked)
                .ok_or(ErrorCode::MathOverflow)?;

            if current_boundary > price {
                total_improvement = total_improvement
                    .checked_add(mul_div_floor(
                        fill_amount,
                        u64::from(current_boundary - price),
                        1000,
                    )?)
                    .ok_or(ErrorCode::MathOverflow)?;
            }
        }

        emit!(OrderMatched {
            market_key,
            maker_order_id: maker_order.id,
            taker_order_id,
            matched_amount: fill_amount,
            price: current_boundary,
        });

        if maker_order.filled >= maker_order.amount {
            unlink_head_order(market_state, &mut level, &mut maker_order);
        }

        maker_order.exit(&crate::ID)?;
        maker_balance.exit(&crate::ID)?;
        level.exit(&crate::ID)?;
        matches_count = matches_count
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;
    }

    let stop_reason = if remaining_amount == 0 {
        MatchStopReason::Filled
    } else if self_trade_prevented {
        MatchStopReason::SelfTradePrevented
    } else if price_crosses_limit(side, price, boundary_price(market_state, side)) {
        MatchStopReason::MatchLimit
    } else {
        MatchStopReason::NonCrossing
    };

    Ok(MatchOutcome {
        remaining_amount,
        executed_cost,
        total_improvement,
        account_idx,
        stop_reason,
        self_trade_prevented,
    })
}

fn derive_order_key(market_key: &Pubkey, order_id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[ORDER_SEED, market_key.as_ref(), &order_id.to_le_bytes()],
        &crate::ID,
    )
    .0
}

fn derive_balance_key(market_key: &Pubkey, user: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[BALANCE_SEED, market_key.as_ref(), user.as_ref()],
        &crate::ID,
    )
    .0
}

fn derive_level_key(market_key: &Pubkey, side: u8, price: u16) -> Pubkey {
    Pubkey::find_program_address(
        &[
            LEVEL_SEED,
            market_key.as_ref(),
            &[side],
            &price.to_le_bytes(),
        ],
        &crate::ID,
    )
    .0
}

fn bitmap_ref_mut(market_state: &mut MarketState, side: u8) -> &mut [u64; BITMAP_WORDS] {
    if side == SIDE_BID {
        &mut market_state.bid_bitmap
    } else {
        &mut market_state.ask_bitmap
    }
}

fn highest_set_price(bitmap: &[u64; BITMAP_WORDS]) -> Option<u16> {
    for (word_idx, word) in bitmap.iter().enumerate().rev() {
        if *word == 0 {
            continue;
        }
        let bit = 63_u32.checked_sub(word.leading_zeros()).unwrap_or_default() as usize;
        let price = word_idx
            .checked_mul(64)
            .and_then(|value| value.checked_add(bit))?;
        if price <= 999 {
            return Some(price as u16);
        }
    }
    None
}

fn lowest_set_price(bitmap: &[u64; BITMAP_WORDS]) -> Option<u16> {
    for (word_idx, word) in bitmap.iter().enumerate() {
        if *word == 0 {
            continue;
        }
        let bit = word.trailing_zeros() as usize;
        let price = word_idx
            .checked_mul(64)
            .and_then(|value| value.checked_add(bit))?;
        if (1..=999).contains(&price) {
            return Some(price as u16);
        }
    }
    None
}

fn update_best_prices(market_state: &mut MarketState) {
    market_state.best_bid = highest_set_price(&market_state.bid_bitmap).unwrap_or(0);
    market_state.best_ask = lowest_set_price(&market_state.ask_bitmap).unwrap_or(1000);
}

fn set_price_bit(market_state: &mut MarketState, side: u8, price: u16, active: bool) {
    let bitmap = bitmap_ref_mut(market_state, side);
    let word_idx = (price as usize) / 64;
    let bit_idx = (price as usize) % 64;
    if active {
        bitmap[word_idx] |= 1_u64 << bit_idx;
    } else {
        bitmap[word_idx] &= !(1_u64 << bit_idx);
    }
}

#[allow(clippy::manual_is_multiple_of)]
fn validate_match_level_state(level: &PriceLevel) -> Result<MatchLevelState> {
    let has_open = level.total_open > 0;
    let has_head = level.head_order_id > 0;
    let has_tail = level.tail_order_id > 0;

    if !has_open && !has_head && !has_tail {
        return Ok(MatchLevelState::Empty);
    }
    require!(
        has_open && has_head && has_tail,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        level.total_open % 1000 == 0,
        ErrorCode::InvalidRemainingAccount
    );
    Ok(MatchLevelState::Active)
}

fn validate_match_head(level: &PriceLevel, order: &Order) -> Result<u64> {
    require!(
        validate_match_level_state(level)? == MatchLevelState::Active,
        ErrorCode::InvalidRemainingAccount
    );
    validate_linked_order(level, order)?;
    require!(
        order.id == level.head_order_id,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        order.order_behavior == ORDER_BEHAVIOR_GTC
            || order.order_behavior == ORDER_BEHAVIOR_POST_ONLY,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        order.prev_order_id == 0 || order.prev_order_id != order.id,
        ErrorCode::InvalidRemainingAccount
    );

    let remaining = order
        .amount
        .checked_sub(order.filled)
        .ok_or(ErrorCode::InvalidRemainingAccount)?;
    require!(remaining > 0, ErrorCode::InvalidRemainingAccount);

    if level.head_order_id == level.tail_order_id {
        require!(
            order.next_order_id == 0 && level.total_open == remaining,
            ErrorCode::InvalidRemainingAccount
        );
    } else {
        require!(
            order.next_order_id > 0
                && order.next_order_id != order.id
                && level.total_open > remaining,
            ErrorCode::InvalidRemainingAccount
        );
    }
    Ok(remaining)
}

fn validate_match_balance(
    market_key: Pubkey,
    order: &Order,
    balance_key: Pubkey,
    balance: &UserBalance,
) -> Result<()> {
    require_keys_eq!(
        balance_key,
        derive_balance_key(&market_key, &order.maker),
        ErrorCode::InvalidRemainingAccount
    );
    require_keys_eq!(
        order.maker,
        balance.user,
        ErrorCode::InvalidRemainingAccount
    );
    require_keys_eq!(
        balance.market_state,
        market_key,
        ErrorCode::InvalidRemainingAccount
    );
    Ok(())
}

fn unlink_head_order(market_state: &mut MarketState, level: &mut PriceLevel, order: &mut Order) {
    level.head_order_id = order.next_order_id;
    if level.head_order_id == 0 {
        level.tail_order_id = 0;
        set_price_bit(market_state, level.side, level.price, false);
        update_best_prices(market_state);
    }
    order.active = false;
    order.prev_order_id = 0;
    order.next_order_id = 0;
}

fn load_adjacent_order<'info>(
    accounts: &'info [AccountInfo<'info>],
    cursor: &mut usize,
    market_key: Pubkey,
    order_id: u64,
) -> Result<Option<Account<'info, Order>>> {
    if order_id == 0 {
        return Ok(None);
    }
    let info = accounts
        .get(*cursor)
        .ok_or(ErrorCode::MissingLinkedOrderAccount)?;
    let expected_key = derive_order_key(&market_key, order_id);
    require_keys_eq!(info.key(), expected_key, ErrorCode::InvalidRemainingAccount);
    *cursor += 1;
    let order = Account::try_from(info).map_err(|_| ErrorCode::InvalidRemainingAccount)?;
    Ok(Some(order))
}

fn validate_append_tail(
    price_level: &PriceLevel,
    tail_order: Option<&Order>,
    new_order_id: u64,
) -> Result<()> {
    require!(new_order_id > 0, ErrorCode::InvalidOrderId);

    if price_level.tail_order_id == 0 {
        require!(tail_order.is_none(), ErrorCode::InvalidRemainingAccount);
        require!(
            price_level.head_order_id == 0 && price_level.total_open == 0,
            ErrorCode::InvalidRemainingAccount
        );
        return Ok(());
    }

    require!(
        price_level.head_order_id > 0 && price_level.total_open > 0,
        ErrorCode::InvalidRemainingAccount
    );
    let tail = tail_order.ok_or(ErrorCode::MissingTailOrder)?;
    validate_linked_order(price_level, tail)?;
    require!(
        tail.id == price_level.tail_order_id,
        ErrorCode::InvalidRemainingAccount
    );
    require!(tail.id != new_order_id, ErrorCode::InvalidRemainingAccount);
    require!(tail.next_order_id == 0, ErrorCode::InvalidRemainingAccount);
    require!(
        tail.amount > tail.filled,
        ErrorCode::InvalidRemainingAccount
    );
    Ok(())
}

fn unlink_order(
    market_state: &mut MarketState,
    price_level: &mut PriceLevel,
    order: &mut Order,
    prev_order: Option<&mut Account<Order>>,
    next_order: Option<&mut Account<Order>>,
    remaining: u64,
) -> Result<()> {
    let unlinking_canonical_head = price_level.head_order_id == order.id;
    validate_unlink_graph(
        price_level,
        order,
        prev_order.as_deref().map(|account| &**account),
        next_order.as_deref().map(|account| &**account),
    )?;
    validate_unlink_conservation(price_level, order, remaining)?;

    if unlinking_canonical_head {
        price_level.head_order_id = order.next_order_id;
    } else {
        let prev = prev_order.ok_or(ErrorCode::MissingLinkedOrderAccount)?;
        require!(
            prev.id == order.prev_order_id,
            ErrorCode::InvalidRemainingAccount
        );
        prev.next_order_id = order.next_order_id;
    }

    if order.next_order_id == 0 {
        price_level.tail_order_id =
            replacement_tail_after_unlink(unlinking_canonical_head, order.prev_order_id);
    } else {
        let next = next_order.ok_or(ErrorCode::MissingLinkedOrderAccount)?;
        require!(
            next.id == order.next_order_id,
            ErrorCode::InvalidRemainingAccount
        );
        next.prev_order_id = if unlinking_canonical_head {
            0
        } else {
            order.prev_order_id
        };
    }

    if remaining > 0 {
        price_level.total_open = price_level
            .total_open
            .checked_sub(remaining)
            .ok_or(ErrorCode::MathOverflow)?;
    }
    let resulting_level_state = validate_match_level_state(price_level)?;
    if resulting_level_state == MatchLevelState::Empty {
        set_price_bit(market_state, price_level.side, price_level.price, false);
    }
    update_best_prices(market_state);

    order.active = false;
    order.prev_order_id = 0;
    order.next_order_id = 0;
    Ok(())
}

fn replacement_tail_after_unlink(
    unlinking_canonical_head: bool,
    stored_previous_order_id: u64,
) -> u64 {
    if unlinking_canonical_head {
        // A newly canonical head can retain the matched-out predecessor's ID
        // until its next unlink. Once that head is also the tail, the stale ID
        // is historical metadata, not a live queue member.
        0
    } else {
        stored_previous_order_id
    }
}

fn validate_unlink_graph(
    price_level: &PriceLevel,
    order: &Order,
    prev_order: Option<&Order>,
    next_order: Option<&Order>,
) -> Result<()> {
    // Continued orders can enter the resting queue after newer global IDs.
    // Queue authority is therefore reciprocal topology, never numeric ID order.
    require!(order.id > 0, ErrorCode::InvalidRemainingAccount);
    require!(order.active, ErrorCode::InvalidRemainingAccount);
    require!(
        !order.continuation_pending,
        ErrorCode::InvalidRemainingAccount
    );
    require_keys_eq!(
        order.market_state,
        price_level.market_state,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        order.side == price_level.side,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        order.price == price_level.price,
        ErrorCode::InvalidRemainingAccount
    );

    let is_canonical_head = price_level.head_order_id == order.id;
    if is_canonical_head {
        require!(prev_order.is_none(), ErrorCode::InvalidRemainingAccount);
        require!(
            order.prev_order_id == 0 || order.prev_order_id != order.id,
            ErrorCode::InvalidRemainingAccount
        );
    } else {
        require!(
            order.prev_order_id > 0 && order.prev_order_id != order.id,
            ErrorCode::InvalidRemainingAccount
        );
        let prev = prev_order.ok_or(ErrorCode::MissingLinkedOrderAccount)?;
        require!(
            prev.id == order.prev_order_id,
            ErrorCode::InvalidRemainingAccount
        );
        validate_linked_order(price_level, prev)?;
        require!(
            prev.next_order_id == order.id,
            ErrorCode::InvalidRemainingAccount
        );
    }

    if order.next_order_id == 0 {
        require!(
            price_level.tail_order_id == order.id,
            ErrorCode::InvalidRemainingAccount
        );
    } else {
        require!(
            order.next_order_id != order.id,
            ErrorCode::InvalidRemainingAccount
        );
        let next = next_order.ok_or(ErrorCode::MissingLinkedOrderAccount)?;
        require!(
            next.id == order.next_order_id,
            ErrorCode::InvalidRemainingAccount
        );
        validate_linked_order(price_level, next)?;
        require!(
            next.prev_order_id == order.id,
            ErrorCode::InvalidRemainingAccount
        );
    }

    require!(
        order.prev_order_id == 0
            || order.next_order_id == 0
            || order.prev_order_id != order.next_order_id,
        ErrorCode::InvalidRemainingAccount
    );
    Ok(())
}

fn validate_unlink_conservation(
    price_level: &PriceLevel,
    order: &Order,
    remaining: u64,
) -> Result<()> {
    require!(remaining > 0, ErrorCode::InvalidRemainingAccount);
    require!(
        order
            .amount
            .checked_sub(order.filled)
            .ok_or(ErrorCode::InvalidRemainingAccount)?
            == remaining,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        validate_match_level_state(price_level)? == MatchLevelState::Active,
        ErrorCode::InvalidRemainingAccount
    );

    if price_level.head_order_id == price_level.tail_order_id {
        require!(
            order.id == price_level.head_order_id && price_level.total_open == remaining,
            ErrorCode::InvalidRemainingAccount
        );
    } else {
        require!(
            price_level.total_open > remaining,
            ErrorCode::InvalidRemainingAccount
        );
    }
    Ok(())
}

#[allow(clippy::manual_is_multiple_of)]
fn validate_linked_order(price_level: &PriceLevel, order: &Order) -> Result<()> {
    require!(order.id > 0, ErrorCode::InvalidRemainingAccount);
    require!(order.active, ErrorCode::InvalidRemainingAccount);
    require!(
        !order.continuation_pending,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        order.order_behavior == ORDER_BEHAVIOR_GTC
            || order.order_behavior == ORDER_BEHAVIOR_POST_ONLY,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        order.amount > order.filled,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        order.amount % 1000 == 0 && order.filled % 1000 == 0,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        order.prev_order_id != order.id && order.next_order_id != order.id,
        ErrorCode::InvalidRemainingAccount
    );
    require_keys_eq!(
        order.market_state,
        price_level.market_state,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        order.side == price_level.side,
        ErrorCode::InvalidRemainingAccount
    );
    require!(
        order.price == price_level.price,
        ErrorCode::InvalidRemainingAccount
    );
    Ok(())
}

#[error_code]
pub enum ErrorCode {
    #[msg("Only the upgrade authority can initialize config")]
    UnauthorizedInitializer,
    #[msg("Config authority is required for this action")]
    UnauthorizedConfigAuthority,
    #[msg("Config authority is immutable")]
    ConfigAuthorityImmutable,
    #[msg("Market operator is not authorized")]
    UnauthorizedMarketOperator,
    #[msg("Market operator pubkey is invalid")]
    InvalidOperator,
    #[msg("Authority pubkey is invalid")]
    InvalidAuthority,
    #[msg("The provided fee account is invalid")]
    InvalidFeeAccount,
    #[msg("Fee configuration exceeds 100%")]
    FeeTooHigh,
    #[msg("Only duel-winner markets are currently supported")]
    InvalidMarketKind,
    #[msg("The duel account does not match the market")]
    DuelMismatch,
    #[msg("Markets can only be created while betting is open or locked")]
    MarketCreationClosed,
    #[msg("Market is not open for new orders")]
    MarketNotOpen,
    #[msg("Market is not resolved")]
    MarketNotResolved,
    #[msg("Market is already resolved or cancelled")]
    MarketAlreadyResolved,
    #[msg("Betting is closed")]
    BettingClosed,
    #[msg("Side must be bid (1) or ask (2)")]
    InvalidSide,
    #[msg("Order behavior must be GTC (0), IOC (1), or POST_ONLY (2)")]
    InvalidOrderBehavior,
    #[msg("Price must be between 1 and 999")]
    InvalidPrice,
    #[msg("Order amount must be greater than zero")]
    InvalidAmount,
    #[msg("Order id does not match the next expected id")]
    InvalidOrderId,
    #[msg("Post-only orders cannot cross the book")]
    PostOnlyWouldCross,
    #[msg("The precision implied by amount and price is invalid")]
    PrecisionError,
    #[msg("Order cost is too low")]
    CostTooLow,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("The supplied price level does not match the order")]
    PriceLevelMismatch,
    #[msg("The supplied price level still contains book state")]
    PriceLevelNotEmpty,
    #[msg("The supplied price-level rent recipient is not the immutable first payer")]
    InvalidPriceLevelRentRecipient,
    #[msg("The supplied order side does not match the stored order")]
    OrderSideMismatch,
    #[msg("The supplied order price does not match the stored order")]
    OrderPriceMismatch,
    #[msg("Only the order maker can cancel this order")]
    NotOrderMaker,
    #[msg("The order does not belong to the supplied market")]
    OrderMarketMismatch,
    #[msg("An active order cannot be closed as filled")]
    OrderStillActive,
    #[msg("Only a fully filled order can be closed with this instruction")]
    OrderNotFullyFilled,
    #[msg("A filled order must be fully unlinked before its account can close")]
    OrderStillLinked,
    #[msg("Required maker match accounts were not supplied")]
    MissingMatchAccounts,
    #[msg("Required resting tail order account was not supplied")]
    MissingTailOrder,
    #[msg("A linked prev/next order account is missing")]
    MissingLinkedOrderAccount,
    #[msg("Remaining account verification failed")]
    InvalidRemainingAccount,
    #[msg("Order does not require continuation")]
    OrderNotContinuable,
    #[msg("No order remainder is left to continue")]
    NothingToContinue,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("No resolved execution fees remain to withdraw")]
    NothingToWithdraw,
    #[msg("Execution-fee escrow accounting is inconsistent")]
    FeeEscrowInvariantViolation,
    #[msg("Config is already initialized")]
    AlreadyInitialized,
    #[msg("Order placement is paused")]
    OrderPlacementPaused,
    #[msg("Market creation is paused")]
    MarketCreationPaused,
    #[msg("Config is permanently frozen")]
    ConfigFrozen,
    #[msg("Market is still open")]
    MarketStillOpen,
    #[msg("Nothing to reclaim")]
    NothingToReclaim,
    #[msg("The resolved market has no canonical winner")]
    MarketHasNoWinner,
    #[msg("A balance with a winning entitlement cannot be closed as a loss")]
    WinningBalanceCannotBeClosed,
    #[msg("Nothing remains in the losing balance to close")]
    NothingToClose,
    #[msg("The supplied user balance is not canonical")]
    InvalidUserBalance,
    #[msg("User balance still contains shares, collateral, or fee custody")]
    UserBalanceNotEmpty,
}

#[event]
pub struct MarketCreated {
    pub duel_key: [u8; 32],
    pub market_key: Pubkey,
    pub market_kind: u8,
}

#[event]
pub struct MarketSynced {
    pub duel_key: [u8; 32],
    pub market_key: Pubkey,
    pub status: MarketStatus,
    pub winner: MarketSide,
}

#[event]
pub struct OrderPlaced {
    pub market_key: Pubkey,
    pub order_id: u64,
    pub maker: Pubkey,
    pub side: u8,
    pub price: u16,
    pub amount: u64,
}

#[event]
pub struct OrderMatched {
    pub market_key: Pubkey,
    pub maker_order_id: u64,
    pub taker_order_id: u64,
    pub matched_amount: u64,
    pub price: u16,
}

#[event]
pub struct TradeFeesEscrowed {
    pub market_key: Pubkey,
    pub order_id: u64,
    pub payer: Pubkey,
    pub executed_cost_lamports: u64,
    pub treasury_fee_lamports: u64,
    pub market_maker_fee_lamports: u64,
}

#[event]
pub struct SelfTradePolicyTriggered {
    pub market_ref: Pubkey,
    pub maker_authority: Pubkey,
    pub taker_authority: Pubkey,
    pub maker_order_id: u64,
    pub taker_order_id: u64,
}

#[event]
pub struct OrderCancelled {
    pub market_key: Pubkey,
    pub order_id: u64,
}

#[event]
pub struct FilledOrderClosed {
    pub market_key: Pubkey,
    pub order_id: u64,
    pub maker: Pubkey,
}

#[event]
pub struct EmptyUserBalanceClosed {
    pub market_key: Pubkey,
    pub user: Pubkey,
}

#[event]
pub struct PriceLevelClosed {
    pub market_key: Pubkey,
    pub side: u8,
    pub price: u16,
    pub rent_recipient: Pubkey,
    pub closer: Pubkey,
}

#[event]
pub struct RestingOrderReclaimed {
    pub market_key: Pubkey,
    pub order_id: u64,
}

#[event]
pub struct LosingBalanceClosed {
    pub market_key: Pubkey,
    pub user: Pubkey,
    pub a_shares: u64,
    pub b_shares: u64,
    pub a_locked_lamports: u64,
    pub b_locked_lamports: u64,
}

#[event]
pub struct ClaimSettled {
    pub market_key: Pubkey,
    pub user: Pubkey,
    pub status: MarketStatus,
    pub winner: MarketSide,
    pub payout_lamports: u64,
    pub winnings_fee_lamports: u64,
    pub refunded_trade_treasury_fee_lamports: u64,
    pub refunded_trade_market_maker_fee_lamports: u64,
}

#[event]
pub struct ResolvedTradeFeesWithdrawn {
    pub market_key: Pubkey,
    pub treasury: Pubkey,
    pub market_maker: Pubkey,
    pub treasury_fee_lamports: u64,
    pub market_maker_fee_lamports: u64,
    pub submitter: Pubkey,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_account_instructions_reject_every_remaining_account() {
        assert!(validate_fixed_account_cardinality(0).is_ok());
        for remaining_account_count in [1, 2, 16, usize::MAX] {
            assert!(validate_fixed_account_cardinality(remaining_account_count).is_err());
        }
    }

    fn linked_order_fixture(
        market_state: Pubkey,
        id: u64,
        prev_order_id: u64,
        next_order_id: u64,
    ) -> Order {
        Order {
            market_state,
            id,
            side: SIDE_ASK,
            price: 600,
            order_behavior: ORDER_BEHAVIOR_GTC,
            maker: Pubkey::new_unique(),
            amount: 1_000,
            filled: 0,
            prev_order_id,
            next_order_id,
            active: true,
            continuation_pending: false,
            bump: 1,
        }
    }

    fn price_level_fixture(market_state: Pubkey) -> PriceLevel {
        PriceLevel {
            market_state,
            rent_recipient: Pubkey::new_unique(),
            side: SIDE_ASK,
            price: 600,
            head_order_id: 1,
            tail_order_id: 3,
            total_open: 3_000,
            bump: 1,
        }
    }

    fn serialized_price_level(level: &PriceLevel) -> Vec<u8> {
        let mut data = vec![0_u8; 8 + PriceLevel::INIT_SPACE];
        level.try_serialize(&mut &mut data[..]).unwrap();
        data
    }

    fn empty_uninitialized_price_level() -> PriceLevel {
        PriceLevel {
            market_state: Pubkey::default(),
            rent_recipient: Pubkey::default(),
            side: 0,
            price: 0,
            head_order_id: 0,
            tail_order_id: 0,
            total_open: 0,
            bump: 0,
        }
    }

    fn empty_uninitialized_user_balance() -> UserBalance {
        UserBalance {
            user: Pubkey::default(),
            market_state: Pubkey::default(),
            a_shares: 0,
            b_shares: 0,
            a_locked_lamports: 0,
            b_locked_lamports: 0,
            trade_treasury_fee_lamports: 0,
            trade_market_maker_fee_lamports: 0,
        }
    }

    fn empty_uninitialized_market_config() -> MarketConfig {
        MarketConfig {
            authority: Pubkey::default(),
            market_operator: Pubkey::default(),
            treasury: Pubkey::default(),
            market_maker: Pubkey::default(),
            trade_treasury_fee_bps: 0,
            trade_market_maker_fee_bps: 0,
            winnings_market_maker_fee_bps: 0,
            order_placement_paused: false,
            market_creation_paused: false,
            config_frozen: false,
            bump: 0,
        }
    }

    #[test]
    fn market_config_initialization_rejects_every_partial_field() {
        assert!(validate_uninitialized_market_config(&empty_uninitialized_market_config()).is_ok());
        let mutations: &[fn(&mut MarketConfig)] = &[
            |value| value.authority = Pubkey::new_unique(),
            |value| value.market_operator = Pubkey::new_unique(),
            |value| value.treasury = Pubkey::new_unique(),
            |value| value.market_maker = Pubkey::new_unique(),
            |value| value.trade_treasury_fee_bps = 1,
            |value| value.trade_market_maker_fee_bps = 1,
            |value| value.winnings_market_maker_fee_bps = 1,
            |value| value.order_placement_paused = true,
            |value| value.market_creation_paused = true,
            |value| value.config_frozen = true,
            |value| value.bump = 1,
        ];
        for mutate in mutations {
            let mut partial = empty_uninitialized_market_config();
            mutate(&mut partial);
            assert!(validate_uninitialized_market_config(&partial).is_err());
        }
    }

    #[test]
    fn price_level_initialization_rejects_partial_identity_or_book_state() {
        let market_state = Pubkey::new_unique();
        let payer = Pubkey::new_unique();
        let mut exact = empty_uninitialized_price_level();
        prepare_resting_level(&mut exact, market_state, SIDE_BID, 500, payer, 7).unwrap();
        assert_eq!(exact.market_state, market_state);
        assert_eq!(exact.rent_recipient, payer);
        assert_eq!(exact.side, SIDE_BID);
        assert_eq!(exact.price, 500);
        assert_eq!(exact.bump, 7);
        assert_eq!(
            validate_match_level_state(&exact).unwrap(),
            MatchLevelState::Empty
        );

        let price_level_corruptions: [fn(&mut PriceLevel); 7] = [
            |level: &mut PriceLevel| level.rent_recipient = Pubkey::new_unique(),
            |level: &mut PriceLevel| level.side = SIDE_ASK,
            |level: &mut PriceLevel| level.price = 500,
            |level: &mut PriceLevel| level.head_order_id = 1,
            |level: &mut PriceLevel| level.tail_order_id = 1,
            |level: &mut PriceLevel| level.total_open = 1_000,
            |level: &mut PriceLevel| level.bump = 1,
        ];
        for corrupt in price_level_corruptions {
            let mut partial = empty_uninitialized_price_level();
            corrupt(&mut partial);
            assert!(
                prepare_resting_level(&mut partial, market_state, SIDE_BID, 500, payer, 7,)
                    .is_err(),
                "partially initialized price-level state was accepted"
            );
        }

        let mut existing = price_level_fixture(market_state);
        let original_recipient = existing.rent_recipient;
        prepare_resting_level(&mut existing, market_state, SIDE_ASK, 600, payer, 1).unwrap();
        assert_eq!(existing.rent_recipient, original_recipient);
        assert!(
            prepare_resting_level(&mut existing, market_state, SIDE_ASK, 600, payer, 2,).is_err(),
            "an existing price level accepted a noncanonical bump"
        );
    }

    #[test]
    fn user_balance_initialization_rejects_partial_identity_or_custody() {
        let market_state = Pubkey::new_unique();
        let user = Pubkey::new_unique();
        let mut exact = empty_uninitialized_user_balance();
        prepare_user_balance(&mut exact, market_state, user).unwrap();
        assert_eq!(exact.user, user);
        assert_eq!(exact.market_state, market_state);

        exact.a_shares = 1_000;
        prepare_user_balance(&mut exact, market_state, user).unwrap();
        assert_eq!(exact.a_shares, 1_000, "existing custody was reset");
        assert!(prepare_user_balance(&mut exact, market_state, Pubkey::new_unique()).is_err());
        assert!(prepare_user_balance(&mut exact, Pubkey::new_unique(), user).is_err());

        let user_balance_corruptions: [fn(&mut UserBalance); 8] = [
            |balance: &mut UserBalance| balance.a_shares = 1,
            |balance: &mut UserBalance| balance.b_shares = 1,
            |balance: &mut UserBalance| balance.a_locked_lamports = 1,
            |balance: &mut UserBalance| balance.b_locked_lamports = 1,
            |balance: &mut UserBalance| balance.trade_treasury_fee_lamports = 1,
            |balance: &mut UserBalance| balance.trade_market_maker_fee_lamports = 1,
            |balance: &mut UserBalance| balance.user = Pubkey::new_unique(),
            |balance: &mut UserBalance| balance.market_state = Pubkey::new_unique(),
        ];
        for corrupt in user_balance_corruptions {
            let mut partial = empty_uninitialized_user_balance();
            corrupt(&mut partial);
            assert!(
                prepare_user_balance(&mut partial, market_state, user).is_err(),
                "partially initialized user-balance state was accepted"
            );
        }
    }

    #[test]
    fn terminal_identity_and_fee_recipient_boundaries_fail_closed() {
        let market_state = Pubkey::new_unique();
        let user = Pubkey::new_unique();
        let vault = Pubkey::new_unique();
        let recipient = Pubkey::new_unique();
        let balance = UserBalance {
            user,
            market_state,
            a_shares: 1_000,
            b_shares: 0,
            a_locked_lamports: 600,
            b_locked_lamports: 0,
            trade_treasury_fee_lamports: 1,
            trade_market_maker_fee_lamports: 1,
        };
        assert!(validate_user_balance_identity(&balance, market_state, user).is_ok());
        assert!(
            validate_user_balance_identity(&balance, market_state, Pubkey::new_unique()).is_err()
        );
        assert!(validate_user_balance_identity(&balance, Pubkey::new_unique(), user).is_err());
        assert!(validate_fee_recipient_not_vault(vault, recipient).is_ok());
        assert!(validate_fee_recipient_not_vault(vault, vault).is_err());
        assert!(validate_fee_recipient_not_vault(vault, Pubkey::default()).is_err());
    }

    #[test]
    fn duel_sync_requires_exact_identity_and_canonical_terminal_winner() {
        let duel_key = [19_u8; 32];
        let (duel_pubkey, duel_bump) = Pubkey::find_program_address(
            &[fight_oracle::DUEL_SEED, duel_key.as_ref()],
            &fight_oracle::ID,
        );
        for status in [
            OracleDuelStatus::Scheduled,
            OracleDuelStatus::BettingOpen,
            OracleDuelStatus::Locked,
            OracleDuelStatus::Proposed,
            OracleDuelStatus::Challenged,
            OracleDuelStatus::Cancelled,
        ] {
            assert!(
                validate_duel_sync_identity(
                    duel_pubkey,
                    duel_key,
                    duel_pubkey,
                    duel_key,
                    duel_bump,
                    fight_oracle::ACCOUNT_SCHEMA_VERSION,
                    status,
                    MarketSide::None,
                )
                .is_ok(),
                "canonical nonresolved status was rejected"
            );
            for invalid_winner in [MarketSide::A, MarketSide::B] {
                assert!(
                    validate_duel_sync_identity(
                        duel_pubkey,
                        duel_key,
                        duel_pubkey,
                        duel_key,
                        duel_bump,
                        fight_oracle::ACCOUNT_SCHEMA_VERSION,
                        status,
                        invalid_winner,
                    )
                    .is_err(),
                    "nonresolved status accepted a winner"
                );
            }
        }
        for winner in [MarketSide::A, MarketSide::B] {
            assert!(validate_duel_sync_identity(
                duel_pubkey,
                duel_key,
                duel_pubkey,
                duel_key,
                duel_bump,
                fight_oracle::ACCOUNT_SCHEMA_VERSION,
                OracleDuelStatus::Resolved,
                winner,
            )
            .is_ok(),);
        }
        assert!(validate_duel_sync_identity(
            duel_pubkey,
            duel_key,
            duel_pubkey,
            duel_key,
            duel_bump,
            fight_oracle::ACCOUNT_SCHEMA_VERSION,
            OracleDuelStatus::Resolved,
            MarketSide::None,
        )
        .is_err());
        assert!(validate_duel_sync_identity(
            duel_pubkey,
            duel_key,
            Pubkey::new_unique(),
            duel_key,
            duel_bump,
            fight_oracle::ACCOUNT_SCHEMA_VERSION,
            OracleDuelStatus::Resolved,
            MarketSide::A,
        )
        .is_err());
        assert!(validate_duel_sync_identity(
            duel_pubkey,
            duel_key,
            duel_pubkey,
            [20_u8; 32],
            duel_bump,
            fight_oracle::ACCOUNT_SCHEMA_VERSION,
            OracleDuelStatus::Resolved,
            MarketSide::A,
        )
        .is_err());
        assert!(validate_duel_sync_identity(
            duel_pubkey,
            duel_key,
            duel_pubkey,
            duel_key,
            duel_bump.wrapping_add(1),
            fight_oracle::ACCOUNT_SCHEMA_VERSION,
            OracleDuelStatus::Resolved,
            MarketSide::A,
        )
        .is_err());
        assert!(validate_duel_sync_identity(
            duel_pubkey,
            duel_key,
            duel_pubkey,
            duel_key,
            duel_bump,
            fight_oracle::ACCOUNT_SCHEMA_VERSION + 1,
            OracleDuelStatus::Resolved,
            MarketSide::A,
        )
        .is_err());
    }

    #[test]
    fn optional_pending_price_level_absence_never_requires_rent() {
        let market_state = Pubkey::new_unique();
        let level_key = Pubkey::new_unique();
        let mut level_lamports = 0_u64;
        let mut level_data = [];
        let system_owner = system_program::ID;
        let level_info = AccountInfo::new(
            &level_key,
            false,
            true,
            &mut level_lamports,
            &mut level_data,
            &system_owner,
            false,
            0,
        );
        let user_key = Pubkey::new_unique();
        let mut user_lamports = 10_u64;
        let mut user_data = [];
        let user_info = AccountInfo::new(
            &user_key,
            true,
            true,
            &mut user_lamports,
            &mut user_data,
            &system_owner,
            false,
            0,
        );

        assert!(!close_pending_price_level_if_present(
            &level_info,
            &user_info,
            market_state,
            SIDE_BID,
            500,
            7,
        )
        .unwrap());
        assert_eq!(level_info.lamports(), 0);
        assert_eq!(user_info.lamports(), 10);
        assert!(level_info.data_is_empty());
        assert_eq!(level_info.owner, &system_program::ID);
    }

    #[test]
    fn optional_price_level_manual_persistence_and_close_conserve_lamports() {
        let market_state = Pubkey::new_unique();
        let user_key = Pubkey::new_unique();
        let level_key = Pubkey::new_unique();
        let mut level = price_level_fixture(market_state);
        level.rent_recipient = user_key;
        level.bump = 7;
        let mut level_data = serialized_price_level(&level);
        let mut level_lamports = 123_u64;
        let program_owner = crate::ID;
        let level_info = AccountInfo::new(
            &level_key,
            false,
            true,
            &mut level_lamports,
            &mut level_data,
            &program_owner,
            false,
            0,
        );
        let mut user_lamports = 10_u64;
        let mut user_data = [];
        let system_owner = system_program::ID;
        let user_info = AccountInfo::new(
            &user_key,
            true,
            true,
            &mut user_lamports,
            &mut user_data,
            &system_owner,
            false,
            0,
        );

        assert!(
            load_existing_price_level(&level_info, market_state, SIDE_ASK, 600, 6).is_err(),
            "a stored PriceLevel bump must match its canonical PDA bump"
        );
        let mut loaded =
            load_existing_price_level(&level_info, market_state, SIDE_ASK, 600, 7).unwrap();
        loaded.total_open = 2_000;
        persist_price_level(&level_info, &loaded).unwrap();
        assert_eq!(
            load_existing_price_level(&level_info, market_state, SIDE_ASK, 600, 7)
                .unwrap()
                .total_open,
            2_000
        );
        assert_eq!(level_info.lamports(), 123);
        assert_eq!(user_info.lamports(), 10);

        let other_user_key = Pubkey::new_unique();
        let mut other_user_lamports = 20_u64;
        let mut other_user_data = [];
        let other_user_info = AccountInfo::new(
            &other_user_key,
            true,
            true,
            &mut other_user_lamports,
            &mut other_user_data,
            &system_owner,
            false,
            0,
        );

        loaded.head_order_id = 0;
        loaded.tail_order_id = 0;
        loaded.total_open = 0;
        persist_price_level(&level_info, &loaded).unwrap();
        assert!(!close_pending_price_level_if_present(
            &level_info,
            &other_user_info,
            market_state,
            SIDE_ASK,
            600,
            7,
        )
        .unwrap());
        assert_eq!(level_info.lamports(), 123);
        assert_eq!(user_info.lamports(), 10);
        assert_eq!(other_user_info.lamports(), 20);
        assert!(should_close_price_level(
            &load_existing_price_level(&level_info, market_state, SIDE_ASK, 600, 7).unwrap()
        ));
        assert_eq!(level_info.owner, &crate::ID);

        let conserved_lamports = level_info.lamports() + user_info.lamports();
        assert!(close_pending_price_level_if_present(
            &level_info,
            &user_info,
            market_state,
            SIDE_ASK,
            600,
            7,
        )
        .unwrap());
        assert_eq!(
            level_info.lamports() + user_info.lamports(),
            conserved_lamports
        );
        assert_eq!(level_info.lamports(), 0);
        assert_eq!(user_info.lamports(), 133);
        assert!(level_info.data_is_empty());
        assert_eq!(level_info.owner, &system_program::ID);
    }

    fn user_balance_fixture(market_state: Pubkey) -> UserBalance {
        UserBalance {
            user: Pubkey::new_unique(),
            market_state,
            a_shares: 0,
            b_shares: 0,
            a_locked_lamports: 0,
            b_locked_lamports: 0,
            trade_treasury_fee_lamports: 0,
            trade_market_maker_fee_lamports: 0,
        }
    }

    fn market_state_fixture() -> MarketState {
        MarketState {
            duel_state: Pubkey::new_unique(),
            duel_key: [7; 32],
            market_kind: MARKET_KIND_DUEL_WINNER,
            status: MarketStatus::Open,
            winner: MarketSide::None,
            trade_treasury_fee_bps_snapshot: 0,
            trade_market_maker_fee_bps_snapshot: 0,
            winnings_market_maker_fee_bps_snapshot: 0,
            next_order_id: 1,
            best_bid: 0,
            best_ask: 1_000,
            authority: Pubkey::new_unique(),
            treasury: Pubkey::new_unique(),
            market_maker: Pubkey::new_unique(),
            accrued_trade_treasury_fee_lamports: 0,
            accrued_trade_market_maker_fee_lamports: 0,
            bid_bitmap: [0; BITMAP_WORDS],
            ask_bitmap: [0; BITMAP_WORDS],
            vault_bump: 1,
            bump: 1,
        }
    }

    #[test]
    fn fee_config_accepts_every_exact_combined_trade_fee_boundary_split() {
        for treasury_fee_bps in 0_u16..=10_000 {
            let market_maker_fee_bps = 10_000_u16 - treasury_fee_bps;
            assert!(
                validate_fee_config(treasury_fee_bps, market_maker_fee_bps, 10_000).is_ok(),
                "exact cap split {treasury_fee_bps}/{market_maker_fee_bps} was rejected"
            );
        }
    }

    #[test]
    fn fee_config_rejects_every_one_bps_over_combined_trade_fee_split() {
        for treasury_fee_bps in 1_u16..=10_000 {
            let market_maker_fee_bps = 10_001_u16 - treasury_fee_bps;
            assert!(
                validate_fee_config(treasury_fee_bps, market_maker_fee_bps, 0).is_err(),
                "over-cap split {treasury_fee_bps}/{market_maker_fee_bps} was accepted"
            );
        }
    }

    #[test]
    fn fee_config_rejects_u16_overflow_vectors_and_excess_winnings_fee() {
        for (treasury_fee_bps, market_maker_fee_bps) in [
            (u16::MAX, 1),
            (u16::MAX, u16::MAX),
            (60_000, 10_000),
            (32_768, 32_768),
        ] {
            assert!(
                validate_fee_config(treasury_fee_bps, market_maker_fee_bps, 0).is_err(),
                "overflow vector {treasury_fee_bps}/{market_maker_fee_bps} was accepted"
            );
        }
        assert!(validate_fee_config(0, 0, 10_001).is_err());
        assert!(validate_fee_config(0, 0, u16::MAX).is_err());
    }

    #[test]
    fn quote_cost_conserves_collateral_across_the_full_price_grid() {
        for price in 1_u16..1_000 {
            let mut previous_bid_cost = 0_u64;

            for lots in 1_u64..=256 {
                let amount = lots.checked_mul(1_000).expect("bounded lot fixture");
                let bid_cost = quote_cost(SIDE_BID, price, amount)
                    .expect("valid bid quote across the launch price grid");
                let ask_cost = quote_cost(SIDE_ASK, price, amount)
                    .expect("valid ask quote across the launch price grid");
                let complementary_ask = quote_cost(SIDE_ASK, 1_000 - price, amount)
                    .expect("valid complementary ask quote");

                assert_eq!(
                    bid_cost.checked_add(ask_cost),
                    Some(amount),
                    "collateral did not conserve at price {price} for {lots} lots"
                );
                assert_eq!(
                    bid_cost, complementary_ask,
                    "bid/ask complement diverged at price {price} for {lots} lots"
                );
                assert!(
                    bid_cost > previous_bid_cost,
                    "bid cost was not strictly monotonic at price {price} for {lots} lots"
                );
                previous_bid_cost = bid_cost;
            }
        }
    }

    #[test]
    fn match_outcome_conserves_taker_collateral_across_full_price_grid() {
        let mut verified = 0_u64;
        for side in [SIDE_BID, SIDE_ASK] {
            for limit_price in 1_u16..1_000 {
                let execution_prices: Box<dyn Iterator<Item = u16>> = if side == SIDE_BID {
                    Box::new(1_u16..=limit_price)
                } else {
                    Box::new(limit_price..1_000)
                };
                for execution_price in execution_prices {
                    let total_improvement = if side == SIDE_BID {
                        u64::from(limit_price - execution_price)
                    } else {
                        u64::from(execution_price - limit_price)
                    };
                    let outcome = MatchOutcome {
                        remaining_amount: 1_000,
                        executed_cost: quote_cost(side, execution_price, 1_000).unwrap(),
                        total_improvement,
                        account_idx: 0,
                        stop_reason: MatchStopReason::NonCrossing,
                        self_trade_prevented: false,
                    };
                    assert!(
                        validate_match_outcome_conservation(
                            side,
                            limit_price,
                            2_000,
                            &outcome,
                        )
                        .is_ok(),
                        "collateral failed for side={side} limit={limit_price} execution={execution_price}",
                    );
                    verified += 1;
                }
            }
        }
        assert_eq!(verified, 999_000);

        for (side, limit_price, execution_price) in [(SIDE_BID, 600, 400), (SIDE_ASK, 400, 600)] {
            let outcome = MatchOutcome {
                remaining_amount: 0,
                executed_cost: quote_cost(side, execution_price, 1_000).unwrap(),
                total_improvement: 200,
                account_idx: 0,
                stop_reason: MatchStopReason::Filled,
                self_trade_prevented: false,
            };
            assert!(
                validate_match_outcome_conservation(side, limit_price, 1_000, &outcome).is_ok()
            );
        }
        let unmatched = MatchOutcome {
            remaining_amount: 1_000,
            executed_cost: 0,
            total_improvement: 0,
            account_idx: 0,
            stop_reason: MatchStopReason::NonCrossing,
            self_trade_prevented: false,
        };
        assert!(validate_match_outcome_conservation(SIDE_BID, 600, 1_000, &unmatched).is_ok());
    }

    #[test]
    fn match_outcome_rejects_every_collateral_or_stop_state_mutation() {
        let canonical = MatchOutcome {
            remaining_amount: 1_000,
            executed_cost: 400,
            total_improvement: 200,
            account_idx: 3,
            stop_reason: MatchStopReason::NonCrossing,
            self_trade_prevented: false,
        };
        assert!(validate_match_outcome_conservation(SIDE_BID, 600, 2_000, &canonical).is_ok());

        for invalid in [
            MatchOutcome {
                executed_cost: 399,
                ..canonical
            },
            MatchOutcome {
                executed_cost: 401,
                ..canonical
            },
            MatchOutcome {
                total_improvement: 199,
                ..canonical
            },
            MatchOutcome {
                total_improvement: 201,
                ..canonical
            },
            MatchOutcome {
                remaining_amount: 1_500,
                ..canonical
            },
            MatchOutcome {
                remaining_amount: 3_000,
                ..canonical
            },
            MatchOutcome {
                stop_reason: MatchStopReason::Filled,
                ..canonical
            },
            MatchOutcome {
                self_trade_prevented: true,
                ..canonical
            },
            MatchOutcome {
                stop_reason: MatchStopReason::SelfTradePrevented,
                ..canonical
            },
        ] {
            assert!(
                validate_match_outcome_conservation(SIDE_BID, 600, 2_000, &invalid).is_err(),
                "mutated collateral/stop state was accepted",
            );
        }
    }

    #[test]
    fn quote_cost_rejects_zero_cost_and_precision_boundaries() {
        assert!(quote_cost(SIDE_BID, 1, 0).is_err());
        assert!(quote_cost(SIDE_ASK, 999, 0).is_err());
        assert!(quote_cost(SIDE_BID, 1, 1).is_err());
        assert!(quote_cost(SIDE_ASK, 998, 1).is_err());
    }

    #[test]
    fn quote_cost_conserves_the_largest_valid_u64_lot() {
        let amount = u64::MAX - (u64::MAX % 1_000);

        for price in [1_u16, 2, 499, 500, 998, 999] {
            let bid_cost = quote_cost(SIDE_BID, price, amount)
                .expect("valid bid quote must not fail on an intermediate product");
            let ask_cost = quote_cost(SIDE_ASK, price, amount)
                .expect("valid ask quote must not fail on an intermediate product");
            let expected_bid = (u128::from(amount) * u128::from(price) / 1_000) as u64;

            assert_eq!(bid_cost, expected_bid);
            assert_eq!(bid_cost.checked_add(ask_cost), Some(amount));
        }
    }

    #[test]
    fn bps_fee_matches_floor_math_and_conserves_every_safe_payout() {
        let safe_amounts = [
            0_u64,
            1,
            999,
            1_000,
            1_001,
            10_000,
            999_999,
            1_000_000,
            u64::MAX / 10_000,
        ];

        for amount in safe_amounts {
            let mut previous_fee = 0_u64;

            for fee_bps in 0_u16..=10_000 {
                let fee = bps_fee(amount, fee_bps)
                    .expect("bounded fee fixture must not overflow program arithmetic");
                let expected_fee = amount
                    .checked_mul(u64::from(fee_bps))
                    .expect("safe amount keeps multiplication in u64")
                    / 10_000;
                let payout = amount
                    .checked_sub(fee)
                    .expect("an approved-bps fee cannot exceed the entitlement");

                assert_eq!(
                    fee, expected_fee,
                    "fee floor diverged for amount {amount} at {fee_bps} bps"
                );
                assert!(
                    fee >= previous_fee,
                    "fee was not monotonic for amount {amount} at {fee_bps} bps"
                );
                assert_eq!(
                    fee.checked_add(payout),
                    Some(amount),
                    "fee plus payout did not conserve amount {amount} at {fee_bps} bps"
                );
                previous_fee = fee;
            }
        }
    }

    #[test]
    fn bps_fee_supports_the_full_u64_amount_domain() {
        for amount in [u64::MAX, u64::MAX - 1, u64::MAX / 2, 1] {
            for fee_bps in [0_u16, 1, 2, 5_000, 9_999, 10_000] {
                let fee = bps_fee(amount, fee_bps)
                    .expect("approved fee math must not fail on an intermediate product");
                let expected = (u128::from(amount) * u128::from(fee_bps) / 10_000) as u64;
                assert_eq!(fee, expected, "amount={amount}, fee_bps={fee_bps}");
                assert!(fee <= amount);
            }
        }

        assert!(bps_fee(u64::MAX, 10_001).is_err());
        assert!(bps_fee(u64::MAX, u16::MAX).is_err());
    }

    #[test]
    fn mul_div_floor_supports_full_width_price_improvement_math() {
        let amount = u64::MAX - (u64::MAX % 1_000);
        for improvement in [1_u64, 2, 499, 500, 998, 999] {
            let value = mul_div_floor(amount, improvement, 1_000)
                .expect("bounded price improvement must not overflow before division");
            let expected = (u128::from(amount) * u128::from(improvement) / 1_000) as u64;
            assert_eq!(value, expected);
        }
    }

    #[test]
    fn price_bitmap_round_trips_every_valid_price_on_both_sides() {
        for price in 1_u16..1_000 {
            let mut market_state = market_state_fixture();

            set_price_bit(&mut market_state, SIDE_BID, price, true);
            update_best_prices(&mut market_state);
            assert_eq!(market_state.best_bid, price, "bid price {price}");
            assert_eq!(market_state.best_ask, 1_000, "ask sentinel {price}");

            set_price_bit(&mut market_state, SIDE_ASK, price, true);
            update_best_prices(&mut market_state);
            assert_eq!(market_state.best_bid, price, "paired bid {price}");
            assert_eq!(market_state.best_ask, price, "paired ask {price}");

            set_price_bit(&mut market_state, SIDE_BID, price, false);
            update_best_prices(&mut market_state);
            assert_eq!(market_state.best_bid, 0, "cleared bid {price}");
            assert_eq!(market_state.best_ask, price, "retained ask {price}");

            set_price_bit(&mut market_state, SIDE_ASK, price, false);
            update_best_prices(&mut market_state);
            assert_eq!(market_state.best_bid, 0, "final bid sentinel {price}");
            assert_eq!(market_state.best_ask, 1_000, "final ask sentinel {price}");
        }
    }

    #[test]
    fn price_bitmap_generated_mutations_match_independent_boundaries() {
        use std::collections::BTreeSet;

        for seed in 1_u64..=32 {
            let mut random_state = seed ^ 0x4859_5045_534f_4c31;
            let mut market_state = market_state_fixture();
            let mut bids = BTreeSet::new();
            let mut asks = BTreeSet::new();

            for step in 0_u64..2_048 {
                random_state ^= random_state << 13;
                random_state ^= random_state >> 7;
                random_state ^= random_state << 17;
                let price = ((random_state % 999) + 1) as u16;
                let side = if random_state & 1 == 0 {
                    SIDE_BID
                } else {
                    SIDE_ASK
                };
                let active = random_state & 2 == 0;
                let reference = if side == SIDE_BID {
                    &mut bids
                } else {
                    &mut asks
                };
                if active {
                    reference.insert(price);
                } else {
                    reference.remove(&price);
                }

                set_price_bit(&mut market_state, side, price, active);
                update_best_prices(&mut market_state);

                assert_eq!(
                    market_state.best_bid,
                    bids.last().copied().unwrap_or(0),
                    "bid boundary drift at seed {seed} step {step}",
                );
                assert_eq!(
                    market_state.best_ask,
                    asks.first().copied().unwrap_or(1_000),
                    "ask boundary drift at seed {seed} step {step}",
                );
            }
        }
    }

    #[test]
    fn crossing_predicate_matches_the_full_valid_price_grid() {
        for limit_price in 1_u16..1_000 {
            assert!(!price_crosses_limit(SIDE_BID, limit_price, 1_000));
            assert!(!price_crosses_limit(SIDE_ASK, limit_price, 0));

            for boundary in 1_u16..1_000 {
                assert_eq!(
                    price_crosses_limit(SIDE_BID, limit_price, boundary),
                    boundary <= limit_price,
                    "bid limit {limit_price} boundary {boundary}",
                );
                assert_eq!(
                    price_crosses_limit(SIDE_ASK, limit_price, boundary),
                    boundary >= limit_price,
                    "ask limit {limit_price} boundary {boundary}",
                );
            }
        }
    }

    #[test]
    fn empty_user_balance_cleanup_rejects_every_single_custody_field() {
        let market_state = Pubkey::new_unique();
        let empty = user_balance_fixture(market_state);
        assert!(validate_empty_user_balance(&empty).is_ok());

        for field in 0_u8..6 {
            let mut occupied = user_balance_fixture(market_state);
            match field {
                0 => occupied.a_shares = 1,
                1 => occupied.b_shares = 1,
                2 => occupied.a_locked_lamports = 1,
                3 => occupied.b_locked_lamports = 1,
                4 => occupied.trade_treasury_fee_lamports = 1,
                5 => occupied.trade_market_maker_fee_lamports = 1,
                _ => unreachable!(),
            }
            assert!(
                validate_empty_user_balance(&occupied).is_err(),
                "custody field {field} was discarded by empty-balance cleanup"
            );
        }
    }

    #[test]
    fn match_level_state_accepts_only_exact_empty_or_exact_active_shapes() {
        let market_state = Pubkey::new_unique();
        for mask in 0_u8..8 {
            let mut level = price_level_fixture(market_state);
            level.total_open = if mask & 1 == 0 { 0 } else { 1_000 };
            level.head_order_id = if mask & 2 == 0 { 0 } else { 10 };
            level.tail_order_id = if mask & 4 == 0 { 0 } else { 10 };

            let result = validate_match_level_state(&level);
            match mask {
                0 => assert_eq!(result.unwrap(), MatchLevelState::Empty),
                7 => assert_eq!(result.unwrap(), MatchLevelState::Active),
                _ => assert!(
                    result.is_err(),
                    "partially empty match-level shape {mask:03b} was accepted",
                ),
            }
        }
    }

    #[test]
    fn match_head_requires_exact_single_or_multi_order_conservation() {
        let market_state = Pubkey::new_unique();
        let mut level = price_level_fixture(market_state);
        level.head_order_id = 42;
        level.tail_order_id = 42;
        level.total_open = 1_000;
        let mut single = linked_order_fixture(market_state, 42, 17, 0);
        single.amount = 2_000;
        single.filled = 1_000;
        assert_eq!(validate_match_head(&level, &single).unwrap(), 1_000);

        level.tail_order_id = 99;
        level.total_open = 2_000;
        let mut multiple = linked_order_fixture(market_state, 42, 17, 99);
        multiple.amount = 2_000;
        multiple.filled = 1_000;
        assert_eq!(validate_match_head(&level, &multiple).unwrap(), 1_000);
    }

    #[test]
    fn match_head_generated_mutations_reject_every_orphaning_shape() {
        const MUTATIONS_PER_HEAD: u64 = 16;
        let mut rejected = 0_u64;

        for selected_id in 2_u64..=257 {
            for mutation in 0_u64..MUTATIONS_PER_HEAD {
                let market_state = Pubkey::new_unique();
                let mut level = price_level_fixture(market_state);
                level.head_order_id = selected_id;
                level.tail_order_id = selected_id + 1;
                level.total_open = 2_000;
                let mut head = linked_order_fixture(
                    market_state,
                    selected_id,
                    selected_id - 1,
                    selected_id + 1,
                );

                match mutation {
                    0 => head.id = selected_id + 2,
                    1 => head.active = false,
                    2 => head.continuation_pending = true,
                    3 => head.market_state = Pubkey::new_unique(),
                    4 => head.side = SIDE_BID,
                    5 => head.price = 601,
                    6 => head.order_behavior = ORDER_BEHAVIOR_IOC,
                    7 => head.prev_order_id = selected_id,
                    8 => head.filled = head.amount,
                    9 => head.filled = head.amount + 1,
                    10 => head.next_order_id = 0,
                    11 => head.next_order_id = selected_id,
                    12 => level.total_open = head.amount - head.filled,
                    13 => level.tail_order_id = selected_id,
                    14 => {
                        level.tail_order_id = selected_id;
                        level.total_open = head.amount + 1;
                        head.next_order_id = 0;
                    }
                    15 => {
                        level.total_open = 0;
                        level.head_order_id = 0;
                        level.tail_order_id = 0;
                    }
                    _ => unreachable!(),
                }

                assert!(
                    validate_match_head(&level, &head).is_err(),
                    "orphaning match-head mutation {mutation} was accepted for {selected_id}",
                );
                rejected += 1;
            }
        }

        assert_eq!(rejected, 4_096);
    }

    #[test]
    fn match_balance_requires_the_exact_maker_pda_and_identity() {
        let market_state = Pubkey::new_unique();
        let order = linked_order_fixture(market_state, 1, 0, 0);
        let balance_key = derive_balance_key(&market_state, &order.maker);
        let mut balance = user_balance_fixture(market_state);
        balance.user = order.maker;

        assert!(validate_match_balance(market_state, &order, balance_key, &balance).is_ok());
        assert!(
            validate_match_balance(market_state, &order, Pubkey::new_unique(), &balance).is_err()
        );

        balance.user = Pubkey::new_unique();
        assert!(validate_match_balance(market_state, &order, balance_key, &balance).is_err());
        balance.user = order.maker;
        balance.market_state = Pubkey::new_unique();
        assert!(validate_match_balance(market_state, &order, balance_key, &balance).is_err());
    }

    #[test]
    fn unlink_conservation_accepts_only_exact_single_or_multi_remainders() {
        let market_state = Pubkey::new_unique();
        let mut level = price_level_fixture(market_state);
        level.head_order_id = 42;
        level.tail_order_id = 42;
        level.total_open = 1_000;
        let mut order = linked_order_fixture(market_state, 42, 0, 0);
        order.amount = 2_000;
        order.filled = 1_000;
        assert!(validate_unlink_conservation(&level, &order, 1_000).is_ok());

        level.tail_order_id = 99;
        level.total_open = 2_000;
        order.next_order_id = 99;
        assert!(validate_unlink_conservation(&level, &order, 1_000).is_ok());
    }

    #[test]
    fn unlink_conservation_generated_mutations_reject_every_orphaning_shape() {
        const MUTATIONS_PER_UNLINK: u64 = 12;
        let mut rejected = 0_u64;

        for selected_id in 2_u64..=257 {
            for mutation in 0_u64..MUTATIONS_PER_UNLINK {
                let market_state = Pubkey::new_unique();
                let mut level = price_level_fixture(market_state);
                level.head_order_id = selected_id;
                level.tail_order_id = selected_id + 1;
                level.total_open = 2_000;
                let mut order = linked_order_fixture(market_state, selected_id, 0, selected_id + 1);
                let mut remaining = 1_000;

                match mutation {
                    0 => remaining = 0,
                    1 => remaining = 999,
                    2 => order.filled = order.amount,
                    3 => order.filled = order.amount + 1,
                    4 => level.total_open = 0,
                    5 => level.head_order_id = 0,
                    6 => level.tail_order_id = 0,
                    7 => {
                        level.tail_order_id = selected_id;
                        level.total_open = 999;
                    }
                    8 => {
                        level.tail_order_id = selected_id;
                        level.total_open = 1_001;
                    }
                    9 => {
                        level.tail_order_id = selected_id;
                        level.total_open = 1_000;
                        order.id = selected_id + 1;
                    }
                    10 => level.total_open = 1_000,
                    11 => level.total_open = 999,
                    _ => unreachable!(),
                }

                assert!(
                    validate_unlink_conservation(&level, &order, remaining).is_err(),
                    "orphaning unlink mutation {mutation} was accepted for {selected_id}",
                );
                rejected += 1;
            }
        }

        assert_eq!(rejected, 3_072);
    }

    #[test]
    fn continuation_pending_orders_must_be_live_unlinked_gtc_remainders() {
        let market_state = Pubkey::new_unique();
        let mut valid = linked_order_fixture(market_state, 42, 0, 0);
        valid.continuation_pending = true;
        valid.amount = 1_000;
        valid.filled = 0;
        assert_eq!(
            validate_continuation_pending_order(&valid, market_state).unwrap(),
            1_000
        );

        for mutation in 0_u8..14 {
            let mut invalid = linked_order_fixture(market_state, 42, 0, 0);
            invalid.continuation_pending = true;
            match mutation {
                0 => invalid.active = false,
                1 => invalid.continuation_pending = false,
                2 => invalid.order_behavior = ORDER_BEHAVIOR_POST_ONLY,
                3 => invalid.prev_order_id = 1,
                4 => invalid.next_order_id = 2,
                5 => invalid.amount = 0,
                6 => invalid.amount = 1_001,
                7 => invalid.filled = 1,
                8 => invalid.id = 0,
                9 => invalid.market_state = Pubkey::new_unique(),
                10 => invalid.side = 0,
                11 => invalid.side = 3,
                12 => invalid.price = 0,
                13 => invalid.price = 1_000,
                _ => unreachable!(),
            }
            assert!(
                validate_continuation_pending_order(&invalid, market_state).is_err(),
                "invalid pending-order mutation {mutation} was accepted",
            );
        }
    }

    #[test]
    fn linked_orders_reject_nonresting_zero_remainder_or_self_links() {
        let market_state = Pubkey::new_unique();
        let level = price_level_fixture(market_state);
        let valid = linked_order_fixture(market_state, 2, 1, 3);
        assert!(validate_linked_order(&level, &valid).is_ok());

        for mutation in 0_u8..5 {
            let mut invalid = linked_order_fixture(market_state, 2, 1, 3);
            match mutation {
                0 => invalid.order_behavior = ORDER_BEHAVIOR_IOC,
                1 => invalid.filled = invalid.amount,
                2 => invalid.filled = invalid.amount + 1,
                3 => invalid.prev_order_id = invalid.id,
                4 => invalid.next_order_id = invalid.id,
                _ => unreachable!(),
            }
            assert!(
                validate_linked_order(&level, &invalid).is_err(),
                "invalid linked-order mutation {mutation} was accepted",
            );
        }
    }

    #[test]
    fn unlink_graph_accepts_reciprocal_head_middle_and_tail_links() {
        let market_state = Pubkey::new_unique();
        let level = price_level_fixture(market_state);
        let head = linked_order_fixture(market_state, 1, 0, 2);
        let middle = linked_order_fixture(market_state, 2, 1, 3);
        let tail = linked_order_fixture(market_state, 3, 2, 0);

        assert!(validate_unlink_graph(&level, &head, None, Some(&middle)).is_ok());
        assert!(validate_unlink_graph(&level, &middle, Some(&head), Some(&tail)).is_ok());
        assert!(validate_unlink_graph(&level, &tail, Some(&middle), None).is_ok());
    }

    #[test]
    fn unlink_graph_accepts_a_lazily_normalized_canonical_head() {
        let market_state = Pubkey::new_unique();
        let mut level = price_level_fixture(market_state);
        level.head_order_id = 2;
        level.tail_order_id = 3;
        level.total_open = 2_000;
        let new_head = linked_order_fixture(market_state, 2, 1, 3);
        let tail = linked_order_fixture(market_state, 3, 2, 0);

        assert!(validate_unlink_graph(&level, &new_head, None, Some(&tail)).is_ok());

        let mut invalid_head = linked_order_fixture(market_state, 2, 2, 3);
        assert!(validate_unlink_graph(&level, &invalid_head, None, Some(&tail)).is_err());
        invalid_head.prev_order_id = 4;
        assert!(validate_unlink_graph(&level, &invalid_head, None, Some(&tail)).is_ok());
    }

    #[test]
    fn last_canonical_head_unlink_discards_only_its_stale_predecessor() {
        assert_eq!(replacement_tail_after_unlink(true, 1), 0);
        assert_eq!(replacement_tail_after_unlink(true, u64::MAX), 0);
        assert_eq!(replacement_tail_after_unlink(false, 1), 1);
        assert_eq!(replacement_tail_after_unlink(false, u64::MAX), u64::MAX);
    }

    #[test]
    fn continued_order_can_append_and_unlink_after_newer_order_ids() {
        let market_state = Pubkey::new_unique();
        let mut level = price_level_fixture(market_state);
        level.head_order_id = 200;
        level.tail_order_id = 300;
        level.total_open = 2_000;

        let head = linked_order_fixture(market_state, 200, 0, 300);
        let mut previous_tail = linked_order_fixture(market_state, 300, 200, 0);
        let continued_order_id = 100;

        assert!(validate_append_tail(&level, Some(&previous_tail), continued_order_id).is_ok());

        previous_tail.next_order_id = continued_order_id;
        let continued = linked_order_fixture(market_state, continued_order_id, 300, 0);
        level.tail_order_id = continued_order_id;
        level.total_open = 3_000;

        assert!(
            validate_unlink_graph(&level, &previous_tail, Some(&head), Some(&continued)).is_ok()
        );
        assert!(validate_unlink_graph(&level, &continued, Some(&previous_tail), None).is_ok());

        level.head_order_id = continued_order_id;
        level.total_open = 1_000;
        assert!(validate_unlink_graph(&level, &continued, None, None).is_ok());
    }

    #[test]
    fn unlink_graph_accepts_generated_nonmonotonic_queue_ids() {
        for seed in 1_u64..=128 {
            let order_count = 2 + (seed as usize % 31);
            let mut ids = (1_u64..=order_count as u64).collect::<Vec<_>>();
            let mut random_state = seed ^ 0x4859_5045_5243_4c4f;
            for index in (1..ids.len()).rev() {
                random_state ^= random_state << 13;
                random_state ^= random_state >> 7;
                random_state ^= random_state << 17;
                ids.swap(index, random_state as usize % (index + 1));
            }

            let market_state = Pubkey::new_unique();
            let mut level = price_level_fixture(market_state);
            level.head_order_id = ids[0];
            level.tail_order_id = *ids.last().expect("generated queue has a tail");
            level.total_open = (order_count as u64) * 1_000;
            let orders = ids
                .iter()
                .enumerate()
                .map(|(index, id)| {
                    linked_order_fixture(
                        market_state,
                        *id,
                        index.checked_sub(1).map(|prev| ids[prev]).unwrap_or(0),
                        ids.get(index + 1).copied().unwrap_or(0),
                    )
                })
                .collect::<Vec<_>>();

            for (index, order) in orders.iter().enumerate() {
                assert!(
                    validate_unlink_graph(
                        &level,
                        order,
                        index.checked_sub(1).map(|prev| &orders[prev]),
                        orders.get(index + 1),
                    )
                    .is_ok(),
                    "valid shuffled queue rejected at seed {seed} index {index}",
                );
            }
        }
    }

    #[test]
    fn append_tail_rejects_inconsistent_or_cyclic_book_state() {
        let market_state = Pubkey::new_unique();
        let mut empty_level = price_level_fixture(market_state);
        empty_level.head_order_id = 0;
        empty_level.tail_order_id = 0;
        empty_level.total_open = 0;
        assert!(validate_append_tail(&empty_level, None, 10).is_ok());

        let unexpected_tail = linked_order_fixture(market_state, 9, 0, 0);
        assert!(validate_append_tail(&empty_level, Some(&unexpected_tail), 10).is_err());

        empty_level.head_order_id = 9;
        assert!(validate_append_tail(&empty_level, None, 10).is_err());

        let mut level = price_level_fixture(market_state);
        level.head_order_id = 8;
        level.tail_order_id = 9;
        level.total_open = 2_000;
        assert!(validate_append_tail(&level, None, 10).is_err());

        let valid_tail = linked_order_fixture(market_state, 9, 8, 0);
        assert!(validate_append_tail(&level, Some(&valid_tail), 10).is_ok());
        assert!(validate_append_tail(&level, Some(&valid_tail), 9).is_err());

        let mut invalid_tail = linked_order_fixture(market_state, 9, 8, 10);
        assert!(validate_append_tail(&level, Some(&invalid_tail), 10).is_err());
        invalid_tail.next_order_id = 0;
        invalid_tail.active = false;
        assert!(validate_append_tail(&level, Some(&invalid_tail), 10).is_err());
        invalid_tail.active = true;
        invalid_tail.continuation_pending = true;
        assert!(validate_append_tail(&level, Some(&invalid_tail), 10).is_err());
        invalid_tail.continuation_pending = false;
        invalid_tail.filled = invalid_tail.amount;
        assert!(validate_append_tail(&level, Some(&invalid_tail), 10).is_err());
        invalid_tail.filled = 0;
        invalid_tail.market_state = Pubkey::new_unique();
        assert!(validate_append_tail(&level, Some(&invalid_tail), 10).is_err());
    }

    #[test]
    fn unlink_graph_generated_single_mutation_matrix_rejects_every_fault() {
        const MUTATIONS_PER_GRAPH: u64 = 16;
        let mut rejected = 0_u64;

        for selected_id in 2_u64..=257 {
            for mutation in 0_u64..MUTATIONS_PER_GRAPH {
                let market_state = Pubkey::new_unique();
                let mut level = price_level_fixture(market_state);
                level.head_order_id = selected_id - 1;
                level.tail_order_id = selected_id + 1;
                let mut selected = linked_order_fixture(
                    market_state,
                    selected_id,
                    selected_id - 1,
                    selected_id + 1,
                );
                let mut previous =
                    linked_order_fixture(market_state, selected_id - 1, 0, selected_id);
                let mut next = linked_order_fixture(market_state, selected_id + 1, selected_id, 0);

                match mutation {
                    0 => selected.id = 0,
                    1 => selected.active = false,
                    2 => selected.continuation_pending = true,
                    3 => selected.market_state = Pubkey::new_unique(),
                    4 => selected.side = SIDE_BID,
                    5 => selected.price = 601,
                    6 => previous.id = selected_id + 2,
                    7 => previous.next_order_id = selected_id + 2,
                    8 => previous.active = false,
                    9 => next.id = selected_id + 2,
                    10 => next.prev_order_id = selected_id + 2,
                    11 => next.market_state = Pubkey::new_unique(),
                    12 => next.active = false,
                    13 => level.head_order_id = selected_id,
                    14 => {
                        selected.next_order_id = selected_id - 1;
                        next.id = selected_id - 1;
                        next.prev_order_id = selected_id;
                    }
                    15 => selected.prev_order_id = selected_id,
                    _ => unreachable!(),
                }

                assert!(
                    validate_unlink_graph(&level, &selected, Some(&previous), Some(&next),)
                        .is_err(),
                    "mutation {mutation} was accepted for generated order {selected_id}"
                );
                rejected += 1;
            }
        }

        assert_eq!(rejected, 256 * MUTATIONS_PER_GRAPH);
    }

    #[test]
    fn unlink_graph_rejects_nonreciprocal_or_wrong_level_neighbors() {
        let market_state = Pubkey::new_unique();
        let level = price_level_fixture(market_state);
        let middle = linked_order_fixture(market_state, 2, 1, 3);
        let mut previous = linked_order_fixture(market_state, 1, 0, 2);
        let mut next = linked_order_fixture(market_state, 3, 2, 0);

        previous.next_order_id = 99;
        assert!(validate_unlink_graph(&level, &middle, Some(&previous), Some(&next)).is_err());

        previous.next_order_id = middle.id;
        next.prev_order_id = 99;
        assert!(validate_unlink_graph(&level, &middle, Some(&previous), Some(&next)).is_err());

        next.prev_order_id = middle.id;
        next.market_state = Pubkey::new_unique();
        assert!(validate_unlink_graph(&level, &middle, Some(&previous), Some(&next)).is_err());

        next.market_state = market_state;
        next.price = 601;
        assert!(validate_unlink_graph(&level, &middle, Some(&previous), Some(&next)).is_err());
    }

    #[test]
    fn unlink_graph_rejects_boundary_and_active_state_corruption() {
        let market_state = Pubkey::new_unique();
        let mut level = price_level_fixture(market_state);
        let mut head = linked_order_fixture(market_state, 1, 0, 2);
        let middle = linked_order_fixture(market_state, 2, 1, 3);

        level.head_order_id = 99;
        assert!(validate_unlink_graph(&level, &head, None, Some(&middle)).is_err());

        level.head_order_id = head.id;
        head.active = false;
        assert!(validate_unlink_graph(&level, &head, None, Some(&middle)).is_err());

        head.active = true;
        head.continuation_pending = true;
        assert!(validate_unlink_graph(&level, &head, None, Some(&middle)).is_err());

        head.continuation_pending = false;
        head.next_order_id = 0;
        assert!(validate_unlink_graph(&level, &head, None, None).is_err());
    }

    #[test]
    fn losing_balance_cleanup_accepts_only_the_resolved_losing_side() {
        assert!(validate_losing_balance_cleanup(
            MarketStatus::Resolved,
            MarketSide::A,
            0,
            40_000,
            0,
            16_000,
        )
        .is_ok());
        assert!(validate_losing_balance_cleanup(
            MarketStatus::Resolved,
            MarketSide::B,
            40_000,
            0,
            24_000,
            0,
        )
        .is_ok());
    }

    #[test]
    fn losing_balance_cleanup_rejects_nonterminal_or_ambiguous_markets() {
        for status in [
            MarketStatus::Open,
            MarketStatus::Locked,
            MarketStatus::Cancelled,
        ] {
            assert!(
                validate_losing_balance_cleanup(status, MarketSide::A, 0, 40_000, 0, 16_000,)
                    .is_err()
            );
        }

        assert!(validate_losing_balance_cleanup(
            MarketStatus::Resolved,
            MarketSide::None,
            0,
            40_000,
            0,
            16_000,
        )
        .is_err());
    }

    #[test]
    fn market_sync_requires_the_canonical_market_pda_kind_and_bump() {
        let duel_pubkey = Pubkey::new_unique();
        let (market_pubkey, bump) = Pubkey::find_program_address(
            &[
                MARKET_SEED,
                duel_pubkey.as_ref(),
                &[MARKET_KIND_DUEL_WINNER],
            ],
            &crate::ID,
        );
        let (_, vault_bump) =
            Pubkey::find_program_address(&[VAULT_SEED, market_pubkey.as_ref()], &crate::ID);
        assert!(validate_market_identity(
            market_pubkey,
            bump,
            vault_bump,
            MARKET_KIND_DUEL_WINNER,
            duel_pubkey,
        )
        .is_ok());
        assert!(validate_market_identity(
            Pubkey::new_unique(),
            bump,
            vault_bump,
            MARKET_KIND_DUEL_WINNER,
            duel_pubkey,
        )
        .is_err());
        assert!(validate_market_identity(
            market_pubkey,
            bump.wrapping_add(1),
            vault_bump,
            MARKET_KIND_DUEL_WINNER,
            duel_pubkey,
        )
        .is_err());
        assert!(validate_market_identity(
            market_pubkey,
            bump,
            vault_bump.wrapping_add(1),
            MARKET_KIND_DUEL_WINNER,
            duel_pubkey,
        )
        .is_err());
        assert!(validate_market_identity(market_pubkey, bump, vault_bump, 0, duel_pubkey).is_err());
        assert!(validate_market_identity(
            market_pubkey,
            bump,
            vault_bump,
            MARKET_KIND_DUEL_WINNER,
            Pubkey::new_unique(),
        )
        .is_err());
    }

    #[test]
    fn positive_fee_configuration_rejects_the_market_vault_recipient() {
        let vault = Pubkey::new_unique();
        let treasury = Pubkey::new_unique();
        let market_maker = Pubkey::new_unique();

        assert!(validate_market_fee_configuration(
            vault,
            treasury,
            market_maker,
            5_000,
            5_000,
            10_000,
        )
        .is_ok());
        assert!(validate_market_fee_configuration(vault, vault, vault, 0, 0, 0).is_ok());
        assert!(validate_market_fee_configuration(vault, vault, market_maker, 1, 0, 0).is_err());
        assert!(validate_market_fee_configuration(vault, treasury, vault, 0, 1, 0).is_err());
        assert!(validate_market_fee_configuration(vault, treasury, vault, 0, 0, 1).is_err());
        assert!(
            validate_market_fee_configuration(vault, treasury, market_maker, 5_001, 5_000, 0,)
                .is_err()
        );
    }

    #[test]
    fn losing_balance_cleanup_never_discards_winning_value() {
        assert!(validate_losing_balance_cleanup(
            MarketStatus::Resolved,
            MarketSide::A,
            1_000,
            40_000,
            600,
            16_000,
        )
        .is_err());
        assert!(validate_losing_balance_cleanup(
            MarketStatus::Resolved,
            MarketSide::B,
            40_000,
            1_000,
            24_000,
            400,
        )
        .is_err());
        assert!(validate_losing_balance_cleanup(
            MarketStatus::Resolved,
            MarketSide::A,
            0,
            40_000,
            1,
            16_000,
        )
        .is_err());
    }

    #[test]
    fn losing_balance_cleanup_rejects_empty_accounts() {
        assert!(
            validate_losing_balance_cleanup(MarketStatus::Resolved, MarketSide::A, 0, 0, 0, 0,)
                .is_err()
        );
    }
}
