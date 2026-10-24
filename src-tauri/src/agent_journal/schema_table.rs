//! The per-version table of record kinds and fields.
//!
//! Each kind (and, from v3 on, each versioned field) has the lowest schema
//! version that may carry it. The decoder refuses a record labelled below
//! that version as `Corrupt`: a v3 kind under a v2 label would be read by a
//! v2 build as something it is not. A label above the minimum is allowed,
//! so a v3 record of a v2 kind decodes. The writer labels each new record
//! with its minimum, never below v2 (`label`), so a journal that uses
//! nothing newer stays readable by a v2 build.
//!
//! The match is exhaustive on purpose: a new kind does not compile until it
//! names its version here. A v3 field joins its kind's arm as a pattern on
//! that field. The v1 → v2 field differences are vetted earlier, in JSON,
//! by `codec_v1`.

use crate::agent_journal::errors::TxnError;
use crate::agent_journal::record::{Envelope, Record, SCHEMA_V1, SCHEMA_V2};

/// The lowest schema version that may carry `record`.
pub(crate) fn min_schema(record: &Record) -> u32 {
    match record {
        Record::JournalHeader { .. }
        | Record::Prepared { .. }
        | Record::Aborted { .. }
        | Record::Committed { .. }
        | Record::Uncommitted
        | Record::Discarded { .. }
        | Record::PendingObservation { .. }
        | Record::ObservedRevision { .. }
        | Record::ConcurrentObservation { .. }
        | Record::Gap { .. }
        | Record::ReviewDecision { .. }
        | Record::Tombstone { .. }
        | Record::LegacyCheckpoint { .. } => SCHEMA_V1,
        Record::EpochArmed { .. } | Record::EpochClosed { .. } | Record::EpochUnclosed { .. } => {
            SCHEMA_V2
        }
    }
}

/// The version a newly written `record` is labelled with: its minimum, but
/// at least v2 (this build's records carry v2 provenance semantics).
pub(crate) fn label(record: &Record) -> u32 {
    min_schema(record).max(SCHEMA_V2)
}

/// Refuse a record labelled below the version of its kind or fields.
pub(crate) fn check(env: &Envelope) -> Result<(), TxnError> {
    let min = min_schema(&env.record);
    if env.schema_version < min {
        return Err(TxnError::Corrupt(format!(
            "a v{min} record kind or field is labelled schemaVersion {}",
            env.schema_version
        )));
    }
    Ok(())
}

#[cfg(test)]
#[path = "schema_table.test.rs"]
mod tests;
