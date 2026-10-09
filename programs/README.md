# Lure programs

On-chain programs for Lure: the leash, which limits a token's AI agent, and the hook, which checks every transfer of a token.

**Status: on devnet only, not audited.** Do not put real money behind them.

| | Leash | Hook |
|---|---|---|
| Devnet address | [`GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p`](https://explorer.solana.com/address/GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p?cluster=devnet) | [`4akkPWLw1imyEhcqAJaHgPPrbDZr6VPaHPifVUV7K5tS`](https://explorer.solana.com/address/4akkPWLw1imyEhcqAJaHgPPrbDZr6VPaHPifVUV7K5tS?cluster=devnet) |
| Upgrade authority | `7f2MiAuyJ1Aaiheo9ctLgJmzGDWoDceyHEEuVB2mhPAA` (still upgradeable) | same |
| Mainnet | not deployed | not deployed |

## Hook

A Token-2022 transfer hook. Token-2022 calls it in the middle of every transfer of a Lure token, with the balances already moved; if the hook returns an error, the whole transaction fails and nothing moves.

This first version carries one rule, a cap on what a wallet can hold, and counts the transfers it lets through. The cap is either fixed at launch or read from the token's leash, so the token's agent can tune it inside the range the leash allows.

### Proven inside Meteora swaps

[examples/meteora-probe.mjs](examples/meteora-probe.mjs) launches a token on a Meteora bonding curve (DBC) with the hook installed and trades through the curve. Run on devnet on 2026-10-05:

- Meteora accepted the hook program as it is. Any executable program can be a hook; there is no allowlist.
- A buy under the cap landed, a buy that would pass 1% of supply was refused by the hook itself, and a sell landed.
- The hook is handed six accounts: source, mint, destination, the source's owner, its account list and its rules. The balances it reads are the ones after the transfer.
- It can write to its own account inside the swap: the counter moved.
- It used about 660 compute units; the whole swap about 85,000.

Two things that shape every later rule:

- Meteora's SDK works out the hook's accounts with placeholder keys for the trader. A rule can only use accounts that follow from the mint alone, unless the trade is built by our own code.
- Meteora removes the hook when a curve graduates. Rules run only while the token is on its curve.

### How it is tested

`hook-tests` runs the compiled hook inside LiteSVM behind the real Token-2022 program: every transfer in those tests goes through Token-2022, which is what calls the hook. `bash test.sh` runs everything.

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
- Parameters are numbers until a hook reads them. The hook's wallet cap is the first rule that does.
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
