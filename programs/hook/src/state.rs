//! What the hook stores per token, the rules it applies, and how it reads the accounts
//! Token-2022 hands it.
//!
//! Nothing here touches the Solana runtime: the processor hands in the slot, the clock and
//! the balances, and gets back yes or no. That keeps every rule unit-testable on the host.

use crate::leash::{Leash, MAX_PARAMS};

/// Layout version written to every rules account.
pub const VERSION: u8 = 2;

pub type Key = [u8; 32];
/// "Nobody": no leash, no exempt owner, no last buyer yet.
pub const NO_KEY: Key = [0; 32];

/// Bit 0 of `flags`: the token plays Last Buyer Wins.
pub const FLAG_LAST_BUYER_WINS: u8 = 1;
/// In `cap_param` or `timer_param`: the number is fixed in this account, not read from a leash.
pub const NO_PARAM: u8 = 0xFF;

/// The most a buy can put on the game clock: a week, in seconds. Only `settle` pays a pot
/// and it waits for the clock, so a clock that could be set years ahead would lock the pot.
pub const MAX_TIMER: i64 = 7 * 86_400;
/// The longest guard a token that plays can have: about a day of slots. The game waits for
/// the guard to come down, so a guard without end would be a game that never starts.
pub const MAX_GUARD_WITH_GAME: u64 = 216_000;

/// Returned to the client as `ProgramError::Custom(code)`.
#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookError {
    /// The transfer would leave the receiving wallet above the token's cap.
    OverMaxPerWallet = 6000,
    /// Not called by Token-2022 in the middle of a transfer of this token.
    NotATransfer = 6001,
    /// The rules or leash account passed in is not this token's.
    WrongAccount = 6002,
    /// The values passed to `init` contradict each other.
    BadConfig = 6003,
    /// The buy would take what was bought from the curve in this slot above the token's limit.
    TooMuchInOneBlock = 6004,
    /// An account the instruction has to write to was passed read-only.
    NotWritable = 6005,
    /// No round has started, or its clock is still running.
    RoundNotOver = 6006,
    /// The account to pay is not the round's last buyer.
    NotTheWinner = 6007,
    /// This token does not play Last Buyer Wins.
    GameOff = 6008,
}

/// One per token. The settings are fixed at `init`; the counters and the game move.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rules {
    pub version: u8,
    pub bump: u8,
    pub flags: u8,
    /// Which leash parameter holds the wallet cap, or `NO_PARAM` to use `max_per_wallet`.
    pub cap_param: u8,
    /// Which leash parameter holds the game timer, or `NO_PARAM` to use `lbw_timer`.
    pub timer_param: u8,
    pub _pad: [u8; 3],
    pub mint: Key,
    /// Owner of the bonding curve's vault. Tokens leaving an account it owns are a buy,
    /// tokens arriving at one are a sell, and its accounts are never capped.
    pub exempt_owner: Key,
    /// The token's leash, when a rule reads a number its agent may tune.
    pub leash: Key,
    /// Most a wallet may hold right after receiving, in base units. 0 means no cap.
    pub max_per_wallet: u64,
    /// Transfers the hook has let through.
    pub transfers: u64,
    /// Slot the guard's window counts from: the slot of `init` at first, then the slot of
    /// the first buy from the curve, once there has been one.
    pub launch_slot: u64,
    /// The block limit applies for this many slots from the first buy. 0 means for good.
    pub guard_slots: u64,
    /// Most tokens that may be bought from the curve in one slot. 0 means no limit.
    pub block_limit: u64,
    /// The slot `block_bought` is counting. 0 until the first buy from the curve.
    pub block_slot: u64,
    pub block_bought: u64,
    /// Seconds a buy puts on the game clock.
    pub lbw_timer: i64,
    /// A buy smaller than this never moves the game.
    pub lbw_min_buy: u64,
    /// Unix time the round ends. 0 while the round waits for its first buy.
    pub lbw_deadline: i64,
    /// Rounds closed so far.
    pub lbw_round: u64,
    pub lbw_last_buyer: Key,
    pub lbw_last_winner: Key,
    pub lbw_last_prize: u64,
    pub lbw_total_paid: u64,
}

pub const RULES_LEN: usize = core::mem::size_of::<Rules>();
const _: () = assert!(RULES_LEN == 272);
const _: () = assert!(core::mem::align_of::<Rules>() == 8);
// Clients read these by offset. `max_per_wallet` and `transfers` sit where layout 1 had them.
const _: () = assert!(core::mem::offset_of!(Rules, mint) == 8);
const _: () = assert!(core::mem::offset_of!(Rules, max_per_wallet) == 104);
const _: () = assert!(core::mem::offset_of!(Rules, transfers) == 112);
const _: () = assert!(core::mem::offset_of!(Rules, lbw_timer) == 160);
const _: () = assert!(core::mem::offset_of!(Rules, lbw_last_buyer) == 192);
const _: () = assert!(core::mem::offset_of!(Rules, lbw_total_paid) == 264);

/// The rules as the first version of the hook stored them: a wallet cap and a counter.
///
/// A token keeps the account it was launched with for good, and its mint is tied to this
/// program's address. So every later version has to go on reading this layout, or a token
/// launched before it could never be bought or sold again.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RulesV1 {
    pub version: u8,
    pub bump: u8,
    /// Which leash parameter holds the cap, when `leash` is set.
    pub leash_param: u8,
    pub _pad: [u8; 5],
    pub mint: Key,
    pub exempt_owner: Key,
    pub leash: Key,
    pub max_per_wallet: u64,
    pub transfers: u64,
}

pub const RULES_V1_LEN: usize = core::mem::size_of::<RulesV1>();
const _: () = assert!(RULES_V1_LEN == 120);
const _: () = assert!(core::mem::align_of::<RulesV1>() == 8);

impl RulesV1 {
    /// Views account data as first-version rules, checking length and alignment only.
    pub fn cast_mut(bytes: &mut [u8]) -> Option<&mut RulesV1> {
        if bytes.len() != RULES_V1_LEN || bytes.as_ptr() as usize % core::mem::align_of::<RulesV1>() != 0 {
            return None;
        }
        // SAFETY: as in `Rules::cast_mut`.
        Some(unsafe { &mut *(bytes.as_mut_ptr() as *mut RulesV1) })
    }

    /// The same token in today's layout: its cap, fixed or in its leash, and nothing else
    /// switched on. The hook applies these like any other rules and writes back only the
    /// counter. `None` if the bytes are not first-version rules.
    pub fn upgraded(&self) -> Option<Rules> {
        let from_leash = self.leash != NO_KEY;
        (self.version == 1).then_some(Rules {
            version: VERSION,
            bump: self.bump,
            flags: 0,
            cap_param: if from_leash { self.leash_param } else { NO_PARAM },
            timer_param: NO_PARAM,
            _pad: [0; 3],
            mint: self.mint,
            exempt_owner: self.exempt_owner,
            leash: self.leash,
            max_per_wallet: self.max_per_wallet,
            transfers: self.transfers,
            launch_slot: 0,
            guard_slots: 0,
            block_limit: 0,
            block_slot: 0,
            block_bought: 0,
            lbw_timer: 0,
            lbw_min_buy: 0,
            lbw_deadline: 0,
            lbw_round: 0,
            lbw_last_buyer: NO_KEY,
            lbw_last_winner: NO_KEY,
            lbw_last_prize: 0,
            lbw_total_paid: 0,
        })
    }
}

