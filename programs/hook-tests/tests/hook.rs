//! The compiled hook, run inside LiteSVM behind the real Token-2022 program: every
//! transfer here goes through Token-2022, which is what calls the hook.
//!
//! Build both programs first (`cargo build-sbf` in `../hook` and `../leash`) and point
//! `HOOK_SO` / `LEASH_SO` at the `.so` files if they aren't in the default target directory.

use {
    litesvm::{types::TransactionResult, LiteSVM},
    lure_hook::{
        processor::{ACCOUNT_LIST_SEED, EXECUTE, INIT, LEASH_PROGRAM, RULES_SEED, TOKEN_2022},
        state::{HookError, Rules, RULES_LEN},
    },
    lure_leash::processor::{tag as leash_tag, SEED as LEASH_SEED},
    solana_account::Account,
    solana_address::Address,
    solana_instruction::{account_meta::AccountMeta, Instruction},
    solana_instruction_error::InstructionError,
    solana_keypair::Keypair,
    solana_message::Message,
    solana_signer::Signer,
    solana_system_interface::instruction::create_account,
    solana_transaction::Transaction,
    solana_transaction_error::TransactionError,
};

const SOL: u64 = 1_000_000_000;
const DECIMALS: u8 = 6;
const TOKEN: u64 = 1_000_000;
const SUPPLY: u64 = 1_000_000_000 * TOKEN;
/// One percent of supply.
const CAP: u64 = 10_000_000 * TOKEN;

const SYSTEM_PROGRAM: Address = Address::new_from_array([0; 32]);
const HOOK: Address = Address::new_from_array([0x48; 32]);
const ATA_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// A mint with only the transfer-hook extension: 165 padded base, the account type byte,
/// and one extension entry (4-byte header, authority, hook program).
const MINT_LEN: usize = 165 + 1 + 4 + 64;

fn so(var: &str, default: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| format!("{}/{default}", env!("CARGO_MANIFEST_DIR")))
}

