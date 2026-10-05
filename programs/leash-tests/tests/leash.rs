//! The compiled program, run inside LiteSVM: real accounts, signatures and lamports.
//!
//! Build the program first (`cargo build-sbf` in `../leash`) and point `LEASH_SO` at the
//! `.so` if it isn't in the default target directory.

use {
    litesvm::{types::TransactionResult, LiteSVM},
    lure_leash::{
        processor::{tag, SEED},
        state::{Leash, LeashError, Param, FLAG_AGENT_LOCKED, LEASH_LEN, NO_KEY, VERSION},
    },
    solana_account::Account,
    solana_address::Address,
    solana_clock::Clock,
    solana_instruction::{account_meta::AccountMeta, Instruction},
    solana_instruction_error::InstructionError,
    solana_keypair::Keypair,
    solana_message::Message,
    solana_signer::Signer,
    solana_system_interface::instruction::transfer,
    solana_transaction::Transaction,
    solana_transaction_error::TransactionError,
};

const SOL: u64 = 1_000_000_000;
const T0: i64 = 1_800_000_000;
const HOUR: i64 = 3_600;
const DAY: i64 = 86_400;
const SYSTEM_PROGRAM: Address = Address::new_from_array([0; 32]);
const PROGRAM: Address = Address::new_from_array([0x4c; 32]);

/// What a creator passes to `init`.
#[derive(Clone)]
struct Config {
    flags: u8,
    agent: Address,
    dest: [Address; 2],
    max_per_spend: u64,
    max_per_day: u64,
    max_per_reward: u64,
    max_reward_per_day: u64,
    /// value, min, max, max step, cooldown
    params: Vec<(i64, i64, i64, u64, i64)>,
}

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    creator: Keypair,
    agent: Keypair,
    pot: Address,
    buyback: Address,
    mint: Address,
    leash: Address,
    bump: u8,
}

fn leash_address(mint: &Address, creator: &Address) -> (Address, u8) {
    Address::find_program_address(&[SEED, mint.as_ref(), creator.as_ref()], &PROGRAM)
}

impl Env {
    fn new() -> Self {
        let so = std::env::var("LEASH_SO")
            .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../leash/target/deploy/lure_leash.so").into());
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(PROGRAM, &so)
            .unwrap_or_else(|e| panic!("build the program first; could not load {so}: {e:?}"));
        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = T0;
        svm.set_sysvar(&clock);

        let (payer, creator, agent) = (Keypair::new(), Keypair::new(), Keypair::new());
        svm.airdrop(&payer.pubkey(), 1_000 * SOL).unwrap();
        svm.airdrop(&creator.pubkey(), 10 * SOL).unwrap();
        let mint = Keypair::new().pubkey();
        let (leash, bump) = leash_address(&mint, &creator.pubkey());
        Env {
            svm,
            payer,
            creator,
            agent,
            pot: Keypair::new().pubkey(),
            buyback: Keypair::new().pubkey(),
            mint,
            leash,
            bump,
        }
    }

    /// A Last Buyer Wins token: the agent may feed the pot and the buyback, hand out small
    /// rewards, and move the clock between 5 and 30 minutes, 5 minutes at a time, once an hour.
    fn config(&self) -> Config {
        Config {
            flags: 0,
            agent: self.agent.pubkey(),
            dest: [self.pot, self.buyback],
            max_per_spend: SOL,
            max_per_day: 3 * SOL,
            max_per_reward: SOL / 20,
            max_reward_per_day: SOL / 10,
            params: vec![(600, 300, 1800, 300, HOUR)],
        }
    }

    /// A leash with the default config and 10 SOL of budget.
    fn launched() -> Self {
        let mut env = Self::new();
        let config = env.config();
        env.init(&config).unwrap();
        env.fund(10 * SOL);
        env
    }

    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> TransactionResult {
        // Identical transactions would otherwise be rejected as duplicates.
        self.svm.expire_blockhash();
        let mut all = vec![&self.payer];
        all.extend(signers);
        let message = Message::new(&[ix], Some(&self.payer.pubkey()));
        self.svm.send_transaction(Transaction::new(&all, message, self.svm.latest_blockhash()))
    }

