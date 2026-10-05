//! Account plumbing: who signed, which accounts were passed, where the lamports go.
//! The limits themselves live in [`crate::state`].

use {
    crate::state::{Key, Leash, LeashError, Param, LEASH_LEN, MAX_PARAMS, NO_KEY, VERSION},
    pinocchio::{
        cpi::{Seed, Signer},
        error::ProgramError,
        sysvars::{clock::Clock, rent::Rent, Sysvar},
        AccountView, Address, ProgramResult,
    },
    pinocchio_system::create_account_with_minimum_balance_signed,
};

/// First byte of the instruction data.
pub mod tag {
    pub const INIT: u8 = 0;
    pub const SPEND: u8 = 1;
    pub const REWARD: u8 = 2;
    pub const SET_PARAM: u8 = 3;
    pub const SET_AGENT: u8 = 4;
    pub const SWEEP: u8 = 5;
}

/// First seed of every leash address: `["leash", mint, creator, bump]`.
pub const SEED: &[u8; 5] = b"leash";

/// `init` data after the tag: bump, flags, param count, mint, agent, two destinations and
/// four caps, then 40 bytes per param (value, min, max, max step, cooldown).
pub const INIT_FIXED_LEN: usize = 3 + 4 * 32 + 4 * 8;
pub const INIT_PARAM_LEN: usize = 40;

