//! Admissions and request receipts (journal schema v3).
//!
//! - `receipt` — a prepare's request id, payload digest and stored reply,
//!   kept on its `prepared` so a retried request is answered from the
//!   journal instead of written twice.
//! - `shape` — the static rules of an `admission` frame: a multi-record
//!   write (observations, their linearizations, a baseline, the outcome)
//!   persisted as one frame so it is durable whole or not at all.
//! - `prepare`, `stage`, `publish` — a controlled prepare written as one
//!   top-level record or one staged admission frame, durable whole or not
//!   at all, answered from its receipt when retried.
//! - `reduce` — what `Projection::apply` checks before an admission's
//!   items, or a receipted record, reduce.
//!
//! @module agent_journal/admission

pub(crate) mod blobs;
pub(crate) mod prepare;
pub(crate) mod prepared_record;
pub(crate) mod publish;
pub mod receipt;
pub(crate) mod reduce;
pub mod shape;
pub(crate) mod stage;

#[cfg(test)]
#[path = "../admission_shape.test.rs"]
mod admission_shape_tests;

#[cfg(test)]
#[path = "../admission_receipts.test.rs"]
mod admission_receipts_tests;

#[cfg(test)]
#[path = "../admission_support.test.rs"]
pub(crate) mod admission_support;

#[cfg(test)]
#[path = "../admission_outcomes.test.rs"]
mod admission_outcomes_tests;

#[cfg(test)]
#[path = "../admission_staging.test.rs"]
mod admission_staging_tests;

#[cfg(test)]
#[path = "../admission_replay.test.rs"]
mod admission_replay_tests;

#[cfg(test)]
#[path = "../admission_compaction.test.rs"]
mod admission_compaction_tests;

#[cfg(test)]
#[path = "../receipt_fixtures.test.rs"]
mod receipt_fixtures_tests;

#[cfg(test)]
#[path = "../admission_torn.test.rs"]
mod admission_torn_tests;

#[cfg(test)]
#[path = "../admission_clone_cost.test.rs"]
mod admission_clone_cost_tests;