    fn init_ix(&self, config: &Config, bump: u8) -> Instruction {
        let mut data = vec![tag::INIT, bump, config.flags, config.params.len() as u8];
        for key in [&self.mint, &config.agent, &config.dest[0], &config.dest[1]] {
            data.extend_from_slice(key.as_ref());
        }
        for cap in [config.max_per_spend, config.max_per_day, config.max_per_reward, config.max_reward_per_day] {
            data.extend_from_slice(&cap.to_le_bytes());
        }
        for (value, min, max, max_step, cooldown) in &config.params {
            for field in [value, min, max] {
                data.extend_from_slice(&field.to_le_bytes());
            }
            data.extend_from_slice(&max_step.to_le_bytes());
            data.extend_from_slice(&cooldown.to_le_bytes());
        }
        Instruction {
            program_id: PROGRAM,
            accounts: vec![
                AccountMeta::new(self.creator.pubkey(), true),
                AccountMeta::new(self.leash, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            ],
            data,
        }
    }

    fn init(&mut self, config: &Config) -> TransactionResult {
        let ix = self.init_ix(config, self.bump);
        let creator = self.creator.insecure_clone();
        self.send(ix, &[&creator])
    }

    /// Anyone tops up the budget with a plain transfer.
    fn fund(&mut self, lamports: u64) {
        let ix = transfer(&self.payer.pubkey(), &self.leash, lamports);
        self.send(ix, &[]).unwrap();
    }

    fn spend_as(&mut self, signer: &Keypair, index: u8, to: Address, amount: u64) -> TransactionResult {
        let mut data = vec![tag::SPEND, index];
        data.extend_from_slice(&amount.to_le_bytes());
        let accounts = vec![
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(self.leash, false),
            AccountMeta::new(to, false),
        ];
        self.send(Instruction { program_id: PROGRAM, accounts, data }, &[signer])
    }

    fn spend(&mut self, index: u8, to: Address, amount: u64) -> TransactionResult {
        let agent = self.agent.insecure_clone();
        self.spend_as(&agent, index, to, amount)
    }

    fn reward_as(&mut self, signer: &Keypair, to: Address, amount: u64) -> TransactionResult {
        let mut data = vec![tag::REWARD];
        data.extend_from_slice(&amount.to_le_bytes());
        let accounts = vec![
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(self.leash, false),
            AccountMeta::new(to, false),
        ];
        self.send(Instruction { program_id: PROGRAM, accounts, data }, &[signer])
    }

    fn reward(&mut self, to: Address, amount: u64) -> TransactionResult {
        let agent = self.agent.insecure_clone();
        self.reward_as(&agent, to, amount)
    }

    fn set_param_as(&mut self, signer: &Keypair, index: u8, value: i64) -> TransactionResult {
        let mut data = vec![tag::SET_PARAM, index];
        data.extend_from_slice(&value.to_le_bytes());
        let accounts = vec![AccountMeta::new_readonly(signer.pubkey(), true), AccountMeta::new(self.leash, false)];
        self.send(Instruction { program_id: PROGRAM, accounts, data }, &[signer])
    }

    fn set_param(&mut self, index: u8, value: i64) -> TransactionResult {
        let agent = self.agent.insecure_clone();
        self.set_param_as(&agent, index, value)
    }

    fn set_agent_as(&mut self, signer: &Keypair, new_agent: Address) -> TransactionResult {
        let mut data = vec![tag::SET_AGENT];
        data.extend_from_slice(new_agent.as_ref());
        let accounts = vec![AccountMeta::new_readonly(signer.pubkey(), true), AccountMeta::new(self.leash, false)];
        self.send(Instruction { program_id: PROGRAM, accounts, data }, &[signer])
    }

    fn set_agent(&mut self, new_agent: Address) -> TransactionResult {
        let creator = self.creator.insecure_clone();
        self.set_agent_as(&creator, new_agent)
    }

    fn sweep(&mut self, to: Address) -> TransactionResult {
        let accounts = vec![AccountMeta::new(self.leash, false), AccountMeta::new(to, false)];
        self.send(Instruction { program_id: PROGRAM, accounts, data: vec![tag::SWEEP] }, &[])
    }

    fn pass_time(&mut self, seconds: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp += seconds;
        self.svm.set_sysvar(&clock);
    }

    fn balance(&self, address: &Address) -> u64 {
        self.svm.get_balance(address).unwrap_or(0)
    }

    fn reserve(&self) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(LEASH_LEN)
    }

