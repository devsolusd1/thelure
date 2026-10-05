//! The leash account and the limits it enforces.
//!
//! Nothing in this module touches the Solana runtime: the processor hands it the
//! clock and the available budget, and it answers yes or no. That keeps every
//! limit unit-testable on the host.

/// Layout version written to every leash.
pub const VERSION: u8 = 1;
/// Tunable parameters a leash can carry.
pub const MAX_PARAMS: usize = 4;
/// Length of a spending window, in seconds.
pub const DAY: i64 = 86_400;

/// The creator can still revoke the agent, but can never put another one in its place.
pub const FLAG_AGENT_LOCKED: u8 = 1;

pub type Key = [u8; 32];
/// "Nobody": an unset destination, or a revoked agent.
pub const NO_KEY: Key = [0; 32];

/// Returned to the client as `ProgramError::Custom(code)`.
#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeashError {
    /// The signer is not this leash's agent, or the agent was revoked.
    NotAgent = 0,
    /// The signer is not this leash's creator.
    NotCreator = 1,
    /// The destination is not one this leash allows.
    BadDestination = 2,
    /// The amount is above the per-action cap (a cap of 0 switches the action off).
    OverActionCap = 3,
    /// The amount would take the day's total above the daily cap.
    OverDailyCap = 4,
    /// The leash doesn't hold that much above its rent reserve.
    OverBudget = 5,
    /// No parameter at that index.
    BadParam = 6,
    /// The value is outside the parameter's range.
    ParamOutOfBounds = 7,
    /// The value moves the parameter further than one change allows.
    ParamStepTooBig = 8,
    /// The parameter changed too recently.
    ParamCooldown = 9,
    /// The agent is locked, so the creator can only revoke it.
    AgentLocked = 10,
    /// Only a revoked leash can be swept.
    NotRevoked = 11,
    /// The limits passed to `init` contradict each other.
    BadConfig = 12,
    /// Nothing to move.
    ZeroAmount = 13,
}

/// A knob the agent may turn, within limits fixed at launch. A hook reads `value`.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Param {
    pub value: i64,
    pub min: i64,
    pub max: i64,
    /// Furthest one change may move the value; 0 means anywhere inside `min..=max`.
    pub max_step: u64,
    /// Seconds that must pass between changes. Counted from launch for the first one.
    pub cooldown: i64,
    /// Unix time of the last change (the launch, until the agent changes it).
    pub last_change: i64,
}

/// One leash per (token, creator). Its lamports above the rent reserve are the agent's budget.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Leash {
    pub version: u8,
    pub bump: u8,
    pub flags: u8,
    pub param_count: u8,
    pub _pad: [u8; 4],
    pub mint: Key,
    pub creator: Key,
    /// The only key that may spend, reward or tune. `NO_KEY` once revoked.
    pub agent: Key,
    /// The only accounts `spend` can pay. `dest[1]` is optional.
    pub dest: [Key; 2],
    pub max_per_spend: u64,
    pub max_per_day: u64,
    /// Rewards go to any account, so they get their own, usually much smaller, caps.
    pub max_per_reward: u64,
    pub max_reward_per_day: u64,
    /// Start of the current spending window.
    pub day_start: i64,
    pub spent_today: u64,
    pub rewarded_today: u64,
    pub total_spent: u64,
    pub total_rewarded: u64,
    pub params: [Param; MAX_PARAMS],
}

pub const LEASH_LEN: usize = core::mem::size_of::<Leash>();
const _: () = assert!(LEASH_LEN == 432);
const _: () = assert!(core::mem::align_of::<Leash>() == 8);

impl Leash {
    /// Views account data as a leash, checking length and alignment only.
    pub fn cast_mut(bytes: &mut [u8]) -> Option<&mut Leash> {
        if bytes.len() != LEASH_LEN || bytes.as_ptr() as usize % core::mem::align_of::<Leash>() != 0 {
            return None;
        }
        // SAFETY: the length and alignment were just checked, the borrow is exclusive, and
        // `Leash` is plain integers and byte arrays with no padding, so any bytes are valid.
        Some(unsafe { &mut *(bytes.as_mut_ptr() as *mut Leash) })
    }

    /// Checks a freshly filled leash before it is stored.
    pub fn validate(&self) -> Result<(), LeashError> {
        let count = self.param_count as usize;
        let ok = self.agent != NO_KEY
            && self.flags & !FLAG_AGENT_LOCKED == 0
            && count <= MAX_PARAMS
            && self.max_per_spend <= self.max_per_day
            && self.max_per_reward <= self.max_reward_per_day
            && (self.max_per_day == 0 || self.dest[0] != NO_KEY)
            && self.params[..count.min(MAX_PARAMS)]
                .iter()
                .all(|p| p.min <= p.value && p.value <= p.max && p.cooldown >= 0);
        if ok {
            Ok(())
        } else {
            Err(LeashError::BadConfig)
        }
    }