/// What a transfer is, judged by who owns the two token accounts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Out of the curve's vault, to anyone else.
    Buy,
    /// Into an account the curve owns.
    Sell,
    /// Between two wallets.
    Transfer,
}

/// The two numbers a rule takes from this account or, when the creator chose so, from the leash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Knobs {
    pub cap: u64,
    pub timer: i64,
}

/// What `settle` knows about the account a prize would go to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Payee {
    /// A program, the rules account itself, or an address no transaction can write to.
    pub locked: bool,
    pub lamports: u64,
    /// What the account must hold to be rent-exempt at its size.
    pub rent_floor: u64,
}

impl Payee {
    /// Whether the account can receive `prize`. The runtime fails a whole transaction that
    /// leaves a credited account short of its rent, so such a payment would never land.
    pub fn can_take(&self, prize: u64) -> bool {
        !self.locked && self.lamports.checked_add(prize).is_some_and(|after| after >= self.rent_floor)
    }
}

impl Rules {
    /// Views account data as rules, checking length and alignment only.
    pub fn cast_mut(bytes: &mut [u8]) -> Option<&mut Rules> {
        if bytes.len() != RULES_LEN || bytes.as_ptr() as usize % core::mem::align_of::<Rules>() != 0 {
            return None;
        }
        // SAFETY: the length and alignment were just checked, the borrow is exclusive, and
        // `Rules` is plain integers and byte arrays with no padding, so any bytes are valid.
        Some(unsafe { &mut *(bytes.as_mut_ptr() as *mut Rules) })
    }

    pub fn game_on(&self) -> bool {
        self.flags & FLAG_LAST_BUYER_WINS != 0
    }

    /// Whether a buy has anything to update beyond the cap check: the guard or the game.
    pub fn watches_buys(&self) -> bool {
        self.block_limit != 0 || self.game_on()
    }

    /// Checks freshly filled rules before they are stored. A setting that would be silently
    /// ignored is refused too: it means the launcher and the creator disagree on the rules.
    pub fn validate(&self) -> Result<(), HookError> {
        let game = self.game_on();
        let (cap_knob, timer_knob) = (self.cap_param != NO_PARAM, self.timer_param != NO_PARAM);
        let (capped, limited) = (cap_knob || self.max_per_wallet != 0, self.block_limit != 0);
        let has_curve = self.exempt_owner != NO_KEY;
        let ok = self.flags & !FLAG_LAST_BUYER_WINS == 0
            && (!cap_knob || (self.cap_param as usize) < MAX_PARAMS)
            && (!timer_knob || (self.timer_param as usize) < MAX_PARAMS)
            // A leash is named exactly when a rule reads from it, and one leash parameter
            // can't be a cap and a timer at once.
            && (self.leash != NO_KEY) == (cap_knob || timer_knob)
            && !(cap_knob && self.cap_param == self.timer_param)
            // One number, one source.
            && !(cap_knob && self.max_per_wallet != 0)
            && !(timer_knob && self.lbw_timer != 0)
            // Every rule needs to know the curve's vault. Without it there is no telling a
            // buy from any other transfer, and a cap would hold the vault too: it has
            // nearly the whole supply, so every sell into it would be refused.
            && (has_curve || !(game || limited || capped))
            && (limited || self.guard_slots == 0)
            && if game {
                // The clock needs a length, and one short enough that a round gets paid.
                (timer_knob || (1..=MAX_TIMER).contains(&self.lbw_timer))
                    // The smallest buy that counts has to fit under the cap, or no round
                    // could ever start.
                    && (self.max_per_wallet == 0 || self.lbw_min_buy <= self.max_per_wallet)
                    // The game waits for the guard to come down, so the guard has to end.
                    && (!limited || (1..=MAX_GUARD_WITH_GAME).contains(&self.guard_slots))
            } else {
                !timer_knob && self.lbw_timer == 0 && self.lbw_min_buy == 0
            };
        if ok {
            Ok(())
        } else {
            Err(HookError::BadConfig)
        }
    }

    /// The numbers as fixed at launch.
    pub fn fixed_knobs(&self) -> Knobs {
        Knobs { cap: self.max_per_wallet, timer: self.lbw_timer }
    }

    /// The numbers with the leash's values in place of the fixed ones, where the creator
    /// chose so. The caller checks that the leash program owns the account. `init` runs this
    /// too, so a token whose leash can't be read is refused at launch instead of born frozen.
    pub fn knobs_from(&self, leash: &Leash) -> Result<Knobs, HookError> {
        if leash.version != crate::leash::VERSION || leash.mint != self.mint {
            return Err(HookError::WrongAccount);
        }
        let read = |index: u8| -> Result<Option<i64>, HookError> {
            if index == NO_PARAM {
                return Ok(None);
            }
            // The leash only lets its agent tune the parameters it was created with.
            if index >= leash.param_count {
                return Err(HookError::BadConfig);
            }
            let param = leash.params.get(index as usize).ok_or(HookError::BadConfig)?;
            Ok(Some(param.value))
        };
        let mut knobs = self.fixed_knobs();
        // The leash keeps each value inside the range set at launch. Zero means no cap, as
        // it does for a fixed cap. A value below zero must never read as "no cap", so it
        // becomes the tightest cap there is; sells still land, they are never capped.
        if let Some(value) = read(self.cap_param)? {
            knobs.cap = u64::try_from(value).unwrap_or(1);
        }
        // A clock of zero or less would end a round the moment it starts, and one longer
        // than `MAX_TIMER` could keep its pot locked for as long as the leash allows.
        if let Some(value) = read(self.timer_param)? {
            knobs.timer = value.clamp(1, MAX_TIMER);
        }
        Ok(knobs)
    }

    /// What `init` asks of a leash on top of being readable. The agent can move each number
    /// anywhere inside a range that is fixed when the leash is created, so the range itself
    /// must not hold a value that breaks the game:
    ///
    /// - a cap under the smallest buy that counts: an agent that leads a round could cut
    ///   the cap, and nobody could buy enough to take the lead before the clock ran out.
    ///   Zero means no cap, but a range that starts at zero holds every small cap as well,
    ///   so on a token that plays the leash can tighten the cap but never switch it off;
    /// - a clock above `MAX_TIMER`, which `knobs_from` would cut short on every buy without
    ///   the creator ever being told.
    pub fn check_leash(&self, leash: &Leash) -> Result<(), HookError> {
        self.knobs_from(leash)?;
        // `knobs_from` just checked that each index in use exists. `NO_PARAM` is past the
        // end of the array, so a number that isn't in the leash has no range to check.
        let range = |index: u8| leash.params.get(index as usize);
        let cap_fits = range(self.cap_param)
            .is_none_or(|cap| !self.game_on() || u64::try_from(cap.min).is_ok_and(|min| min >= self.lbw_min_buy));
        let timer_fits = range(self.timer_param).is_none_or(|timer| timer.max <= MAX_TIMER);
        if cap_fits && timer_fits {
            Ok(())
        } else {
            Err(HookError::BadConfig)
        }
    }

