//! The compiled hook, run inside LiteSVM behind the real Token-2022 program: every
//! transfer here goes through Token-2022, which is what calls the hook.
//!
//! The "curve" in these tests is a token account owned by a key that plays Meteora's pool
//! authority. Tokens leaving it are buys, tokens arriving at it are sells.
//!
//! Build both programs first (`cargo build-sbf` in `../hook` and `../leash`) and point
//! `HOOK_SO` / `LEASH_SO` at the `.so` files if they aren't in the default target directory.
//! Set `HOOK_QUIET` when `HOOK_SO` is a hook built without its probe, which logs nothing.

use {
    litesvm::{
        types::{TransactionMetadata, TransactionResult},
        LiteSVM,
    },
    lure_hook::{
        processor::{ACCOUNT_LIST_SEED, EXECUTE, INIT, LEASH_PROGRAM, RULES_SEED, SETTLE, TOKEN_2022},
        state::{HookError, Rules, FLAG_LAST_BUYER_WINS, NO_PARAM, RULES_LEN, VERSION},
    },
    lure_leash::processor::{tag as leash_tag, SEED as LEASH_SEED},
    solana_account::Account,
    solana_address::Address,
    solana_clock::Clock,
    solana_instruction::{account_meta::AccountMeta, Instruction},
    solana_instruction_error::InstructionError,
    solana_keypair::Keypair,
    solana_message::Message,
    solana_signer::Signer,
    solana_system_interface::instruction::{create_account, transfer as send_sol},
    solana_transaction::Transaction,
    solana_transaction_error::TransactionError,
};

const SOL: u64 = 1_000_000_000;
const DECIMALS: u8 = 6;
const TOKEN: u64 = 1_000_000;
const SUPPLY: u64 = 1_000_000_000 * TOKEN;
/// One percent of supply.
const CAP: u64 = 10_000_000 * TOKEN;

/// Every world starts at this time and slot, so neither is zero by accident.
const T0: i64 = 1_800_000_000;
const LAUNCH_SLOT: u64 = 5_000;
/// The game these tests play: ten minutes on the clock, buys of 1,000 tokens and up count.
const TIMER: i64 = 600;
const MIN_BUY: u64 = 1_000 * TOKEN;
/// The guard these tests use: half a percent of supply per slot, for the first 150 slots.
const BLOCK_LIMIT: u64 = 5_000_000 * TOKEN;
const GUARD_SLOTS: u64 = 150;
/// The longest game clock the hook accepts, written out so a change to it is noticed here.
const WEEK: i64 = 604_800;
/// The longest guard the hook accepts on a token that plays: about a day of slots.
const DAY_OF_SLOTS: u64 = 216_000;

const SYSTEM_PROGRAM: Address = Address::new_from_array([0; 32]);
const HOOK: Address = Address::new_from_array([0x48; 32]);
const ATA_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const CLOCK_SYSVAR: Address = Address::from_str_const("SysvarC1ock11111111111111111111111111111111");
/// Owns every sysvar, and has no account of its own.
const SYSVAR_OWNER: Address = Address::from_str_const("Sysvar1111111111111111111111111111111111111");
/// A mint with only the transfer-hook extension: 165 padded base, the account type byte,
/// and one extension entry (4-byte header, authority, hook program).
const MINT_LEN: usize = 165 + 1 + 4 + 64;

fn so(var: &str, default: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| format!("{}/{default}", env!("CARGO_MANIFEST_DIR")))
}

