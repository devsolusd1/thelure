# Lure programs

On-chain programs for Lure. So far there is one: the leash.

**Status: not audited, not deployed.** Everything here runs in tests only.

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
- Parameters are numbers until a hook reads them. That hook does not exist yet.
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

### Cost

Measured on 2026-10-05 with `solana rent`; devnet and mainnet give the same numbers.

| | |
|---|---|
| Binary | 18,352 bytes |
| Deploy (program data + program account) | 0.095 SOL |
| One leash, paid by the creator | 0.0028 SOL |
| Compute per call | `init` 1,925 · `spend` 662 · `reward` 622 · `set_param` 338 · `set_agent` 169 · `sweep` 340 units |

It is this small because it is written with [Pinocchio](https://github.com/anza-xyz/pinocchio) and no other dependency, has no allocator and logs nothing.