    /// Tells buys, sells and plain transfers apart. Only the curve's program can move tokens
    /// out of an account its authority owns, so nobody can fake a buy by sending tokens
    /// between wallets. Anything arriving at the curve is a sell, whoever sent it.
    ///
    /// The hook can't see why the curve is paying tokens out. A curve whose config collects
    /// trading fees in the token itself pays them out of the same vault, and those claims
    /// would be capped, counted and played like buys: whoever claims fees could take a
    /// round's lead without buying. A Lure curve has to collect its fees in SOL.
    pub fn classify(&self, from_owner: &Key, to_owner: &Key) -> Kind {
        if self.exempt_owner == NO_KEY {
            Kind::Transfer
        } else if *to_owner == self.exempt_owner {
            Kind::Sell
        } else if *from_owner == self.exempt_owner {
            Kind::Buy
        } else {
            Kind::Transfer
        }
    }

    /// Whether a wallet may end up holding `balance_after` once a transfer lands.
    pub fn check_receive(&self, owner: &Key, balance_after: u64, cap: u64) -> Result<(), HookError> {
        let exempt = self.exempt_owner != NO_KEY && self.exempt_owner == *owner;
        if cap != 0 && !exempt && balance_after > cap {
            return Err(HookError::OverMaxPerWallet);
        }
        Ok(())
    }

    /// Whether the block limit still applies at `slot`. Its window opens with the first buy
    /// from the curve and not at `init`: whoever launches a token chooses how long `init`
    /// comes before its pool, and could otherwise let the window run out before anyone was
    /// able to buy.
    pub fn guard_is_up(&self, slot: u64) -> bool {
        let opened = self.block_slot != 0;
        self.block_limit != 0
            && (self.guard_slots == 0 || !opened || slot.saturating_sub(self.launch_slot) < self.guard_slots)
    }

    /// Counts a buy against the block limit, refusing the one that would cross it.
    ///
    /// The limit is on tokens, not on trades: a bundle that buys the supply in one block
    /// needs a lot of tokens, while a count of trades could be used up by dust buys to keep
    /// everyone else out for a few cents.
    ///
    /// What it can't do: tokens sold straight back still count, because a sell is never
    /// read against the guard. Someone who buys the limit and sells it again in each slot
    /// keeps other buyers out for the price of the curve's fee both ways.
    pub fn count_buy(&mut self, amount: u64, slot: u64) -> Result<(), HookError> {
        if !self.guard_is_up(slot) {
            return Ok(());
        }
        let so_far = if slot == self.block_slot { self.block_bought } else { 0 };
        let bought = so_far.checked_add(amount).filter(|&total| total <= self.block_limit);
        self.block_bought = bought.ok_or(HookError::TooMuchInOneBlock)?;
        // The first buy that lands is where the window starts.
        if self.block_slot == 0 {
            self.launch_slot = slot;
        }
        self.block_slot = slot;
        Ok(())
    }

    /// A buy from the curve: counted against the block limit while the guard is up, played
    /// in the game once it is down.
    ///
    /// Never both. A slot under the limit only has so much room, and whoever leads a round
    /// could use it up, slot after slot, with buys too small to count (sold straight back,
    /// so costing only fees), until the clock ran out with nobody else able to buy enough
    /// to take the lead.
    pub fn buy(&mut self, buyer: &Key, amount: u64, slot: u64, now: i64, timer: i64) -> Result<(), HookError> {
        if self.guard_is_up(slot) {
            return self.count_buy(amount, slot);
        }
        self.play(buyer, amount, now, timer);
        Ok(())
    }

    /// One step of Last Buyer Wins: a buy big enough, while the round is open, makes
    /// `buyer` the one to beat and restarts the clock. Once the clock has run out nothing
    /// moves until `settle` closes the round, so the winner can't be bought out of the prize.
    pub fn play(&mut self, buyer: &Key, amount: u64, now: i64, timer: i64) {
        let counts = amount != 0 && amount >= self.lbw_min_buy;
        let open = self.lbw_deadline == 0 || now < self.lbw_deadline;
        if self.game_on() && counts && open {
            self.lbw_last_buyer = *buyer;
            // Never 0, which would read as a round that hasn't started.
            self.lbw_deadline = now.saturating_add(timer.max(1)).max(1);
        }
    }

    /// Closes a finished round and returns the prize to move to `winner`: the whole pot, or
    /// nothing when the winner can't take it, in which case the pot stays for the next
    /// round. Either way the round closes, so one unpayable winner can't freeze the game.
    pub fn settle(&mut self, now: i64, winner: &Key, pot: u64, payee: &Payee) -> Result<u64, HookError> {
        if !self.game_on() {
            return Err(HookError::GameOff);
        }
        if self.lbw_deadline == 0 || now < self.lbw_deadline {
            return Err(HookError::RoundNotOver);
        }
        if *winner != self.lbw_last_buyer {
            return Err(HookError::NotTheWinner);
        }
        let prize = if payee.can_take(pot) { pot } else { 0 };
        self.lbw_last_winner = *winner;
        self.lbw_last_prize = prize;
        self.lbw_total_paid = self.lbw_total_paid.saturating_add(prize);
        self.lbw_round = self.lbw_round.saturating_add(1);
        // Back to waiting for a first buy: a second `settle` finds no round to close.
        self.lbw_last_buyer = NO_KEY;
        self.lbw_deadline = 0;
        Ok(prize)
    }
}

/// Length of a token account before its extensions.
const BASE_LEN: usize = 165;
/// Marks the bytes after the base as belonging to a token account (not a mint).
const ACCOUNT_TYPE: u8 = 2;
/// Extension Token-2022 adds to every account of a mint that has a transfer hook.
const TRANSFER_HOOK_ACCOUNT: u16 = 15;

/// The parts of a Token-2022 token account the hook reads.
pub struct TokenAccount<'a>(&'a [u8]);

impl<'a> TokenAccount<'a> {
    pub fn parse(data: &'a [u8]) -> Option<Self> {
        (data.len() >= BASE_LEN).then_some(Self(data))
    }

    fn key(&self, at: usize) -> Key {
        let mut key = NO_KEY;
        key.copy_from_slice(&self.0[at..at + 32]);
        key
    }

    pub fn mint(&self) -> Key {
        self.key(0)
    }

    pub fn owner(&self) -> Key {
        self.key(32)
    }

    pub fn amount(&self) -> u64 {
        let mut bytes = [0; 8];
        bytes.copy_from_slice(&self.0[64..72]);
        u64::from_le_bytes(bytes)
    }

