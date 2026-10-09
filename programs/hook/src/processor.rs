//! Account plumbing for the hook. The rule itself lives in [`crate::state`].
//!
//! Two instructions: `init`, which a launcher calls once per token, and `execute`, which
//! Token-2022 calls on every transfer through the SPL transfer-hook interface.

use {
    crate::leash::{Leash, MAX_PARAMS},
    crate::state::{HookError, Key, Rules, TokenAccount, NO_KEY, RULES_LEN, VERSION},
    pinocchio::{
        address::address,
        cpi::{Seed, Signer},
        error::ProgramError,
        AccountView, Address, ProgramResult,
    },
    pinocchio_system::create_account_with_minimum_balance_signed,
};

/// First eight bytes of an `execute` call: sha256("spl-transfer-hook-interface:execute").
pub const EXECUTE: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];
/// First byte of an `init` call.
pub const INIT: u8 = 0;

/// The rules account sits at `["rules", mint]`.
pub const RULES_SEED: &[u8; 5] = b"rules";
/// Token-2022 and every client look for the hook's account list at this address.
pub const ACCOUNT_LIST_SEED: &[u8; 19] = b"extra-account-metas";

pub const TOKEN_2022: Address = address!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/// Only an account owned by this program is a real leash, whatever its bytes say.
pub const LEASH_PROGRAM: Address = address!("GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p");

/// `init` data after the tag: two bumps, the leash parameter index, the exempt owner,
/// the leash (zeros for none) and the cap.
pub const INIT_LEN: usize = 3 + 2 * 32 + 8;