    pub fn is_agent(&self, key: &Key) -> bool {
        self.agent != NO_KEY && self.agent == *key
    }

    /// Whether `spend` may pay `key`.
    pub fn allows_destination(&self, index: usize, key: &Key) -> bool {
        *key != NO_KEY && self.dest.get(index) == Some(key)
    }

    // Windows are fixed, not sliding: one that is used up late and the next one used up
    // early can put two days' worth close together.
    fn roll_day(&mut self, now: i64) {
        if now.saturating_sub(self.day_start) >= DAY {
            self.day_start = now;
            self.spent_today = 0;
            self.rewarded_today = 0;
        }
    }

    /// Accounts for `amount` going to one of the fixed destinations.
    pub fn spend(&mut self, amount: u64, now: i64, budget: u64) -> Result<(), LeashError> {
        self.roll_day(now);
        self.spent_today = within_caps(amount, budget, self.max_per_spend, self.max_per_day, self.spent_today)?;
        self.total_spent = self.total_spent.saturating_add(amount);
        Ok(())
    }

    /// Accounts for `amount` going to an account of the agent's choosing.
    pub fn reward(&mut self, amount: u64, now: i64, budget: u64) -> Result<(), LeashError> {
        self.roll_day(now);
        self.rewarded_today =
            within_caps(amount, budget, self.max_per_reward, self.max_reward_per_day, self.rewarded_today)?;
        self.total_rewarded = self.total_rewarded.saturating_add(amount);
        Ok(())
    }

    /// Turns a knob, if the new value respects its range, step and cooldown.
    pub fn set_param(&mut self, index: usize, value: i64, now: i64) -> Result<(), LeashError> {
        if index >= self.param_count as usize {
            return Err(LeashError::BadParam);
        }
        let param = self.params.get_mut(index).ok_or(LeashError::BadParam)?;
        if value < param.min || value > param.max {
            return Err(LeashError::ParamOutOfBounds);
        }
        if param.max_step != 0 && value.abs_diff(param.value) > param.max_step {
            return Err(LeashError::ParamStepTooBig);
        }
        if now.saturating_sub(param.last_change) < param.cooldown {
            return Err(LeashError::ParamCooldown);
        }
        param.value = value;
        param.last_change = now;
        Ok(())
    }

    /// Revokes the agent (`NO_KEY`) or, unless the leash is locked, replaces it.
    pub fn set_agent(&mut self, new_agent: Key) -> Result<(), LeashError> {
        if new_agent != NO_KEY && self.flags & FLAG_AGENT_LOCKED != 0 {
            return Err(LeashError::AgentLocked);
        }
        self.agent = new_agent;
        Ok(())
    }
}