    /// Token-2022 sets this flag on both accounts for exactly as long as it is calling the
    /// hook, and nothing else can write to accounts it owns. So a set flag proves the hook
    /// is running inside a real transfer.
    pub fn is_transferring(&self) -> bool {
        if self.0.get(BASE_LEN) != Some(&ACCOUNT_TYPE) {
            return false;
        }
        // Extensions follow as (type u16, length u16, value) entries; type 0 ends the list.
        let mut rest = &self.0[BASE_LEN + 1..];
        while let [t0, t1, l0, l1, tail @ ..] = rest {
            let kind = u16::from_le_bytes([*t0, *t1]);
            let len = u16::from_le_bytes([*l0, *l1]) as usize;
            if kind == 0 || tail.len() < len {
                return false;
            }
            if kind == TRANSFER_HOOK_ACCOUNT {
                return len == 1 && tail[0] == 1;
            }
            rest = &tail[len..];
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use {super::*, crate::leash::Param};

    const MINT: Key = [1; 32];
    const BUYER: Key = [2; 32];
    const VAULT_OWNER: Key = [3; 32];
    const OTHER: Key = [4; 32];
    const LEASH: Key = [5; 32];
    const T0: i64 = 1_800_000_000;
    const LAUNCH: u64 = 1_000;

    /// The token the first hook knew: a wallet cap and nothing else.
    fn rules() -> Rules {
        Rules {
            version: VERSION,
            bump: 255,
            flags: 0,
            cap_param: NO_PARAM,
            timer_param: NO_PARAM,
            _pad: [0; 3],
            mint: MINT,
            exempt_owner: VAULT_OWNER,
            leash: NO_KEY,
            max_per_wallet: 1_000,
            transfers: 0,
            launch_slot: LAUNCH,
            guard_slots: 0,
            block_limit: 0,
            block_slot: 0,
            block_bought: 0,
            lbw_timer: 0,
            lbw_min_buy: 0,
            lbw_deadline: 0,
            lbw_round: 0,
            lbw_last_buyer: NO_KEY,
            lbw_last_winner: NO_KEY,
            lbw_last_prize: 0,
            lbw_total_paid: 0,
        }
    }

    /// A token that plays Last Buyer Wins: ten minutes on the clock, buys of 100 and up count.
    fn game() -> Rules {
        Rules { flags: FLAG_LAST_BUYER_WINS, max_per_wallet: 0, lbw_timer: 600, lbw_min_buy: 100, ..rules() }
    }

    /// A token that lets at most 500 be bought per slot for its first 150 slots.
    fn guarded() -> Rules {
        Rules { max_per_wallet: 0, block_limit: 500, guard_slots: 150, ..rules() }
    }

    fn leash(values: &[i64]) -> Leash {
        let param = |value| Param { value, min: i64::MIN, max: i64::MAX, max_step: 0, cooldown: 0, last_change: 0 };
        let mut params = [param(0); MAX_PARAMS];
        for (slot, value) in params.iter_mut().zip(values) {
            *slot = param(*value);
        }
        Leash {
            version: crate::leash::VERSION,
            bump: 255,
            flags: 0,
            param_count: values.len() as u8,
            _pad: [0; 4],
            mint: MINT,
            creator: OTHER,
            agent: OTHER,
            dest: [NO_KEY; 2],
            max_per_spend: 0,
            max_per_day: 0,
            max_per_reward: 0,
            max_reward_per_day: 0,
            day_start: 0,
            spent_today: 0,
            rewarded_today: 0,
            total_spent: 0,
            total_rewarded: 0,
            params,
        }
    }

    /// An ordinary wallet that already holds some SOL.
    const WALLET: Payee = Payee { locked: false, lamports: 1_000_000, rent_floor: 890_880 };

    /// A token account as Token-2022 lays it out, with the given extensions.
    fn token_account(owner: Key, amount: u64, extensions: &[(u16, &[u8])]) -> Vec<u8> {
        let mut data = vec![0u8; BASE_LEN];
        data[..32].copy_from_slice(&MINT);
        data[32..64].copy_from_slice(&owner);
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        data.push(ACCOUNT_TYPE);
        for (kind, value) in extensions {
            data.extend_from_slice(&kind.to_le_bytes());
            data.extend_from_slice(&(value.len() as u16).to_le_bytes());
            data.extend_from_slice(value);
        }
        data
    }

    #[test]
    fn layout_is_stable() {
        assert_eq!(RULES_LEN, 272);
        // Every field gets a value of its own, then is read back at its documented offset.
        let filled = Rules {
            version: VERSION,
            bump: 0xB0,
            flags: 0xF1,
            cap_param: 0xC3,
            timer_param: 0xD4,
            _pad: [0; 3],
            mint: MINT,
            exempt_owner: VAULT_OWNER,
            leash: LEASH,
            max_per_wallet: 104,
            transfers: 112,
            launch_slot: 120,
            guard_slots: 128,
            block_limit: 136,
            block_slot: 144,
            block_bought: 152,
            lbw_timer: 160,
            lbw_min_buy: 168,
            lbw_deadline: 176,
            lbw_round: 184,
            lbw_last_buyer: BUYER,
            lbw_last_winner: OTHER,
            lbw_last_prize: 256,
            lbw_total_paid: 264,
        };
        let mut words = [0u64; RULES_LEN / 8 + 1];
        let raw = unsafe { core::slice::from_raw_parts_mut(words.as_mut_ptr() as *mut u8, RULES_LEN + 8) };
        *Rules::cast_mut(&mut raw[..RULES_LEN]).unwrap() = filled;
        assert_eq!(raw[..8], [VERSION, 0xB0, 0xF1, 0xC3, 0xD4, 0, 0, 0]);
        for (at, key) in [(8, MINT), (40, VAULT_OWNER), (72, LEASH), (192, BUYER), (224, OTHER)] {
            assert_eq!(raw[at..at + 32], key, "key at {at}");
        }
        // Each number was set to its own offset.
        for at in (104..192).step_by(8).chain([256, 264]) {
            assert_eq!(u64::from_le_bytes(raw[at..at + 8].try_into().unwrap()), at as u64, "number at {at}");
        }
        assert!(Rules::cast_mut(&mut raw[..RULES_LEN - 1]).is_none(), "too short");
        assert!(Rules::cast_mut(&mut raw[..RULES_LEN + 8]).is_none(), "too long");
        assert!(Rules::cast_mut(&mut raw[..120]).is_none(), "an account in layout 1");
        assert!(Rules::cast_mut(&mut raw[1..RULES_LEN + 1]).is_none(), "misaligned");
    }

    #[test]
    fn the_first_layout_is_still_read() {
        assert_eq!(RULES_V1_LEN, 120);
        // A first-version account, byte by byte: version, bump, the leash parameter, then
        // the three keys, the cap and the counter where today's layout also keeps them.
        let mut words = [0u64; RULES_V1_LEN / 8 + 1];
        let raw = unsafe { core::slice::from_raw_parts_mut(words.as_mut_ptr() as *mut u8, RULES_V1_LEN + 8) };
        raw[..3].copy_from_slice(&[1, 0xB0, 2]);
        for (at, key) in [(8, MINT), (40, VAULT_OWNER), (72, LEASH)] {
            raw[at..at + 32].copy_from_slice(&key);
        }
        raw[104..112].copy_from_slice(&1_000u64.to_le_bytes());
        raw[112..120].copy_from_slice(&7u64.to_le_bytes());

        let stored = RulesV1::cast_mut(&mut raw[..RULES_V1_LEN]).unwrap();
        let leashed = Rules { bump: 0xB0, leash: LEASH, cap_param: 2, transfers: 7, launch_slot: 0, ..rules() };
        assert_eq!(stored.upgraded(), Some(leashed), "the cap is in parameter 2 of its leash");
        // With no leash the cap is the fixed one, whatever the parameter byte says.
        stored.leash = NO_KEY;
        assert_eq!(stored.upgraded(), Some(Rules { leash: NO_KEY, cap_param: NO_PARAM, ..leashed }));
        // Writing the counter back lands where clients read it.
        stored.transfers = 8;
        assert_eq!(raw[112..120], 8u64.to_le_bytes());

        // Only version 1 was ever written at this size.
        for version in [0, 2, 255] {
            raw[0] = version;
            assert_eq!(RulesV1::cast_mut(&mut raw[..RULES_V1_LEN]).unwrap().upgraded(), None);
        }
        assert!(RulesV1::cast_mut(&mut raw[..RULES_V1_LEN - 1]).is_none(), "too short");
        assert!(RulesV1::cast_mut(&mut raw[..RULES_V1_LEN + 8]).is_none(), "too long");
        assert!(RulesV1::cast_mut(&mut raw[1..RULES_V1_LEN + 1]).is_none(), "misaligned");
    }

    #[test]
    fn caps_what_a_wallet_can_hold() {
        let r = rules();
        assert_eq!(r.check_receive(&BUYER, 1_000, 1_000), Ok(()));
        assert_eq!(r.check_receive(&BUYER, 1_001, 1_000), Err(HookError::OverMaxPerWallet));
        assert_eq!(r.check_receive(&BUYER, u64::MAX, 0), Ok(()), "a cap of 0 switches the rule off");
        // The curve's vault holds the whole supply, so it has to be exempt for sells to land.
        assert_eq!(r.check_receive(&VAULT_OWNER, u64::MAX, 1_000), Ok(()));
    }

    #[test]
    fn an_unset_exempt_owner_exempts_nobody() {
        let mut r = rules();
        r.exempt_owner = NO_KEY;
        assert_eq!(r.check_receive(&NO_KEY, 1_001, 1_000), Err(HookError::OverMaxPerWallet));
        // And with no curve named, nothing is a buy or a sell.
        assert_eq!(r.classify(&NO_KEY, &BUYER), Kind::Transfer);
        assert_eq!(r.classify(&BUYER, &NO_KEY), Kind::Transfer);
    }

    #[test]
    fn tells_buys_sells_and_transfers_apart() {
        let r = rules();
        assert_eq!(r.classify(&VAULT_OWNER, &BUYER), Kind::Buy);
        assert_eq!(r.classify(&BUYER, &VAULT_OWNER), Kind::Sell);
        assert_eq!(r.classify(&BUYER, &OTHER), Kind::Transfer);
        assert_eq!(r.classify(&BUYER, &BUYER), Kind::Transfer);
        // The curve moving tokens between its own accounts must never be held up either.
        assert_eq!(r.classify(&VAULT_OWNER, &VAULT_OWNER), Kind::Sell);
    }

    #[test]
    fn block_limit_refuses_the_buy_that_crosses_it() {
        let mut r = guarded();
        assert_eq!(r.count_buy(200, LAUNCH), Ok(()));
        assert_eq!(r.count_buy(300, LAUNCH), Ok(()), "exactly the limit is allowed");
        assert_eq!((r.block_slot, r.block_bought), (LAUNCH, 500));
        assert_eq!(r.count_buy(1, LAUNCH), Err(HookError::TooMuchInOneBlock));
        assert_eq!((r.block_slot, r.block_bought), (LAUNCH, 500), "a refused buy isn't counted");

        // The next slot starts from zero.
        assert_eq!(r.count_buy(500, LAUNCH + 1), Ok(()));
        assert_eq!(r.count_buy(1, LAUNCH + 1), Err(HookError::TooMuchInOneBlock));
        assert_eq!(r.count_buy(501, LAUNCH + 2), Err(HookError::TooMuchInOneBlock), "one buy can cross it alone");
        assert_eq!((r.block_slot, r.block_bought), (LAUNCH + 1, 500));
        assert_eq!(r.count_buy(0, LAUNCH + 1), Ok(()));
    }

    #[test]
    fn block_limit_is_on_tokens_not_on_trades() {
        // Dust buys can't use the block up: they only take what they bought.
        let mut r = guarded();
        for _ in 0..50 {
            assert_eq!(r.count_buy(1, LAUNCH), Ok(()));
        }
        assert_eq!(r.count_buy(450, LAUNCH), Ok(()));
        assert_eq!(r.count_buy(1, LAUNCH), Err(HookError::TooMuchInOneBlock));
    }

    #[test]
    fn block_limit_ends_with_the_guard() {
        let mut r = guarded();
        assert_eq!(r.count_buy(1, LAUNCH), Ok(()), "the first buy opens the window");
        assert!(r.guard_is_up(LAUNCH) && r.guard_is_up(LAUNCH + 149));
        assert!(!r.guard_is_up(LAUNCH + 150));
        assert_eq!(r.count_buy(501, LAUNCH + 149), Err(HookError::TooMuchInOneBlock));
        assert_eq!(r.count_buy(u64::MAX, LAUNCH + 150), Ok(()));
        assert_eq!((r.block_slot, r.block_bought), (LAUNCH, 1), "nothing is counted once the guard is down");
        assert!(r.guard_is_up(LAUNCH - 1), "a slot before the window is still guarded");

        // No guard length: the limit lasts as long as the token.
        r.guard_slots = 0;
        assert_eq!(r.count_buy(501, u64::MAX), Err(HookError::TooMuchInOneBlock));
        // No limit: nothing to guard.
        r.block_limit = 0;
        assert!(!r.guard_is_up(LAUNCH));
        assert_eq!(r.count_buy(u64::MAX, LAUNCH), Ok(()));
    }

    #[test]
    fn the_guard_window_opens_with_the_first_buy() {
        // Whoever launches a token chooses how long `init` comes before its pool. Counted
        // from `init`, the window could be over before anyone was able to buy.
        let mut r = guarded();
        assert!(r.guard_is_up(LAUNCH + 1_000_000), "no buy yet, so the window hasn't started");
        assert_eq!(r.count_buy(501, LAUNCH + 1_000), Err(HookError::TooMuchInOneBlock));
        assert_eq!((r.launch_slot, r.block_slot), (LAUNCH, 0), "a refused buy opens nothing");
        assert_eq!(r.count_buy(500, LAUNCH + 1_000), Ok(()));
        assert_eq!((r.launch_slot, r.block_slot, r.block_bought), (LAUNCH + 1_000, LAUNCH + 1_000, 500));

        // It lasts its full length from there, and later buys don't move it.
        assert_eq!(r.count_buy(200, LAUNCH + 1_149), Ok(()));
        assert_eq!(r.launch_slot, LAUNCH + 1_000);
        assert!(r.guard_is_up(LAUNCH + 1_149) && !r.guard_is_up(LAUNCH + 1_150));
    }

    #[test]
    fn block_limit_never_overflows() {
        let mut r = guarded();
        r.block_limit = u64::MAX;
        assert_eq!(r.count_buy(u64::MAX, LAUNCH), Ok(()));
        assert_eq!(r.count_buy(1, LAUNCH), Err(HookError::TooMuchInOneBlock));
        assert_eq!(r.block_bought, u64::MAX);
    }

    #[test]
    fn a_big_enough_buy_takes_the_lead_and_restarts_the_clock() {
        let mut r = game();
        r.play(&BUYER, 100, T0, 600);
        assert_eq!((r.lbw_last_buyer, r.lbw_deadline), (BUYER, T0 + 600));
        r.play(&OTHER, 5_000, T0 + 599, 600);
        assert_eq!((r.lbw_last_buyer, r.lbw_deadline), (OTHER, T0 + 1_199));

        // Too small to count, whoever sends it.
        r.play(&BUYER, 99, T0 + 700, 600);
        assert_eq!((r.lbw_last_buyer, r.lbw_deadline), (OTHER, T0 + 1_199));
    }

    #[test]
    fn nothing_moves_once_the_clock_has_run_out() {
        let mut r = game();
        r.play(&BUYER, 100, T0, 600);
        let before = r;
        r.play(&OTHER, 5_000, T0 + 600, 600);
        r.play(&OTHER, 5_000, i64::MAX, 600);
        assert_eq!(r, before, "the winner keeps the round until it is settled");
    }

    #[test]
    fn the_game_only_runs_where_it_is_on() {
        let mut r = rules();
        r.play(&BUYER, u64::MAX, T0, 600);
        assert_eq!(r, rules());

        // With no minimum every buy counts, but a transfer of nothing is not a buy.
        let mut r = game();
        r.lbw_min_buy = 0;
        r.play(&BUYER, 0, T0, 600);
        assert_eq!(r.lbw_deadline, 0);
        r.play(&BUYER, 1, T0, 600);
        assert_eq!((r.lbw_last_buyer, r.lbw_deadline), (BUYER, T0 + 600));
    }

    #[test]
    fn a_buy_is_counted_under_the_guard_and_played_after_it() {
        // Buys of 300 and up count, a slot has room for 500, the guard lasts 150 slots.
        let mut r = Rules { block_limit: 500, guard_slots: 150, lbw_min_buy: 300, ..game() };
        assert_eq!(r.buy(&BUYER, 300, LAUNCH, T0, 600), Ok(()));
        assert_eq!((r.block_bought, r.lbw_last_buyer, r.lbw_deadline), (300, NO_KEY, 0), "counted, and nobody leads");
        // The slot can be used up, but there is no lead to protect by doing so.
        assert_eq!(r.buy(&OTHER, 201, LAUNCH, T0, 600), Err(HookError::TooMuchInOneBlock));
        assert_eq!(r.buy(&OTHER, 200, LAUNCH + 149, T0, 600), Ok(()));
        assert_eq!(r.buy(&BUYER, 301, LAUNCH + 149, T0, 600), Err(HookError::TooMuchInOneBlock));
        assert_eq!(r.lbw_deadline, 0);

        // Guard down: the same buys play, and nothing is counted or refused any more.
        let counted = (r.block_slot, r.block_bought);
        assert_eq!(r.buy(&BUYER, 300, LAUNCH + 150, T0, 600), Ok(()));
        assert_eq!((r.lbw_last_buyer, r.lbw_deadline), (BUYER, T0 + 600));
        assert_eq!(r.buy(&OTHER, 299, LAUNCH + 150, T0 + 1, 600), Ok(()));
        assert_eq!(r.buy(&OTHER, 5_000, LAUNCH + 150, T0 + 2, 600), Ok(()));
        assert_eq!((r.lbw_last_buyer, r.lbw_deadline), (OTHER, T0 + 602));
        assert_eq!((r.block_slot, r.block_bought), counted);

        // A token with only the game plays from its first buy; one with only the guard never does.
        let mut r = game();
        assert_eq!(r.buy(&BUYER, 100, LAUNCH, T0, 600), Ok(()));
        assert_eq!((r.lbw_last_buyer, r.lbw_deadline), (BUYER, T0 + 600));
        let mut r = guarded();
        assert_eq!(r.buy(&BUYER, 100, LAUNCH, T0, 600), Ok(()));
        assert_eq!(r.buy(&BUYER, 100, LAUNCH + 150, T0, 600), Ok(()));
        assert_eq!((r.block_bought, r.lbw_last_buyer, r.lbw_deadline), (100, NO_KEY, 0));
    }

    #[test]
    fn the_clock_never_overflows_or_reads_as_unstarted() {
        let mut r = game();
        r.play(&BUYER, 100, i64::MAX - 10, i64::MAX);
        assert_eq!(r.lbw_deadline, i64::MAX);
        // A timer of zero or less still gives the round a second.
        let mut r = game();
        r.play(&BUYER, 100, T0, 0);
        assert_eq!(r.lbw_deadline, T0 + 1);
        r.play(&BUYER, 100, T0, i64::MIN);
        assert_eq!(r.lbw_deadline, T0 + 1);
        // A clock at or before the epoch can't produce the "not started" value.
        let mut r = game();
        r.play(&BUYER, 100, -1, 1);
        assert_eq!(r.lbw_deadline, 1);
    }

    #[test]
    fn knobs_come_from_the_account_unless_a_leash_holds_them() {
        let mut r = game();
        r.max_per_wallet = 1_000;
        assert_eq!(r.fixed_knobs(), Knobs { cap: 1_000, timer: 600 });

        // The cap in parameter 1, the timer left fixed.
        let mut r = Rules { leash: LEASH, cap_param: 1, ..game() };
        assert_eq!(r.knobs_from(&leash(&[7, 2_000])), Ok(Knobs { cap: 2_000, timer: 600 }));
        // Both in the leash.
        r.timer_param = 0;
        r.lbw_timer = 0;
        assert_eq!(r.knobs_from(&leash(&[900, 2_000])), Ok(Knobs { cap: 2_000, timer: 900 }));
    }

    #[test]
    fn a_leash_value_can_never_loosen_a_rule_by_being_odd() {
        let r = Rules { leash: LEASH, cap_param: 0, timer_param: 1, lbw_timer: 0, ..game() };
        let knobs = |cap, timer| r.knobs_from(&leash(&[cap, timer])).unwrap();
        assert_eq!(knobs(-1, 600).cap, 1, "below zero is the tightest cap, not no cap");
        assert_eq!(knobs(i64::MIN, 600).cap, 1);
        assert_eq!(knobs(0, 600).cap, 0, "zero means no cap, as it does when fixed");
        assert_eq!(knobs(i64::MAX, 600).cap, i64::MAX as u64);
        assert_eq!(knobs(5, 0).timer, 1, "a round always lasts at least a second");
        assert_eq!(knobs(5, i64::MIN).timer, 1);
        assert_eq!(knobs(5, 604_800).timer, 604_800);
        assert_eq!(knobs(5, 604_801).timer, 604_800, "and never more than a week past a buy");
        assert_eq!(knobs(5, i64::MAX).timer, 604_800);
    }

    #[test]
    fn only_reads_a_leash_that_fits_the_token() {
        let r = Rules { leash: LEASH, cap_param: 1, ..game() };
        let good = leash(&[0, 2_000]);
        assert!(r.knobs_from(&good).is_ok());
        assert_eq!(r.knobs_from(&Leash { version: 2, ..good }), Err(HookError::WrongAccount));
        assert_eq!(r.knobs_from(&Leash { mint: OTHER, ..good }), Err(HookError::WrongAccount), "another token's leash");
        // The leash was created with fewer parameters than the rules point at.
        assert_eq!(r.knobs_from(&leash(&[2_000])), Err(HookError::BadConfig));
        assert_eq!(r.knobs_from(&leash(&[])), Err(HookError::BadConfig));
        let timer_missing = Rules { cap_param: 0, timer_param: 3, lbw_timer: 0, ..r };
        assert_eq!(timer_missing.knobs_from(&leash(&[1, 2, 3])), Err(HookError::BadConfig));
        assert!(timer_missing.knobs_from(&leash(&[1, 2, 3, 4])).is_ok());
        // An index no leash can have never reads past the array, whatever the count claims.
        let past_the_end = Rules { cap_param: 4, ..r };
        assert_eq!(past_the_end.knobs_from(&Leash { param_count: 9, ..good }), Err(HookError::BadConfig));
    }

    #[test]
    fn checks_how_far_a_leash_lets_its_agent_go() {
        // The cap in parameter 0 and the clock in parameter 1, each with a range of its own.
        let ranged = |cap: (i64, i64), timer: (i64, i64)| {
            let mut leash = leash(&[1_000, 600]);
            (leash.params[0].min, leash.params[0].max) = cap;
            (leash.params[1].min, leash.params[1].max) = timer;
            leash
        };
        let r = Rules { leash: LEASH, cap_param: 0, timer_param: 1, lbw_timer: 0, ..game() };
        let clock = (60, 3_600);
        assert_eq!(r.check_leash(&ranged((100, 5_000), clock)), Ok(()));

        // A cap the agent could take under the smallest buy that counts, here 100.
        for low in [99, 1, 0, -1, i64::MIN] {
            assert_eq!(r.check_leash(&ranged((low, 5_000), clock)), Err(HookError::BadConfig), "a cap from {low}");
        }
        // A smallest buy no cap in an i64 could stay above.
        let huge = Rules { lbw_min_buy: u64::MAX, ..r };
        assert_eq!(huge.check_leash(&ranged((i64::MAX, i64::MAX), clock)), Err(HookError::BadConfig));
        // Without the game there is no lead to protect, so any range will do.
        let no_game = Rules { flags: 0, timer_param: NO_PARAM, lbw_min_buy: 0, ..r };
        assert_eq!(no_game.check_leash(&ranged((i64::MIN, i64::MAX), clock)), Ok(()));

        // A clock the agent could stretch past a week.
        assert_eq!(r.check_leash(&ranged((100, 5_000), (60, MAX_TIMER))), Ok(()));
        assert_eq!(r.check_leash(&ranged((100, 5_000), (60, MAX_TIMER + 1))), Err(HookError::BadConfig));
        assert_eq!(r.check_leash(&ranged((100, 5_000), (i64::MIN, i64::MAX))), Err(HookError::BadConfig));
        // Only the numbers the rules take from the leash are held to anything.
        let fixed_clock = Rules { timer_param: NO_PARAM, lbw_timer: 600, ..r };
        assert_eq!(fixed_clock.check_leash(&ranged((100, 5_000), (0, i64::MAX))), Ok(()));
        let fixed_cap = Rules { cap_param: NO_PARAM, ..r };
        assert_eq!(fixed_cap.check_leash(&ranged((i64::MIN, 5), clock)), Ok(()));

        // And it is still a leash this token can read at all.
        assert_eq!(r.check_leash(&Leash { mint: OTHER, ..ranged((100, 5_000), clock) }), Err(HookError::WrongAccount));
        assert_eq!(r.check_leash(&leash(&[1_000])), Err(HookError::BadConfig), "no parameter 1");
    }

    #[test]
    fn validates_config() {
        let leashed = Rules { leash: LEASH, cap_param: 0, max_per_wallet: 0, ..rules() };
        let leashed_game = Rules { leash: LEASH, timer_param: 1, lbw_timer: 0, ..game() };
        for good in [rules(), game(), guarded(), leashed, leashed_game] {
            assert_eq!(good.validate(), Ok(()));
        }
        assert_eq!(Rules { cap_param: 0, timer_param: 1, lbw_timer: 0, ..leashed_game }.validate(), Ok(()));
        // Nothing switched on at all is a valid token too.
        assert_eq!(Rules { max_per_wallet: 0, exempt_owner: NO_KEY, ..rules() }.validate(), Ok(()));

        let bad = |rules: Rules| assert_eq!(rules.validate(), Err(HookError::BadConfig));
        // Flags nobody defined.
        bad(Rules { flags: 2, ..rules() });
        bad(Rules { flags: FLAG_LAST_BUYER_WINS | 0x80, ..game() });
        // Parameter indexes: past what a leash can hold, without a leash, or shared.
        bad(Rules { cap_param: 4, ..leashed });
        bad(Rules { cap_param: 0xFE, ..leashed });
        bad(Rules { timer_param: 4, ..leashed_game });
        bad(Rules { leash: NO_KEY, ..leashed });
        bad(Rules { leash: NO_KEY, ..leashed_game });
        bad(Rules { cap_param: 1, ..leashed_game });
        // A leash nothing reads, or a number given twice.
        bad(Rules { leash: LEASH, ..rules() });
        bad(Rules { max_per_wallet: 1_000, ..leashed });
        bad(Rules { lbw_timer: 600, ..leashed_game });
        // Buys can't be told apart without the curve's vault owner.
        bad(Rules { exempt_owner: NO_KEY, ..game() });
        bad(Rules { exempt_owner: NO_KEY, ..guarded() });
        // Nor can the vault be left out of a cap: every sell into it would be refused.
        bad(Rules { exempt_owner: NO_KEY, ..rules() });
        bad(Rules { exempt_owner: NO_KEY, ..leashed });
        // A guard window with nothing to guard.
        bad(Rules { block_limit: 0, ..guarded() });
        // A game with no clock, with a clock that runs backwards, or with one so long that
        // a round would never be paid.
        bad(Rules { lbw_timer: 0, ..game() });
        bad(Rules { lbw_timer: -600, ..game() });
        bad(Rules { lbw_timer: 604_801, ..game() });
        bad(Rules { lbw_timer: i64::MAX, ..game() });
        assert_eq!(Rules { lbw_timer: 604_800, ..game() }.validate(), Ok(()), "a week is the longest");
        assert_eq!(Rules { lbw_timer: 1, ..game() }.validate(), Ok(()));
        // Game settings on a token that doesn't play.
        bad(Rules { flags: 0, ..game() });
        bad(Rules { lbw_min_buy: 100, ..rules() });
        bad(Rules { flags: 0, ..leashed_game });
        bad(Rules { leash: LEASH, timer_param: 1, max_per_wallet: 0, ..rules() });
        // A smallest buy that no buy can reach.
        bad(Rules { max_per_wallet: 99, ..game() });
        assert_eq!(Rules { max_per_wallet: 100, ..game() }.validate(), Ok(()));
        // The game waits for the guard to come down, so the guard has to end, and within
        // about a day.
        bad(Rules { block_limit: 500, ..game() });
        bad(Rules { block_limit: 500, guard_slots: 216_001, ..game() });
        assert_eq!(Rules { block_limit: 500, guard_slots: 216_000, ..game() }.validate(), Ok(()));
        assert_eq!(Rules { block_limit: 99, guard_slots: 150, ..game() }.validate(), Ok(()), "smaller than a buy that counts, but gone when the game starts");
        // Without the game a guard can last as long as the creator likes.
        assert_eq!(Rules { guard_slots: u64::MAX, ..guarded() }.validate(), Ok(()));
    }

    /// A round that BUYER leads and that ends at T0 + 600.
    fn running() -> Rules {
        let mut r = game();
        r.play(&BUYER, 100, T0, 600);
        r
    }

    #[test]
    fn settle_needs_a_finished_round_and_its_winner() {
        let mut off = rules();
        assert_eq!(off.settle(T0, &BUYER, 5, &WALLET), Err(HookError::GameOff));

        let mut waiting = game();
        assert_eq!(waiting.settle(i64::MAX, &NO_KEY, 5, &WALLET), Err(HookError::RoundNotOver), "no round to close");

        let mut r = running();
        assert_eq!(r.settle(T0 + 599, &BUYER, 5, &WALLET), Err(HookError::RoundNotOver));
        assert_eq!(r.settle(T0 + 600, &OTHER, 5, &WALLET), Err(HookError::NotTheWinner));
        assert_eq!(r.settle(T0 + 600, &NO_KEY, 5, &WALLET), Err(HookError::NotTheWinner));
        assert_eq!(r, running(), "a refused settle changes nothing");
    }

    #[test]
    fn settle_pays_the_pot_once_and_opens_the_next_round() {
        let mut r = running();
        assert_eq!(r.settle(T0 + 600, &BUYER, 5_000, &WALLET), Ok(5_000));
        assert_eq!((r.lbw_last_winner, r.lbw_last_prize, r.lbw_total_paid, r.lbw_round), (BUYER, 5_000, 5_000, 1));
        assert_eq!((r.lbw_last_buyer, r.lbw_deadline), (NO_KEY, 0));

        // The same round can't pay again, to the winner or to "nobody".
        assert_eq!(r.settle(T0 + 601, &BUYER, 5_000, &WALLET), Err(HookError::RoundNotOver));
        assert_eq!(r.settle(T0 + 601, &NO_KEY, 5_000, &WALLET), Err(HookError::RoundNotOver));

        // The next first buy starts a new round, and its winner is paid in turn.
        r.play(&OTHER, 100, T0 + 700, 600);
        assert_eq!((r.lbw_last_buyer, r.lbw_deadline), (OTHER, T0 + 1_300));
        assert_eq!(r.settle(T0 + 1_300, &BUYER, 70, &WALLET), Err(HookError::NotTheWinner));
        assert_eq!(r.settle(T0 + 1_300, &OTHER, 70, &WALLET), Ok(70));
        assert_eq!((r.lbw_last_winner, r.lbw_last_prize, r.lbw_total_paid, r.lbw_round), (OTHER, 70, 5_070, 2));
    }

    #[test]
    fn a_winner_that_cannot_be_paid_rolls_the_pot_over() {
        let locked = Payee { locked: true, ..WALLET };
        let empty = Payee { locked: false, lamports: 0, rent_floor: 890_880 };
        for (payee, pot) in [(locked, 5_000), (empty, 890_879)] {
            let mut r = running();
            assert_eq!(r.settle(T0 + 600, &BUYER, pot, &payee), Ok(0));
            assert_eq!((r.lbw_last_winner, r.lbw_last_prize, r.lbw_total_paid, r.lbw_round), (BUYER, 0, 0, 1));
            assert_eq!((r.lbw_last_buyer, r.lbw_deadline), (NO_KEY, 0), "the round still closes");
        }
        // An empty pot closes the round too.
        let mut r = running();
        assert_eq!(r.settle(T0 + 600, &BUYER, 0, &WALLET), Ok(0));
        assert_eq!(r.lbw_round, 1);
    }

    #[test]
    fn a_payee_takes_a_prize_only_if_it_stays_rent_exempt() {
        let empty = Payee { locked: false, lamports: 0, rent_floor: 890_880 };
        assert!(!empty.can_take(890_879));
        assert!(empty.can_take(890_880));
        assert!(!Payee { lamports: 1, rent_floor: 1_000, ..empty }.can_take(998));
        assert!(Payee { lamports: 1, rent_floor: 1_000, ..empty }.can_take(999));
        assert!(WALLET.can_take(0) && WALLET.can_take(1));
        assert!(!Payee { locked: true, ..WALLET }.can_take(1));
        assert!(!Payee { lamports: u64::MAX, ..WALLET }.can_take(1), "never overflows");
    }

    #[test]
    fn totals_never_overflow() {
        let mut r = running();
        r.lbw_total_paid = u64::MAX - 1;
        r.lbw_round = u64::MAX;
        assert_eq!(r.settle(T0 + 600, &BUYER, 5_000, &WALLET), Ok(5_000));
        assert_eq!((r.lbw_total_paid, r.lbw_round), (u64::MAX, u64::MAX));
    }

    #[test]
    fn reads_a_token_account() {
        let data = token_account(BUYER, 4_242, &[(7, &[]), (15, &[1])]);
        let account = TokenAccount::parse(&data).unwrap();
        assert_eq!(account.mint(), MINT);
        assert_eq!(account.owner(), BUYER);
        assert_eq!(account.amount(), 4_242);
        assert!(TokenAccount::parse(&data[..BASE_LEN - 1]).is_none());
    }

    #[test]
    fn only_trusts_the_transferring_flag_token_2022_sets() {
        let flag = |extensions: &[(u16, &[u8])]| {
            let data = token_account(BUYER, 1, extensions);
            TokenAccount::parse(&data).unwrap().is_transferring()
        };
        assert!(flag(&[(15, &[1])]));
        assert!(flag(&[(7, &[]), (15, &[1])]), "after another extension");
        assert!(!flag(&[(15, &[0])]), "flag down: not in a transfer");
        assert!(!flag(&[(15, &[2])]) && !flag(&[(15, &[255])]), "only 1 is the flag");
        assert!(!flag(&[(7, &[])]), "no transfer-hook extension");
        assert!(!flag(&[]), "no extensions");
        assert!(!flag(&[(0, &[]), (15, &[1])]), "type 0 ends the list");
        assert!(!flag(&[(15, &[])]), "empty value");

        // A plain 165-byte account, a mint-typed account, and truncated extensions.
        let bare = token_account(BUYER, 1, &[]);
        assert!(!TokenAccount::parse(&bare[..BASE_LEN]).unwrap().is_transferring());
        let mut mint_typed = token_account(BUYER, 1, &[(15, &[1])]);
        mint_typed[BASE_LEN] = 1;
        assert!(!TokenAccount::parse(&mint_typed).unwrap().is_transferring());
        let cut = token_account(BUYER, 1, &[(7, &[9, 9, 9, 9]), (15, &[1])]);
        assert!(!TokenAccount::parse(&cut[..BASE_LEN + 4]).unwrap().is_transferring());
        assert!(!TokenAccount::parse(&cut[..BASE_LEN + 7]).unwrap().is_transferring(), "value cut short");
    }
}