fn ata(owner: &Address, mint: &Address) -> Address {
    Address::find_program_address(&[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

fn rules_of(mint: &Address) -> (Address, u8) {
    Address::find_program_address(&[RULES_SEED, mint.as_ref()], &HOOK)
}

fn list_of(mint: &Address) -> (Address, u8) {
    Address::find_program_address(&[ACCOUNT_LIST_SEED, mint.as_ref()], &HOOK)
}

/// The data of an `init` call, field by field.
#[derive(Clone, Copy)]
struct Init {
    flags: u8,
    cap_param: u8,
    timer_param: u8,
    exempt_owner: Address,
    leash: Address,
    max_per_wallet: u64,
    guard_slots: u64,
    block_limit: u64,
    lbw_timer: i64,
    lbw_min_buy: u64,
}

/// `init` for `mint`, passing the leash account when the rules name one.
fn init_ix(payer: &Address, mint: &Address, init: &Init) -> Instruction {
    let (rules, list) = (rules_of(mint), list_of(mint));
    let mut data = vec![INIT, rules.1, list.1, init.flags, init.cap_param, init.timer_param];
    data.extend_from_slice(init.exempt_owner.as_ref());
    data.extend_from_slice(init.leash.as_ref());
    for number in [init.max_per_wallet, init.guard_slots, init.block_limit, init.lbw_timer as u64, init.lbw_min_buy] {
        data.extend_from_slice(&number.to_le_bytes());
    }
    let mut accounts = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(*mint, true),
        AccountMeta::new(rules.0, false),
        AccountMeta::new(list.0, false),
        AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
    ];
    if init.leash != SYSTEM_PROGRAM {
        accounts.push(AccountMeta::new_readonly(init.leash, false));
    }
    Instruction { program_id: HOOK, accounts, data }
}

/// A leash to create next to a token.
#[derive(Clone, Default)]
struct LeashConfig {
    /// Each parameter's value and the range its agent may move it in. No step limit, no cooldown.
    params: Vec<(i64, i64, i64)>,
    /// Most SOL the agent may send to the token's rules account at once. 0: it moves none.
    spend: u64,
}

/// A token to launch. The default has every rule off.
#[derive(Clone, Default)]
struct Config {
    flags: u8,
    max_per_wallet: u64,
    guard_slots: u64,
    block_limit: u64,
    lbw_timer: i64,
    lbw_min_buy: u64,
    /// The leash parameters holding the cap and the game timer, when the leash decides them.
    cap_param: Option<u8>,
    timer_param: Option<u8>,
    leash: Option<LeashConfig>,
}

impl Config {
    fn capped(cap: u64) -> Self {
        Config { max_per_wallet: cap, ..Config::default() }
    }

    fn guarded() -> Self {
        Config { block_limit: BLOCK_LIMIT, guard_slots: GUARD_SLOTS, ..Config::default() }
    }

    fn game() -> Self {
        Config { flags: FLAG_LAST_BUYER_WINS, lbw_timer: TIMER, lbw_min_buy: MIN_BUY, ..Config::default() }
    }

    /// The cap lives in a leash: 1 percent of supply, which the agent may move up to 5 percent.
    fn leash_capped() -> Self {
        let leash = LeashConfig { params: vec![(CAP as i64, CAP as i64, 5 * CAP as i64)], spend: 0 };
        Config { cap_param: Some(0), leash: Some(leash), ..Config::default() }
    }
}

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    mint: Keypair,
    /// Stands in for the bonding curve: its token account holds the supply.
    vault: Keypair,
    alice: Keypair,
    bob: Keypair,
    rules: Address,
    list: Address,
    /// The token's leash, when it was launched with one.
    leash: Option<Address>,
    agent: Keypair,
}

impl Env {
    /// A token with the hook installed and the whole supply in the curve's vault.
    fn launch(config: Config) -> Self {
        let mut svm = LiteSVM::new();
        let hook_so = so("HOOK_SO", "../hook/target/deploy/lure_hook.so");
        svm.add_program_from_file(HOOK, &hook_so)
            .unwrap_or_else(|e| panic!("build the hook first; could not load {hook_so}: {e:?}"));
        let leash_so = so("LEASH_SO", "../leash/target/deploy/lure_leash.so");
        svm.add_program_from_file(LEASH_PROGRAM, &leash_so)
            .unwrap_or_else(|e| panic!("build the leash first; could not load {leash_so}: {e:?}"));
        let mut clock = svm.get_sysvar::<Clock>();
        (clock.unix_timestamp, clock.slot) = (T0, LAUNCH_SLOT);
        svm.set_sysvar(&clock);

        let keys: [Keypair; 6] = std::array::from_fn(|_| Keypair::new());
        let [payer, mint, vault, alice, bob, agent] = keys;
        svm.airdrop(&payer.pubkey(), 1_000 * SOL).unwrap();
        let mint_key = mint.pubkey();
        let (rules, list) = (rules_of(&mint_key).0, list_of(&mint_key).0);
        let mut env = Env { svm, payer, mint, vault, alice, bob, rules, list, leash: None, agent };

        // The leash comes first: the hook reads it before it accepts the rules.
        if let Some(leash) = &config.leash {
            env.leash = Some(env.create_leash(&mint_key, leash));
        }

        // The mint: created, pointed at the hook, initialised, and given its rules, all in
        // one transaction that the mint key signs.
        let payer_key = env.payer.pubkey();
        let lamports = env.svm.minimum_balance_for_rent_exemption(MINT_LEN);
        let mut hook_ext = vec![36, 0];
        hook_ext.extend_from_slice(&[0; 32]);
        hook_ext.extend_from_slice(HOOK.as_ref());
        let mut init_mint = vec![20, DECIMALS];
        init_mint.extend_from_slice(payer_key.as_ref());
        init_mint.push(0);
        let setup = vec![
            create_account(&payer_key, &mint_key, lamports, MINT_LEN as u64, &TOKEN_2022),
            Instruction { program_id: TOKEN_2022, accounts: vec![AccountMeta::new(mint_key, false)], data: hook_ext },
            Instruction { program_id: TOKEN_2022, accounts: vec![AccountMeta::new(mint_key, false)], data: init_mint },
            init_ix(&payer_key, &mint_key, &env.init_of(&config)),
        ];
        let mint = env.mint.insecure_clone();
        env.send(setup, &[&mint]).unwrap();

        // Minting doesn't go through the hook; only transfers do.
        let vault_owner = env.vault.pubkey();
        let vault_ata = env.open_account(&vault_owner);
        let mut mint_to = vec![7];
        mint_to.extend_from_slice(&SUPPLY.to_le_bytes());
        let accounts = vec![AccountMeta::new(mint_key, false), AccountMeta::new(vault_ata, false), AccountMeta::new_readonly(payer_key, true)];
        env.send(vec![Instruction { program_id: TOKEN_2022, accounts, data: mint_to }], &[]).unwrap();
        env
    }

    fn send(&mut self, ixs: Vec<Instruction>, signers: &[&Keypair]) -> TransactionResult {
        self.svm.expire_blockhash();
        let mut all = vec![&self.payer];
        all.extend(signers);
        let message = Message::new(&ixs, Some(&self.payer.pubkey()));
        self.svm.send_transaction(Transaction::new(&all, message, self.svm.latest_blockhash()))
    }

    /// What `init` is given for this world's token: the vault's owner is the curve, and the
    /// leash is named exactly when a rule reads from it.
    fn init_of(&self, config: &Config) -> Init {
        let reads_leash = config.cap_param.or(config.timer_param).is_some();
        Init {
            flags: config.flags,
            cap_param: config.cap_param.unwrap_or(NO_PARAM),
            timer_param: config.timer_param.unwrap_or(NO_PARAM),
            exempt_owner: self.vault.pubkey(),
            leash: if reads_leash { self.leash.expect("a leash to read from") } else { SYSTEM_PROGRAM },
            max_per_wallet: config.max_per_wallet,
            guard_slots: config.guard_slots,
            block_limit: config.block_limit,
            lbw_timer: config.lbw_timer,
            lbw_min_buy: config.lbw_min_buy,
        }
    }

    /// A leash for `mint`, created by the payer. Its agent can send SOL to the creator's
    /// wallet and to the token's rules account, which is where the game's pot sits.
    ///
    /// The wallet comes first on purpose. Once an agent is revoked, what is left in a leash
    /// can only be swept to its first destination, and SOL in the rules account of a token
    /// whose curve has graduated never leaves it.
    fn create_leash(&mut self, mint: &Address, config: &LeashConfig) -> Address {
        let (ix, leash) = self.leash_init_ix(&self.payer.pubkey(), mint, config);
        self.send(vec![ix], &[]).unwrap();
        leash
    }

    /// The same leash created by somebody else, who pays for it. Anyone can create a leash
    /// for any token: there is one per (token, creator).
    fn create_leash_as(&mut self, creator: &Keypair, mint: &Address, config: &LeashConfig) -> Address {
        let (ix, leash) = self.leash_init_ix(&creator.pubkey(), mint, config);
        self.send(vec![ix], &[creator]).unwrap();
        leash
    }

    fn leash_init_ix(&self, creator: &Address, mint: &Address, config: &LeashConfig) -> (Instruction, Address) {
        let payer = *creator;
        let (leash, bump) = Address::find_program_address(&[LEASH_SEED, mint.as_ref(), payer.as_ref()], &LEASH_PROGRAM);
        let mut data = vec![leash_tag::INIT, bump, 0, config.params.len() as u8];
        for key in [*mint, self.agent.pubkey(), payer, rules_of(mint).0] {
            data.extend_from_slice(key.as_ref());
        }
        // Per spend, per day, then the two reward caps: no rewards.
        for cap in [config.spend, 10 * config.spend, 0, 0] {
            data.extend_from_slice(&cap.to_le_bytes());
        }
        for (value, min, max) in &config.params {
            for field in [value, min, max] {
                data.extend_from_slice(&field.to_le_bytes());
            }
            data.extend_from_slice(&0u64.to_le_bytes());
            data.extend_from_slice(&0i64.to_le_bytes());
        }
        let accounts = vec![AccountMeta::new(payer, true), AccountMeta::new(leash, false), AccountMeta::new_readonly(SYSTEM_PROGRAM, false)];
        (Instruction { program_id: LEASH_PROGRAM, accounts, data }, leash)
    }

    /// The agent turns one of the leash's knobs.
    fn set_param(&mut self, index: u8, value: i64) -> TransactionResult {
        let mut data = vec![leash_tag::SET_PARAM, index];
        data.extend_from_slice(&value.to_le_bytes());
        let accounts = vec![AccountMeta::new_readonly(self.agent.pubkey(), true), AccountMeta::new(self.leash.unwrap(), false)];
        let agent = self.agent.insecure_clone();
        self.send(vec![Instruction { program_id: LEASH_PROGRAM, accounts, data }], &[&agent])
    }

    /// The agent sends SOL from the leash to `to` as its second destination, which the leash
    /// only allows for the rules account.
    fn spend(&mut self, to: Address, amount: u64) -> TransactionResult {
        let mut data = vec![leash_tag::SPEND, 1];
        data.extend_from_slice(&amount.to_le_bytes());
        let accounts = vec![
            AccountMeta::new_readonly(self.agent.pubkey(), true),
            AccountMeta::new(self.leash.unwrap(), false),
            AccountMeta::new(to, false),
        ];
        let agent = self.agent.insecure_clone();
        self.send(vec![Instruction { program_id: LEASH_PROGRAM, accounts, data }], &[&agent])
    }

    /// A plain SOL transfer from the payer: how anyone adds to a pot or a leash.
    fn fund(&mut self, to: &Address, lamports: u64) {
        let ix = send_sol(&self.payer.pubkey(), to, lamports);
        self.send(vec![ix], &[]).unwrap();
    }

    fn pass_time(&mut self, seconds: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp += seconds;
        self.svm.set_sysvar(&clock);
    }

    fn set_slot(&mut self, slot: u64) {
        self.svm.warp_to_slot(slot);
    }

    /// Creates the owner's token account if it isn't there yet.
    fn open_account(&mut self, owner: &Address) -> Address {
        let (mint, address) = (self.mint.pubkey(), ata(owner, &self.mint.pubkey()));
        let accounts = vec![
            AccountMeta::new(self.payer.pubkey(), true),
            AccountMeta::new(address, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
        ];
        self.send(vec![Instruction { program_id: ATA_PROGRAM, accounts, data: vec![1] }], &[]).unwrap();
        address
    }

    /// The accounts a client appends to a transfer so Token-2022 can call the hook: what
    /// the token's account list names, then the hook and the list itself.
    fn hook_accounts(&self) -> Vec<AccountMeta> {
        let mut metas = vec![AccountMeta::new(self.rules, false)];
        // Read from the raw bytes: the leash sits at the same place in every layout.
        let stored = self.svm.get_account(&self.rules).expect("rules account").data;
        let named_leash = Address::new_from_array(stored[72..104].try_into().unwrap());
        if named_leash != SYSTEM_PROGRAM {
            metas.push(AccountMeta::new_readonly(named_leash, false));
        }
        metas.push(AccountMeta::new_readonly(HOOK, false));
        metas.push(AccountMeta::new_readonly(self.list, false));
        metas
    }

    /// A checked transfer between the token accounts of two owners.
    fn transfer_ix(&self, from: &Address, to: &Address, amount: u64) -> Instruction {
        let mint = self.mint.pubkey();
        let mut data = vec![12];
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(DECIMALS);
        let mut accounts = vec![
            AccountMeta::new(ata(from, &mint), false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(ata(to, &mint), false),
            AccountMeta::new_readonly(*from, true),
        ];
        accounts.extend(self.hook_accounts());
        Instruction { program_id: TOKEN_2022, accounts, data }
    }

    fn transfer(&mut self, from: &Keypair, to: &Address, amount: u64) -> TransactionResult {
        self.open_account(to);
        let ix = self.transfer_ix(&from.pubkey(), to, amount);
        self.send(vec![ix], &[from])
    }

    /// Tokens leave the curve's vault for `to`.
    fn buy(&mut self, to: &Address, amount: u64) -> TransactionResult {
        let vault = self.vault.insecure_clone();
        self.transfer(&vault, to, amount)
    }

    /// Tokens go back to the curve's vault.
    fn sell(&mut self, from: &Keypair, amount: u64) -> TransactionResult {
        let vault = self.vault.pubkey();
        self.transfer(from, &vault, amount)
    }

    fn settle_ix(&self, winner: &Address) -> Instruction {
        let accounts = vec![AccountMeta::new(self.rules, false), AccountMeta::new(*winner, false)];
        Instruction { program_id: HOOK, accounts, data: vec![SETTLE] }
    }

    /// Sent and paid for by the payer, who is never the winner: anyone may settle.
    fn settle(&mut self, winner: &Address) -> TransactionResult {
        let ix = self.settle_ix(winner);
        self.send(vec![ix], &[])
    }

    fn balance(&self, owner: &Address) -> u64 {
        match self.svm.get_account(&ata(owner, &self.mint.pubkey())) {
            Some(account) => u64::from_le_bytes(account.data[64..72].try_into().unwrap()),
            None => 0,
        }
    }

    fn lamports(&self, address: &Address) -> u64 {
        self.svm.get_balance(address).unwrap_or(0)
    }

    /// What the rules account must hold to stay rent-exempt.
    fn reserve(&self) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(RULES_LEN)
    }

    /// SOL waiting for the next winner.
    fn pot(&self) -> u64 {
        self.lamports(&self.rules) - self.reserve()
    }

    fn state(&self) -> Rules {
        let account = self.svm.get_account(&self.rules).expect("rules account");
        assert_eq!((account.owner, account.data.len()), (HOOK, RULES_LEN));
        unsafe { std::ptr::read_unaligned(account.data.as_ptr() as *const Rules) }
    }

    /// Who leads the round, and when it ends.
    fn round(&self) -> (Address, i64) {
        let state = self.state();
        (Address::new_from_array(state.lbw_last_buyer), state.lbw_deadline)
    }

    /// Overwrites the stored rules, to put the token in a state that is hard to reach by trading.
    fn rewrite_rules(&mut self, edit: impl FnOnce(&mut Rules)) {
        let mut state = self.state();
        edit(&mut state);
        let mut account = self.svm.get_account(&self.rules).unwrap();
        unsafe { std::ptr::write_unaligned(account.data.as_mut_ptr() as *mut Rules, state) };
        self.svm.set_account(self.rules, account).unwrap();
    }
}

/// The instruction error a failed transaction ended with.
fn error(result: TransactionResult) -> InstructionError {
    match result.expect_err("transaction should have failed").err {
        TransactionError::InstructionError(_, error) => error,
        other => panic!("failed outside the instruction: {other:?}"),
    }
}

fn hook_error(code: HookError) -> InstructionError {
    InstructionError::Custom(code as u32)
}

/// The runtime still reports the old name; `MissingAccount` is a different variant.
#[allow(deprecated)]
const TOO_FEW_ACCOUNTS: InstructionError = InstructionError::NotEnoughAccountKeys;

/// Compute units the hook itself used inside a transaction, read from its log.
fn hook_units(meta: &TransactionMetadata) -> u64 {
    let prefix = format!("Program {HOOK} consumed ");
    let line = meta.logs.iter().find_map(|line| line.strip_prefix(&prefix));
    line.and_then(|rest| rest.split(' ').next()?.parse().ok())
        .unwrap_or_else(|| panic!("the hook didn't run:\n{}", meta.pretty_logs()))
}

/* ---------------- what clients are written against ---------------- */

#[test]
fn published_numbers_are_pinned() {
    // Every other test takes these from the hook's own crate, so it would follow a change
    // without noticing. Clients don't: they carry the numbers below, as the README lists them.
    let codes = [
        (HookError::OverMaxPerWallet, 6000),
        (HookError::NotATransfer, 6001),
        (HookError::WrongAccount, 6002),
        (HookError::BadConfig, 6003),
        (HookError::TooMuchInOneBlock, 6004),
        (HookError::NotWritable, 6005),
        (HookError::RoundNotOver, 6006),
        (HookError::NotTheWinner, 6007),
        (HookError::GameOff, 6008),
    ];
    for (error, code) in codes {
        assert_eq!(error as u32, code, "{error:?}");
    }
    assert_eq!((INIT, SETTLE), (0, 1));
    assert_eq!(EXECUTE, [105, 37, 101, 197, 75, 251, 102, 26]);
    assert_eq!((RULES_SEED.as_slice(), ACCOUNT_LIST_SEED.as_slice()), (b"rules".as_slice(), b"extra-account-metas".as_slice()));
    assert_eq!((RULES_LEN, VERSION, NO_PARAM, FLAG_LAST_BUYER_WINS), (272, 2, 0xFF, 1));
    // The one program whose accounts the hook believes, and the one whose calls it answers.
    assert_eq!(LEASH_PROGRAM, Address::from_str_const("GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p"));
    assert_eq!(TOKEN_2022, Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"));
}

/* ---------------- init ---------------- */

#[test]
fn init_writes_the_rules_and_the_account_list() {
    let env = Env::launch(Config { max_per_wallet: CAP, ..Config::guarded() });
    let expected = Rules {
        version: VERSION,
        bump: rules_of(&env.mint.pubkey()).1,
        flags: 0,
        cap_param: NO_PARAM,
        timer_param: NO_PARAM,
        _pad: [0; 3],
        mint: env.mint.pubkey().to_bytes(),
        exempt_owner: env.vault.pubkey().to_bytes(),
        leash: [0; 32],
        max_per_wallet: CAP,
        transfers: 0,
        launch_slot: LAUNCH_SLOT,
        guard_slots: GUARD_SLOTS,
        block_limit: BLOCK_LIMIT,
        block_slot: 0,
        block_bought: 0,
        lbw_timer: 0,
        lbw_min_buy: 0,
        lbw_deadline: 0,
        lbw_round: 0,
        lbw_last_buyer: [0; 32],
        lbw_last_winner: [0; 32],
        lbw_last_prize: 0,
        lbw_total_paid: 0,
    };
    assert_eq!(env.state(), expected);
    assert_eq!(env.lamports(&env.rules), env.reserve(), "funded with exactly its rent: the pot starts empty");

    // The game's settings land where they belong too.
    let game = Env::launch(Config::game()).state();
    assert_eq!((game.flags, game.lbw_timer, game.lbw_min_buy), (FLAG_LAST_BUYER_WINS, TIMER, MIN_BUY));

    // The list is laid out the way Token-2022 and every client parse it: the instruction
    // it is for, its length, the count, then one fixed-address, writable entry: the rules.
    let list = env.svm.get_account(&env.list).unwrap();
    assert_eq!(list.owner, HOOK);
    let mut expected = EXECUTE.to_vec();
    expected.extend_from_slice(&39u32.to_le_bytes());
    expected.extend_from_slice(&1u32.to_le_bytes());
    expected.push(0);
    expected.extend_from_slice(env.rules.as_ref());
    expected.extend_from_slice(&[0, 1]);
    assert_eq!(list.data, expected);
}

#[test]
fn only_the_mint_can_set_its_rules_and_only_once() {
    let mut env = Env::launch(Config::capped(CAP));
    let (payer, mint_key, stranger) = (env.payer.pubkey(), env.mint.pubkey(), Keypair::new().pubkey());
    let loose = Init { exempt_owner: stranger, ..env.init_of(&Config::default()) };

    // Already set: a second init can't loosen them.
    let mint = env.mint.insecure_clone();
    let again = init_ix(&payer, &mint_key, &loose);
    assert_eq!(error(env.send(vec![again], &[&mint])), InstructionError::AccountAlreadyInitialized);
    assert_eq!(env.state().max_per_wallet, CAP);

    // A token whose mint key didn't sign gets no rules from anyone else.
    let other_mint = Keypair::new().pubkey();
    let mut ix = init_ix(&payer, &other_mint, &loose);
    ix.accounts[1] = AccountMeta::new_readonly(other_mint, false);
    assert_eq!(error(env.send(vec![ix], &[])), InstructionError::MissingRequiredSignature);
    assert!(env.svm.get_account(&rules_of(&other_mint).0).is_none());
}

#[test]
fn init_copes_with_addresses_that_already_hold_sol() {
    // Anyone can send SOL to a token's rules and list addresses before they exist. That
    // must not block the launch.
    let mut env = Env::launch(Config::default());
    let payer = env.payer.pubkey();
    let floor = env.svm.minimum_balance_for_rent_exemption(0);
    for prefund in [floor, 3 * SOL] {
        let mint = Keypair::new();
        let (rules, list) = (rules_of(&mint.pubkey()).0, list_of(&mint.pubkey()).0);
        env.fund(&rules, prefund);
        env.fund(&list, prefund);
        let init = env.init_of(&Config::game());
        env.send(vec![init_ix(&payer, &mint.pubkey(), &init)], &[&mint]).unwrap();

        // Each account is topped up only as far as its rent. Whatever the rules account
        // holds above that is the first round's pot.
        let (rules, list) = (env.svm.get_account(&rules).unwrap(), env.svm.get_account(&list).unwrap());
        assert_eq!((rules.owner, rules.data.len(), rules.lamports), (HOOK, RULES_LEN, prefund.max(env.reserve())));
        assert_eq!(rules.data[0], VERSION);
        let list_rent = env.svm.minimum_balance_for_rent_exemption(list.data.len());
        assert_eq!((list.owner, list.data.len(), list.lamports), (HOOK, 16 + 35, prefund.max(list_rent)));
    }
}

#[test]
fn init_refuses_rules_that_contradict_each_other() {
    let mut env = Env::launch(Config::default());
    let (payer, vault) = (env.payer.pubkey(), env.vault.pubkey());
    // Every attempt is for a fresh mint that has a leash with two parameters, so a refusal
    // is about the rules themselves and never about a missing leash or its ranges.
    let two_params = LeashConfig { params: vec![(CAP as i64, MIN_BUY as i64, i64::MAX), (TIMER, 60, 3_600)], spend: 0 };
    let mut attempt = |edit: &dyn Fn(&mut Init, Address)| {
        let mint = Keypair::new();
        let leash = env.create_leash(&mint.pubkey(), &two_params);
        let mut init = Init {
            flags: 0,
            cap_param: NO_PARAM,
            timer_param: NO_PARAM,
            exempt_owner: vault,
            leash: SYSTEM_PROGRAM,
            max_per_wallet: 0,
            guard_slots: 0,
            block_limit: 0,
            lbw_timer: 0,
            lbw_min_buy: 0,
        };
        edit(&mut init, leash);
        let result = env.send(vec![init_ix(&payer, &mint.pubkey(), &init)], &[&mint]);
        assert_eq!(env.svm.get_account(&rules_of(&mint.pubkey()).0).is_some(), result.is_ok());
        result
    };
    let game = |i: &mut Init| (i.flags, i.lbw_timer, i.lbw_min_buy) = (FLAG_LAST_BUYER_WINS, TIMER, MIN_BUY);
    let leash_cap = |i: &mut Init, leash| (i.leash, i.cap_param) = (leash, 0);
    let leash_timer = |i: &mut Init, leash| (i.flags, i.lbw_min_buy, i.leash, i.timer_param) = (FLAG_LAST_BUYER_WINS, MIN_BUY, leash, 1);

    // The settings each refusal below starts from are accepted as they are.
    attempt(&|_, _| ()).unwrap();
    attempt(&|i, _| game(i)).unwrap();
    attempt(&|i, leash| leash_cap(i, leash)).unwrap();
    attempt(&|i, leash| leash_timer(i, leash)).unwrap();
    attempt(&|i, leash| { leash_timer(i, leash); i.cap_param = 0 }).unwrap();
    attempt(&|i, _| (i.block_limit, i.guard_slots) = (BLOCK_LIMIT, GUARD_SLOTS)).unwrap();
    attempt(&|i, _| i.block_limit = BLOCK_LIMIT).unwrap();
    attempt(&|i, _| i.exempt_owner = SYSTEM_PROGRAM).unwrap();
    // The longest clock and the longest guard a token that plays can have.
    attempt(&|i, _| { game(i); i.lbw_timer = WEEK }).unwrap();
    attempt(&|i, _| { game(i); (i.block_limit, i.guard_slots) = (BLOCK_LIMIT, DAY_OF_SLOTS) }).unwrap();
    // Smaller than the smallest buy that counts, but gone by the time the game starts.
    attempt(&|i, _| { game(i); (i.block_limit, i.guard_slots) = (MIN_BUY - 1, GUARD_SLOTS) }).unwrap();

    let bad_config = hook_error(HookError::BadConfig);
    let mut refuse = |why: &str, edit: &dyn Fn(&mut Init, Address)| assert_eq!(error(attempt(edit)), bad_config, "{why}");
    refuse("a flag nobody defined", &|i, _| i.flags = 2);
    refuse("a flag nobody defined, next to the game", &|i, _| { game(i); i.flags |= 0x80 });
    refuse("a cap parameter no leash can have", &|i, leash| { leash_cap(i, leash); i.cap_param = 4 });
    refuse("a timer parameter no leash can have", &|i, leash| { leash_timer(i, leash); i.timer_param = 0xFE });
    refuse("a cap parameter without a leash", &|i, _| i.cap_param = 0);
    refuse("a timer parameter without a leash", &|i, leash| { leash_timer(i, leash); i.leash = SYSTEM_PROGRAM });
    refuse("a leash nothing reads", &|i, leash| i.leash = leash);
    refuse("one parameter for both the cap and the timer", &|i, leash| { leash_timer(i, leash); i.cap_param = 1 });
    refuse("a cap given twice", &|i, leash| { leash_cap(i, leash); i.max_per_wallet = CAP });
    refuse("a timer given twice", &|i, leash| { leash_timer(i, leash); i.lbw_timer = TIMER });
    refuse("a game without a curve to buy from", &|i, _| { game(i); i.exempt_owner = SYSTEM_PROGRAM });
    refuse("a block limit without a curve to buy from", &|i, _| (i.block_limit, i.exempt_owner) = (BLOCK_LIMIT, SYSTEM_PROGRAM));
    // On a curve, a cap that doesn't know the vault caps the vault: every sell would fail.
    refuse("a cap without a curve to sell into", &|i, _| (i.max_per_wallet, i.exempt_owner) = (CAP, SYSTEM_PROGRAM));
    refuse("a leash cap without a curve to sell into", &|i, leash| { leash_cap(i, leash); i.exempt_owner = SYSTEM_PROGRAM });
    refuse("a guard window with no limit", &|i, _| i.guard_slots = GUARD_SLOTS);
    refuse("a game with no timer", &|i, _| { game(i); i.lbw_timer = 0 });
    refuse("a game with a negative timer", &|i, _| { game(i); i.lbw_timer = -TIMER });
    refuse("a game whose clock runs longer than a week", &|i, _| { game(i); i.lbw_timer = WEEK + 1 });
    refuse("a game whose clock never runs out", &|i, _| { game(i); i.lbw_timer = i64::MAX });
    refuse("a timer on a token that doesn't play", &|i, _| i.lbw_timer = TIMER);
    refuse("a smallest buy on a token that doesn't play", &|i, _| i.lbw_min_buy = MIN_BUY);
    refuse("a leash timer on a token that doesn't play", &|i, leash| { leash_timer(i, leash); i.flags = 0 });
    refuse("a leash timer and nothing else on a token that doesn't play", &|i, leash| (i.leash, i.timer_param) = (leash, 1));
    refuse("a smallest buy above the wallet cap", &|i, _| { game(i); i.max_per_wallet = MIN_BUY - 1 });
    // The game waits for the guard to come down, so the guard has to end, and soon.
    refuse("a game behind a block limit that never ends", &|i, _| { game(i); i.block_limit = BLOCK_LIMIT });
    refuse("a game behind a guard longer than a day", &|i, _| { game(i); (i.block_limit, i.guard_slots) = (BLOCK_LIMIT, DAY_OF_SLOTS + 1) });

    // Malformed data: a missing byte, an extra one.
    let mint = Keypair::new();
    for edit in [|d: &mut Vec<u8>| { d.pop(); }, |d: &mut Vec<u8>| d.push(0)] {
        let mut ix = init_ix(&payer, &mint.pubkey(), &env.init_of(&Config::default()));
        edit(&mut ix.data);
        assert_eq!(error(env.send(vec![ix], &[&mint])), InstructionError::InvalidInstructionData);
    }
}

#[test]
fn init_checks_the_leash_it_names() {
    let mut env = Env::launch(Config::default());
    let (payer, vault) = (env.payer.pubkey(), env.vault.pubkey());
    let one_param = LeashConfig { params: vec![(CAP as i64, 0, i64::MAX)], spend: 0 };

    // A fresh mint with a one-parameter leash, and rules that read the cap from it.
    let mint = Keypair::new();
    let mint_key = mint.pubkey();
    let leash = env.create_leash(&mint_key, &one_param);
    let init = Init {
        flags: 0,
        cap_param: 0,
        timer_param: NO_PARAM,
        exempt_owner: vault,
        leash,
        max_per_wallet: 0,
        guard_slots: 0,
        block_limit: 0,
        lbw_timer: 0,
        lbw_min_buy: 0,
    };
    let wrong_account = hook_error(HookError::WrongAccount);
    let real = env.svm.get_account(&leash).unwrap();
    // Tries the launch with the leash account replaced by `stored`, then puts the real one back.
    let with_leash = |env: &mut Env, init: &Init, stored: Account| {
        env.svm.set_account(leash, stored).unwrap();
        let result = env.send(vec![init_ix(&payer, &mint_key, init)], &[&mint]);
        env.svm.set_account(leash, real.clone()).unwrap();
        result
    };

    // The leash account isn't passed at all, or another token's real leash is passed for it.
    let mut missing = init_ix(&payer, &mint_key, &init);
    missing.accounts.pop();
    assert_eq!(error(env.send(vec![missing], &[&mint])), TOO_FEW_ACCOUNTS);
    let other_leash = env.create_leash(&Keypair::new().pubkey(), &one_param);
    let mut swapped = init_ix(&payer, &mint_key, &init);
    swapped.accounts[5] = AccountMeta::new_readonly(other_leash, false);
    assert_eq!(error(env.send(vec![swapped], &[&mint])), wrong_account);
    // Anyone can create a leash for any token. A real leash of this very token, made by a
    // stranger, is not the one the rules name either: launched with it, the list would name
    // a leash that every later transfer is refused for.
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let strangers_leash = env.create_leash_as(&stranger, &mint_key, &one_param);
    assert_ne!(strangers_leash, leash);
    let mut swapped = init_ix(&payer, &mint_key, &init);
    swapped.accounts[5] = AccountMeta::new_readonly(strangers_leash, false);
    assert_eq!(error(env.send(vec![swapped], &[&mint])), wrong_account);

    // The right address and the right bytes, owned by someone else.
    let look_alike = Account { owner: Keypair::new().pubkey(), ..real.clone() };
    assert_eq!(error(with_leash(&mut env, &init, look_alike)), wrong_account);
    // Nothing at that address yet.
    let empty = Account { lamports: SOL, data: vec![], owner: SYSTEM_PROGRAM, executable: false, rent_epoch: 0 };
    assert_eq!(error(with_leash(&mut env, &init, empty)), wrong_account);
    // Owned by the leash program, but not laid out as this version's leash.
    let mut short = real.clone();
    short.data.pop();
    assert_eq!(error(with_leash(&mut env, &init, short)), wrong_account);
    let mut future = real.clone();
    future.data[0] = 2;
    assert_eq!(error(with_leash(&mut env, &init, future)), wrong_account);
    // A leash whose contents say it belongs to another token.
    let mut other_token = real.clone();
    other_token.data[8..40].copy_from_slice(env.mint.pubkey().as_ref());
    assert_eq!(error(with_leash(&mut env, &init, other_token)), wrong_account);

    // The rules point at a parameter the leash was created without.
    let bad_config = hook_error(HookError::BadConfig);
    let past_the_end = Init { cap_param: 1, ..init };
    assert_eq!(error(with_leash(&mut env, &past_the_end, real.clone())), bad_config);
    let timer_past_the_end = Init { flags: FLAG_LAST_BUYER_WINS, timer_param: 3, ..init };
    assert_eq!(error(with_leash(&mut env, &timer_past_the_end, real.clone())), bad_config);
    assert!(env.svm.get_account(&rules_of(&mint_key).0).is_none(), "nothing was created along the way");

    // The leash as it really is: the token launches, and both accounts are on its list.
    with_leash(&mut env, &init, real.clone()).unwrap();
    let mut expected = EXECUTE.to_vec();
    expected.extend_from_slice(&74u32.to_le_bytes());
    expected.extend_from_slice(&2u32.to_le_bytes());
    expected.push(0);
    expected.extend_from_slice(rules_of(&mint_key).0.as_ref());
    expected.extend_from_slice(&[0, 1, 0]);
    expected.extend_from_slice(leash.as_ref());
    expected.extend_from_slice(&[0, 0]);
    assert_eq!(env.svm.get_account(&list_of(&mint_key).0).unwrap().data, expected);
}

#[test]
fn init_checks_how_far_the_agent_can_turn_each_number() {
    let mut env = Env::launch(Config::default());
    let (payer, vault) = (env.payer.pubkey(), env.vault.pubkey());
    let bad_config = hook_error(HookError::BadConfig);
    // Launches a token with its cap in parameter 0 of a leash with the given ranges (value,
    // lowest, highest) and, when it plays, its clock in parameter 1.
    let mut launch = |cap: (i64, i64, i64), clock: (i64, i64, i64), flags: u8| {
        let mint = Keypair::new();
        let leash = env.create_leash(&mint.pubkey(), &LeashConfig { params: vec![cap, clock], spend: 0 });
        let plays = flags == FLAG_LAST_BUYER_WINS;
        let init = Init {
            flags,
            cap_param: 0,
            timer_param: if plays { 1 } else { NO_PARAM },
            exempt_owner: vault,
            leash,
            max_per_wallet: 0,
            guard_slots: 0,
            block_limit: 0,
            lbw_timer: 0,
            lbw_min_buy: if plays { MIN_BUY } else { 0 },
        };
        env.send(vec![init_ix(&payer, &mint.pubkey(), &init)], &[&mint])
    };
    let (min_buy, cap) = (MIN_BUY as i64, CAP as i64);
    let (clock, plays) = ((TIMER, 60, 3_600), FLAG_LAST_BUYER_WINS);

    // The agent may move the cap anywhere in its range. If that range reaches under the
    // smallest buy that counts, an agent that leads a round can cut the cap, nobody can buy
    // enough to take the lead, and the pot is its own. The range is fixed when the leash is
    // created, so checking it once at launch is enough.
    launch((cap, min_buy, 5 * cap), clock, plays).unwrap();
    assert_eq!(error(launch((cap, min_buy - 1, 5 * cap), clock, plays)), bad_config);
    assert_eq!(error(launch((cap, 1, 5 * cap), clock, plays)), bad_config);
    // Zero switches the cap off, but a range that starts there holds every small cap too.
    assert_eq!(error(launch((cap, 0, 5 * cap), clock, plays)), bad_config);
    assert_eq!(error(launch((cap, -5, 5 * cap), clock, plays)), bad_config);
    // A token that doesn't play has no lead to protect: any range will do.
    launch((cap, -5, 5 * cap), clock, 0).unwrap();

    // A clock the agent could stretch past a week would be cut short on every buy, which is
    // not what the creator asked for.
    launch((cap, min_buy, 5 * cap), (TIMER, 60, WEEK), plays).unwrap();
    assert_eq!(error(launch((cap, min_buy, 5 * cap), (TIMER, 60, WEEK + 1), plays)), bad_config);
    assert_eq!(error(launch((cap, min_buy, 5 * cap), (TIMER, 60, i64::MAX), plays)), bad_config);
}

#[test]
fn init_only_takes_the_addresses_every_client_derives() {
    // The seeds of the rules and of the account list give a valid address for about half of
    // all bumps. Token-2022 and every client use the first one they find, counting down
    // from 255. A list at any other address is one Token-2022 never reads, so every
    // transfer of the token would fail; rules at any other address would leave the usual
    // address free for a second, different set that the hook never applies.
    let mut env = Env::launch(Config::default());
    let payer = env.payer.pubkey();
    let lower = |seed: &[u8], mint: &Address, first: u8| {
        (0..first).rev().find_map(|bump| Some((Address::create_program_address(&[seed, mint.as_ref(), &[bump]], &HOOK).ok()?, bump))).unwrap()
    };
    // In the instruction, the rules are account 2 and bump byte 1; the list is account 3 and byte 2.
    for (account, byte) in [(2, 1), (3, 2)] {
        let mint = Keypair::new();
        let mint_key = mint.pubkey();
        let good = init_ix(&payer, &mint_key, &env.init_of(&Config::capped(CAP)));
        let (seed, first): (&[u8], u8) = if account == 2 { (RULES_SEED, rules_of(&mint_key).1) } else { (ACCOUNT_LIST_SEED, list_of(&mint_key).1) };
        let (address, bump) = lower(seed, &mint_key, first);

        let mut moved = good.clone();
        moved.accounts[account] = AccountMeta::new(address, false);
        moved.data[byte] = bump;
        assert_eq!(error(env.send(vec![moved], &[&mint])), InstructionError::InvalidSeeds);
        // The same address next to the bump every client sends, and the right address next
        // to a bump that doesn't lead to it.
        let mut wrong_address = good.clone();
        wrong_address.accounts[account] = AccountMeta::new(address, false);
        assert_eq!(error(env.send(vec![wrong_address], &[&mint])), InstructionError::InvalidSeeds);
        let mut wrong_bump = good.clone();
        wrong_bump.data[byte] = bump;
        assert_eq!(error(env.send(vec![wrong_bump], &[&mint])), InstructionError::InvalidSeeds);
        for created in [address, rules_of(&mint_key).0, list_of(&mint_key).0] {
            assert!(env.svm.get_account(&created).is_none(), "nothing was created along the way");
        }

        env.send(vec![good], &[&mint]).unwrap();
    }
}

/* ---------------- the wallet cap, and what the first hook already did ---------------- */

#[test]
fn hook_runs_inside_a_token_2022_transfer() {
    let mut env = Env::launch(Config::capped(CAP));
    let alice = env.alice.pubkey();

    let result = env.buy(&alice, 1_000 * TOKEN).unwrap();
    assert_eq!(env.balance(&alice), 1_000 * TOKEN);
    assert_eq!(env.state().transfers, 1);
    // The probe build logs one line: extra accounts, amount, receiver's balance after, cap,
    // count. The build without the probe logs nothing; test.sh runs these tests against
    // both, and sets HOOK_QUIET for that one.
    let line = format!("Program log: 0x0, {:#x}, {:#x}, {:#x}, 0x1", 1_000 * TOKEN, 1_000 * TOKEN, CAP);
    if std::env::var_os("HOOK_QUIET").is_some() {
        assert!(!result.logs.iter().any(|log| log.starts_with("Program log: 0x")), "the hook logged:\n{}", result.pretty_logs());
    } else {
        assert!(result.logs.contains(&line), "hook log missing:\n{}", result.pretty_logs());
    }

    env.buy(&alice, 500 * TOKEN).unwrap();
    assert_eq!(env.state().transfers, 2);
}

#[test]
fn refuses_a_transfer_that_breaks_the_cap() {
    let mut env = Env::launch(Config::capped(CAP));
    let alice = env.alice.pubkey();

    env.buy(&alice, CAP - TOKEN).unwrap();
    assert_eq!(error(env.buy(&alice, TOKEN + 1)), hook_error(HookError::OverMaxPerWallet));
    assert_eq!(env.balance(&alice), CAP - TOKEN, "a refused transfer moves nothing");
    assert_eq!(env.state().transfers, 1, "and isn't counted");

    env.buy(&alice, TOKEN).unwrap();
    assert_eq!(env.balance(&alice), CAP, "exactly the cap is allowed");
    assert_eq!(error(env.buy(&alice, 1)), hook_error(HookError::OverMaxPerWallet));
}

#[test]
fn sells_always_land_and_wallet_to_wallet_is_capped() {
    let mut env = Env::launch(Config::capped(CAP));
    let (alice, bob, vault) = (env.alice.pubkey(), env.bob.pubkey(), env.vault.pubkey());
    let (alice_key, bob_key) = (env.alice.insecure_clone(), env.bob.insecure_clone());
    env.buy(&alice, CAP).unwrap();
    env.buy(&bob, CAP / 2).unwrap();

    // Sending between wallets is a transfer like any other.
    assert_eq!(error(env.transfer(&alice_key, &bob, CAP / 2 + 1)), hook_error(HookError::OverMaxPerWallet));
    env.transfer(&alice_key, &bob, CAP / 2).unwrap();
    assert_eq!((env.balance(&alice), env.balance(&bob)), (CAP / 2, CAP));

    // Selling back to the vault is never blocked, however much it already holds.
    env.sell(&bob_key, CAP).unwrap();
    env.sell(&alice_key, CAP / 2).unwrap();
    assert_eq!(env.balance(&vault), SUPPLY);
    assert_eq!(env.state().transfers, 5);
}

#[test]
fn a_cap_of_zero_switches_the_rule_off() {
    let mut env = Env::launch(Config::default());
    let alice = env.alice.pubkey();
    env.buy(&alice, SUPPLY / 2).unwrap();
    assert_eq!(env.balance(&alice), SUPPLY / 2);
}

#[test]
fn cannot_be_called_outside_a_transfer() {
    let mut env = Env::launch(Config::game());
    let alice = env.alice.pubkey();
    env.buy(&alice, TOKEN).unwrap();
    let before = env.state();

    // The same accounts a real buy passes, called directly with an amount big enough to
    // take the lead: the token accounts exist and belong to this mint, but Token-2022 isn't
    // in the middle of moving anything.
    let mut data = EXECUTE.to_vec();
    data.extend_from_slice(&MIN_BUY.to_le_bytes());
    let (mint, vault, list, rules) = (env.mint.pubkey(), env.vault.pubkey(), env.list, env.rules);
    let direct = move |source: Address, destination: Address| Instruction {
        program_id: HOOK,
        accounts: vec![
            AccountMeta::new_readonly(source, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(destination, false),
            AccountMeta::new_readonly(vault, false),
            AccountMeta::new_readonly(list, false),
            AccountMeta::new(rules, false),
        ],
        data: data.clone(),
    };
    let real = direct(ata(&vault, &mint), ata(&alice, &mint));
    assert_eq!(error(env.send(vec![real.clone()], &[])), hook_error(HookError::NotATransfer));

    // Accounts made up to look like token accounts in mid-transfer, owned by someone else:
    // one that says the curve owns it, one that says a thief does.
    let thief = Keypair::new().pubkey();
    let forge = |env: &mut Env, owner: Address| {
        let mut bytes = vec![0u8; 165];
        bytes[..32].copy_from_slice(mint.as_ref());
        bytes[32..64].copy_from_slice(owner.as_ref());
        bytes[64..72].copy_from_slice(&MIN_BUY.to_le_bytes());
        bytes.extend_from_slice(&[2, 15, 0, 1, 0, 1]);
        let address = Keypair::new().pubkey();
        let account = Account { lamports: SOL, data: bytes, owner: Keypair::new().pubkey(), executable: false, rent_epoch: 0 };
        env.svm.set_account(address, account).unwrap();
        address
    };
    let (fake_vault, fake_wallet) = (forge(&mut env, vault), forge(&mut env, thief));
    let forged = direct(fake_vault, fake_wallet);
    assert_eq!(error(env.send(vec![forged], &[])), hook_error(HookError::NotATransfer));
    // A real token account on one side doesn't make the other side real.
    let half_forged = direct(ata(&vault, &mint), fake_wallet);
    assert_eq!(error(env.send(vec![half_forged], &[])), hook_error(HookError::NotATransfer));

    // The rules account has to be writable, and has to be one the hook made.
    let mut read_only = real.clone();
    read_only.accounts[5] = AccountMeta::new_readonly(rules, false);
    assert_eq!(error(env.send(vec![read_only], &[])), hook_error(HookError::NotWritable));
    let mut not_rules = real.clone();
    not_rules.accounts[5] = AccountMeta::new(fake_wallet, false);
    assert_eq!(error(env.send(vec![not_rules], &[])), InstructionError::InvalidAccountOwner);
    let mut too_few = real.clone();
    too_few.accounts.pop();
    assert_eq!(error(env.send(vec![too_few], &[])), TOO_FEW_ACCOUNTS);

    assert_eq!(env.state(), before, "the counters and the game only move with real transfers");
}

#[test]
fn only_reads_and_writes_the_rules_of_the_token_being_moved() {
    // Two tokens in one world: one that plays, and a second whose rules cap nothing.
    let mut env = Env::launch(Config::game());
    let (payer, alice, vault, mint) = (env.payer.pubkey(), env.alice.pubkey(), env.vault.pubkey(), env.mint.pubkey());
    let other = Keypair::new();
    let loose = env.init_of(&Config::default());
    env.send(vec![init_ix(&payer, &other.pubkey(), &loose)], &[&other]).unwrap();
    let before = env.state();

    // Only a simulator can do this: write token accounts that look exactly like Token-2022
    // has them in the middle of a buy, flag up, so a direct call gets past the proof that a
    // transfer is running and reaches the checks behind it.
    let in_flight = |env: &mut Env, of_mint: Address, owner: Address| {
        let mut bytes = vec![0u8; 165];
        bytes[..32].copy_from_slice(of_mint.as_ref());
        bytes[32..64].copy_from_slice(owner.as_ref());
        bytes[64..72].copy_from_slice(&MIN_BUY.to_le_bytes());
        bytes.extend_from_slice(&[2, 15, 0, 1, 0, 1]);
        let address = Keypair::new().pubkey();
        let account = Account { lamports: SOL, data: bytes, owner: TOKEN_2022, executable: false, rent_epoch: 0 };
        env.svm.set_account(address, account).unwrap();
        address
    };
    let mut data = EXECUTE.to_vec();
    data.extend_from_slice(&MIN_BUY.to_le_bytes());
    let list = env.list;
    let call = |source: Address, of_mint: Address, destination: Address, rules: Address| Instruction {
        program_id: HOOK,
        accounts: vec![
            AccountMeta::new_readonly(source, false),
            AccountMeta::new_readonly(of_mint, false),
            AccountMeta::new_readonly(destination, false),
            AccountMeta::new_readonly(vault, false),
            AccountMeta::new_readonly(list, false),
            AccountMeta::new(rules, false),
        ],
        data: data.clone(),
    };

    // A transfer of the second token can't be passed off as a buy of the first: not with
    // the first token's rules, and not by naming the first token's mint either.
    let (source, destination) = (in_flight(&mut env, other.pubkey(), vault), in_flight(&mut env, other.pubkey(), alice));
    let ix = call(source, other.pubkey(), destination, env.rules);
    assert_eq!(error(env.send(vec![ix], &[])), hook_error(HookError::WrongAccount));
    let ix = call(source, mint, destination, env.rules);
    assert_eq!(error(env.send(vec![ix], &[])), hook_error(HookError::NotATransfer));
    // And a transfer of the first token can't run under the second token's loose rules.
    let (source, destination) = (in_flight(&mut env, mint, vault), in_flight(&mut env, mint, alice));
    let ix = call(source, mint, destination, rules_of(&other.pubkey()).0);
    assert_eq!(error(env.send(vec![ix], &[])), hook_error(HookError::WrongAccount));
    assert_eq!(env.state(), before);

    // The same call with the token's own rules is what a real buy looks like to the hook.
    let ix = call(source, mint, destination, env.rules);
    env.send(vec![ix], &[]).unwrap();
    assert_eq!(env.round(), (alice, T0 + TIMER));
}

#[test]
fn one_real_end_is_not_a_transfer() {
    let mut env = Env::launch(Config::game());
    let (alice, vault, mint, list, rules) = (env.alice.pubkey(), env.vault.pubkey(), env.mint.pubkey(), env.list, env.rules);
    let (other_mint, other_program) = (Keypair::new().pubkey(), Keypair::new().pubkey());
    let before = env.state();

    // A token account written straight into the simulator. `flag` is the byte Token-2022
    // raises to 1 on both accounts while it is calling the hook.
    let forge = |env: &mut Env, of_mint: Address, owner: Address, program: Address, flag: u8| {
        let mut bytes = vec![0u8; 165];
        bytes[..32].copy_from_slice(of_mint.as_ref());
        bytes[32..64].copy_from_slice(owner.as_ref());
        bytes[64..72].copy_from_slice(&MIN_BUY.to_le_bytes());
        bytes.extend_from_slice(&[2, 15, 0, 1, 0, flag]);
        let address = Keypair::new().pubkey();
        let account = Account { lamports: SOL, data: bytes, owner: program, executable: false, rent_epoch: 0 };
        env.svm.set_account(address, account).unwrap();
        address
    };
    // The four ways one end can fall short of "a Token-2022 account of this mint, in the
    // middle of a transfer": another program owns it, it holds another token, its flag is
    // down, or its flag is some other number.
    let broken = |env: &mut Env, owner: Address| {
        [
            ("owned by another program", forge(env, mint, owner, other_program, 1)),
            ("of another mint", forge(env, other_mint, owner, TOKEN_2022, 1)),
            ("with its flag down", forge(env, mint, owner, TOKEN_2022, 0)),
            ("with a flag that isn't 1", forge(env, mint, owner, TOKEN_2022, 2)),
        ]
    };
    let mut data = EXECUTE.to_vec();
    data.extend_from_slice(&MIN_BUY.to_le_bytes());
    let call = |source: Address, destination: Address| Instruction {
        program_id: HOOK,
        accounts: vec![
            AccountMeta::new_readonly(source, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(destination, false),
            AccountMeta::new_readonly(vault, false),
            AccountMeta::new_readonly(list, false),
            AccountMeta::new(rules, false),
        ],
        data: data.clone(),
    };

    // Both ends exactly as they are in the middle of a buy, then each end spoiled in turn
    // while the other stays perfect. The proof has to hold for both.
    let (source, destination) = (forge(&mut env, mint, vault, TOKEN_2022, 1), forge(&mut env, mint, alice, TOKEN_2022, 1));
    for (what, bad_source) in broken(&mut env, vault) {
        assert_eq!(error(env.send(vec![call(bad_source, destination)], &[])), hook_error(HookError::NotATransfer), "a source {what}");
    }
    for (what, bad_destination) in broken(&mut env, alice) {
        assert_eq!(error(env.send(vec![call(source, bad_destination)], &[])), hook_error(HookError::NotATransfer), "a destination {what}");
    }
    assert_eq!(env.state(), before);

    // The two good ends together do pass, so each refusal above was about the spoiled end.
    env.send(vec![call(source, destination)], &[]).unwrap();
    assert_eq!(env.round(), (alice, T0 + TIMER));
}

#[test]
fn rules_in_a_layout_the_hook_does_not_know_are_refused() {
    let mut env = Env::launch(Config::game());
    let (alice, bob, rules, alice_key) = (env.alice.pubkey(), env.bob.pubkey(), env.rules, env.alice.insecure_clone());
    let wrong_account = hook_error(HookError::WrongAccount);
    env.fund(&rules, SOL);
    env.buy(&alice, MIN_BUY).unwrap();
    env.pass_time(TIMER);

    // The right size, with a version number from the future: its fields could mean anything,
    // so nothing is read from it and nothing is paid out of it.
    env.rewrite_rules(|rules| rules.version = 3);
    let before = env.state();
    assert_eq!(error(env.buy(&bob, MIN_BUY)), wrong_account);
    assert_eq!(error(env.transfer(&alice_key, &bob, TOKEN)), wrong_account);
    assert_eq!(error(env.settle(&alice)), wrong_account);
    assert_eq!((env.state(), env.pot()), (before, SOL));

    env.rewrite_rules(|rules| rules.version = VERSION);
    env.settle(&alice).unwrap();
    assert_eq!(env.lamports(&alice), SOL);
}

/* ---------------- tokens launched by the first version of the hook ---------------- */

/// Rewrites a token's rules the way the first version of the hook stored them: 120 bytes,
/// version 1, a cap (fixed, or in parameter 0 of `leash`) and a counter.
fn store_layout_one(env: &mut Env, cap: u64, leash: Option<Address>) {
    let mut data = vec![0u8; 120];
    data[0] = 1;
    data[1] = rules_of(&env.mint.pubkey()).1;
    data[8..40].copy_from_slice(env.mint.pubkey().as_ref());
    data[40..72].copy_from_slice(env.vault.pubkey().as_ref());
    data[72..104].copy_from_slice(leash.unwrap_or(SYSTEM_PROGRAM).as_ref());
    data[104..112].copy_from_slice(&cap.to_le_bytes());
    let mut account = env.svm.get_account(&env.rules).unwrap();
    account.data = data;
    env.svm.set_account(env.rules, account).unwrap();
}

/// The counter of a token still in the first layout, after checking the account was left in it.
fn layout_one_transfers(env: &Env) -> u64 {
    let data = env.svm.get_account(&env.rules).unwrap().data;
    assert_eq!((data.len(), data[0]), (120, 1), "the account keeps its first layout");
    u64::from_le_bytes(data[112..120].try_into().unwrap())
}

#[test]
fn a_token_from_the_first_hook_still_trades() {
    // A token keeps the rules account it was launched with for good, and its mint is tied
    // to this program's address. So when the program is upgraded in place, the tokens that
    // are already out there must go on trading under the rules they have, or their holders
    // could never sell again.
    let mut env = Env::launch(Config::capped(CAP));
    store_layout_one(&mut env, CAP, None);
    let (alice, bob, rules, alice_key) = (env.alice.pubkey(), env.bob.pubkey(), env.rules, env.alice.insecure_clone());
    let over = hook_error(HookError::OverMaxPerWallet);

    env.buy(&alice, CAP).unwrap();
    assert_eq!(error(env.buy(&alice, 1)), over);
    env.buy(&bob, CAP / 2).unwrap();
    assert_eq!(error(env.transfer(&alice_key, &bob, CAP / 2 + 1)), over);
    env.transfer(&alice_key, &bob, TOKEN).unwrap();
    env.sell(&alice_key, CAP - TOKEN).unwrap();
    assert_eq!((env.balance(&alice), env.balance(&bob)), (0, CAP / 2 + TOKEN));
    assert_eq!(layout_one_transfers(&env), 4);

    // It has no game: `settle` finds nothing to read, and takes nothing.
    env.fund(&rules, SOL);
    let held = env.lamports(&rules);
    assert_eq!(error(env.settle(&alice)), InstructionError::InvalidAccountData);
    assert_eq!(env.lamports(&rules), held);

    // 120 bytes that don't say version 1 are not rules the first hook wrote.
    let mut account = env.svm.get_account(&rules).unwrap();
    account.data[0] = 2;
    env.svm.set_account(rules, account).unwrap();
    assert_eq!(error(env.buy(&alice, TOKEN)), hook_error(HookError::WrongAccount));
}

#[test]
fn a_token_from_the_first_hook_still_reads_its_leash() {
    // The first hook could read its cap from a leash too: 1 percent, which the agent may
    // move up to 5 percent.
    let mut env = Env::launch(Config::leash_capped());
    let leash = env.leash.unwrap();
    store_layout_one(&mut env, 0, Some(leash));
    let (alice, bob, alice_key) = (env.alice.pubkey(), env.bob.pubkey(), env.alice.insecure_clone());
    let over = hook_error(HookError::OverMaxPerWallet);

    env.buy(&alice, CAP).unwrap();
    assert_eq!(error(env.buy(&alice, TOKEN)), over);
    env.set_param(0, 2 * CAP as i64).unwrap();
    env.buy(&alice, CAP).unwrap();
    assert_eq!(error(env.buy(&alice, TOKEN)), over);
    assert_eq!(layout_one_transfers(&env), 2);

    // A leash that can no longer be read stops buys and transfers. It never stops a sell,
    // which is more than the first hook itself promised.
    let mut account = env.svm.get_account(&leash).unwrap();
    account.owner = Keypair::new().pubkey();
    env.svm.set_account(leash, account).unwrap();
    assert_eq!(error(env.buy(&bob, TOKEN)), hook_error(HookError::WrongAccount));
    assert_eq!(error(env.transfer(&alice_key, &bob, TOKEN)), hook_error(HookError::WrongAccount));
    env.sell(&alice_key, 2 * CAP).unwrap();
    assert_eq!((env.balance(&alice), layout_one_transfers(&env)), (0, 3));
}

#[test]
fn a_transfer_that_passes_the_rules_read_only_fails() {
    let mut env = Env::launch(Config::capped(CAP));
    let (alice, vault, rules) = (env.alice.pubkey(), env.vault.insecure_clone(), env.rules);
    env.open_account(&alice);

    // Token-2022 calls the hook with the rules writable, as the list says. It can't do
    // that with an account the transaction only lent it for reading: the runtime stops the
    // call before the hook runs. The hook's own check for this is reached by calling it
    // directly, in `cannot_be_called_outside_a_transfer`.
    let mut ix = env.transfer_ix(&vault.pubkey(), &alice, TOKEN);
    ix.accounts[4] = AccountMeta::new_readonly(rules, false);
    assert_eq!(error(env.send(vec![ix], &[&vault])), InstructionError::PrivilegeEscalation);
    assert_eq!((env.balance(&alice), env.state().transfers), (0, 0));
}

#[test]
fn rejects_rules_that_belong_to_another_token() {
    let mut a = Env::launch(Config::capped(CAP));
    let (payer, alice) = (a.payer.pubkey(), a.alice.pubkey());
    // A second token in the same world, with no cap at all.
    let other = Keypair::new();
    let loose = Init { exempt_owner: alice, ..a.init_of(&Config::default()) };
    a.send(vec![init_ix(&payer, &other.pubkey(), &loose)], &[&other]).unwrap();

    // Token-2022 only passes what the token's own list names, so the swapped rules never
    // reach the hook: Token-2022 itself refuses, with its "incorrect account" error, before
    // any token moves. The hook's own check is reached by calling it directly, in
    // `only_reads_and_writes_the_rules_of_the_token_being_moved`.
    a.rules = rules_of(&other.pubkey()).0;
    assert_eq!(error(a.buy(&alice, 2 * CAP)), InstructionError::Custom(0xa261_c2c0));
    assert_eq!(a.balance(&alice), 0);
}

#[test]
fn cap_follows_the_leash() {
    // The cap starts at 1 percent, in a leash that lets the agent move it up to 5 percent.
    let mut env = Env::launch(Config::leash_capped());
    let alice = env.alice.pubkey();
    assert_eq!(env.state().leash, env.leash.unwrap().to_bytes());
    assert_eq!(env.svm.get_account(&env.list).unwrap().data.len(), 16 + 35 * 2, "rules and leash are both listed");

    env.buy(&alice, CAP).unwrap();
    assert_eq!(error(env.buy(&alice, TOKEN)), hook_error(HookError::OverMaxPerWallet));

    // The agent raises the cap; the very next transfer obeys the new value.
    env.set_param(0, 3 * CAP as i64).unwrap();
    env.buy(&alice, 2 * CAP).unwrap();
    assert_eq!(env.balance(&alice), 3 * CAP);
    assert_eq!(error(env.buy(&alice, TOKEN)), hook_error(HookError::OverMaxPerWallet));

    // And it can't go past what the leash allows, so neither can the cap.
    assert!(env.set_param(0, 5 * CAP as i64 + 1).is_err());
    env.set_param(0, 5 * CAP as i64).unwrap();
    env.buy(&alice, 2 * CAP).unwrap();
    assert_eq!(error(env.buy(&alice, TOKEN)), hook_error(HookError::OverMaxPerWallet));

    // Lowering it never traps holders: alice is over the new cap and can still sell.
    env.set_param(0, CAP as i64).unwrap();
    let alice_key = env.alice.insecure_clone();
    env.sell(&alice_key, 5 * CAP).unwrap();
    assert_eq!(env.balance(&alice), 0);
}

#[test]
fn a_leash_cap_below_zero_is_the_tightest_cap() {
    // A leash that lets its agent take the cap below zero. That must never read as "no cap".
    let leash = LeashConfig { params: vec![(CAP as i64, -5, CAP as i64)], spend: 0 };
    let mut env = Env::launch(Config { cap_param: Some(0), leash: Some(leash), ..Config::default() });
    let (alice, bob, alice_key) = (env.alice.pubkey(), env.bob.pubkey(), env.alice.insecure_clone());
    env.buy(&alice, CAP).unwrap();

    env.set_param(0, -5).unwrap();
    assert_eq!(error(env.buy(&bob, 2)), hook_error(HookError::OverMaxPerWallet));
    env.buy(&bob, 1).unwrap();
    assert_eq!(error(env.buy(&bob, 1)), hook_error(HookError::OverMaxPerWallet));
    // Holders can still get out.
    env.sell(&alice_key, CAP).unwrap();

    // Zero is what "no cap" looks like, as it does for a fixed cap.
    env.set_param(0, 0).unwrap();
    env.buy(&bob, 3 * CAP).unwrap();
    assert_eq!(env.balance(&bob), 3 * CAP + 1);
}

#[test]
fn a_leash_look_alike_is_not_a_leash() {
    let mut env = Env::launch(Config::leash_capped());
    let (alice, bob, alice_key) = (env.alice.pubkey(), env.bob.pubkey(), env.alice.insecure_clone());
    let leash = env.leash.unwrap();
    env.buy(&alice, CAP).unwrap();

    // Same address, same bytes, a huge cap, but no longer owned by the leash program.
    let mut account = env.svm.get_account(&leash).unwrap();
    account.data[240..248].copy_from_slice(&(SUPPLY as i64).to_le_bytes());
    account.owner = Keypair::new().pubkey();
    env.svm.set_account(leash, account).unwrap();

    assert_eq!(error(env.buy(&bob, 2 * CAP)), hook_error(HookError::WrongAccount));
    assert_eq!(error(env.transfer(&alice_key, &bob, TOKEN)), hook_error(HookError::WrongAccount));
    assert_eq!(env.balance(&bob), 0);

    // A sell never reads the leash, so a broken one can't trap anybody.
    env.sell(&alice_key, CAP).unwrap();
    assert_eq!(env.balance(&alice), 0);
}

/* ---------------- the block limit ---------------- */

#[test]
fn block_limit_refuses_the_buy_that_crosses_it() {
    let mut env = Env::launch(Config::guarded());
    let (alice, bob, alice_key) = (env.alice.pubkey(), env.bob.pubkey(), env.alice.insecure_clone());
    let too_much = hook_error(HookError::TooMuchInOneBlock);

    // The limit is on the slot, not on a wallet: a bundle's second wallet is stopped.
    env.buy(&alice, BLOCK_LIMIT - TOKEN).unwrap();
    assert_eq!(error(env.buy(&bob, TOKEN + 1)), too_much);
    assert_eq!(env.balance(&bob), 0, "a refused buy moves nothing");
    env.buy(&bob, TOKEN).unwrap();
    assert_eq!(error(env.buy(&bob, 1)), too_much, "exactly the limit was allowed, nothing above it");
    let state = env.state();
    assert_eq!((state.block_slot, state.block_bought, state.transfers), (LAUNCH_SLOT, BLOCK_LIMIT, 2));

    // Sells and transfers between wallets are neither counted nor blocked in a full block,
    // and selling doesn't make room to buy again.
    env.transfer(&alice_key, &bob, BLOCK_LIMIT / 2).unwrap();
    env.sell(&alice_key, BLOCK_LIMIT / 4).unwrap();
    assert_eq!(env.state().block_bought, BLOCK_LIMIT);
    assert_eq!(error(env.buy(&alice, 1)), too_much);

    // The next slot starts from zero.
    env.set_slot(LAUNCH_SLOT + 1);
    env.buy(&bob, BLOCK_LIMIT).unwrap();
    assert_eq!(error(env.buy(&alice, 1)), too_much);
    let state = env.state();
    assert_eq!((state.block_slot, state.block_bought), (LAUNCH_SLOT + 1, BLOCK_LIMIT));

    // One buy can cross the limit on its own.
    env.set_slot(LAUNCH_SLOT + 2);
    assert_eq!(error(env.buy(&alice, BLOCK_LIMIT + 1)), too_much);
}

#[test]
fn block_limit_ends_with_the_guard() {
    let mut env = Env::launch(Config::guarded());
    let alice = env.alice.pubkey();
    // The first buy opens the window.
    env.buy(&alice, TOKEN).unwrap();
    env.set_slot(LAUNCH_SLOT + GUARD_SLOTS - 1);
    assert_eq!(error(env.buy(&alice, BLOCK_LIMIT + 1)), hook_error(HookError::TooMuchInOneBlock));
    env.set_slot(LAUNCH_SLOT + GUARD_SLOTS);
    env.buy(&alice, 10 * BLOCK_LIMIT).unwrap();
    env.buy(&alice, 10 * BLOCK_LIMIT).unwrap();
    assert_eq!(env.balance(&alice), 20 * BLOCK_LIMIT + TOKEN);
    let state = env.state();
    assert_eq!((state.block_slot, state.block_bought), (LAUNCH_SLOT, TOKEN), "nothing is counted once the guard is down");

    // A guard length of zero means the limit lasts as long as the token.
    let mut env = Env::launch(Config { guard_slots: 0, ..Config::guarded() });
    let alice = env.alice.pubkey();
    env.buy(&alice, TOKEN).unwrap();
    env.set_slot(LAUNCH_SLOT + 1_000_000_000);
    assert_eq!(error(env.buy(&alice, BLOCK_LIMIT + 1)), hook_error(HookError::TooMuchInOneBlock));
    env.buy(&alice, BLOCK_LIMIT).unwrap();
}

#[test]
fn the_guard_counts_from_the_first_buy() {
    // `init` needs only the mint key, so whoever launches a token chooses how long passes
    // between its rules and its pool. If the window ran from `init`, a creator could let it
    // run out with the pool still closed and then buy the supply in the pool's first block,
    // on a token whose rules say it is guarded.
    let mut env = Env::launch(Config::guarded());
    let (alice, bob) = (env.alice.pubkey(), env.bob.pubkey());
    let too_much = hook_error(HookError::TooMuchInOneBlock);
    let first = LAUNCH_SLOT + 10 * GUARD_SLOTS;
    env.set_slot(first);

    // Long after `init`, the first buy the token ever sees is still held to the limit.
    assert_eq!(error(env.buy(&alice, BLOCK_LIMIT + 1)), too_much);
    assert_eq!((env.state().launch_slot, env.state().transfers), (LAUNCH_SLOT, 0), "a refused buy opens nothing");
    env.buy(&alice, BLOCK_LIMIT).unwrap();
    assert_eq!(env.state().launch_slot, first, "the window runs from the first buy");
    assert_eq!(error(env.buy(&bob, 1)), too_much);

    // It lasts its full length from there, and later buys don't move it.
    env.set_slot(first + GUARD_SLOTS - 1);
    assert_eq!(error(env.buy(&bob, BLOCK_LIMIT + 1)), too_much);
    env.buy(&bob, BLOCK_LIMIT).unwrap();
    assert_eq!(env.state().launch_slot, first);
    env.set_slot(first + GUARD_SLOTS);
    env.buy(&bob, 10 * BLOCK_LIMIT).unwrap();
    assert_eq!(env.state().launch_slot, first);
}

/* ---------------- Last Buyer Wins ---------------- */

#[test]
fn the_last_buyer_leads_and_each_buy_restarts_the_clock() {
    let mut env = Env::launch(Config::game());
    let (alice, bob, vault) = (env.alice.pubkey(), env.bob.pubkey(), env.vault.pubkey());
    let (alice_key, bob_key) = (env.alice.insecure_clone(), env.bob.insecure_clone());
    assert_eq!(env.round(), (SYSTEM_PROGRAM, 0), "waiting for a first buy");

    // A buy under the minimum lands but doesn't start the clock.
    env.buy(&alice, MIN_BUY - 1).unwrap();
    assert_eq!(env.round(), (SYSTEM_PROGRAM, 0));

    // The first buy that counts does.
    env.buy(&alice, MIN_BUY).unwrap();
    assert_eq!(env.round(), (alice, T0 + TIMER));

    // A later one takes the lead and restarts the clock from the moment it lands.
    env.pass_time(TIMER - 1);
    env.buy(&bob, 3 * MIN_BUY).unwrap();
    assert_eq!(env.round(), (bob, T0 + 2 * TIMER - 1));

    // Only buys from the curve play. A small buy, a transfer between wallets and a sell
    // change nothing, whatever their size.
    env.pass_time(10);
    env.buy(&alice, MIN_BUY - 1).unwrap();
    env.transfer(&bob_key, &alice, 2 * MIN_BUY).unwrap();
    env.sell(&alice_key, 2 * MIN_BUY).unwrap();
    assert_eq!(env.round(), (bob, T0 + 2 * TIMER - 1));
    assert_ne!(env.round().0, vault);

    // From the second the clock runs out, buys still land but the round is bob's until it
    // is settled.
    env.pass_time(TIMER - 10);
    env.buy(&alice, 5 * MIN_BUY).unwrap();
    env.pass_time(3 * TIMER);
    env.buy(&alice, 5 * MIN_BUY).unwrap();
    assert_eq!(env.round(), (bob, T0 + 2 * TIMER - 1));
    assert_eq!(env.balance(&alice), 13 * MIN_BUY - 2);
    assert_eq!(env.state().lbw_round, 0);
}

#[test]
fn the_game_waits_for_the_guard() {
    // While the block limit applies, a slot only has so much room. Whoever leads a round
    // could use it up, slot after slot, with buys too small to count (sold straight back,
    // so they cost only fees), and nobody else could buy enough to take the lead before the
    // clock ran out. So the two never run together: the game starts when the guard is down.
    //
    // Here a buy has to be 3,000,000 tokens to count and a slot has room for 5,000,000, so
    // one buy of 2,000,001, too small to count, leaves no room for one that does.
    let min_buy = 3_000_000 * TOKEN;
    let filler = BLOCK_LIMIT - min_buy + 1;
    let mut env = Env::launch(Config { block_limit: BLOCK_LIMIT, guard_slots: GUARD_SLOTS, lbw_min_buy: min_buy, ..Config::game() });
    let (alice, bob, rules, helper) = (env.alice.pubkey(), env.bob.pubkey(), env.rules, Keypair::new().pubkey());
    env.fund(&rules, SOL);

    // Under the guard, buys land and are counted against the block, but none of them leads:
    // keeping a rival out of a slot wins nothing yet.
    env.buy(&alice, min_buy).unwrap();
    assert_eq!(env.round(), (SYSTEM_PROGRAM, 0));
    env.set_slot(LAUNCH_SLOT + GUARD_SLOTS - 1);
    env.pass_time(60);
    env.buy(&helper, filler).unwrap();
    assert_eq!(error(env.buy(&bob, min_buy)), hook_error(HookError::TooMuchInOneBlock));
    let state = env.state();
    assert_eq!((state.block_bought, state.lbw_deadline, state.lbw_last_buyer), (filler, 0, [0; 32]));
    assert_eq!(error(env.settle(&alice)), hook_error(HookError::RoundNotOver));

    // The slot the guard comes down, the next buy that counts starts the first round.
    env.set_slot(LAUNCH_SLOT + GUARD_SLOTS);
    env.buy(&alice, min_buy).unwrap();
    assert_eq!(env.round(), (alice, T0 + 60 + TIMER));

    // The same small buy now keeps nobody out: bob's lands in that very slot and leads.
    env.pass_time(10);
    env.buy(&helper, filler).unwrap();
    assert_eq!(env.round(), (alice, T0 + 60 + TIMER), "too small to count");
    env.buy(&bob, min_buy).unwrap();
    assert_eq!(env.round(), (bob, T0 + 70 + TIMER));
}

#[test]
fn settle_pays_the_pot_to_the_last_buyer_once() {
    let mut env = Env::launch(Config::game());
    let (payer, alice, bob, rules) = (env.payer.pubkey(), env.alice.pubkey(), env.bob.pubkey(), env.rules);
    let not_over = hook_error(HookError::RoundNotOver);
    let not_the_winner = hook_error(HookError::NotTheWinner);
    // Anyone funds the pot with a plain transfer. Alice already holds some SOL of her own.
    env.fund(&rules, 2 * SOL);
    env.fund(&alice, SOL);
    assert_eq!(env.pot(), 2 * SOL);

    // No round has started, so there is nobody to pay: not even "nobody".
    assert_eq!(error(env.settle(&alice)), not_over);
    assert_eq!(error(env.settle(&SYSTEM_PROGRAM)), not_over);

    // The clock is still running.
    env.buy(&alice, MIN_BUY).unwrap();
    env.pass_time(TIMER - 1);
    assert_eq!(error(env.settle(&alice)), not_over);

    // It has run out, and only the last buyer can be paid.
    env.pass_time(1);
    for stranger in [bob, payer, rules, SYSTEM_PROGRAM] {
        assert_eq!(error(env.settle(&stranger)), not_the_winner);
    }
    assert_eq!(env.pot(), 2 * SOL);

    // The whole pot goes to alice, and the rules account keeps exactly its rent.
    let fees_before = env.lamports(&payer);
    let result = env.settle(&alice).unwrap();
    assert_eq!(env.lamports(&alice), SOL + 2 * SOL);
    assert_eq!(env.lamports(&rules), env.reserve());
    assert_eq!(env.lamports(&payer), fees_before - result.fee, "whoever calls it only pays the fee");
    let state = env.state();
    assert_eq!((state.lbw_last_winner, state.lbw_last_prize, state.lbw_total_paid), (alice.to_bytes(), 2 * SOL, 2 * SOL));
    assert_eq!((state.lbw_round, state.lbw_last_buyer, state.lbw_deadline), (1, [0; 32], 0));

    // One round pays once, even after the pot is filled again.
    assert_eq!(error(env.settle(&alice)), not_over);
    env.fund(&rules, SOL);
    assert_eq!(error(env.settle(&alice)), not_over);
    assert_eq!(error(env.settle(&SYSTEM_PROGRAM)), not_over);
    assert_eq!((env.pot(), env.lamports(&alice)), (SOL, 3 * SOL));
}

#[test]
fn the_next_round_starts_with_the_next_buy() {
    let mut env = Env::launch(Config::game());
    let (alice, bob, rules) = (env.alice.pubkey(), env.bob.pubkey(), env.rules);
    env.fund(&rules, SOL);
    env.buy(&alice, MIN_BUY).unwrap();
    env.pass_time(TIMER);
    // A buy between the end of the round and its settlement doesn't carry into the next one.
    env.buy(&bob, MIN_BUY).unwrap();
    env.settle(&alice).unwrap();
    assert_eq!(env.round(), (SYSTEM_PROGRAM, 0));

    // Round two: money that arrives now is its pot, and its clock starts with its first buy.
    env.fund(&rules, 3 * SOL);
    env.pass_time(5 * TIMER);
    env.buy(&bob, MIN_BUY).unwrap();
    assert_eq!(env.round(), (bob, T0 + 7 * TIMER));
    env.pass_time(TIMER - 1);
    assert_eq!(error(env.settle(&bob)), hook_error(HookError::RoundNotOver));
    env.pass_time(1);
    assert_eq!(error(env.settle(&alice)), hook_error(HookError::NotTheWinner), "last round's winner has no claim");
    env.settle(&bob).unwrap();

    assert_eq!((env.lamports(&alice), env.lamports(&bob)), (SOL, 3 * SOL));
    let state = env.state();
    assert_eq!((state.lbw_round, state.lbw_last_winner, state.lbw_last_prize, state.lbw_total_paid), (2, bob.to_bytes(), 3 * SOL, 4 * SOL));
    assert_eq!(env.lamports(&rules), env.reserve());
}

#[test]
fn settle_refuses_a_token_without_the_game() {
    let mut env = Env::launch(Config::capped(CAP));
    let (alice, rules) = (env.alice.pubkey(), env.rules);
    env.buy(&alice, MIN_BUY).unwrap();
    // SOL sent to a token that doesn't play has no winner to go to. It stays there.
    env.fund(&rules, SOL);
    env.pass_time(10 * TIMER);
    for winner in [alice, SYSTEM_PROGRAM] {
        assert_eq!(error(env.settle(&winner)), hook_error(HookError::GameOff));
    }
    assert_eq!(env.pot(), SOL);
}

#[test]
fn settle_only_trusts_a_rules_account_the_hook_made() {
    let mut env = Env::launch(Config::game());
    let (alice, rules, list) = (env.alice.pubkey(), env.rules, env.list);
    env.fund(&rules, SOL);
    env.buy(&alice, MIN_BUY).unwrap();
    env.pass_time(TIMER);
    let before = env.state();

    // A copy of the rules that names a thief as the last buyer, with SOL in it, owned by
    // another program: the kind of account anyone can make.
    let thief = Keypair::new().pubkey();
    let mut forged_state = before;
    forged_state.lbw_last_buyer = thief.to_bytes();
    let data = unsafe { std::slice::from_raw_parts(&forged_state as *const Rules as *const u8, RULES_LEN) }.to_vec();
    let forged = Keypair::new().pubkey();
    let account = Account { lamports: 50 * SOL, data, owner: Keypair::new().pubkey(), executable: false, rent_epoch: 0 };
    env.svm.set_account(forged, account).unwrap();
    let settle = |rules: AccountMeta, winner: Address, data: Vec<u8>| Instruction {
        program_id: HOOK,
        accounts: vec![rules, AccountMeta::new(winner, false)],
        data,
    };
    let ix = settle(AccountMeta::new(forged, false), thief, vec![SETTLE]);
    assert_eq!(error(env.send(vec![ix], &[])), InstructionError::InvalidAccountOwner);
    assert_eq!((env.lamports(&forged), env.lamports(&thief)), (50 * SOL, 0));

    // The hook's other account, the list, is not a rules account either.
    let ix = settle(AccountMeta::new(list, false), alice, vec![SETTLE]);
    assert_eq!(error(env.send(vec![ix], &[])), InstructionError::InvalidAccountData);

    // The real rules passed read-only, or with no winner next to them.
    let ix = settle(AccountMeta::new_readonly(rules, false), alice, vec![SETTLE]);
    assert_eq!(error(env.send(vec![ix], &[])), hook_error(HookError::NotWritable));
    let mut alone = env.settle_ix(&alice);
    alone.accounts.pop();
    assert_eq!(error(env.send(vec![alone], &[])), TOO_FEW_ACCOUNTS);

    // Bytes that are no instruction: nothing, unknown tags, a settle with something after it.
    for data in [vec![], vec![2], vec![255], vec![SETTLE, 0], EXECUTE[..7].to_vec()] {
        let ix = settle(AccountMeta::new(rules, false), alice, data);
        assert_eq!(error(env.send(vec![ix], &[])), InstructionError::InvalidInstructionData);
    }

    assert_eq!((env.state(), env.pot()), (before, SOL), "none of that touched the round");
    env.settle(&alice).unwrap();
    assert_eq!(env.lamports(&alice), SOL);
}

#[test]
fn a_winner_passed_read_only_keeps_the_prize() {
    let mut env = Env::launch(Config::game());
    let (alice, rules) = (env.alice.pubkey(), env.rules);
    env.fund(&rules, SOL);
    env.buy(&alice, MIN_BUY).unwrap();
    env.pass_time(TIMER);
    let before = env.state();

    // Whoever calls `settle` chooses how the winner's account is passed. Passing it
    // read-only must not be a way to close the round without paying.
    let mut ix = env.settle_ix(&alice);
    ix.accounts[1] = AccountMeta::new_readonly(alice, false);
    assert_eq!(error(env.send(vec![ix], &[])), hook_error(HookError::NotWritable));
    assert_eq!((env.state(), env.pot()), (before, SOL));

    env.settle(&alice).unwrap();
    assert_eq!(env.lamports(&alice), SOL);
}

#[test]
fn a_winner_that_cannot_be_paid_rolls_the_pot_over() {
    let mut env = Env::launch(Config::game());
    let (alice, rules) = (env.alice.pubkey(), env.rules);
    env.fund(&rules, 3 * SOL);

    // Anyone can make any address the last buyer by buying into a token account it owns.
    // A program, the rules account itself, a sysvar, an address the runtime reserves
    // without there being an account, the system program (whose address is also how the
    // rules write "nobody"), and a sysvar this hook has never heard of: none of them can be
    // paid, and the reserved ones can't even be passed writable. Each round must still
    // close, with the pot untouched.
    let new_sysvar = Keypair::new().pubkey();
    let account = Account { lamports: SOL, data: vec![0; 8], owner: SYSVAR_OWNER, executable: false, rent_epoch: 0 };
    env.svm.set_account(new_sysvar, account).unwrap();
    let winners = [HOOK, rules, CLOCK_SYSVAR, SYSVAR_OWNER, SYSTEM_PROGRAM, new_sysvar];
    for (round, winner) in winners.into_iter().enumerate() {
        env.buy(&winner, MIN_BUY).unwrap();
        assert_eq!(env.round(), (winner, T0 + (round as i64 + 1) * TIMER));
        env.pass_time(TIMER);
        let held = env.lamports(&winner);

        env.settle(&winner).unwrap_or_else(|e| panic!("the round won by {winner} is stuck: {e:?}"));
        let state = env.state();
        assert_eq!((state.lbw_round, state.lbw_last_winner), (round as u64 + 1, winner.to_bytes()));
        assert_eq!((state.lbw_last_prize, state.lbw_total_paid), (0, 0));
        assert_eq!((env.round(), env.pot(), env.lamports(&winner)), ((SYSTEM_PROGRAM, 0), 3 * SOL, held));
    }

    // The next winner who can take it gets all of it.
    env.buy(&alice, MIN_BUY).unwrap();
    env.pass_time(TIMER);
    env.settle(&alice).unwrap();
    assert_eq!((env.lamports(&alice), env.pot()), (3 * SOL, 0));
    assert_eq!(env.state().lbw_total_paid, 3 * SOL);
}

#[test]
fn every_reserved_address_rolls_the_pot_over() {
    // The addresses the runtime makes read-only in every transaction, written out again
    // here on purpose: if one is dropped or mistyped in the hook, or the simulator starts
    // reserving one the hook doesn't know, the round won by it gets stuck and this fails.
    const RESERVED: [&str; 31] = [
        "AddressLookupTab1e1111111111111111111111111",
        "BPFLoader2111111111111111111111111111111111",
        "BPFLoader1111111111111111111111111111111111",
        "BPFLoaderUpgradeab1e11111111111111111111111",
        "ComputeBudget111111111111111111111111111111",
        "Config1111111111111111111111111111111111111",
        "Ed25519SigVerify111111111111111111111111111",
        "Feature111111111111111111111111111111111111",
        "LoaderV411111111111111111111111111111111111",
        "KeccakSecp256k11111111111111111111111111111",
        "Secp256r1SigVerify1111111111111111111111111",
        "StakeConfig11111111111111111111111111111111",
        "Stake11111111111111111111111111111111111111",
        "11111111111111111111111111111111",
        "Vote111111111111111111111111111111111111111",
        "ZkE1Gama1Proof11111111111111111111111111111",
        "ZkTokenProof1111111111111111111111111111111",
        "SysvarC1ock11111111111111111111111111111111",
        "SysvarEpochRewards1111111111111111111111111",
        "SysvarEpochSchedu1e111111111111111111111111",
        "SysvarFees111111111111111111111111111111111",
        "Sysvar1nstructions1111111111111111111111111",
        "SysvarLastRestartS1ot1111111111111111111111",
        "SysvarRecentB1ockHashes11111111111111111111",
        "SysvarRent111111111111111111111111111111111",
        "SysvarRewards111111111111111111111111111111",
        "SysvarS1otHashes111111111111111111111111111",
        "SysvarS1otHistory11111111111111111111111111",
        "SysvarStakeHistory1111111111111111111111111",
        "NativeLoader1111111111111111111111111111111",
        "Sysvar1111111111111111111111111111111111111",
    ];
    let mut env = Env::launch(Config::game());
    let rules = env.rules;
    env.fund(&rules, SOL);
    for (round, name) in RESERVED.into_iter().enumerate() {
        let winner = Address::from_str_const(name);
        env.buy(&winner, MIN_BUY).unwrap();
        env.pass_time(TIMER);
        let held = env.lamports(&winner);

        env.settle(&winner).unwrap_or_else(|e| panic!("the round won by {name} is stuck: {e:?}"));
        let state = env.state();
        assert_eq!((state.lbw_round, state.lbw_last_winner, state.lbw_last_prize), (round as u64 + 1, winner.to_bytes(), 0), "{name}");
        assert_eq!((env.pot(), env.lamports(&winner)), (SOL, held), "{name}");
    }
}

#[test]
fn a_pot_too_small_for_an_empty_account_rolls_over() {
    let mut env = Env::launch(Config::game());
    let (alice, bob, rules) = (env.alice.pubkey(), env.bob.pubkey(), env.rules);
    // What an account with no data must hold to exist. The runtime fails any transaction
    // that leaves a new account with less, so paying less than this to an empty account
    // could never land.
    let floor = env.svm.minimum_balance_for_rent_exemption(0);
    let play = |env: &mut Env, winner: &Address| {
        env.buy(winner, MIN_BUY).unwrap();
        env.pass_time(TIMER);
        env.settle(winner).unwrap();
        env.state().lbw_last_prize
    };

    // Alice holds no SOL at all, and the pot is one lamport short of that floor.
    env.fund(&rules, floor - 1);
    assert_eq!(play(&mut env, &alice), 0);
    assert_eq!((env.lamports(&alice), env.pot(), env.state().lbw_round), (0, floor - 1, 1));

    // One lamport more and the same empty account can take it.
    env.fund(&rules, 1);
    assert_eq!(play(&mut env, &alice), floor);
    assert_eq!((env.lamports(&alice), env.pot()), (floor, 0));

    // A winner who already holds SOL takes any pot, however small. An empty pot pays nothing.
    env.fund(&rules, 5);
    assert_eq!(play(&mut env, &alice), 5);
    assert_eq!(env.lamports(&alice), floor + 5);
    assert_eq!(play(&mut env, &bob), 0);
    assert_eq!((env.lamports(&bob), env.state().lbw_round), (0, 4));
    assert_eq!(env.lamports(&rules), env.reserve());

    // The floor is the winner's own. An account that holds data needs more to stay: this
    // one has 200 bytes and a single lamport, and a pot that would do for an empty account
    // leaves it one lamport short.
    let heavy = Keypair::new().pubkey();
    let account = Account { lamports: 1, data: vec![0; 200], owner: Keypair::new().pubkey(), executable: false, rent_epoch: 0 };
    env.svm.set_account(heavy, account).unwrap();
    let heavy_floor = env.svm.minimum_balance_for_rent_exemption(200);
    assert!(heavy_floor - 2 > floor);
    env.fund(&rules, heavy_floor - 2);
    assert_eq!(play(&mut env, &heavy), 0);
    assert_eq!((env.lamports(&heavy), env.pot()), (1, heavy_floor - 2));
    env.fund(&rules, 1);
    assert_eq!(play(&mut env, &heavy), heavy_floor - 1);
    assert_eq!((env.lamports(&heavy), env.pot()), (heavy_floor, 0));
}

/* ---------------- the leash and the game ---------------- */

#[test]
fn the_agent_feeds_the_pot_through_the_leash() {
    // A leash that can pay into the game: the token's rules account is its second
    // destination, after the creator's wallet. The hook itself reads nothing from this leash.
    let leash = LeashConfig { params: vec![], spend: SOL };
    let mut env = Env::launch(Config { leash: Some(leash), ..Config::game() });
    let (alice, rules, leash) = (env.alice.pubkey(), env.rules, env.leash.unwrap());
    assert_eq!(env.state().leash, [0; 32]);
    env.fund(&leash, 5 * SOL);
    assert_eq!(env.pot(), 0);

    env.spend(rules, SOL).unwrap();
    env.spend(rules, SOL / 2).unwrap();
    assert_eq!(env.pot(), SOL + SOL / 2);
    // The leash still decides how much and where to.
    assert!(env.spend(rules, SOL + 1).is_err());
    assert!(env.spend(alice, SOL / 2).is_err());

    env.buy(&alice, MIN_BUY).unwrap();
    // Money that arrives while the round runs is part of its pot.
    env.spend(rules, SOL).unwrap();
    env.pass_time(TIMER);
    env.settle(&alice).unwrap();
    assert_eq!(env.lamports(&alice), 2 * SOL + SOL / 2);
    assert_eq!((env.pot(), env.state().lbw_last_prize), (0, 2 * SOL + SOL / 2));

    // And the agent can fill the next round's pot the same way.
    env.spend(rules, SOL).unwrap();
    assert_eq!(env.pot(), SOL);
}

#[test]
fn the_clock_follows_the_leash() {
    // The timer lives in the leash: ten minutes, which the agent may move between one
    // minute and one hour.
    let leash = LeashConfig { params: vec![(TIMER, 60, 3_600)], spend: 0 };
    let mut env = Env::launch(Config { timer_param: Some(0), lbw_timer: 0, leash: Some(leash), ..Config::game() });
    let (alice, bob, alice_key) = (env.alice.pubkey(), env.bob.pubkey(), env.alice.insecure_clone());
    assert_eq!((env.state().timer_param, env.state().cap_param), (0, NO_PARAM));

    env.buy(&alice, MIN_BUY).unwrap();
    assert_eq!(env.round(), (alice, T0 + TIMER));

    // The agent shortens the clock. The running round keeps its deadline until the next
    // buy, which gets the new length.
    env.set_param(0, 60).unwrap();
    assert_eq!(env.round(), (alice, T0 + TIMER));
    env.pass_time(100);
    env.buy(&bob, MIN_BUY).unwrap();
    assert_eq!(env.round(), (bob, T0 + 100 + 60));

    // It can't leave the leash's range, so neither can the clock.
    assert!(env.set_param(0, 59).is_err());
    assert!(env.set_param(0, 3_601).is_err());
    env.set_param(0, 3_600).unwrap();
    env.pass_time(59);
    env.buy(&alice, MIN_BUY).unwrap();
    assert_eq!(env.round(), (alice, T0 + 159 + 3_600));

    // Whatever a leash says, one buy never puts more than a week on the clock: a round has
    // to end for its pot to be paid. `init` refuses a leash that could ask for more, so
    // only a simulator can write this value.
    let leash = env.leash.unwrap();
    let mut account = env.svm.get_account(&leash).unwrap();
    account.data[240..248].copy_from_slice(&i64::MAX.to_le_bytes());
    env.svm.set_account(leash, account).unwrap();
    env.buy(&bob, MIN_BUY).unwrap();
    assert_eq!(env.round(), (bob, T0 + 159 + WEEK));

    // A transfer between wallets and a sell don't need the leash at all on this token:
    // they still go through when it can't be read.
    let leash = env.leash.unwrap();
    let mut account = env.svm.get_account(&leash).unwrap();
    account.owner = Keypair::new().pubkey();
    env.svm.set_account(leash, account).unwrap();
    assert_eq!(error(env.buy(&bob, MIN_BUY)), hook_error(HookError::WrongAccount));
    env.transfer(&alice_key, &bob, TOKEN).unwrap();
    env.sell(&alice_key, TOKEN).unwrap();
}

/* ---------------- a sell must always land ---------------- */

#[test]
fn a_sell_lands_in_every_state() {
    // Everything switched on at once: the cap and the clock in a leash, the block limit and
    // the game.
    let leash = LeashConfig { params: vec![(CAP as i64, MIN_BUY as i64, 5 * CAP as i64), (TIMER, 60, 3_600)], spend: SOL };
    let config = Config {
        cap_param: Some(0),
        timer_param: Some(1),
        block_limit: BLOCK_LIMIT,
        guard_slots: GUARD_SLOTS,
        lbw_timer: 0,
        leash: Some(leash),
        ..Config::game()
    };
    let mut env = Env::launch(config);
    let (alice, bob, alice_key) = (env.alice.pubkey(), env.bob.pubkey(), env.alice.insecure_clone());
    let leash = env.leash.unwrap();

    // Sells one token and checks it landed, was counted, and left the guard and the game alone.
    let sell = |env: &mut Env, state: &str| {
        let (before, held) = (env.state(), env.balance(&alice));
        env.sell(&alice_key, TOKEN).unwrap_or_else(|e| panic!("a sell failed when {state}: {e:?}"));
        assert_eq!(env.balance(&alice), held - TOKEN, "{state}");
        let expected = Rules { transfers: before.transfers.saturating_add(1), ..before };
        assert_eq!(env.state(), expected, "{state}");
    };

    env.buy(&alice, BLOCK_LIMIT).unwrap();
    assert_eq!(error(env.buy(&bob, 1)), hook_error(HookError::TooMuchInOneBlock));
    sell(&mut env, "the block is full");

    env.set_slot(LAUNCH_SLOT + GUARD_SLOTS);
    env.buy(&alice, MIN_BUY).unwrap();
    assert_eq!(env.round(), (alice, T0 + TIMER));
    sell(&mut env, "a round is running");

    env.set_param(0, MIN_BUY as i64).unwrap();
    assert_eq!(error(env.buy(&bob, MIN_BUY + 1)), hook_error(HookError::OverMaxPerWallet));
    assert_eq!(error(env.transfer(&alice_key, &bob, MIN_BUY + 1)), hook_error(HookError::OverMaxPerWallet));
    sell(&mut env, "the agent has cut the cap as far as its leash lets it");

    env.pass_time(10 * TIMER);
    sell(&mut env, "the round is over and nobody has settled it");

    let real_leash = env.svm.get_account(&leash).unwrap();
    env.svm.set_account(leash, Account { owner: Keypair::new().pubkey(), ..real_leash.clone() }).unwrap();
    assert_eq!(error(env.buy(&bob, 1)), hook_error(HookError::WrongAccount));
    sell(&mut env, "the leash is owned by another program");
    let gone = Account { lamports: 0, data: vec![], owner: SYSTEM_PROGRAM, executable: false, rent_epoch: 0 };
    env.svm.set_account(leash, gone).unwrap();
    assert_eq!(error(env.buy(&bob, 1)), hook_error(HookError::WrongAccount));
    sell(&mut env, "the leash is gone");
    env.svm.set_account(leash, real_leash).unwrap();

    // Numbers no amount of trading would reach, to show a sell has no sum that can overflow.
    for (clock, slot) in [(i64::MAX, u64::MAX), (i64::MIN, 0)] {
        env.rewrite_rules(|rules| {
            rules.transfers = u64::MAX;
            (rules.launch_slot, rules.block_slot, rules.block_bought) = (slot, LAUNCH_SLOT + 1, u64::MAX);
            (rules.lbw_deadline, rules.lbw_round, rules.lbw_total_paid, rules.lbw_last_prize) = (clock, u64::MAX, u64::MAX, u64::MAX);
        });
        sell(&mut env, "every counter is at its limit");
    }
    assert_eq!(env.state().transfers, u64::MAX);
}

/* ---------------- cost ---------------- */

#[test]
fn stays_cheap_to_run() {
    // The lightest token: one fixed cap.
    let mut env = Env::launch(Config::capped(CAP));
    let (alice, alice_key) = (env.alice.pubkey(), env.alice.insecure_clone());
    let cap_only = hook_units(&env.buy(&alice, MIN_BUY).unwrap());
    let cap_only_sell = hook_units(&env.sell(&alice_key, TOKEN).unwrap());

    // The heaviest: cap and clock read from a leash, the block limit and the game.
    let leash = LeashConfig { params: vec![(CAP as i64, MIN_BUY as i64, 5 * CAP as i64), (TIMER, 60, 3_600)], spend: 0 };
    let config = Config {
        cap_param: Some(0),
        timer_param: Some(1),
        block_limit: BLOCK_LIMIT,
        guard_slots: GUARD_SLOTS,
        lbw_timer: 0,
        leash: Some(leash.clone()),
        ..Config::game()
    };
    let mut env = Env::launch(config.clone());
    let (alice, bob, rules, alice_key) = (env.alice.pubkey(), env.bob.pubkey(), env.rules, env.alice.insecure_clone());
    env.fund(&rules, SOL);

    // `init` for one more token with the same rules, on its own in a transaction. Finding
    // the two addresses costs 1,500 units for each bump tried, so this one varies by mint.
    let init = {
        let (payer, mint, own_leash) = (env.payer.pubkey(), Keypair::new(), env.leash);
        env.leash = Some(env.create_leash(&mint.pubkey(), &leash));
        let ix = init_ix(&payer, &mint.pubkey(), &env.init_of(&config));
        env.leash = own_leash;
        env.send(vec![ix], &[&mint]).unwrap().compute_units_consumed
    };

    // A buy is counted against the block while the guard is up, and plays the game after.
    let guarded_buy = hook_units(&env.buy(&alice, MIN_BUY).unwrap());
    env.set_slot(LAUNCH_SLOT + GUARD_SLOTS);
    let buy = hook_units(&env.buy(&alice, MIN_BUY).unwrap());
    let transfer = hook_units(&env.transfer(&alice_key, &bob, TOKEN).unwrap());
    let sell = hook_units(&env.sell(&alice_key, TOKEN).unwrap());
    env.pass_time(TIMER);
    let settle = env.settle(&alice).unwrap().compute_units_consumed;
    let rollover = {
        env.buy(&CLOCK_SYSVAR, MIN_BUY).unwrap();
        env.pass_time(TIMER);
        env.settle(&CLOCK_SYSVAR).unwrap().compute_units_consumed
    };

    // A token still in the first hook's layout, with its fixed cap.
    let mut old = Env::launch(Config::capped(CAP));
    store_layout_one(&mut old, CAP, None);
    let (alice, alice_key) = (old.alice.pubkey(), old.alice.insecure_clone());
    let old_buy = hook_units(&old.buy(&alice, MIN_BUY).unwrap());
    let old_sell = hook_units(&old.sell(&alice_key, TOKEN).unwrap());

    println!(
        "compute units: execute {cap_only} for a buy and {cap_only_sell} for a sell with only a fixed cap \
         ({old_buy} and {old_sell} on a token in the first layout); \
         with every rule on and a leash, buy {guarded_buy} under the guard and {buy} after it, transfer {transfer}, sell {sell}; \
         settle {settle}, or {rollover} when the pot rolls over; init {init}"
    );
    let execute = [("a buy under the guard", guarded_buy), ("a buy", buy), ("a transfer", transfer), ("a sell", sell)];
    let old = [("a buy in the first layout", old_buy), ("a sell in the first layout", old_sell)];
    for (name, units) in execute.into_iter().chain(old).chain([("settle", settle), ("a rollover", rollover)]) {
        assert!(units < 5_000, "{name} used {units} compute units");
    }
    assert!(sell <= cap_only_sell + 50 && sell < buy && sell < guarded_buy, "a sell does the least work of all");
}