/// Returns the day's new total if `amount` fits every limit.
fn within_caps(amount: u64, budget: u64, per_action: u64, per_day: u64, today: u64) -> Result<u64, LeashError> {
    if amount == 0 {
        return Err(LeashError::ZeroAmount);
    }
    if amount > per_action {
        return Err(LeashError::OverActionCap);
    }
    let total = today.checked_add(amount).ok_or(LeashError::OverDailyCap)?;
    if total > per_day {
        return Err(LeashError::OverDailyCap);
    }
    if amount > budget {
        return Err(LeashError::OverBudget);
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT: Key = [7; 32];
    const POT: Key = [9; 32];
    const T0: i64 = 1_800_000_000;
    const SOL: u64 = 1_000_000_000;

    fn param(value: i64, min: i64, max: i64, max_step: u64, cooldown: i64) -> Param {
        Param { value, min, max, max_step, cooldown, last_change: T0 }
    }

    fn leash() -> Leash {
        let off = param(0, 0, 0, 0, 0);
        Leash {
            version: VERSION,
            bump: 255,
            flags: 0,
            param_count: 1,
            _pad: [0; 4],
            mint: [1; 32],
            creator: [2; 32],
            agent: AGENT,
            dest: [POT, NO_KEY],
            max_per_spend: SOL,
            max_per_day: 3 * SOL,
            max_per_reward: SOL / 20,
            max_reward_per_day: SOL / 2,
            day_start: T0,
            spent_today: 0,
            rewarded_today: 0,
            total_spent: 0,
            total_rewarded: 0,
            // Last Buyer Wins clock, in seconds: 5 to 30 minutes, 5 minutes a move, once an hour.
            params: [param(600, 300, 1800, 300, 3600), off, off, off],
        }
    }

    #[test]
    fn layout_is_stable() {
        assert_eq!(LEASH_LEN, 432);
        assert_eq!(core::mem::size_of::<Param>(), 48);
        // Backed by u64s so the start is aligned, with a spare word to slide along.
        let mut words = [0u64; LEASH_LEN / 8 + 1];
        let raw = unsafe { core::slice::from_raw_parts_mut(words.as_mut_ptr() as *mut u8, LEASH_LEN + 8) };
        *Leash::cast_mut(&mut raw[..LEASH_LEN]).unwrap() = leash();
        assert_eq!(raw[0], VERSION);
        assert_eq!(&raw[72..104], &AGENT);
        assert_eq!(&raw[104..136], &POT);
        assert_eq!(u64::from_le_bytes(raw[168..176].try_into().unwrap()), SOL);
        assert_eq!(i64::from_le_bytes(raw[240..248].try_into().unwrap()), 600);
        assert!(Leash::cast_mut(&mut raw[..LEASH_LEN - 1]).is_none(), "too short");
        assert!(Leash::cast_mut(&mut raw[1..LEASH_LEN + 1]).is_none(), "misaligned");
    }

    #[test]
    fn validates_config() {
        assert_eq!(leash().validate(), Ok(()));
        let bad = |edit: fn(&mut Leash)| {
            let mut l = leash();
            edit(&mut l);
            l.validate()
        };
        assert_eq!(bad(|l| l.agent = NO_KEY), Err(LeashError::BadConfig));
        assert_eq!(bad(|l| l.flags = 2), Err(LeashError::BadConfig));
        assert_eq!(bad(|l| l.param_count = 5), Err(LeashError::BadConfig));
        assert_eq!(bad(|l| l.max_per_spend = l.max_per_day + 1), Err(LeashError::BadConfig));
        assert_eq!(bad(|l| l.max_per_reward = l.max_reward_per_day + 1), Err(LeashError::BadConfig));
        assert_eq!(bad(|l| l.dest[0] = NO_KEY), Err(LeashError::BadConfig));
        assert_eq!(bad(|l| l.params[0].value = 200), Err(LeashError::BadConfig));
        assert_eq!(bad(|l| l.params[0].cooldown = -1), Err(LeashError::BadConfig));
        // A leash that can't spend needs no destination, and unused params aren't checked.
        assert_eq!(bad(|l| { l.max_per_spend = 0; l.max_per_day = 0; l.dest[0] = NO_KEY }), Ok(()));
        assert_eq!(bad(|l| l.params[3].value = 99), Ok(()));
    }

    #[test]
    fn only_the_agent_and_the_listed_destinations() {
        let l = leash();
        assert!(l.is_agent(&AGENT));
        assert!(!l.is_agent(&[8; 32]));
        assert!(l.allows_destination(0, &POT));
        assert!(!l.allows_destination(0, &[8; 32]));
        assert!(!l.allows_destination(1, &POT));
        assert!(!l.allows_destination(1, &NO_KEY), "an unset slot pays nobody");
        assert!(!l.allows_destination(2, &POT));
        let mut revoked = l;
        revoked.set_agent(NO_KEY).unwrap();
        assert!(!revoked.is_agent(&AGENT));
        assert!(!revoked.is_agent(&NO_KEY), "nobody can sign as the revoked agent");
    }

    #[test]
    fn spend_respects_every_cap() {
        let mut l = leash();
        let budget = 10 * SOL;
        assert_eq!(l.spend(0, T0, budget), Err(LeashError::ZeroAmount));
        assert_eq!(l.spend(SOL + 1, T0, budget), Err(LeashError::OverActionCap));
        assert_eq!(l.spend(SOL, T0, SOL - 1), Err(LeashError::OverBudget));
        for _ in 0..3 {
            assert_eq!(l.spend(SOL, T0 + 10, budget), Ok(()));
        }
        assert_eq!(l.spend(1, T0 + 20, budget), Err(LeashError::OverDailyCap));
        assert_eq!((l.spent_today, l.total_spent), (3 * SOL, 3 * SOL));
        // The reward caps are separate.
        assert_eq!(l.reward(SOL / 20, T0 + 20, budget), Ok(()));
    }

    #[test]
    fn day_rolls_over() {
        let mut l = leash();
        let budget = 100 * SOL;
        for _ in 0..3 {
            l.spend(SOL, T0, budget).unwrap();
        }
        assert_eq!(l.spend(SOL, T0 + DAY - 1, budget), Err(LeashError::OverDailyCap));
        assert_eq!(l.spend(SOL, T0 + DAY, budget), Ok(()));
        assert_eq!((l.day_start, l.spent_today, l.total_spent), (T0 + DAY, SOL, 4 * SOL));
        // A clock that steps backwards doesn't open a new window.
        l.spend(SOL, T0, budget).unwrap();
        l.spend(SOL, T0, budget).unwrap();
        assert_eq!(l.spend(SOL, i64::MIN, budget), Err(LeashError::OverDailyCap));
    }

    #[test]
    fn rewards_are_capped_and_off_at_zero() {
        let mut l = leash();
        let budget = 10 * SOL;
        assert_eq!(l.reward(SOL / 20 + 1, T0, budget), Err(LeashError::OverActionCap));
        for _ in 0..10 {
            assert_eq!(l.reward(SOL / 20, T0, budget), Ok(()));
        }
        assert_eq!(l.reward(1, T0, budget), Err(LeashError::OverDailyCap));
        assert_eq!(l.total_rewarded, SOL / 2);
        assert_eq!(l.spent_today, 0);

        let mut off = leash();
        off.max_per_reward = 0;
        off.max_reward_per_day = 0;
        assert_eq!(off.reward(1, T0, budget), Err(LeashError::OverActionCap));
    }

    #[test]
    fn totals_never_overflow() {
        let mut l = leash();
        l.max_per_spend = u64::MAX;
        l.max_per_day = u64::MAX;
        l.spend(u64::MAX, T0, u64::MAX).unwrap();
        assert_eq!(l.spend(1, T0, u64::MAX), Err(LeashError::OverDailyCap));
        assert_eq!(l.spend(1, T0 + DAY, u64::MAX), Ok(()));
        assert_eq!(l.total_spent, u64::MAX);
    }

    #[test]
    fn params_stay_inside_their_limits() {
        let mut l = leash();
        let later = T0 + 3600;
        assert_eq!(l.set_param(1, 0, later), Err(LeashError::BadParam));
        assert_eq!(l.set_param(0, 299, later), Err(LeashError::ParamOutOfBounds));
        assert_eq!(l.set_param(0, 1801, later), Err(LeashError::ParamOutOfBounds));
        assert_eq!(l.set_param(0, 1200, later), Err(LeashError::ParamStepTooBig));
        assert_eq!(l.set_param(0, 900, T0 + 3599), Err(LeashError::ParamCooldown), "counted from launch");
        assert_eq!(l.set_param(0, 900, later), Ok(()));
        assert_eq!((l.params[0].value, l.params[0].last_change), (900, later));
        assert_eq!(l.set_param(0, 600, later + 3599), Err(LeashError::ParamCooldown));
        assert_eq!(l.set_param(0, 600, later + 3600), Ok(()));
    }

    #[test]
    fn param_edges() {
        let mut l = leash();
        // No step limit: anywhere in range, in one move.
        l.params[0] = param(0, i64::MIN, i64::MAX, 0, 0);
        assert_eq!(l.set_param(0, i64::MAX, T0), Ok(()));
        assert_eq!(l.set_param(0, i64::MIN, T0), Ok(()));
        // A step limit holds across the whole i64 range without overflowing.
        l.params[0] = param(i64::MIN, i64::MIN, i64::MAX, 10, 0);
        assert_eq!(l.set_param(0, i64::MAX, T0), Err(LeashError::ParamStepTooBig));
        assert_eq!(l.set_param(0, i64::MIN + 10, T0), Ok(()));
    }

    #[test]
    fn creator_can_replace_or_revoke() {
        let mut l = leash();
        assert_eq!(l.set_agent([8; 32]), Ok(()));
        assert!(l.is_agent(&[8; 32]) && !l.is_agent(&AGENT));
        assert_eq!(l.set_agent(NO_KEY), Ok(()));
        assert_eq!(l.set_agent(AGENT), Ok(()), "an unlocked leash can be armed again");
    }

    #[test]
    fn locked_agent_can_only_be_revoked() {
        let mut l = leash();
        l.flags = FLAG_AGENT_LOCKED;
        assert_eq!(l.set_agent([8; 32]), Err(LeashError::AgentLocked));
        assert!(l.is_agent(&AGENT));
        assert_eq!(l.set_agent(NO_KEY), Ok(()));
        assert_eq!(l.set_agent(AGENT), Err(LeashError::AgentLocked), "revoking a locked leash is final");
    }
}