fn ata(owner: &Address, mint: &Address) -> Address {
    Address::find_program_address(&[owner.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    mint: Keypair,
    /// Stands in for the bonding curve: holds the supply and is exempt from the cap.
    vault: Keypair,
    alice: Keypair,
    bob: Keypair,
    rules: Address,
    list: Address,
    /// Set when the cap comes from a leash.
    leash: Option<Address>,
    agent: Keypair,
}

impl Env {
    /// A token with the hook installed and the whole supply in the vault. With `leash_cap`,
    /// the cap is read from a leash whose agent may move it between 1 and 5 percent.
    fn new(cap: u64, leash_cap: Option<u64>) -> Self {
        let mut svm = LiteSVM::new();
        let hook_so = so("HOOK_SO", "../hook/target/deploy/lure_hook.so");
        svm.add_program_from_file(HOOK, &hook_so)
            .unwrap_or_else(|e| panic!("build the hook first; could not load {hook_so}: {e:?}"));
        let leash_so = so("LEASH_SO", "../leash/target/deploy/lure_leash.so");
        svm.add_program_from_file(LEASH_PROGRAM, &leash_so)
            .unwrap_or_else(|e| panic!("build the leash first; could not load {leash_so}: {e:?}"));

        let keys: [Keypair; 6] = std::array::from_fn(|_| Keypair::new());
        let [payer, mint, vault, alice, bob, agent] = keys;
        svm.airdrop(&payer.pubkey(), 1_000 * SOL).unwrap();
        let mint_key = mint.pubkey();
        let rules = Address::find_program_address(&[RULES_SEED, mint_key.as_ref()], &HOOK);
        let list = Address::find_program_address(&[ACCOUNT_LIST_SEED, mint_key.as_ref()], &HOOK);
        let leash = leash_cap.map(|_| Address::find_program_address(&[LEASH_SEED, mint_key.as_ref(), payer.pubkey().as_ref()], &LEASH_PROGRAM));

        let mut env = Env { svm, payer, mint, vault, alice, bob, rules: rules.0, list: list.0, leash: leash.map(|l| l.0), agent };

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
            env.init_ix(rules.1, list.1, cap, env.vault.pubkey(), env.leash),
        ];
        let mint = env.mint.insecure_clone();
        env.send(setup, &[&mint]).unwrap();

        if let (Some(value), Some((_, bump))) = (leash_cap, leash) {
            env.create_leash(bump, value);
        }

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

    fn init_ix(&self, rules_bump: u8, list_bump: u8, cap: u64, exempt: Address, leash: Option<Address>) -> Instruction {
        let mut data = vec![INIT, rules_bump, list_bump, 0];
        data.extend_from_slice(exempt.as_ref());
        data.extend_from_slice(leash.unwrap_or(SYSTEM_PROGRAM).as_ref());
        data.extend_from_slice(&cap.to_le_bytes());
        Instruction {
            program_id: HOOK,
            accounts: vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new_readonly(self.mint.pubkey(), true),
                AccountMeta::new(self.rules, false),
                AccountMeta::new(self.list, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            ],
            data,
        }
    }

    /// A leash whose first parameter is the cap: 1 to 5 percent of supply, no cooldown.
    fn create_leash(&mut self, bump: u8, value: u64) {
        let mut data = vec![leash_tag::INIT, bump, 0, 1];
        for key in [self.mint.pubkey(), self.agent.pubkey(), self.vault.pubkey(), SYSTEM_PROGRAM] {
            data.extend_from_slice(key.as_ref());
        }
        data.extend_from_slice(&[0; 32]); // the four spending caps: this leash moves no SOL
        for field in [value as i64, CAP as i64, 5 * CAP as i64] {
            data.extend_from_slice(&field.to_le_bytes());
        }
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&0i64.to_le_bytes());
        let accounts = vec![
            AccountMeta::new(self.payer.pubkey(), true),
            AccountMeta::new(self.leash.unwrap(), false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ];
        self.send(vec![Instruction { program_id: LEASH_PROGRAM, accounts, data }], &[]).unwrap();
    }

    fn set_cap_through_leash(&mut self, value: u64) -> TransactionResult {
        let mut data = vec![leash_tag::SET_PARAM, 0];
        data.extend_from_slice(&(value as i64).to_le_bytes());
        let accounts = vec![AccountMeta::new_readonly(self.agent.pubkey(), true), AccountMeta::new(self.leash.unwrap(), false)];
        let agent = self.agent.insecure_clone();
        self.send(vec![Instruction { program_id: LEASH_PROGRAM, accounts, data }], &[&agent])
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

    /// The accounts a client appends to a transfer so Token-2022 can call the hook.
    fn hook_accounts(&self) -> Vec<AccountMeta> {
        let mut metas = vec![AccountMeta::new(self.rules, false)];
        metas.extend(self.leash.map(|leash| AccountMeta::new_readonly(leash, false)));
        metas.push(AccountMeta::new_readonly(HOOK, false));
        metas.push(AccountMeta::new_readonly(self.list, false));
        metas
    }

    fn transfer(&mut self, from: &Keypair, to: &Address, amount: u64) -> TransactionResult {
        let destination = self.open_account(to);
        let mut data = vec![12];
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(DECIMALS);
        let mut accounts = vec![
            AccountMeta::new(ata(&from.pubkey(), &self.mint.pubkey()), false),
            AccountMeta::new_readonly(self.mint.pubkey(), false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(from.pubkey(), true),
        ];
        accounts.extend(self.hook_accounts());
        self.send(vec![Instruction { program_id: TOKEN_2022, accounts, data }], &[from])
    }

    fn buy(&mut self, to: &Address, amount: u64) -> TransactionResult {
        let vault = self.vault.insecure_clone();
        self.transfer(&vault, to, amount)
    }

    fn balance(&self, owner: &Address) -> u64 {
        match self.svm.get_account(&ata(owner, &self.mint.pubkey())) {
            Some(account) => u64::from_le_bytes(account.data[64..72].try_into().unwrap()),
            None => 0,
        }
    }

    fn state(&self) -> Rules {
        let account = self.svm.get_account(&self.rules).expect("rules account");
        assert_eq!((account.owner, account.data.len()), (HOOK, RULES_LEN));
        unsafe { std::ptr::read_unaligned(account.data.as_ptr() as *const Rules) }
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

#[test]
fn init_writes_the_rules_and_the_account_list() {
    let env = Env::new(CAP, None);
    let state = env.state();
    assert_eq!(state.mint, env.mint.pubkey().to_bytes());
    assert_eq!(state.exempt_owner, env.vault.pubkey().to_bytes());
    assert_eq!((state.max_per_wallet, state.transfers, state.leash), (CAP, 0, [0; 32]));

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
    let mut env = Env::new(CAP, None);
    let (rules_bump, list_bump) = (env.state().bump, 0);
    let stranger = Keypair::new().pubkey();

    // Already set: a second init can't loosen them.
    let again = env.init_ix(rules_bump, list_bump, 0, stranger, None);
    let mint = env.mint.insecure_clone();
    assert_eq!(error(env.send(vec![again], &[&mint])), InstructionError::AccountAlreadyInitialized);
    assert_eq!(env.state().max_per_wallet, CAP);

    // A token whose mint key didn't sign gets no rules from anyone else.
    let other_mint = Keypair::new().pubkey();
    let rules = Address::find_program_address(&[RULES_SEED, other_mint.as_ref()], &HOOK);
    let list = Address::find_program_address(&[ACCOUNT_LIST_SEED, other_mint.as_ref()], &HOOK);
    let mut ix = env.init_ix(rules.1, list.1, 0, stranger, None);
    ix.accounts[1] = AccountMeta::new_readonly(other_mint, false);
    ix.accounts[2] = AccountMeta::new(rules.0, false);
    ix.accounts[3] = AccountMeta::new(list.0, false);
    assert_eq!(error(env.send(vec![ix], &[])), InstructionError::MissingRequiredSignature);
    assert!(env.svm.get_account(&rules.0).is_none());
}

#[test]
fn hook_runs_inside_a_token_2022_transfer() {
    let mut env = Env::new(CAP, None);
    let alice = env.alice.pubkey();

    let result = env.buy(&alice, 1_000 * TOKEN).unwrap();
    assert_eq!(env.balance(&alice), 1_000 * TOKEN);
    assert_eq!(env.state().transfers, 1);
    // The probe build logs: extra accounts, amount, receiver's balance after, cap, count.
    let line = format!("Program log: 0x0, {:#x}, {:#x}, {:#x}, 0x1", 1_000 * TOKEN, 1_000 * TOKEN, CAP);
    assert!(result.logs.contains(&line), "hook log missing:\n{}", result.pretty_logs());

    env.buy(&alice, 500 * TOKEN).unwrap();
    assert_eq!(env.state().transfers, 2);
    println!("transfer with hook: {} compute units", result.compute_units_consumed);
}

#[test]
fn refuses_a_transfer_that_breaks_the_cap() {
    let mut env = Env::new(CAP, None);
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
    let mut env = Env::new(CAP, None);
    let (alice, bob, vault) = (env.alice.pubkey(), env.bob.pubkey(), env.vault.pubkey());
    let (alice_key, bob_key) = (env.alice.insecure_clone(), env.bob.insecure_clone());
    env.buy(&alice, CAP).unwrap();
    env.buy(&bob, CAP / 2).unwrap();

    // Sending between wallets is a transfer like any other.
    assert_eq!(error(env.transfer(&alice_key, &bob, CAP / 2 + 1)), hook_error(HookError::OverMaxPerWallet));
    env.transfer(&alice_key, &bob, CAP / 2).unwrap();
    assert_eq!((env.balance(&alice), env.balance(&bob)), (CAP / 2, CAP));

    // Selling back to the vault is never blocked, however much it already holds.
    env.transfer(&bob_key, &vault, CAP).unwrap();
    env.transfer(&alice_key, &vault, CAP / 2).unwrap();
    assert_eq!(env.balance(&vault), SUPPLY);
    assert_eq!(env.state().transfers, 5);
}

#[test]
fn a_cap_of_zero_switches_the_rule_off() {
    let mut env = Env::new(0, None);
    let alice = env.alice.pubkey();
    env.buy(&alice, SUPPLY / 2).unwrap();
    assert_eq!(env.balance(&alice), SUPPLY / 2);
}

#[test]
fn cannot_be_called_outside_a_transfer() {
    let mut env = Env::new(CAP, None);
    let alice = env.alice.pubkey();
    env.buy(&alice, TOKEN).unwrap();

    // The same accounts a real transfer passes, called directly: the token accounts exist
    // and belong to this mint, but Token-2022 isn't in the middle of moving anything.
    let mut data = EXECUTE.to_vec();
    data.extend_from_slice(&TOKEN.to_le_bytes());
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
    assert_eq!(error(env.send(vec![real], &[])), hook_error(HookError::NotATransfer));

    // Accounts made up to look like token accounts in mid-transfer, owned by someone else.
    let fake = Keypair::new().pubkey();
    let mut bytes = vec![0u8; 165];
    bytes[..32].copy_from_slice(mint.as_ref());
    bytes.extend_from_slice(&[2, 15, 0, 1, 0, 1]);
    let account = Account { lamports: SOL, data: bytes, owner: Keypair::new().pubkey(), executable: false, rent_epoch: 0 };
    env.svm.set_account(fake, account).unwrap();
    let forged = direct(fake, fake);
    assert_eq!(error(env.send(vec![forged], &[])), hook_error(HookError::NotATransfer));

    assert_eq!(env.state().transfers, 1, "the counter only moves with real transfers");
}

#[test]
fn rejects_rules_that_belong_to_another_token() {
    let mut a = Env::new(CAP, None);
    let alice = a.alice.pubkey();
    // A second token in the same world, with no cap at all.
    let other = Keypair::new();
    let other_key = other.pubkey();
    let rules = Address::find_program_address(&[RULES_SEED, other_key.as_ref()], &HOOK);
    let list = Address::find_program_address(&[ACCOUNT_LIST_SEED, other_key.as_ref()], &HOOK);
    let mut ix = a.init_ix(rules.1, list.1, 0, alice, None);
    ix.accounts[1] = AccountMeta::new_readonly(other_key, true);
    ix.accounts[2] = AccountMeta::new(rules.0, false);
    ix.accounts[3] = AccountMeta::new(list.0, false);
    a.send(vec![ix], &[&other]).unwrap();

    // Token-2022 only passes what the token's own list names, so the swapped rules never
    // reach the hook: the transfer fails before any token moves.
    let loose_rules = rules.0;
    a.rules = loose_rules;
    assert!(a.buy(&alice, 2 * CAP).is_err());
    assert_eq!(a.balance(&alice), 0);
}

#[test]
fn cap_follows_the_leash() {
    // The cap starts at 1 percent, in a leash that lets the agent move it up to 5 percent.
    let mut env = Env::new(0, Some(CAP));
    let alice = env.alice.pubkey();
    assert_eq!(env.state().leash, env.leash.unwrap().to_bytes());
    assert_eq!(env.svm.get_account(&env.list).unwrap().data.len(), 16 + 35 * 2, "rules and leash are both listed");

    env.buy(&alice, CAP).unwrap();
    assert_eq!(error(env.buy(&alice, TOKEN)), hook_error(HookError::OverMaxPerWallet));

    // The agent raises the cap; the very next transfer obeys the new value.
    env.set_cap_through_leash(3 * CAP).unwrap();
    env.buy(&alice, 2 * CAP).unwrap();
    assert_eq!(env.balance(&alice), 3 * CAP);
    assert_eq!(error(env.buy(&alice, TOKEN)), hook_error(HookError::OverMaxPerWallet));

    // And it can't go past what the leash allows, so neither can the cap.
    assert!(env.set_cap_through_leash(5 * CAP + 1).is_err());
    env.set_cap_through_leash(5 * CAP).unwrap();
    env.buy(&alice, 2 * CAP).unwrap();
    assert_eq!(error(env.buy(&alice, TOKEN)), hook_error(HookError::OverMaxPerWallet));

    // Lowering it never traps holders: alice is over the new cap and can still sell.
    env.set_cap_through_leash(CAP).unwrap();
    let (alice_key, vault) = (env.alice.insecure_clone(), env.vault.pubkey());
    env.transfer(&alice_key, &vault, 5 * CAP).unwrap();
    assert_eq!(env.balance(&alice), 0);
}

#[test]
fn a_leash_look_alike_is_not_a_leash() {
    let mut env = Env::new(0, Some(CAP));
    let alice = env.alice.pubkey();
    let leash = env.leash.unwrap();

    // Same address, same bytes, a huge cap, but no longer owned by the leash program.
    let mut account = env.svm.get_account(&leash).unwrap();
    account.data[240..248].copy_from_slice(&(SUPPLY as i64).to_le_bytes());
    account.owner = Keypair::new().pubkey();
    env.svm.set_account(leash, account).unwrap();

    assert_eq!(error(env.buy(&alice, 2 * CAP)), hook_error(HookError::WrongAccount));
    assert_eq!(env.balance(&alice), 0);
}