    /// SOL the agent could still move.
    fn budget(&self) -> u64 {
        self.balance(&self.leash) - self.reserve()
    }

    fn state(&self) -> Leash {
        let account = self.svm.get_account(&self.leash).expect("leash account");
        assert_eq!(account.data.len(), LEASH_LEN);
        unsafe { std::ptr::read_unaligned(account.data.as_ptr() as *const Leash) }
    }
}

/// The instruction error a failed transaction ended with.
fn error(result: TransactionResult) -> InstructionError {
    match result.expect_err("transaction should have failed").err {
        TransactionError::InstructionError(_, error) => error,
        other => panic!("failed outside the instruction: {other:?}"),
    }
}

fn leash_error(code: LeashError) -> InstructionError {
    InstructionError::Custom(code as u32)
}

#[test]
fn init_writes_the_leash() {
    let mut env = Env::new();
    let config = env.config();
    let before = env.balance(&env.creator.pubkey());
    env.init(&config).unwrap();

    let account = env.svm.get_account(&env.leash).unwrap();
    assert_eq!(account.owner, PROGRAM);
    assert_eq!(account.lamports, env.reserve(), "the creator pays exactly the rent reserve");
    assert_eq!(before - env.balance(&env.creator.pubkey()), env.reserve());
    assert_eq!(env.budget(), 0);

    let state = env.state();
    let off = Param { value: 0, min: 0, max: 0, max_step: 0, cooldown: 0, last_change: 0 };
    let expected = Leash {
        version: VERSION,
        bump: env.bump,
        flags: 0,
        param_count: 1,
        _pad: [0; 4],
        mint: env.mint.to_bytes(),
        creator: env.creator.pubkey().to_bytes(),
        agent: env.agent.pubkey().to_bytes(),
        dest: [env.pot.to_bytes(), env.buyback.to_bytes()],
        max_per_spend: SOL,
        max_per_day: 3 * SOL,
        max_per_reward: SOL / 20,
        max_reward_per_day: SOL / 10,
        day_start: T0,
        spent_today: 0,
        rewarded_today: 0,
        total_spent: 0,
        total_rewarded: 0,
        params: [Param { value: 600, min: 300, max: 1800, max_step: 300, cooldown: HOUR, last_change: T0 }, off, off, off],
    };
    assert_eq!(state, expected);

    // A second init can't overwrite it, even with other limits.
    let mut looser = config.clone();
    looser.max_per_day = 1_000 * SOL;
    looser.max_per_spend = 1_000 * SOL;
    assert_eq!(error(env.init(&looser)), InstructionError::AccountAlreadyInitialized);
    assert_eq!(env.state(), expected);
}

#[test]
fn init_copes_with_an_address_that_already_holds_sol() {
    // Anyone can send SOL to the leash address before it exists. That must not block the launch.
    for prefund in [890_880, SOL / 2] {
        let mut env = Env::new();
        env.fund(prefund);
        let config = env.config();
        env.init(&config).unwrap();

        let account = env.svm.get_account(&env.leash).unwrap();
        assert_eq!(account.owner, PROGRAM);
        assert_eq!(account.lamports, prefund.max(env.reserve()), "topped up only as far as the reserve");
        assert_eq!(env.state().agent, env.agent.pubkey().to_bytes());
    }
}

