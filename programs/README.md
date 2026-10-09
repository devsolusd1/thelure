# Lure programs

On-chain programs for Lure: the leash, which limits a token's AI agent, and the hook, which checks every transfer of a token.

**Status: on devnet only, not audited.** Do not put real money behind them.

| | Leash | Hook |
|---|---|---|
| Devnet address | [`GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p`](https://explorer.solana.com/address/GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p?cluster=devnet) | [`4akkPWLw1imyEhcqAJaHgPPrbDZr6VPaHPifVUV7K5tS`](https://explorer.solana.com/address/4akkPWLw1imyEhcqAJaHgPPrbDZr6VPaHPifVUV7K5tS?cluster=devnet) (first version) |
| Upgrade authority | `7f2MiAuyJ1Aaiheo9ctLgJmzGDWoDceyHEEuVB2mhPAA` (still upgradeable) | same |
| Mainnet | not deployed | not deployed |

## Hook

A Token-2022 transfer hook. Token-2022 calls it in the middle of every transfer of a Lure token, with the balances already moved; if the hook returns an error, the whole transaction fails and nothing moves.

The code in this folder is its second version. It carries three rules: a cap on what a wallet can hold, a limit on how much can be bought from the curve in one block, and a game, Last Buyer Wins. Each rule is optional, and all of them are fixed when the token is launched.

**Devnet runs this version** since 2026-10-09, upgraded in place at the same address. [examples/demo-token.mjs](examples/demo-token.mjs) launched a token with all three rules on a curve that never graduates and traded it through Meteora: the first buy was counted under the guard, the next one took the lead and started a clock read from the leash, and the hook used about 1,060 compute units in each swap. [examples/host-agent.mjs](examples/host-agent.mjs) is the reference agent that hosts the game; on that token it fed the pot with a real leash spend. Some paragraphs below still describe the state before this deploy.

### Buys, sells and transfers

A Lure token trades on a Meteora bonding curve (DBC). The curve keeps its tokens in a vault that belongs to Meteora's pool authority, and the token's rules name that owner (`exempt_owner`).

- Tokens leaving an account it owns are a **buy**.
- Tokens arriving at an account it owns are a **sell**.
- Anything else is a **transfer** between wallets.

Only Meteora's program can move tokens out of the vault, so nobody can fake a buy by sending tokens from one wallet to another.

### What it enforces

- **A sell always lands.** The hook checks that it is a real transfer of this token, counts it, and does nothing else. A sell never reads the cap, the leash, the clock or the state of the game.
- **Wallet cap.** After a buy or a transfer, the receiving wallet may hold at most the cap. The vault is never capped.
- **Block limit.** While the guard is up, at most `block_limit` tokens can be bought from the curve in one slot; the buy that would cross it fails. The guard lasts `guard_slots` slots counted from the first buy that lands, or for the life of the token if `guard_slots` is 0. It counts tokens, not trades, so a few dust buys cannot use a block up. Sells and transfers are not counted.
- **Last Buyer Wins.** Once the guard is down, a buy of at least `lbw_min_buy` tokens makes the owner of the receiving account the last buyer and sets the deadline to now plus the timer. When the deadline passes, the round is over: buys still land, but nothing in the game moves until someone calls `settle`. `settle` pays the pot to the last buyer, and the next buy that counts starts a new round.
- **The pot** is every lamport in the rules account above its rent. Anyone adds to it with a plain SOL transfer, and a leash can `spend` into it when the rules account is one of its destinations. `settle` pays only the recorded last buyer, once per round, and never takes the account below its rent.
- **A winner that cannot be paid does not stop the game.** If the winner is a program, the rules account itself, a sysvar or another address the runtime keeps read-only, or if the prize would leave it short of its own rent, the round closes with a prize of 0 and the pot stays for the next round.
- **Numbers the agent can tune.** The cap and the timer are each either fixed at launch or read from a parameter of the token's leash. A cap below zero reads as the tightest cap, never as no cap. A timer is held between one second and one week.
- **Only real transfers count.** `execute` refuses any call that is not Token-2022 in the middle of a transfer of this token: both token accounts must belong to Token-2022, be of this mint, and carry the flag Token-2022 raises while it calls the hook.
- **Rules are set once.** `init` needs the mint's own signature, so only whoever creates the token can set its rules, and there is no instruction to change them. The rules and the account list can only sit at the addresses every client derives.
- **Tokens from the first version keep trading.** Their 120-byte rules account is still read: the cap and the counter, as before.

`init` refuses, with `BadConfig`, rules that would be ignored or that no trade could satisfy:

- any rule at all without an `exempt_owner`. Without it a buy cannot be told from a transfer, and a cap would hold the vault too, which refuses every sell;
- a flag nobody defined, a leash parameter that is neither `0xFF` nor 0 to 3, a parameter without a leash, a leash that nothing reads, one parameter for both numbers, or one number given both ways;
- a guard length without a block limit, or game settings on a token that does not play;
- a game with no timer or a timer above one week, or whose smallest buy that counts is above a fixed cap;
- a game together with a block limit that never ends or lasts more than 216,000 slots (about a day). The game waits for the guard: while a block has limited room, whoever leads a round could fill it with buys too small to count and nobody could take the lead;
- a leash whose ranges let the agent break the game: on a token that plays, a cap that can go under `lbw_min_buy`, or a timer that can go over one week.

A leash named by the rules is read during `init`, so a token cannot be born with its buys frozen. It must be that very account, owned by the leash program, in the leash's current layout, made for this mint, and it must hold every parameter the rules use. Anything else is refused with `WrongAccount`, or `BadConfig` for a missing parameter.

### What it does not do

- It does not check that `exempt_owner` is Meteora's pool authority. Rules that name any other key treat every trade as a plain transfer: the cap then applies to the vault and sells are refused. Whoever lists a token as a Lure token must compare the two first.
- It cannot tell a fee claim from a buy. A curve that collects its trading fees in the token pays them out of the same vault, and such a claim would be capped, counted against the block, and could take a round's lead without buying. A Lure curve has to collect fees in SOL, as both example configs do.
- The block limit does not keep a block open for everyone. It stops one block from buying more than the limit, but someone who buys the limit and sells it straight back uses the block up for the price of the curve's fee both ways. Selling gives no room back.
- The game has no fixed end. A buy that counts always restarts the clock, so a round ends when buying stops.
- On a curve that graduates, Meteora removes the hook in the swap that fills the curve. Whoever leads then cannot be outbid and takes the pot. No round can start after that.
- SOL only leaves the rules account through `settle`. Sent to a token that does not play, to a token still in the first layout, or after a graduated curve's last round, it stays there for good.
- It does not judge the agent. Inside its leash's ranges an agent can still play against holders, for example by shortening the clock to its minimum just before it buys. The ranges are the creator's choice and are public.
- It does not protect a leash's budget. A leash pays into the pot but nothing comes back, and a revoked leash is swept to its first destination. Put a wallet first and the rules account second, or what is left after graduation is swept into an account nobody can empty.
- It pays whoever owns the token account that bought, whatever that address is. A prize sent to an address nobody holds a key for is lost. A winner with an empty wallet cannot be paid a pot smaller than the rent of an empty account (0.00065 SOL on devnet); that pot rolls over.
- The list of read-only addresses is a copy of the runtime's (31 of them). If the runtime reserves a new one that is neither a program nor a sysvar, a round won by it could not be settled until the hook is upgraded.
- It does not migrate. A token launched under the first version keeps the first version's rules.
- Every rule stops when the curve graduates, because the hook is removed. Rules for the life of a token need a curve that never graduates; see [examples/curve-check.mjs](examples/curve-check.mjs).
- It is only as fixed as the program. Until its upgrade authority is removed, whoever holds it can change every token's rules.

### Rules account

One per token, at the address derived from `["rules", mint]`. 272 bytes, little-endian, layout 2. The settings are written by `init` and never change; the counters and the game move.

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | `version` (2) |
| 1 | 1 | `bump` |
| 2 | 1 | `flags` (bit 0: Last Buyer Wins is on) |
| 3 | 1 | `cap_param`: leash parameter holding the wallet cap, `0xFF` to use `max_per_wallet` |
| 4 | 1 | `timer_param`: leash parameter holding the timer in seconds, `0xFF` to use `lbw_timer` |
| 8 | 32 | `mint` |
| 40 | 32 | `exempt_owner`: owner of the curve's vault |
| 72 | 32 | `leash` (all zeros if none) |
| 104 | 8 | `max_per_wallet` (0: no cap) |
| 112 | 8 | `transfers`: transfers let through so far |
| 120 | 8 | `launch_slot`: slot of `init`, then of the first buy from the curve |
| 128 | 8 | `guard_slots` (0: the block limit never ends) |
| 136 | 8 | `block_limit` (0: off) |
| 144 | 8 | `block_slot`: the slot being counted (0 until the first buy) |
| 152 | 8 | `block_bought`: bought from the curve in that slot |
| 160 | 8 | `lbw_timer`, in seconds |
| 168 | 8 | `lbw_min_buy`: a smaller buy never moves the game |
| 176 | 8 | `lbw_deadline`, unix time (0: waiting for a first buy) |
| 184 | 8 | `lbw_round`: rounds closed so far |
| 192 | 32 | `lbw_last_buyer` (all zeros between rounds) |
| 224 | 32 | `lbw_last_winner` |
| 256 | 8 | `lbw_last_prize`, in lamports |
| 264 | 8 | `lbw_total_paid`, in lamports |

The first version's account is 120 bytes with `version` 1: the same `mint`, `exempt_owner`, `leash`, `max_per_wallet` and `transfers` at the same offsets, and the cap's leash parameter in byte 2.

The hook's account list, which Token-2022 and every client read to know what to pass, sits at `["extra-account-metas", mint]`. It names the rules account, writable, then the leash, read-only, if there is one.

### Instructions

`init` and `settle` start with a one-byte tag. `execute` is the transfer-hook interface's call and starts with its eight bytes, `69 25 65 c5 4b fb 66 1a`.

| Tag | Name | Signer | Accounts | Data after the tag |
|---|---|---|---|---|
| 0 | `init` | payer, mint | payer (writable), mint, rules (writable), account list (writable), system program, then the leash if the rules name one | `rules_bump`, `list_bump`, `flags`, `cap_param`, `timer_param` (u8 each), `exempt_owner`, `leash` (32 each), `max_per_wallet`, `guard_slots`, `block_limit` (u64 each), `lbw_timer` (i64), `lbw_min_buy` (u64) |
| 1 | `settle` | nobody | rules (writable), winner (writable) | none |
| 8 bytes | `execute` | nobody: Token-2022 calls it | source, mint, destination, source's owner, account list, rules (writable), then the leash if the list names one | amount (u64) |

### Errors

Custom codes, as `HookError` in [hook/src/state.rs](hook/src/state.rs):

| Code | Name | Meaning |
|---|---|---|
| 6000 | `OverMaxPerWallet` | the transfer would leave the receiving wallet above the cap |
| 6001 | `NotATransfer` | not called by Token-2022 in the middle of a transfer of this token |
| 6002 | `WrongAccount` | the rules or leash account passed is not this token's, or is in a layout the hook does not know |
| 6003 | `BadConfig` | the values passed to `init` contradict each other |
| 6004 | `TooMuchInOneBlock` | the buy would take the slot above the block limit |
| 6005 | `NotWritable` | an account the instruction has to write to was passed read-only |
| 6006 | `RoundNotOver` | no round has started, or its clock is still running |
| 6007 | `NotTheWinner` | the account to pay is not the round's last buyer |
| 6008 | `GameOff` | the token does not play Last Buyer Wins |

`init` also answers `InvalidSeeds` when the rules or the list is not at the first address its seeds give.

### Proven inside Meteora swaps

This is the first version, the one on devnet. [examples/meteora-probe.mjs](examples/meteora-probe.mjs) launches a token on a Meteora bonding curve (DBC) with the hook installed and trades through the curve. Run on devnet on 2026-10-05:

- Meteora accepted the hook program as it is. Any executable program can be a hook; there is no allowlist.
- A buy under the cap landed, a buy that would pass 1% of supply was refused by the hook itself, and a sell landed.
- The hook is handed six accounts: source, mint, destination, the source's owner, its account list and its rules. The balances it reads are the ones after the transfer.
- It can write to its own account inside the swap: the counter moved.
- It used about 660 compute units; the whole swap about 85,000.

Two things that shape every later rule:

- Meteora's SDK works out the hook's accounts with placeholder keys for the trader. A rule can only use accounts that follow from the mint alone, unless the trade is built by our own code.
- Meteora removes the hook when a curve graduates. Rules run only while the token is on its curve.

Not proven yet for the second version: that it reads the clock and stays cheap inside a Meteora swap, and that its game and block limit behave there as they do in the simulator.

The two example scripts speak different versions until the next deploy. `meteora-probe.mjs` now sends the second version's `init`, which the devnet copy refuses: point it at a deployment of this code with `HOOK_PROGRAM`. [examples/curve-check.mjs](examples/curve-check.mjs) still sends the first version's `init` and runs against devnet as it is.

### How it is tested

The rules are plain functions, tested on the host: 27 tests. `hook-tests` then runs the compiled hook inside LiteSVM behind the real Token-2022 program and the real leash program, 40 tests. Trades there go through Token-2022, which is what calls the hook; a few tests also call the hook directly with forged accounts, to reach the checks Token-2022 never lets a transfer get to. They cover each rule, the refusals of `init` and `settle`, a sell landing in every state a token can be in, and a token still in the first layout.

`bash test.sh` runs everything. It builds the hook twice, with and without its probe (one log line per transfer, which the devnet scripts read), and runs the 40 tests against both, so the build meant for real money is the one tested.

### Cost

Measured in LiteSVM on the build without the probe (`cargo build-sbf --no-default-features`). Rent is what `solana rent` answered on devnet on 2026-10-09.

| | |
|---|---|
| Binary | 33,464 bytes (33,680 with the probe) |
| Deploy (program data + program account) | 0.172 SOL |
| One token, paid at `init` | 0.0029 SOL: 0.0020 for the rules and 0.0009 for the account list (0.0011 when it names a leash) |
| `execute`, wallet cap only | buy 655 · sell 594 units |
| `execute`, every rule on, cap and timer from a leash | buy 980 (960 under the guard) · transfer 778 · sell 609 units |
| `execute`, token in the first layout | buy 757 · sell 696 units |
| `settle` | 1,065 units, or 506 when the pot rolls over |
| `init` | from about 6,600 units. Finding the two addresses costs 1,500 for each bump tried, so some mints cost several thousand more (14,112 was the most seen) |

About half of what `settle` uses goes on comparing the winner with the 31 read-only addresses.

## Leash

A leash limits what a token's AI agent can do. The creator sets one up at launch: it names one agent key and fixes, for good, how much SOL that key can send to which accounts, how much it can hand out as rewards, and how far it can turn each rule parameter. The agent runs wherever its owner likes. A stolen or fooled agent can still only do what the leash allows.

The SOL in the leash account is the agent's budget. Anyone adds to it with a plain transfer; it only leaves through `spend`, `reward` or `sweep`.

### What it enforces

- Only the agent key can spend, reward or tune. Only the creator can replace or revoke the agent.
- `spend` pays one of two destinations chosen at launch, up to a cap per action and a cap per day.
- `reward` pays any account, under its own caps. Set them to 0 and rewards are off.
- `set_param` keeps each parameter inside its range, moves it at most one step per change, and waits out a cooldown between changes. The first cooldown counts from launch.
- No limit can be changed after `init`. There is no instruction for it.
- The creator can always revoke the agent. On a locked leash that is final; otherwise a new agent can be named.
- Once revoked, anyone can `sweep` what is left to the first destination. It has nowhere else to go.
- The account never drops below its rent reserve, so it stays readable.

### What it does not do

- It does not judge the agent. Inside the limits the agent can act badly, for example reward itself up to the reward caps.
- It does not pick honest destinations. The creator chooses them at launch and they are public on-chain.
- The daily caps use fixed windows. A window spent late and the next one spent early can land two days' worth close together.
- It does not swap or burn. A buyback is a `spend` to a buyback destination that does the swap.
- Parameters are numbers until a hook reads them. The hook's wallet cap and its game timer are the rules that do.
- It is only as fixed as the program. Until its upgrade authority is removed, whoever holds it can change every leash.

### Account

One per (token, creator), at the address derived from `["leash", mint, creator]`. 432 bytes, little-endian.

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | `version` (1) |
| 1 | 1 | `bump` |
| 2 | 1 | `flags` (bit 0: agent locked) |
| 3 | 1 | `param_count` (0 to 4) |
| 8 | 32 | `mint` |
| 40 | 32 | `creator` |
| 72 | 32 | `agent` (all zeros once revoked) |
| 104 | 32 | `dest[0]` |
| 136 | 32 | `dest[1]` (all zeros if unused) |
| 168 | 8 | `max_per_spend` |
| 176 | 8 | `max_per_day` |
| 184 | 8 | `max_per_reward` |
| 192 | 8 | `max_reward_per_day` |
| 200 | 8 | `day_start` |
| 208 | 8 | `spent_today` |
| 216 | 8 | `rewarded_today` |
| 224 | 8 | `total_spent` |
| 232 | 8 | `total_rewarded` |
| 240 + 48·i | 48 | `params[i]`: `value`, `min`, `max`, `max_step`, `cooldown`, `last_change` (8 bytes each) |

A hook that wants an agent-tunable rule reads `params[i].value`, after checking the account is owned by the leash program.

### Instructions

The first byte of the data is the tag.

| Tag | Name | Signer | Accounts | Data after the tag |
|---|---|---|---|---|
| 0 | `init` | creator | creator (writable), leash (writable), system program | `bump`, `flags`, `param_count` (u8 each), `mint`, `agent`, `dest[0]`, `dest[1]` (32 each), the four caps (u64 each), then per param `value`, `min`, `max` (i64), `max_step` (u64), `cooldown` (i64) |
| 1 | `spend` | agent | agent, leash (writable), destination (writable) | destination index (u8), amount (u64) |
| 2 | `reward` | agent | agent, leash (writable), recipient (writable) | amount (u64) |
| 3 | `set_param` | agent | agent, leash (writable) | param index (u8), value (i64) |
| 4 | `set_agent` | creator | creator, leash (writable) | new agent (32), or zeros to revoke |
| 5 | `sweep` | nobody | leash (writable), `dest[0]` (writable) | none |

Errors come back as custom codes; see `LeashError` in [leash/src/state.rs](leash/src/state.rs).

### Build and test

Use Linux or WSL with the Solana CLI and Rust installed:

```bash
bash test.sh
```

It runs the rule tests on the host, builds the on-chain binary, and runs that binary inside LiteSVM (`leash-tests`). The build also writes `lure_leash-keypair.json` next to the binary. That key decides the program's address: keep it, and keep it out of git.

`leash-tests` pins LiteSVM 0.16 because 0.17 needs Rust 1.97.

### Try it on devnet

[examples/devnet-smoke.mjs](examples/devnet-smoke.mjs) creates a leash on devnet and walks it through its whole life with real transactions: funding, spending, rewards, a parameter change, a revoke and a sweep, plus every refusal along the way. It is also the client example: each instruction is built there.

```bash
cd examples
npm install
KEYPAIR=~/.config/solana/id.json node devnet-smoke.mjs
```

The keypair acts as the creator and pays the fees, about 0.015 devnet SOL a run.

### Cost

Rent measured on 2026-10-05 with `solana rent`; devnet and mainnet give the same numbers. The devnet deploy cost exactly this.

| | |
|---|---|
| Binary | 18,352 bytes |
| Deploy (program data + program account) | 0.095 SOL |
| One leash, paid by the creator | 0.0028 SOL |
| Compute per call | `init` 1,925 · `spend` 662 · `reward` 622 · `set_param` 338 · `set_agent` 169 · `sweep` 340 units |

It is this small because it is written with [Pinocchio](https://github.com/anza-xyz/pinocchio) and no other dependency, has no allocator and logs nothing.
