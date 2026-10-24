// WI-AL2.2a — the frozen receipt fixtures (`fixtures/receipts.json`, shared with the TypeScript client): the agent write's and the restore's `prepared` receipts decode through the production types and re-encode byte for byte, each digest is SHA-256 over its exact payload, and two payloads differing only in field order digest differently
//! R64 §3–§4, R101 rule 2 and R103 rule 7.

use serde_json::Value;

use crate::agent_journal::admission::admission_shape_tests::prepared;
use crate::agent_journal::admission::receipt::{Outcome, PayloadDigest, PreparedResponse, Receipt};
use crate::agent_journal::controlled_restore::decode_restore_prepare;
use crate::agent_journal::controlled_wire::decode_prepare;
use crate::agent_journal::record::Envelope;

const FIXTURE: &str = include_str!("fixtures/receipts.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("fixture is JSON")
}

fn case(name: &str) -> (String, String) {
    let f = fixture();
    let c = f["receipts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("fixture {name}"))
        .clone();
    let s = |k: &str| c[k].as_str().unwrap().to_owned();
    (s("payload"), s("receipt"))
}

#[test]
fn the_controlled_prepared_receipt_round_trips_byte_for_byte() {
    let (payload, wire) = case("controlledPrepared");
    let r: Receipt = serde_json::from_str(&wire).expect("decodes");
    let Outcome::Prepared(PreparedResponse::Controlled(p)) = &r.outcome else {
        panic!("a controlled reply: {r:?}")
    };
    assert_eq!(p.generation, u64::MAX - 1, "a u64 past 2^53 survives");
    assert!(p.baseline.is_some());
    assert_eq!(serde_json::to_string(&r).unwrap(), wire, "byte for byte");
    assert_eq!(
        r.digest,
        PayloadDigest::of(&payload),
        "digest of the raw payload"
    );
    let req = decode_prepare(payload.as_bytes()).expect("the payload decodes");
    assert_eq!(req.request_id, Some(r.request_id));
}

#[test]
fn the_restore_prepared_receipt_round_trips_byte_for_byte() {
    let (payload, wire) = case("restorePrepared");
    let r: Receipt = serde_json::from_str(&wire).expect("decodes");
    let Outcome::Prepared(PreparedResponse::Restore(p)) = &r.outcome else {
        panic!("a restore reply: {r:?}")
    };
    assert!(p.resolves.is_some(), "non-null resolves");
    assert!(p.text.contains("café") && p.text.contains('🧾') && p.text.contains('\u{0}'));
    assert_eq!(serde_json::to_string(&r).unwrap(), wire, "byte for byte");
    assert_eq!(r.digest, PayloadDigest::of(&payload));
    let req = decode_restore_prepare(payload.as_bytes()).expect("the payload decodes");
    assert_eq!(req.request_id, Some(r.request_id));
}

#[test]
fn a_receipt_survives_the_journal_codec_on_its_prepared() {
    use crate::agent_journal::codec::{decode, encode, Decoded};
    for name in ["controlledPrepared", "restorePrepared"] {
        let (_, wire) = case(name);
        let receipt: Receipt = serde_json::from_str(&wire).unwrap();
        let (doc, revision) = match &receipt.outcome {
            Outcome::Prepared(PreparedResponse::Controlled(p)) => (p.doc, p.revision),
            Outcome::Prepared(PreparedResponse::Restore(p)) => (p.doc, p.revision),
        };
        let env = Envelope {
            schema_version: 3,
            seq: 7,
            txn: receipt.txn(),
            at: 0,
            record: prepared(doc, None, revision, "pre"),
            receipt: Some(receipt.clone()),
        };
        let Decoded::Known(back) = decode(&encode(&env)).expect("decodes") else {
            panic!("{name}: a known record")
        };
        assert_eq!(back.receipt, Some(receipt), "{name}");
    }
}

#[test]
fn payloads_differing_only_in_field_order_digest_differently() {
    let f = fixture();
    let orders = f["fieldOrder"].as_array().unwrap();
    assert_eq!(orders.len(), 2);
    let digests: Vec<PayloadDigest> = orders
        .iter()
        .map(|o| {
            let p = o["payload"].as_str().unwrap();
            let d = PayloadDigest::of(p);
            assert_eq!(
                serde_json::to_value(&d).unwrap(),
                o["digest"],
                "stored digest"
            );
            d
        })
        .collect();
    assert_ne!(
        digests[0], digests[1],
        "hashed as bytes, never re-canonicalized"
    );
    let decoded: Vec<_> = orders
        .iter()
        .map(|o| decode_prepare(o["payload"].as_str().unwrap().as_bytes()).unwrap())
        .collect();
    assert_eq!(decoded[0], decoded[1], "the same request either way");
}
