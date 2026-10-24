//! Admissions and request receipts (journal schema v3).
//!
//! - `receipt` — a prepare's request id, payload digest and stored reply,
//!   kept on its `prepared` so a retried request is answered from the
//!   journal instead of written twice.
//! - `answer` — the refusal a decoded request id gets: its state, the
//!   wire token that state maps to, and whether the caller is `uncertain`.
//! - `shape` — the static rules of an `admission` frame: a multi-record
//!   write (observations, their linearizations, a baseline, the outcome)
//!   persisted as one frame so it is durable whole or not at all.
//! - `prepare`, `stage`, `publish` — a controlled prepare written as one
//!   top-level record or one staged admission frame, durable whole or not
//!   at all, answered from its receipt when retried.
//! - `reconcile` — the receipt lookup and the exhaustive classification of
//!   a receipted request's transaction.
//! - `reduce` — what `Projection::apply` checks before an admission's
//!   items, or a receipted record, reduce.
//!
//! @module agent_journal/admission

pub mod abandon;
pub mod answer;
pub(crate) mod blobs;
pub mod bound;
pub(crate) mod framed;
pub mod identity;
pub mod owned;
pub mod page_table;
pub(crate) mod payload;
pub(crate) mod prepare;
pub(crate) mod prepared_record;
pub(crate) mod publish;
pub mod receipt;
pub(crate) mod reconcile;
pub(crate) mod reduce;
pub mod requests;
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

#[cfg(test)]
#[path = "../request_commit.test.rs"]
mod request_commit_tests;

#[cfg(test)]
#[path = "../page_table.test.rs"]
pub(crate) mod page_table_tests;

#[cfg(test)]
#[path = "../request_support.test.rs"]
pub(crate) mod request_support;

#[cfg(test)]
#[path = "../request_inflight.test.rs"]
mod request_inflight_tests;

#[cfg(test)]
#[path = "../request_order.test.rs"]
mod request_order_tests;

#[cfg(test)]
#[path = "../request_bounds.test.rs"]
mod request_bounds_tests;

#[cfg(test)]
#[path = "../request_abandon.test.rs"]
mod request_abandon_tests;

#[cfg(test)]
#[path = "../request_sweep.test.rs"]
mod request_sweep_tests;

#[cfg(test)]
#[path = "../request_pages.test.rs"]
mod request_pages_tests;

#[cfg(test)]
#[path = "../request_restart.test.rs"]
mod request_restart_tests;

#[cfg(test)]
#[path = "../duplicate_requests.test.rs"]
mod duplicate_requests_tests;

#[cfg(test)]
#[path = "../request_settle.test.rs"]
mod request_settle_tests;
