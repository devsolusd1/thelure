//! Lure leash: an on-chain limit on what a token's agent can do.
//!
//! A creator gives a token a leash at launch. It names one agent key and fixes, for good,
//! what that key may do: how much SOL it can send to which accounts, how much it can hand
//! out as rewards, and how far it can turn each rule parameter. The agent itself runs
//! wherever its owner likes; a stolen or fooled agent can still only do what is written here.
//!
//! The SOL sitting in the leash account is the agent's budget. Anyone can add to it with a
//! plain transfer, and it only ever leaves through `spend`, `reward` or `sweep`.

#![cfg_attr(target_os = "solana", no_std)]

pub mod processor;
pub mod state;

#[cfg(target_os = "solana")]
mod entrypoint {
    pinocchio::program_entrypoint!(crate::processor::process_instruction);
    pinocchio::no_allocator!();
    pinocchio::nostd_panic_handler!();
}