#[test]
fn init_rejects_bad_input() {
    let mut env = Env::new();
    let config = env.config();
    let creator = env.creator.insecure_clone();

    // A bump that doesn't derive this address can't sign for it.
    let wrong_bump = env.init_ix(&config, env.bump.wrapping_sub(1));
    assert!(env.send(wrong_bump, &[&creator]).is_err());

    // Nobody can claim the leash address of another creator.
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let mut stolen = env.init_ix(&config, env.bump);
    stolen.accounts[0] = AccountMeta::new(stranger.pubkey(), true);
    assert!(env.send(stolen, &[&stranger]).is_err());

    // The creator has to sign.
    let mut unsigned = env.init_ix(&config, env.bump);
    unsigned.accounts[0] = AccountMeta::new(creator.pubkey(), false);
    assert_eq!(error(env.send(unsigned, &[])), InstructionError::MissingRequiredSignature);

    let bad = |edit: fn(&mut Config, &Env)| {
        let mut env = Env::new();
        let mut config = env.config();
        edit(&mut config, &env);
        error(env.init(&config))
    };
    let bad_config = leash_error(LeashError::BadConfig);
    assert_eq!(bad(|c, _| c.max_per_spend = c.max_per_day + 1), bad_config);
    assert_eq!(bad(|c, _| c.max_per_reward = c.max_reward_per_day + 1), bad_config);
    assert_eq!(bad(|c, _| c.agent = Address::new_from_array(NO_KEY)), bad_config);
    assert_eq!(bad(|c, _| c.dest[0] = Address::new_from_array(NO_KEY)), bad_config);
    assert_eq!(bad(|c, env| c.dest[1] = env.leash), bad_config, "a leash can't pay itself");
    assert_eq!(bad(|c, _| c.flags = 0x80), bad_config);
    assert_eq!(bad(|c, _| c.params[0] = (100, 300, 1800, 0, 0)), bad_config, "value under its own minimum");
    assert_eq!(bad(|c, _| c.params[0].4 = -1), bad_config);

    // Malformed data: a missing byte, an extra one, a param count that doesn't match.
    for edit in [|d: &mut Vec<u8>| { d.pop(); }, |d: &mut Vec<u8>| d.push(0), |d: &mut Vec<u8>| d[3] = 2, |d: &mut Vec<u8>| d[3] = 5] {
        let mut ix = env.init_ix(&config, env.bump);
        edit(&mut ix.data);
        assert_eq!(error(env.send(ix, &[&creator])), InstructionError::InvalidInstructionData);
    }
    assert!(env.svm.get_account(&env.leash).is_none(), "nothing was created along the way");
}

#[test]
fn agent_spends_only_to_its_destinations_and_within_caps() {
    let mut env = Env::launched();
    let (pot, buyback) = (env.pot, env.buyback);
    assert_eq!(env.budget(), 10 * SOL);

    env.spend(0, pot, SOL).unwrap();
    env.spend(1, buyback, SOL / 2).unwrap();
    assert_eq!((env.balance(&pot), env.balance(&buyback)), (SOL, SOL / 2));
    assert_eq!(env.budget(), 10 * SOL - SOL - SOL / 2);

    // Somewhere else, or the right account under the wrong index.
    let elsewhere = env.agent.pubkey();
    assert_eq!(error(env.spend(0, elsewhere, SOL / 10)), leash_error(LeashError::BadDestination));
    assert_eq!(error(env.spend(1, pot, SOL / 10)), leash_error(LeashError::BadDestination));
    assert_eq!(error(env.spend(2, pot, SOL / 10)), leash_error(LeashError::BadDestination));

    // Too much at once, then too much in a day.
    assert_eq!(error(env.spend(0, pot, SOL + 1)), leash_error(LeashError::OverActionCap));
    assert_eq!(error(env.spend(0, pot, 0)), leash_error(LeashError::ZeroAmount));
    env.spend(0, pot, SOL).unwrap();
    env.spend(0, pot, SOL / 2).unwrap();
    assert_eq!(error(env.spend(0, pot, 1)), leash_error(LeashError::OverDailyCap));
    assert_eq!(env.state().spent_today, 3 * SOL);

    // The window reopens a day after it started, not before.
    env.pass_time(DAY - 1);
    assert_eq!(error(env.spend(0, pot, 1)), leash_error(LeashError::OverDailyCap));
    env.pass_time(1);
    env.spend(0, pot, SOL).unwrap();
    let state = env.state();
    assert_eq!((state.day_start, state.spent_today, state.total_spent), (T0 + DAY, SOL, 4 * SOL));
    assert_eq!(env.balance(&pot) + env.balance(&buyback), 4 * SOL);
    assert_eq!(env.budget(), 6 * SOL);
}

