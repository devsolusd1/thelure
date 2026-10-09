//! Account plumbing for the hook. The rules themselves live in [`crate::state`].
//!
//! Three instructions: `init`, which a launcher calls once per token; `execute`, which
//! Token-2022 calls on every transfer through the SPL transfer-hook interface; and `settle`,
//! which anyone calls to pay the winner of a finished Last Buyer Wins round.

use {
    crate::leash::Leash,
    crate::state::{
        HookError, Key, Kind, Payee, Rules, RulesV1, TokenAccount, NO_KEY, NO_PARAM, RULES_LEN, RULES_V1_LEN, VERSION,
    },
    pinocchio::{
        address::address,
        cpi::{Seed, Signer},
        error::ProgramError,
        sysvars::{clock::Clock, rent::Rent, Sysvar},
        AccountView, Address, ProgramResult,
    },
    pinocchio_system::create_account_with_minimum_balance_signed,
};

/// First eight bytes of an `execute` call: sha256("spl-transfer-hook-interface:execute").
pub const EXECUTE: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];
/// First byte of an `init` call.
pub const INIT: u8 = 0;
/// First byte of a `settle` call.
pub const SETTLE: u8 = 1;

/// The rules account sits at `["rules", mint]`.
pub const RULES_SEED: &[u8; 5] = b"rules";
/// Token-2022 and every client look for the hook's account list at this address.
pub const ACCOUNT_LIST_SEED: &[u8; 19] = b"extra-account-metas";

pub const TOKEN_2022: Address = address!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/// Only an account owned by this program is a real leash, whatever its bytes say.
pub const LEASH_PROGRAM: Address = address!("GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p");

/// `init` data after the tag: two bumps, the flags and the two leash parameter indexes (a
/// byte each), the exempt owner, the leash (zeros for none), then the wallet cap, the guard
/// length, the block limit, the game timer and the smallest buy that counts (8 bytes each).
pub const INIT_LEN: usize = 5 + 2 * 32 + 5 * 8;

/// Every sysvar account belongs to this address.
const SYSVAR_OWNER: Address = address!("Sysvar1111111111111111111111111111111111111");

/// Addresses the runtime turns read-only in every transaction, whatever the sender asks
/// for: its own programs, the sysvars and a few ids. None of them can ever receive a prize.
/// Copied from Agave's reserved account keys; that list only grows.
const RESERVED: [Address; 31] = [
    address!("AddressLookupTab1e1111111111111111111111111"),
    address!("BPFLoader2111111111111111111111111111111111"),
    address!("BPFLoader1111111111111111111111111111111111"),
    address!("BPFLoaderUpgradeab1e11111111111111111111111"),
    address!("ComputeBudget111111111111111111111111111111"),
    address!("Config1111111111111111111111111111111111111"),
    address!("Ed25519SigVerify111111111111111111111111111"),
    address!("Feature111111111111111111111111111111111111"),
    address!("LoaderV411111111111111111111111111111111111"),
    address!("KeccakSecp256k11111111111111111111111111111"),
    address!("Secp256r1SigVerify1111111111111111111111111"),
    address!("StakeConfig11111111111111111111111111111111"),
    address!("Stake11111111111111111111111111111111111111"),
    address!("11111111111111111111111111111111"),
    address!("Vote111111111111111111111111111111111111111"),
    address!("ZkE1Gama1Proof11111111111111111111111111111"),
    address!("ZkTokenProof1111111111111111111111111111111"),
    address!("SysvarC1ock11111111111111111111111111111111"),
    address!("SysvarEpochRewards1111111111111111111111111"),
    address!("SysvarEpochSchedu1e111111111111111111111111"),
    address!("SysvarFees111111111111111111111111111111111"),
    address!("Sysvar1nstructions1111111111111111111111111"),
    address!("SysvarLastRestartS1ot1111111111111111111111"),
    address!("SysvarRecentB1ockHashes11111111111111111111"),
    address!("SysvarRent111111111111111111111111111111111"),
    address!("SysvarRewards111111111111111111111111111111"),
    address!("SysvarS1otHashes111111111111111111111111111"),
    address!("SysvarS1otHistory11111111111111111111111111"),
    address!("SysvarStakeHistory1111111111111111111111111"),
    address!("NativeLoader1111111111111111111111111111111"),
    SYSVAR_OWNER,
];

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
        Some((&SETTLE, [])) => settle(program_id, accounts),
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

/// Opens the token's leash, where its agent keeps the numbers it is allowed to tune, and
/// hands it to `read`. The account has to be the one the rules name, and the leash program
/// has to own it: anyone can create a leash for any token, and anyone can fill an account
/// of their own with bytes that look like one.
fn with_leash<T>(
    account: &AccountView,
    rules: &Rules,
    read: impl FnOnce(&Leash) -> Result<T, HookError>,
) -> Result<T, ProgramError> {
    if *account.address().as_array() != rules.leash || !account.owned_by(&LEASH_PROGRAM) {
        return Err(HookError::WrongAccount.into());
    }
    let bytes = account.try_borrow()?;
    let leash = Leash::cast(&bytes).ok_or(HookError::WrongAccount)?;
    Ok(read(leash)?)
}

