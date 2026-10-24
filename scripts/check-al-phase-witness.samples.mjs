/**
 * Purpose: the witness self-test's fixture code — for every row of
 *   scripts/al-witnesses.json, one code line per assert regex, in assert
 *   order. A row's lines together satisfy every regex, and without line k
 *   regex k fails, so a fixture written without line k is that row with one
 *   assertion missing (the self-test checks both facts before it uses them).
 *
 * TypeScript lines run inside an `async` case body; Rust lines inside a
 * `#[test] fn`. Strings are the text written to the fixture file verbatim.
 *
 * @coordinates-with scripts/check-al-phase-witness.test.mjs — builds the fixture trees from these lines
 * @coordinates-with scripts/al-witnesses.json — the rows and regexes these lines answer
 * @module scripts/check-al-phase-witness.samples
 */

const OPEN = "let w = Writer::open(cfg.clone()).unwrap();";

export const SAMPLES = {
  // Phase 2
  "keep B of {A, B}, restart → only A pending": [OPEN, "assert_eq!(state(&w, a), HunkState::Pending);", "assert_eq!(state(&w, b), HunkState::Kept);"],
  "revert preserves a later disjoint human edit": [
    "w.revert_hunk(doc, agent).unwrap();", 'assert!(after.contains("human line"));', String.raw`assert_eq!(after, "intro\nhuman line\nend\n");`,
  ],
  "revert of a revert restores exactly, across a restart": [
    OPEN, "let r = w.revert_hunk(doc, h).unwrap(); w.revert_hunk(doc, r).unwrap();", String.raw`assert_eq!(text(&w, doc), "original\n");`,
  ],
  "overlap → conflicted, with a message": [
    'expect(row.dataset.state).toBe("conflicted");', 'expect(screen.getByText(t("review.hunkConflicted"))).toBeInTheDocument();',
  ],
  "CRLF- or BOM-only save shows no hunks; a real whitespace edit shows": [
    String.raw`const crlf = "a\r\nb\r\n";`, String.raw`const bom = "\uFEFFtext";`, "expect(hunks(crlf, bom)).toHaveLength(0);",
    'expect(hunks("a b", "a  b").length).toBeGreaterThanOrEqual(1);',
  ],
  "WI-AL0.6 budgets met, measured on the CPU clock": ["const ms = cpuMs(() => diff(big));", "expect(ms).toBeLessThan(200);"],
  "600 review rows paint and scroll to the last row within 100 ms": [
    "const rows = renderRows(600);", "list.scrollTop = list.scrollHeight;",
    "expect(paintMs).toBeLessThan(100); expect(scrollMs).toBeLessThan(100);", "await expect.element(last).toBeVisible();",
  ],
  "aZ/Za: the rotating hunk is refused, the disjoint one reverts exactly": [
    'let pre = "aZ";', 'let post = "Za";', "assert!(matches!(err, RevertError::AmbiguousRevert));", "assert_eq!(text(&w, doc), EXPECTED);",
  ],
  "a remount without a certificate refuses, journal and projection unchanged": [
    OPEN, "assert!(matches!(w.apply_uncertified(doc), Err(AmbiguousRevert)));", "assert_eq!(w.projection(), proj_before);",
    "assert_eq!(journal_len(&w), len_before);",
  ],
  "R24 oracle: zero wrong, zero span mismatches, nonzero successes, refusals change nothing": [
    "expect(tally.wrongReverts).toBe(0);", "expect(tally.spanMismatches).toBe(0);", "expect(tally.successes).toBeGreaterThan(0);",
    "expect(snapshot(state)).toEqual(before);",
  ],
  "WYSIWYG net-zero capture, end to end through the production sessions": [
    "stop = startProvenanceSessions();", 'deleteAndRetype(editor, "a");', "expect(prepareInput(1)).toMatchObject({ baselineTouched: true });",
    "expect(distant.baseline).not.toBeNull();", 'expect(mapHunk(map, T1, "a").block).toEqual({ reason: "uncertifiedRange" });',
    'expect(mapHunk(map, T1, "far end").block).toBeNull();',
  ],
  "WYSIWYG net-zero capture, in the production collector": [
    'deleteAndRetype(editor, "a");', "expect(touched).toBe(true);", 'expect(mapHunk(p, T1, "a").block).toEqual({ reason: "uncertifiedRange" });',
    'expect(mapHunk(p, T1, "ara tw").block).toBeNull();',
  ],
  "WYSIWYG widening shown: the production collector's blocked hunk carries the panel indicator": [
    "const stop = startProvenanceSessions();", 'const badge = screen.getByLabelText(t("review.hunkBlocked"));', "expect(badge).toBeInTheDocument();",
  ],
  "admission outcome: a write error refuses, journal and projection unchanged": [
    "assert_eq!(outcome, Admission::Refused);", "assert_eq!(w.projection(), proj_before);", "assert_eq!(journal_len(&w), len_before);",
    "faults.fail_next_write();",
  ],
  "admission outcome: an fsync failure is indeterminate, poisons, and reopens cleanly": [
    "faults.fail_next_fsync();", "assert!(outcome.indeterminate);", "assert!(w.is_poisoned());", OPEN,
  ],
  "admission outcome: success prepares and the live projection equals the replayed one": [
    "assert_eq!(outcome, Admission::Prepared);", "assert_eq!(w.projection(), replayed.projection());", OPEN,
  ],
  "prepare failure leaves the content unchanged": [
    'journal.prepare.mockRejectedValueOnce(new Error("disk"));', "expect(store.content).toBe(before);", 'expect(out.status).toBe("refused");',
  ],
  "commit failure answers applied but not durable, and blocks the next mutation": [
    'journal.commit.mockRejectedValueOnce(new Error("disk"));', "expect(out).toMatchObject({ applied: true, durable: false });",
    'expect(next.status).toBe("refused");',
  ],
  "trust boundary: no MCP operation schema admits provenance keys": [
    'forbid("provenance");', 'forbid("certificate");', 'forbid("capture");', 'forbid("hunks");', 'forbid("spans");', "expect(admitted).toEqual([]);",
  ],
  "trust boundary: the bridge refuses a request carrying a provenance key": [
    "const req = { provenance: { spans: [] } };", "expect(res.isError).toBe(true);", 'expect(res.message).toContain("provenance");',
  ],
  "trust boundary: a capture seq regression is refused": [
    "let older = Capture { seq: 3, ..last };", "assert!(w.capture(older).is_err());", "assert_eq!(journal_len(&w), len_before);",
  ],
  "staged blob visibility: the baseline derives with its preimage absent from the pack": [
    "let baseline = derive_staged(&w, doc);", "assert!(!pack_contains(&w, preimage_id));", "assert_eq!(pack_len(&w), 0);",
  ],
  "admission-owned state: a refused admission leaves reservations, degraded queues and window bases unchanged": [
    "assert_eq!(outcome, Admission::Refused);", "assert_eq!(w.reservations(), reservations_before);",
    "assert_eq!(w.degraded_queue(doc), queue_before);", "assert_eq!(w.window_base(doc), base_before);", "assert_eq!(journal_len(&w), len_before);",
  ],
  "live = replay: Projection equality, requests included, after an immediate retry": [
    "let a = w.prepare(req.clone()); let b = w.prepare(req);", "let replayed = Writer::open(cfg.clone()).unwrap();",
    "assert_eq!(w.projection(), replayed.projection());", "assert!(replayed.projection().requests.contains_key(&req_id));",
  ],
  "compaction of admissions: surviving seq unchanged, receipt retained, reopen clean": [
    "w.compact().unwrap();", "assert_eq!(survivor.seq, seq_before);", "assert!(w.receipt(req_id).is_some());", OPEN,
  ],
  "duplicate states: executable, terminalPending, terminal and unavailable, with zero extra apply": [
    "assert!(matches!(a, Duplicate::Executable));", "assert!(matches!(b, Duplicate::TerminalPending));", "assert!(matches!(c, Duplicate::Terminal));",
    "assert!(matches!(d, Duplicate::Unavailable));", "assert_eq!(applies.get(), 1);",
  ],
  "uncertainty contract: the freeze is released only on a confirmed clean refusal": [
    "expect(release).toHaveBeenCalled();", "expect(releaseOnRetry).not.toHaveBeenCalled();", "expect(invalidate).toHaveBeenCalled();",
    "expect(out).toMatchObject({ indeterminate: true });",
  ],
  "uncertainty contract: every Rust refusal code has its TypeScript journal code": [
    'const rust = readFileSync("src-tauri/src/agent_journal/refusal.rs", "utf8");', "const codes = JOURNAL_CODES;",
    'expect(codes).toContain("AMBIGUOUS_REVERT");',
  ],
  "writer-bound certificate: a dirty-buffer write is certified and reverts an unaffected hunk exactly": [
    "let dirty = edit_buffer(&w, doc);", "assert!(write.certified);", "w.revert_hunk(doc, other).unwrap();",
    String.raw`assert_eq!(text(&w, doc), "intro\nkept\n");`,
  ],
  // Phase 3
  "duplicated passage → ambiguous": ["let r = resolve(&doc, &anchor);", "assert_eq!(r, Resolution::Ambiguous);"],
  "deleted passage → orphaned": ["let r = resolve(&doc, &anchor);", "assert_eq!(r, Resolution::Orphaned);"],
  "heading rename still resolves by context": [
    String.raw`let doc = "## Renamed\nbody";`, "let r = resolve(&doc, &anchor);", "assert!(matches!(r, Resolution::Exact(_)));",
  ],
  "selection across headings maps exactly or widens visibly": [
    String.raw`let doc = "# One\na\n## Two\nb";`, "let r = resolve(&doc, &anchor);", "assert!(matches!(r, Resolution::Exact(_) | Resolution::Widened(_)));",
  ],
  "CJK, emoji and RTL offsets equal the expected UTF-16 numbers": [
    'let cjk = "中文";', 'let emoji = "😀";', 'let rtl = "שלום";', "assert_eq!(offset(&doc, 5), 12);",
  ],
  "anchor quote bound: 4096 bytes accepted, 4097 refused": [
    "let fits = quote(4096);", "let too_long = quote(4097);", "assert_eq!(err.code, COMMENT_ANCHOR_TOO_LONG);",
  ],
  "reply body bound: 16,384 bytes accepted, 16,385 refused": [
    "let fits = body(16384);", "let big = body(16385);", "assert!(add_reply(&w, big).is_err());",
  ],
  "replies per comment: 200 accepted, 201 refused": [
    "for _ in 0..200 { add_reply(&w).unwrap(); }", "let next = 201;", "assert!(add_reply(&w).is_err());",
  ],
  "comments: 1,000 accepted, 1,001 refused": ["fill_comments(&w, 1000);", "let next = 1_001;", "assert!(add_comment(&w).is_err());"],
  "logical byte limits at the boundary: thread 256 KiB, document 4 MiB, global 64 MiB": [
    "fill_thread(&w, 256 * 1024);", "fill_document(&w, 4 * 1024 * 1024);", "fill_global(&w, 64 * 1024 * 1024);",
    "assert!(add_comment(&w).is_err());", "assert!(resolve_thread(&w).is_ok());",
  ],
  "physical cap: 128 MiB of retained records refuses with COMMENT_STORAGE_FULL": [
    "fill_physical(&w, 128 * 1024 * 1024);", "assert_eq!(err.code, COMMENT_STORAGE_FULL);",
  ],
  "terminal reserve: resolve and delete succeed with the budget full": [
    "fill_logical(&w);", "let r = resolve_comment(&w, id);", "let d = delete_comment(&w, id);", "assert!(r.is_ok() && d.is_ok());",
  ],
  "a comment id is never reused after delete and restart": [
    "delete_comment(&w, id).unwrap();", OPEN, "assert_ne!(add_comment(&w).unwrap(), id);",
  ],
  "agent resolve refused, with nothing appended": [
    'const res = await call("resolve", { id });', "expect(res.isError).toBe(true);", "expect(append).not.toHaveBeenCalled();",
  ],
  "comment HTML renders as text only": [
    'const body = "<script>alert(1)</script>";', 'expect(view.querySelector("script")).toBeNull();', "expect(view.textContent).toBe(body);",
  ],
  "every WI-AL0.9 fixture maps exactly or widens visibly, through the production resolver": [
    'let fixtures: Vec<Fixture> = serde_json::from_str(include_str!("fixtures/anchor.json")).unwrap();',
    "if outcome == Outcome::Exact { exact += 1; }", "if outcome == Outcome::Widened { widened += 1; }", "assert!(fixtures.len() >= 47);",
  ],
  "heading goldens come from the production parser, with no drift": [
    "const tree = parseMarkdownToMdast(src);", 'const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));', "expect(generate(tree)).toEqual(golden);",
  ],
  "a future record stops before repair, the file's bytes unchanged": [
    "assert_eq!(err.code(), FUTURE_FORMAT);", "let digest = Sha256::digest(&bytes);", "assert_eq!(hashes(&dir), before);",
    "append_raw(&path, &torn_frame(10));", "let r = Writer::open_with_max_schema(cfg.clone(), 3);",
  ],
};