#[test]
fn only_the_agent_can_act() {
    let mut env = Env::launched();
    let pot = env.pot;
    let (creator, stranger) = (env.creator.insecure_clone(), Keypair::new());

    for signer in [&creator, &stranger] {
        assert_eq!(error(env.spend_as(signer, 0, pot, SOL)), leash_error(LeashError::NotAgent));
        assert_eq!(error(env.reward_as(signer, signer.pubkey(), SOL / 100)), leash_error(LeashError::NotAgent));
        assert_eq!(error(env.set_param_as(signer, 0, 900)), leash_error(LeashError::NotAgent));
    }

    // Naming the agent without its signature isn't enough.
    let mut data = vec![tag::SPEND, 0];
    data.extend_from_slice(&SOL.to_le_bytes());
    let accounts = vec![
        AccountMeta::new_readonly(env.agent.pubkey(), false),
        AccountMeta::new(env.leash, false),
        AccountMeta::new(pot, false),
    ];
    let unsigned = Instruction { program_id: PROGRAM, accounts, data };
    assert_eq!(error(env.send(unsigned, &[])), InstructionError::MissingRequiredSignature);

    assert_eq!(env.budget(), 10 * SOL);
    assert_eq!(env.balance(&pot), 0);
}

#[test]
fn the_rent_reserve_is_never_spent() {
    let mut env = Env::new();
    let mut config = env.config();
    config.max_per_spend = 100 * SOL;
    config.max_per_day = 100 * SOL;
    env.init(&config).unwrap();
    env.fund(SOL / 4);
    let pot = env.pot;

    assert_eq!(error(env.spend(0, pot, SOL / 4 + 1)), leash_error(LeashError::OverBudget));
    env.spend(0, pot, SOL / 4).unwrap();
    assert_eq!(env.balance(&env.leash), env.reserve());
    assert_eq!(error(env.spend(0, pot, 1)), leash_error(LeashError::OverBudget));

    // Still alive and still readable, and a top-up puts it back to work.
    assert_eq!(env.state().total_spent, SOL / 4);
    env.fund(SOL);
    env.spend(0, pot, SOL).unwrap();
}

#[test]
fn rewards_have_their_own_smaller_caps() {
    let mut env = Env::launched();
    let holder = Keypair::new().pubkey();
    env.svm.airdrop(&holder, SOL).unwrap();

    env.reward(holder, SOL / 20).unwrap();
    assert_eq!(env.balance(&holder), SOL + SOL / 20);
    assert_eq!(error(env.reward(holder, SOL / 20 + 1)), leash_error(LeashError::OverActionCap));
    env.reward(holder, SOL / 20).unwrap();
    assert_eq!(error(env.reward(holder, 1)), leash_error(LeashError::OverDailyCap));

    // Rewards and spending are counted apart.
    let pot = env.pot;
    env.spend(0, pot, SOL).unwrap();
    let state = env.state();
    assert_eq!((state.rewarded_today, state.total_rewarded, state.spent_today), (SOL / 10, SOL / 10, SOL));

    // The leash can't be its own recipient.
    env.pass_time(DAY);
    let leash = env.leash;
    assert_eq!(error(env.reward(leash, SOL / 20)), leash_error(LeashError::BadDestination));
    env.reward(holder, SOL / 20).unwrap();
}

#[test]
fn rewards_can_be_switched_off() {
    let mut env = Env::new();
    let mut config = env.config();
    config.max_per_reward = 0;
    config.max_reward_per_day = 0;
    env.init(&config).unwrap();
    env.fund(10 * SOL);

    let agent = env.agent.pubkey();
    assert_eq!(error(env.reward(agent, 1)), leash_error(LeashError::OverActionCap));
    let pot = env.pot;
    env.spend(0, pot, SOL).unwrap();
}

