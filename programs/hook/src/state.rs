//! What the hook stores per token, and how it reads the accounts Token-2022 hands it.
//!
//! Nothing here touches the Solana runtime, so the rule can be unit tested on the host.

/// Layout version written to every rules account.
pub const VERSION: u8 = 1;

pub type Key = [u8; 32];
/// "Nobody": no leash, or no exempt owner.
pub const NO_KEY: Key = [0; 32];

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
}

/// One per token. Fixed at `init`, except for the counter.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rules {
    pub version: u8,
    pub bump: u8,
    /// Which leash parameter holds the cap, when `leash` is set.
    pub leash_param: u8,
    pub _pad: [u8; 5],
    pub mint: Key,
    /// Token accounts owned by this key are never capped: the bonding curve's own vault.
    pub exempt_owner: Key,
    /// When set, the cap is read from this leash, so the token's agent can tune it.
    pub leash: Key,
    /// Most a wallet may hold right after receiving, in base units. 0 means no cap.
    pub max_per_wallet: u64,
    /// Transfers the hook has let through.
    pub transfers: u64,
}

pub const RULES_LEN: usize = core::mem::size_of::<Rules>();
const _: () = assert!(RULES_LEN == 120);
const _: () = assert!(core::mem::align_of::<Rules>() == 8);

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

    /// Whether a wallet may end up holding `balance_after` once a transfer lands.
    pub fn check_receive(&self, owner: &Key, balance_after: u64, cap: u64) -> Result<(), HookError> {
        let exempt = self.exempt_owner != NO_KEY && self.exempt_owner == *owner;
        if cap != 0 && !exempt && balance_after > cap {
            return Err(HookError::OverMaxPerWallet);
        }
        Ok(())
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
    use super::*;

    const MINT: Key = [1; 32];
    const BUYER: Key = [2; 32];
    const VAULT_OWNER: Key = [3; 32];

    fn rules() -> Rules {
        Rules {
            version: VERSION,
            bump: 255,
            leash_param: 0,
            _pad: [0; 5],
            mint: MINT,
            exempt_owner: VAULT_OWNER,
            leash: NO_KEY,
            max_per_wallet: 1_000,
            transfers: 0,
        }
    }

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
        assert_eq!(RULES_LEN, 120);
        let mut words = [0u64; RULES_LEN / 8 + 1];
        let raw = unsafe { core::slice::from_raw_parts_mut(words.as_mut_ptr() as *mut u8, RULES_LEN + 8) };
        *Rules::cast_mut(&mut raw[..RULES_LEN]).unwrap() = rules();
        assert_eq!(raw[0], VERSION);
        assert_eq!(&raw[8..40], &MINT);
        assert_eq!(&raw[40..72], &VAULT_OWNER);
        assert_eq!(u64::from_le_bytes(raw[104..112].try_into().unwrap()), 1_000);
        assert!(Rules::cast_mut(&mut raw[..RULES_LEN - 1]).is_none(), "too short");
        assert!(Rules::cast_mut(&mut raw[1..RULES_LEN + 1]).is_none(), "misaligned");
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