impl From<LeashError> for ProgramError {
    fn from(error: LeashError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (kind, data) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match *kind {
        tag::INIT => init(program_id, accounts, data),
        tag::SPEND => pay(program_id, accounts, data, true),
        tag::REWARD => pay(program_id, accounts, data, false),
        tag::SET_PARAM => set_param(program_id, accounts, data),
        tag::SET_AGENT => set_agent(program_id, accounts, data),
        tag::SWEEP => sweep(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn bytes_at<const N: usize>(data: &[u8], at: usize) -> Result<[u8; N], ProgramError> {
    data.get(at..at + N)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(ProgramError::InvalidInstructionData)
}

fn u64_at(data: &[u8], at: usize) -> Result<u64, ProgramError> {
    bytes_at(data, at).map(u64::from_le_bytes)
}

fn i64_at(data: &[u8], at: usize) -> Result<i64, ProgramError> {
    bytes_at(data, at).map(i64::from_le_bytes)
}

fn now() -> Result<i64, ProgramError> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Lamports the leash holds above what keeps its account alive.
fn budget(leash: &AccountView) -> Result<u64, ProgramError> {
    Ok(leash.lamports().saturating_sub(Rent::get()?.try_minimum_balance(LEASH_LEN)?))
}

/// Runs `f` on the leash stored in `account`.
///
/// Only this program can write to accounts it owns, and `init` is the only place it lays
/// one out, so the owner check is what makes the contents trustworthy.
fn with_leash<T>(
    program_id: &Address,
    account: &mut AccountView,
    f: impl FnOnce(&mut Leash) -> Result<T, ProgramError>,
) -> Result<T, ProgramError> {
    if !account.owned_by(program_id) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let mut data = account.try_borrow_mut()?;
    let leash = Leash::cast_mut(&mut data).ok_or(ProgramError::InvalidAccountData)?;
    if leash.version != VERSION {
        return Err(ProgramError::InvalidAccountData);
    }
    f(leash)
}

fn move_lamports(from: &mut AccountView, to: &mut AccountView, amount: u64) -> ProgramResult {
    let left = from.lamports().checked_sub(amount).ok_or(ProgramError::InsufficientFunds)?;
    let total = to.lamports().checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)?;
    from.set_lamports(left);
    to.set_lamports(total);
    Ok(())
}

/// Accounts: creator (signer, writable), leash (writable), system program.
fn init(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [creator, leash, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !creator.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !leash.is_data_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let [bump, flags, param_count] = bytes_at(data, 0)?;
    let count = param_count as usize;
    if count > MAX_PARAMS || data.len() != INIT_FIXED_LEN + count * INIT_PARAM_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mint: Key = bytes_at(data, 3)?;
    let created = now()?;

    let mut params = [Param { value: 0, min: 0, max: 0, max_step: 0, cooldown: 0, last_change: 0 }; MAX_PARAMS];
    for (i, param) in params.iter_mut().take(count).enumerate() {
        let at = INIT_FIXED_LEN + i * INIT_PARAM_LEN;
        *param = Param {
            value: i64_at(data, at)?,
            min: i64_at(data, at + 8)?,
            max: i64_at(data, at + 16)?,
            max_step: u64_at(data, at + 24)?,
            cooldown: i64_at(data, at + 32)?,
            last_change: created,
        };
    }
    let state = Leash {
        version: VERSION,
        bump,
        flags,
        param_count,
        _pad: [0; 4],
        mint,
        creator: *creator.address().as_array(),
        agent: bytes_at(data, 35)?,
        dest: [bytes_at(data, 67)?, bytes_at(data, 99)?],
        max_per_spend: u64_at(data, 131)?,
        max_per_day: u64_at(data, 139)?,
        max_per_reward: u64_at(data, 147)?,
        max_reward_per_day: u64_at(data, 155)?,
        day_start: created,
        spent_today: 0,
        rewarded_today: 0,
        total_spent: 0,
        total_rewarded: 0,
        params,
    };
    state.validate()?;
    // A leash that could pay itself would burn its caps without moving anything.
    if state.dest.contains(leash.address().as_array()) {
        return Err(LeashError::BadConfig.into());
    }

    // The system program only lets these seeds sign for the address they derive, so a
    // wrong bump, or an account that isn't this (mint, creator)'s leash, fails right here.
    // The helper also copes with an address somebody already sent SOL to.
    let bump = [bump];
    let seeds = [
        Seed::from(SEED),
        Seed::from(&mint),
        Seed::from(creator.address().as_array()),
        Seed::from(&bump),
    ];
    create_account_with_minimum_balance_signed(leash, LEASH_LEN, program_id, creator, None, &[Signer::from(&seeds)])?;

    let mut bytes = leash.try_borrow_mut()?;
    *Leash::cast_mut(&mut bytes).ok_or(ProgramError::InvalidAccountData)? = state;
    Ok(())
}

/// `spend` data: destination index (u8), amount (u64). `reward` data: amount (u64).
/// Accounts: agent (signer), leash (writable), recipient (writable).
fn pay(program_id: &Address, accounts: &mut [AccountView], data: &[u8], to_destination: bool) -> ProgramResult {
    let [agent, leash, to, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !agent.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    // The same account twice would count against the caps and move nothing.
    if to.address() == leash.address() {
        return Err(LeashError::BadDestination.into());
    }
    let amount = u64_at(data, if to_destination { 1 } else { 0 })?;
    let (now, budget) = (now()?, budget(leash)?);

    with_leash(program_id, leash, |state| {
        if !state.is_agent(agent.address().as_array()) {
            return Err(LeashError::NotAgent.into());
        }
        if to_destination {
            let [index] = bytes_at(data, 0)?;
            if !state.allows_destination(index as usize, to.address().as_array()) {
                return Err(LeashError::BadDestination.into());
            }
            state.spend(amount, now, budget)?;
        } else {
            state.reward(amount, now, budget)?;
        }
        Ok(())
    })?;
    move_lamports(leash, to, amount)
}

/// Data: param index (u8), new value (i64). Accounts: agent (signer), leash (writable).
fn set_param(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [agent, leash, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !agent.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let [index] = bytes_at(data, 0)?;
    let (value, now) = (i64_at(data, 1)?, now()?);

    with_leash(program_id, leash, |state| {
        if !state.is_agent(agent.address().as_array()) {
            return Err(LeashError::NotAgent.into());
        }
        Ok(state.set_param(index as usize, value, now)?)
    })
}

/// Data: the new agent, or 32 zero bytes to revoke. Accounts: creator (signer), leash (writable).
fn set_agent(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [creator, leash, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !creator.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let new_agent: Key = bytes_at(data, 0)?;

    with_leash(program_id, leash, |state| {
        if state.creator != *creator.address().as_array() {
            return Err(LeashError::NotCreator.into());
        }
        Ok(state.set_agent(new_agent)?)
    })
}

/// Sends what is left of a revoked leash to its first destination. Anyone can call it:
/// the money has only one place to go. Accounts: leash (writable), destination (writable).
fn sweep(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [leash, to, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let budget = budget(leash)?;

    with_leash(program_id, leash, |state| {
        if state.agent != NO_KEY {
            return Err(LeashError::NotRevoked.into());
        }
        if !state.allows_destination(0, to.address().as_array()) {
            return Err(LeashError::BadDestination.into());
        }
        Ok(())
    })?;
    move_lamports(leash, to, budget)
}