#[test]
fn agent_tunes_params_inside_their_limits() {
    let mut env = Env::launched();

    // The launch value holds for one cooldown.
    assert_eq!(error(env.set_param(0, 900)), leash_error(LeashError::ParamCooldown));
    env.pass_time(HOUR);

    assert_eq!(error(env.set_param(0, 299)), leash_error(LeashError::ParamOutOfBounds));
    assert_eq!(error(env.set_param(0, 1801)), leash_error(LeashError::ParamOutOfBounds));
    assert_eq!(error(env.set_param(0, 1200)), leash_error(LeashError::ParamStepTooBig));
    assert_eq!(error(env.set_param(1, 0)), leash_error(LeashError::BadParam));

    env.set_param(0, 900).unwrap();
    let param = env.state().params[0];
    assert_eq!((param.value, param.last_change), (900, T0 + HOUR));

    assert_eq!(error(env.set_param(0, 1200)), leash_error(LeashError::ParamCooldown));
    env.pass_time(HOUR);
    env.set_param(0, 1200).unwrap();
    env.pass_time(HOUR);
    env.set_param(0, 1500).unwrap();
    env.pass_time(HOUR);
    env.set_param(0, 1800).unwrap();
    env.pass_time(HOUR);
    assert_eq!(error(env.set_param(0, 2100)), leash_error(LeashError::ParamOutOfBounds));
    assert_eq!(env.state().params[0].value, 1800);
}

#[test]
fn creator_replaces_and_revokes_the_agent() {
    let mut env = Env::launched();
    let pot = env.pot;
    let (old_agent, new_agent, stranger) = (env.agent.insecure_clone(), Keypair::new(), Keypair::new());

    // Not the agent's call, and not a stranger's.
    assert_eq!(error(env.set_agent_as(&old_agent, old_agent.pubkey())), leash_error(LeashError::NotCreator));
    assert_eq!(error(env.set_agent_as(&stranger, stranger.pubkey())), leash_error(LeashError::NotCreator));

    env.set_agent(new_agent.pubkey()).unwrap();
    assert_eq!(error(env.spend_as(&old_agent, 0, pot, SOL)), leash_error(LeashError::NotAgent));
    env.spend_as(&new_agent, 0, pot, SOL).unwrap();

    // Nothing can be swept while an agent is in place.
    assert_eq!(error(env.sweep(pot)), leash_error(LeashError::NotRevoked));

    env.set_agent(Address::new_from_array(NO_KEY)).unwrap();
    assert_eq!(error(env.spend_as(&new_agent, 0, pot, SOL)), leash_error(LeashError::NotAgent));
    assert_eq!(error(env.set_param_as(&new_agent, 0, 900)), leash_error(LeashError::NotAgent));

    // What's left can only go to the first destination, whoever asks.
    let (buyback, creator) = (env.buyback, env.creator.pubkey());
    assert_eq!(error(env.sweep(buyback)), leash_error(LeashError::BadDestination));
    assert_eq!(error(env.sweep(creator)), leash_error(LeashError::BadDestination));
    env.sweep(pot).unwrap();
    assert_eq!(env.balance(&pot), 10 * SOL);
    assert_eq!(env.balance(&env.leash), env.reserve());
    assert_eq!(env.state().params[0].value, 600, "the leash stays readable after the sweep");

    // An unlocked leash can be armed again.
    env.set_agent(old_agent.pubkey()).unwrap();
    env.fund(SOL);
    env.pass_time(DAY);
    env.spend_as(&old_agent, 0, pot, SOL).unwrap();
}

#[test]
fn a_locked_agent_can_only_be_revoked() {
    let mut env = Env::new();
    let mut config = env.config();
    config.flags = FLAG_AGENT_LOCKED;
    env.init(&config).unwrap();
    env.fund(5 * SOL);
    let (pot, agent) = (env.pot, env.agent.pubkey());

    let replacement = Keypair::new().pubkey();
    assert_eq!(error(env.set_agent(replacement)), leash_error(LeashError::AgentLocked));
    env.spend(0, pot, SOL).unwrap();

    env.set_agent(Address::new_from_array(NO_KEY)).unwrap();
    assert_eq!(error(env.spend(0, pot, SOL)), leash_error(LeashError::NotAgent));
    assert_eq!(error(env.set_agent(agent)), leash_error(LeashError::AgentLocked), "revoking is final");
    env.sweep(pot).unwrap();
    assert_eq!(env.balance(&pot), 5 * SOL);
}

