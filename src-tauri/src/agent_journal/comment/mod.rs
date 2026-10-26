//! Comment threads (schema v5): records, the state machine, bounds and the
//! book the projection keeps of every retained thread.
//!
//! - `ids`, `records`, `replies`: the persisted and answered shapes.
//! - `rules`: who may do what from which state; `commentGen` exhaustion.
//! - `bounds`: the caps and the bytes each record is charged.
//! - `binding`: invariants of one record, checked on decode and append.
//! - `thread`: one thread's state and charges, and the checked step.
//! - `book`: per-thread state and usage, shared by the writer and replay.
//! - `wire`: the request bodies the handles decode.
//! - `create`, `ops`: creating, replying to and changing a thread under the
//!   writer lock; a create on unsaved text stages a schema-5 admission.
//! - `entry`: the user and agent handles on the controller. The handle a
//!   call arrives on is its caller; no request names one.
//!
//! @module agent_journal/comment

pub mod binding;
pub mod book;
pub mod bounds;
pub mod create;
pub mod entry;
pub mod ids;
pub mod ops;
pub mod records;
pub mod replies;
pub mod rules;
pub mod thread;
pub mod wire;

#[cfg(test)]
#[path = "../comment_support.test.rs"]
pub(crate) mod comment_support;

#[cfg(test)]
#[path = "../comment_bounds.test.rs"]
mod comment_bounds_tests;

#[cfg(test)]
#[path = "../comment_storage.test.rs"]
mod comment_storage_tests;

#[cfg(test)]
#[path = "../comment_admission.test.rs"]
mod comment_admission_tests;
#[cfg(test)]
#[path = "../comment_physical.test.rs"]
mod comment_physical_tests;
#[cfg(test)]
#[path = "../comment_receipts.test.rs"]
mod comment_receipts_tests;
#[cfg(test)]
#[path = "../comment_replay.test.rs"]
mod comment_replay_tests;
#[cfg(test)]
#[path = "../comment_rules.test.rs"]
mod comment_rules_tests;
