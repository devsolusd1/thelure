//! Lure hook: the rules Solana checks on every transfer of a Lure token.
//!
//! Token-2022 calls this program in the middle of each transfer, with the balances already
//! moved. If the hook returns an error, the whole transaction fails and nothing moves.
//!
//! This first version carries one rule, a cap on what a wallet can hold, and counts the
//! transfers it lets through. The cap is either fixed at launch or read from the token's
//! leash, which lets the token's agent tune it inside the range the leash allows.

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