/// Sets a token's rules and publishes the list of accounts its hook needs.
///
/// Accounts: payer (signer, writable), mint (signer), rules (writable), account list
/// (writable), system program, and the leash when the rules name one. The mint signs, so
/// only whoever is creating the token can set its rules: nobody can get there first, and
/// nobody can do it later.
fn init(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [payer, mint, rules, list, _system_program, extra @ ..] = accounts else {
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
    let [rules_bump, list_bump, flags, cap_param, timer_param] = bytes_at(data, 0)?;
    let mint_key = *mint.address().as_array();
    let state = Rules {
        version: VERSION,
        bump: rules_bump,
        flags,
        cap_param,
        timer_param,
        _pad: [0; 3],
        mint: mint_key,
        exempt_owner: bytes_at(data, 5)?,
        leash: bytes_at(data, 37)?,
        max_per_wallet: u64_at(data, 69)?,
        transfers: 0,
        launch_slot: Clock::get()?.slot,
        guard_slots: u64_at(data, 77)?,
        block_limit: u64_at(data, 85)?,
        block_slot: 0,
        block_bought: 0,
        lbw_timer: bytes_at(data, 93).map(i64::from_le_bytes)?,
        lbw_min_buy: u64_at(data, 101)?,
        lbw_deadline: 0,
        lbw_round: 0,
        lbw_last_buyer: NO_KEY,
        lbw_last_winner: NO_KEY,
        lbw_last_prize: 0,
        lbw_total_paid: 0,
    };
    state.validate()?;

    // Every buy will read the leash these rules name, and fail if it can't. Reading it now,
    // the same way, means a token can't be born with buys already frozen. The ranges its
    // agent can move in never change after this, so they are checked here once.
    let has_leash = state.leash != NO_KEY;
    if has_leash {
        let [leash, ..] = extra else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        with_leash(leash, &state, |leash| state.check_leash(leash))?;
    }

    // Token-2022 and every client look for both accounts at the first address their seeds
    // give, counting bumps down from 255. A lower bump would sign just as well, so it is
    // refused here. A list anywhere else is one Token-2022 never reads, and every transfer
    // of the token would fail. Rules anywhere else would leave the address everybody reads
    // free for a second, different set that the hook never applies.
    #[cfg(target_os = "solana")]
    for (seed, account, bump) in [(&RULES_SEED[..], &*rules, rules_bump), (&ACCOUNT_LIST_SEED[..], &*list, list_bump)] {
        match Address::try_find_program_address(&[seed, &mint_key], program_id) {
            Some((address, found)) if address == *account.address() && found == bump => {}
            _ => return Err(ProgramError::InvalidSeeds),
        }
    }

    // The system program only lets these seeds sign for the addresses they derive.
    let bump = [rules_bump];
    let seeds = [Seed::from(RULES_SEED), Seed::from(&mint_key), Seed::from(&bump)];
    create_account_with_minimum_balance_signed(rules, RULES_LEN, program_id, payer, None, &[Signer::from(&seeds)])?;

    // The list every client reads to know which accounts to pass: the rules, writable for
    // the counters and the game, then the leash if there is one. Fixed addresses, so any
    // router resolves them without knowing who is buying.
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
fn execute(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [source, mint, destination, _owner, _list, rules, extra @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !rules.owned_by(program_id) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    // Every transfer writes here. Token-2022 passes the account the way the list names it,
    // writable, so only a direct call can get this wrong.
    if !rules.is_writable() {
        return Err(HookError::NotWritable.into());
    }
    let mint_key = *mint.address().as_array();

    // Anyone can call this instruction directly with accounts of their choosing. Requiring
    // both ends to be mid-transfer in Token-2022 is what makes the counters and the game
    // trustworthy: the amount and the balances are then the ones Token-2022 just wrote.
    let moved = {
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
        Moved { mint: mint_key, sender: from.owner(), receiver: to.owner(), balance_after: to.amount() }
    };

    let mut bytes = rules.try_borrow_mut()?;
    // A token launched by the first version of the hook still has the 120-byte account that
    // version wrote. Its rules are applied like any others, and only its counter is written
    // back: refusing the old layout would freeze the token, sells included, for good.
    if bytes.len() == RULES_V1_LEN {
        let stored = RulesV1::cast_mut(&mut bytes).ok_or(ProgramError::InvalidAccountData)?;
        let mut state = stored.upgraded().ok_or(HookError::WrongAccount)?;
        apply(&mut state, &moved, extra, data)?;
        stored.transfers = state.transfers;
        return Ok(());
    }
    let state = Rules::cast_mut(&mut bytes).ok_or(ProgramError::InvalidAccountData)?;
    if state.version != VERSION {
        return Err(HookError::WrongAccount.into());
    }
    apply(state, &moved, extra, data)
}

/// What the two token accounts say about a transfer in flight.
struct Moved {
    mint: Key,
    /// Who owns the account the tokens left, and the one they reached.
    sender: Key,
    receiver: Key,
    /// What the receiving account holds now.
    balance_after: u64,
}

/// Checks a transfer against its token's rules, and counts it.
fn apply(state: &mut Rules, moved: &Moved, extra: &[AccountView], data: &[u8]) -> ProgramResult {
    if state.mint != moved.mint {
        return Err(HookError::WrongAccount.into());
    }

    // A sell must always land, or holders are trapped. So everything that can refuse a
    // transfer, or that depends on another account or on the clock, is behind this check:
    // a sell is only counted.
    let kind = state.classify(&moved.sender, &moved.receiver);
    let _cap = if kind == Kind::Sell {
        0
    } else {
        // The leash is read only when this transfer needs a number that lives there.
        let from_leash = state.cap_param != NO_PARAM || (kind == Kind::Buy && state.timer_param != NO_PARAM);
        let knobs = if from_leash {
            let [leash, ..] = extra else {
                return Err(ProgramError::NotEnoughAccountKeys);
            };
            with_leash(leash, state, |leash| state.knobs_from(leash))?
        } else {
            state.fixed_knobs()
        };
        state.check_receive(&moved.receiver, moved.balance_after, knobs.cap)?;

        if kind == Kind::Buy && state.watches_buys() {
            let amount = u64_at(data, 0)?;
            let clock = Clock::get()?;
            state.buy(&moved.receiver, amount, clock.slot, clock.unix_timestamp, knobs.timer)?;
        }
        knobs.cap
    };
    state.transfers = state.transfers.saturating_add(1);

    #[cfg(all(target_os = "solana", feature = "probe"))]
    {
        let amount = u64_at(data, 0).unwrap_or(0);
        // Accounts beyond the fixed six, amount moved, receiver's balance after, the cap
        // applied (0 for a sell, which has none), transfers so far.
        unsafe {
            pinocchio::syscalls::sol_log_64_(extra.len() as u64, amount, moved.balance_after, _cap, state.transfers)
        };
    }
    Ok(())
}

/// Pays the pot of a finished Last Buyer Wins round to its winner. Anyone can call it: the
/// money has only one place to go.
///
/// Accounts: rules (writable), winner (writable).
///
/// The pot is every lamport the rules account holds above its own rent. Anyone adds to it
/// with a plain transfer, and a leash can `spend` into it when the rules account is one of
/// its destinations.
///
/// Known limit: SOL only leaves the account through this instruction. What is sent to a
/// token whose game is off, or sits in a round that never gets a first buy once the curve
/// has graduated and the hook is gone, stays there. A token still in the first version's
/// layout has no game either: `settle` can't read its account and takes nothing from it.
fn settle(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [rules, winner, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    // Only this program can write to accounts it owns, and `init` is the only place it
    // lays one out, so the owner check is what makes the round's state trustworthy.
    if !rules.owned_by(program_id) {
        return Err(ProgramError::InvalidAccountOwner);
    }
    if !rules.is_writable() {
        return Err(HookError::NotWritable.into());
    }
    let rent = Rent::get()?;
    let pot = rules.lamports().saturating_sub(rent.try_minimum_balance(RULES_LEN)?);

    // Anyone can make any address the last buyer, by buying into a token account that
    // address owns. A payment that can't land would fail every `settle` and freeze the
    // game with the pot inside, so the accounts that can't take one are told apart here.
    let payee = Payee {
        locked: winner.executable()
            || winner.address() == rules.address()
            || winner.owned_by(&SYSVAR_OWNER)
            || RESERVED.contains(winner.address()),
        lamports: winner.lamports(),
        rent_floor: rent.try_minimum_balance(winner.data_len())?,
    };
    let now = Clock::get()?.unix_timestamp;

    let prize = {
        let mut bytes = rules.try_borrow_mut()?;
        let state = Rules::cast_mut(&mut bytes).ok_or(ProgramError::InvalidAccountData)?;
        if state.version != VERSION {
            return Err(HookError::WrongAccount.into());
        }
        state.settle(now, winner.address().as_array(), pot, &payee)?
    };
    if prize != 0 {
        // An ordinary winner passed read-only is the caller's mistake, not a reason to
        // take the prize away: refuse, and let the next call get it right.
        if !winner.is_writable() {
            return Err(HookError::NotWritable.into());
        }
        // This program owns the rules account, so it may take lamports out of it directly.
        // `prize` is at most the pot, and `Payee::can_take` ruled out an overflow.
        let (left, paid) = (rules.lamports() - prize, winner.lamports() + prize);
        rules.set_lamports(left);
        winner.set_lamports(paid);
    }
    Ok(())
}
