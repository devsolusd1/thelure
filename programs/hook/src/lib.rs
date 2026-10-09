//! Lure hook: the rules Solana checks on every transfer of a Lure token.
//!
//! Token-2022 calls this program in the middle of each transfer, with the balances already
//! moved. If the hook returns an error, the whole transaction fails and nothing moves.
//!
//! The token trades on a bonding curve, and the hook tells buys from sells by who owns the
//! curve's vault. It carries three rules, each one optional:
//!
//! - a cap on what a wallet can hold;
//! - a limit on how many tokens can be bought from the curve in one block, against bundles,
//!   for a number of slots counted from the first buy;
//! - Last Buyer Wins: once that guard is down, every buy restarts a clock, and whoever
//!   bought last when it runs out is paid the pot of SOL held in the token's rules account.
//!
//! The cap and the clock are either fixed at launch or read from the token's leash, which
//! lets the token's agent tune them inside the range the leash allows.
//!
//! No rule ever refuses a sell: a transfer into the curve's vault is only counted. That
//! holds as long as the rules name the real owner of that vault, which `init` is told and
//! cannot check.

#![cfg_attr(target_os = "solana", no_std)]

/// The leash account layout, compiled in from the leash program's own source. Sharing the
/// file keeps one definition without linking a second program (and its entrypoint) in here.
#[allow(dead_code)]
#[path = "../../leash/src/state.rs"]
pub mod leash;
pub mod processor;
pub mod state;

#[cfg(target_os = "solana")]
mod entrypoint {
    pinocchio::program_entrypoint!(crate::processor::process_instruction);
    pinocchio::no_allocator!();
    pinocchio::nostd_panic_handler!();
}
