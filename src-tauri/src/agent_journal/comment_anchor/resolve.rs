//! Resolving a stored anchor in a revision's text, tier by tier.
//!
//! @module agent_journal/comment_anchor/resolve

use super::outline::{headings, Heading};
use super::{Resolution, StoredAnchor, Tier};
use crate::agent_journal::ids::RevisionId;

/// Find `anchor` in `text`. `at` is the revision `text` is; the offset hint
/// applies only when it is the anchor's creation revision.
pub fn resolve(text: &str, anchor: &StoredAnchor, at: Option<RevisionId>) -> Resolution {
    let hay: Vec<u16> = text.encode_utf16().collect();
    let quote: Vec<u16> = anchor.quote.encode_utf16().collect();
    let all = occurrences(&hay, &quote);
    if all.is_empty() {
        return Resolution::Orphaned;
    }
    let hint = anchor
        .hint
        .as_ref()
        .filter(|h| Some(h.revision) == at)
        .map(|h| h.offset);
    let decide = |tier: Tier, found: Vec<usize>| decide(tier, &found, quote.len(), hint);

    let prefix: Vec<u16> = anchor.prefix.encode_utf16().collect();
    let suffix: Vec<u16> = anchor.suffix.encode_utf16().collect();
    let in_context: Vec<usize> = all
        .iter()
        .copied()
        .filter(|&i| {
            let after = i + quote.len();
            i >= prefix.len()
                && hay[i - prefix.len()..i] == prefix[..]
                && hay.get(after..after + suffix.len()) == Some(&suffix[..])
        })
        .collect();
    if !in_context.is_empty() {
        return decide(Tier::Context, in_context);
    }
    let in_path = within_path(&headings(text), &all, &anchor.heading_path);
    if !in_path.is_empty() {
        return decide(Tier::HeadingPath, in_path);
    }
    decide(Tier::Anywhere, all)
}

fn decide(tier: Tier, found: &[usize], len: usize, hint: Option<u64>) -> Resolution {
    let resolved = |start: usize, by_hint: bool| Resolution::Resolved {
        tier,
        start: start as u64,
        end: (start + len) as u64,
        by_hint,
    };
    match found {
        [only] => resolved(*only, false),
        _ => match hint.and_then(|h| found.iter().copied().find(|&c| c as u64 == h)) {
            Some(start) => resolved(start, true),
            None => Resolution::Ambiguous {
                tier,
                candidates: found.iter().map(|&c| c as u64).collect(),
            },
        },
    }
}

/// The candidates (ascending) whose enclosing heading path is `path`.
fn within_path(headings: &[Heading], candidates: &[usize], path: &[String]) -> Vec<usize> {
    let mut stack: Vec<&Heading> = Vec::new();
    let mut next = 0;
    let mut out = Vec::new();
    for &c in candidates {
        while let Some(h) = headings.get(next).filter(|h| h.offset <= c as u64) {
            while stack.last().is_some_and(|top| top.depth >= h.depth) {
                stack.pop();
            }
            stack.push(h);
            next += 1;
        }
        if stack.len() == path.len() && stack.iter().zip(path).all(|(h, p)| h.text == *p) {
            out.push(c);
        }
    }
    out
}

/// Every start of `needle` in `hay`, overlapping ones included (KMP, linear).
fn occurrences(hay: &[u16], needle: &[u16]) -> Vec<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return Vec::new();
    }
    let mut fail = vec![0usize; needle.len()];
    let mut k = 0;
    for i in 1..needle.len() {
        while k > 0 && needle[i] != needle[k] {
            k = fail[k - 1];
        }
        if needle[i] == needle[k] {
            k += 1;
        }
        fail[i] = k;
    }
    let mut out = Vec::new();
    k = 0;
    for (i, &u) in hay.iter().enumerate() {
        while k > 0 && u != needle[k] {
            k = fail[k - 1];
        }
        if u == needle[k] {
            k += 1;
        }
        if k == needle.len() {
            out.push(i + 1 - k);
            k = fail[k - 1];
        }
    }
    out
}