#[test]
fn rejects_a_forged_leash() {
    let mut env = Env::launched();
    let thief = Keypair::new();

    // Same bytes as a leash, naming the thief as agent and destination, but owned by
    // another program: the kind of account anyone can make.
    let mut forged_state = env.state();
    forged_state.agent = thief.pubkey().to_bytes();
    forged_state.creator = thief.pubkey().to_bytes();
    forged_state.dest[0] = thief.pubkey().to_bytes();
    let data = unsafe { std::slice::from_raw_parts(&forged_state as *const Leash as *const u8, LEASH_LEN) }.to_vec();
    let forged = Keypair::new().pubkey();
    let other_program = Address::new_from_array([0x77; 32]);
    env.svm
        .set_account(forged, Account { lamports: 50 * SOL, data, owner: other_program, executable: false, rent_epoch: 0 })
        .unwrap();

    let real = env.leash;
    env.leash = forged;
    let target = thief.pubkey();
    assert_eq!(error(env.spend_as(&thief, 0, target, SOL)), InstructionError::InvalidAccountOwner);
    assert_eq!(error(env.reward_as(&thief, target, 1)), InstructionError::InvalidAccountOwner);
    assert_eq!(error(env.set_param_as(&thief, 0, 900)), InstructionError::InvalidAccountOwner);
    assert_eq!(error(env.set_agent_as(&thief, target)), InstructionError::InvalidAccountOwner);
    assert_eq!(error(env.sweep(target)), InstructionError::InvalidAccountOwner);
    assert_eq!(env.balance(&forged), 50 * SOL);

    // And the thief gets nowhere against the real one.
    env.leash = real;
    assert_eq!(error(env.spend_as(&thief, 0, target, SOL)), leash_error(LeashError::NotAgent));
    assert_eq!(env.budget(), 10 * SOL);
}

#[test]
fn rejects_unknown_and_truncated_instructions() {
    let mut env = Env::launched();
    let agent = env.agent.insecure_clone();
    let accounts = vec![
        AccountMeta::new_readonly(agent.pubkey(), true),
        AccountMeta::new(env.leash, false),
        AccountMeta::new(env.pot, false),
    ];
    for data in [vec![], vec![6], vec![255], vec![tag::SPEND, 0, 1, 2, 3], vec![tag::REWARD], vec![tag::SET_PARAM, 0], vec![tag::SET_AGENT, 1]] {
        let ix = Instruction { program_id: PROGRAM, accounts: accounts.clone(), data };
        assert_eq!(error(env.send(ix, &[&agent])), InstructionError::InvalidInstructionData);
    }
    // Too few accounts.
    let mut data = vec![tag::SPEND, 0];
    data.extend_from_slice(&SOL.to_le_bytes());
    let ix = Instruction { program_id: PROGRAM, accounts: accounts[..2].to_vec(), data };
    // The runtime still reports the old name; `MissingAccount` is a different variant.
    #[allow(deprecated)]
    let too_few = InstructionError::NotEnoughAccountKeys;
    assert_eq!(error(env.send(ix, &[&agent])), too_few);
}

#[test]
fn stays_cheap_to_run() {
    let mut env = Env::new();
    let config = env.config();
    let init = env.init(&config).unwrap().compute_units_consumed;
    env.fund(10 * SOL);
    let (pot, holder) = (env.pot, Keypair::new().pubkey());
    env.svm.airdrop(&holder, SOL).unwrap();
    env.pass_time(HOUR);

    let spend = env.spend(0, pot, SOL).unwrap().compute_units_consumed;
    let reward = env.reward(holder, SOL / 20).unwrap().compute_units_consumed;
    let set_param = env.set_param(0, 900).unwrap().compute_units_consumed;
    let set_agent = env.set_agent(Address::new_from_array(NO_KEY)).unwrap().compute_units_consumed;
    let sweep = env.sweep(pot).unwrap().compute_units_consumed;
    println!("compute units: init {init}, spend {spend}, reward {reward}, set_param {set_param}, set_agent {set_agent}, sweep {sweep}");
    for (name, units) in [("spend", spend), ("reward", reward), ("set_param", set_param), ("set_agent", set_agent), ("sweep", sweep)] {
        assert!(units < 2_000, "{name} used {units} compute units");
    }
    assert!(init < 10_000, "init used {init} compute units");
}