impl From<HookError> for ProgramError {
    fn from(error: HookError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    if let Some(data) = data.strip_prefix(&EXECUTE) {
        return execute(program_id, accounts, data);
    }
    match data.split_first() {
        Some((&INIT, data)) => init(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn bytes_at<const N: usize>(data: &[u8], at: usize) -> Result<[u8; N], ProgramError> {
    data.get(at..at + N)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(ProgramError::InvalidInstructionData)
}

/// Sets a token's rules and publishes the list of accounts its hook needs.
///
/// Accounts: payer (signer, writable), mint (signer), rules (writable), account list
/// (writable), system program. The mint signs, so only whoever is creating the token can
/// set its rules: nobody can get there first, and nobody can do it later.
fn init(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [payer, mint, rules, list, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !payer.is_signer() || !mint.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !rules.is_data_empty() || !list.is_data_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    if data.len() != INIT_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let [rules_bump, list_bump, leash_param] = bytes_at(data, 0)?;
    let state = Rules {
        version: VERSION,
        bump: rules_bump,
        leash_param,
        _pad: [0; 5],
        mint: *mint.address().as_array(),
        exempt_owner: bytes_at(data, 3)?,
        leash: bytes_at(data, 35)?,
        max_per_wallet: u64::from_le_bytes(bytes_at(data, 67)?),
        transfers: 0,
    };
    let has_leash = state.leash != NO_KEY;
    if has_leash && leash_param as usize >= MAX_PARAMS {
        return Err(HookError::BadConfig.into());
    }

    // The system program only lets these seeds sign for the addresses they derive, so a
    // wrong bump or a wrong account fails here.
    let mint_key = *mint.address().as_array();
    let bump = [rules_bump];
    let seeds = [Seed::from(RULES_SEED), Seed::from(&mint_key), Seed::from(&bump)];
    create_account_with_minimum_balance_signed(rules, RULES_LEN, program_id, payer, None, &[Signer::from(&seeds)])?;

    // The list every client reads to know which accounts to pass: the rules, writable for
    // the counter, then the leash if there is one. Fixed addresses, so any router resolves
    // them without knowing who is buying.
    let entries: usize = if has_leash { 2 } else { 1 };
    let list_len = 16 + ENTRY_LEN * entries;
    let bump = [list_bump];
    let seeds = [Seed::from(ACCOUNT_LIST_SEED), Seed::from(&mint_key), Seed::from(&bump)];
    create_account_with_minimum_balance_signed(list, list_len, program_id, payer, None, &[Signer::from(&seeds)])?;

    let rules_key = *rules.address().as_array();
    {
        let mut bytes = list.try_borrow_mut()?;
        bytes[..8].copy_from_slice(&EXECUTE);
        bytes[8..12].copy_from_slice(&((4 + ENTRY_LEN * entries) as u32).to_le_bytes());
        bytes[12..16].copy_from_slice(&(entries as u32).to_le_bytes());
        write_entry(&mut bytes[16..], &rules_key, true);
        if has_leash {
            write_entry(&mut bytes[16 + ENTRY_LEN..], &state.leash, false);
        }
    }

    let mut bytes = rules.try_borrow_mut()?;
    *Rules::cast_mut(&mut bytes).ok_or(ProgramError::InvalidAccountData)? = state;
    Ok(())
}

/// One entry of the account list: kind 0 (a fixed address), the address, signer, writable.
const ENTRY_LEN: usize = 35;

fn write_entry(out: &mut [u8], address: &Key, writable: bool) {
    out[0] = 0;
    out[1..33].copy_from_slice(address);
    out[33] = 0;
    out[34] = writable as u8;
}

/// Called by Token-2022 after it has moved the tokens and before the transfer is final.
///
/// Accounts, in the interface's order: source, mint, destination, source owner, account
/// list, then the list's own entries: rules, and the leash if the token has one.
fn execute(program_id: &Address, accounts: &mut [AccountView], _data: &[u8]) -> ProgramResult {
    let [source, mint, destination, _owner, _list, rules, extra @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !rules.owned_by(program_id) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    let mint_key = *mint.address().as_array();

    // Anyone can call this instruction directly with accounts of their choosing. Requiring
    // both ends to be mid-transfer in Token-2022 is what makes the counter (and any state a
    // rule keeps) trustworthy.
    let (receiver, balance_after) = {
        if !source.owned_by(&TOKEN_2022) || !destination.owned_by(&TOKEN_2022) {
            return Err(HookError::NotATransfer.into());
        }
        let (from, to) = (source.try_borrow()?, destination.try_borrow()?);
        let from = TokenAccount::parse(&from).ok_or(HookError::NotATransfer)?;
        let to = TokenAccount::parse(&to).ok_or(HookError::NotATransfer)?;
        let ours = from.mint() == mint_key && to.mint() == mint_key;
        if !ours || !from.is_transferring() || !to.is_transferring() {
            return Err(HookError::NotATransfer.into());
        }
        (to.owner(), to.amount())
    };

    let writable = rules.is_writable();
    let mut bytes = rules.try_borrow_mut()?;
    let state = Rules::cast_mut(&mut bytes).ok_or(ProgramError::InvalidAccountData)?;
    if state.version != VERSION || state.mint != mint_key {
        return Err(HookError::WrongAccount.into());
    }

    let cap = if state.leash == NO_KEY {
        state.max_per_wallet
    } else {
        let [leash, ..] = extra else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        cap_from_leash(leash, state)?
    };
    state.check_receive(&receiver, balance_after, cap)?;

    if writable {
        state.transfers = state.transfers.saturating_add(1);
    }
    #[cfg(all(target_os = "solana", feature = "probe"))]
    {
        let amount = bytes_at(_data, 0).map(u64::from_le_bytes).unwrap_or(0);
        // Accounts beyond the fixed six, amount moved, receiver's balance, cap, transfers so far.
        unsafe { pinocchio::syscalls::sol_log_64_(extra.len() as u64, amount, balance_after, cap, state.transfers) };
    }
    Ok(())
}

/// Reads the cap out of the token's leash: the value its agent is allowed to tune.
fn cap_from_leash(account: &AccountView, rules: &Rules) -> Result<u64, ProgramError> {
    if *account.address().as_array() != rules.leash || !account.owned_by(&LEASH_PROGRAM) {
        return Err(HookError::WrongAccount.into());
    }
    let bytes = account.try_borrow()?;
    let leash = Leash::cast(&bytes).ok_or(HookError::WrongAccount)?;
    let index = rules.leash_param as usize;
    if leash.version != crate::leash::VERSION || index >= leash.param_count as usize {
        return Err(HookError::WrongAccount.into());
    }
    // The leash keeps the value inside the range set at launch. Zero means no cap, as it
    // does for a fixed cap. A value below zero must never read as "no cap", so it becomes
    // the tightest cap there is; sells still land, because the vault is exempt.
    Ok(u64::try_from(leash.params[index].value).unwrap_or(1))
}
