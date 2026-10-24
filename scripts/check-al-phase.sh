#!/usr/bin/env bash
# shellcheck disable=SC2329  # usage and the phase/slice functions are called by name, indirectly
#
# Phase gate for the agent edit ledger (#1591): rule 60 §3's machine-checkable
# Definition of Done, one block per phase.
#
# Usage: bash scripts/check-al-phase.sh <0-4> [--root=<dir>] [--no-exec]
#
# Exit 0 when every assertion passes, 1 when any fails or is unverified,
# 64 on bad invocation. `--root` points the gate at another tree (the
# self-test, scripts/check-al-phase.test.mjs, proves both directions on
# fixture trees); `--no-exec` skips everything that RUNS a command and reports
# it UNVERIFIED, so a quick read never passes a phase.
#
# Self-contained: the plan is maintainer-local and gitignored, so this file
# never reads it — every assertion is a path, symbol, test or command written
# below. Tests are found by their header and then run (scripts/lib/al-gate.sh).
#
# Phase 0's spike artifacts live under dev-docs/grills (the exact folder is
# GRILLS_DIR in scripts/check-al-spike-results.mjs), which
# is maintainer-local too: on a clone without it, phase 0 fails, one line per
# artifact. Each of the five artifacts (revert, backend, txn, anchor, review)
# is judged on its own by scripts/check-al-spike-results.mjs (present, valid,
# names its work item, passing provenance verdict, and a sha256 fingerprint of
# its sources, the src/ code they import and their lockfiles that still
# matches them), so one
# missing or stale artifact never hides another. Not checkable here, and therefore confirmed by
# hand in the plan: the schema/protocol/wire design text and the Codex
# re-review of the updated plan.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  echo "Usage: $0 <phase> [--root=<dir>] [--no-exec]"
  echo "  0  Contracts and spikes — five spike artifacts, attribution wire, the gates"
  echo "  1  Durable journal — slices 1.1–1.7 plus the phase-wide DoD"
  echo "  2  Review — diff dependency, revert engine, hunk state, review panel, normalization"
  echo "  3  Anchored comments and MCP comment tools"
  echo "  4  Git export"
}

source "$SCRIPT_DIR/lib/al-gate.sh"
al_parse_args '^[0-4]$' usage "$@"
cd "$ROOT" || exit 64
source "$SCRIPT_DIR/lib/dod-assertions.sh"
source "$SCRIPT_DIR/lib/al-slices.sh"

RS_BRIDGE=src-tauri/src/mcp_bridge
TS_BRIDGE=src/services/mcpBridge

phase_0() {
  local s
  echo "Phase 0 — contracts and spikes"
  for s in revert backend txn anchor review; do al_spike "$s"; done

  echo "  — attribution wire (Rust ↔ TS envelope)"
  assert_rust_code_grep 'enum\s+PrincipalWire' "$RS_BRIDGE/attribution.rs" "WI-AL0.3: PrincipalWire in $RS_BRIDGE/attribution.rs"
  assert_rust_code_grep 'struct\s+McpAttribution' "$RS_BRIDGE/attribution.rs" "WI-AL0.3: McpAttribution in $RS_BRIDGE/attribution.rs"
  assert_rust_code_grep 'attribution\s*:\s*McpAttribution' "$RS_BRIDGE/types.rs" "WI-AL0.3: McpRequestEvent carries attribution"
  assert_rust_code_grep '(^|[^A-Za-z0-9_])mod\s+attribution\s*;' "$RS_BRIDGE/mod.rs" "WI-AL0.3: attribution module declared"
  assert_ts_code_grep 'export\s+function\s+parseMcpAttribution' "$TS_BRIDGE/attribution.ts" "WI-AL0.3: parseMcpAttribution exported from $TS_BRIDGE/attribution.ts"
  assert_ts_code_grep 'export\s+const\s+MAX_SESSION_LABEL_BYTES' "$TS_BRIDGE/attribution.ts" "WI-AL0.3: MAX_SESSION_LABEL_BYTES exported"
  assert_ts_code_grep 'attribution\s*:\s*McpAttribution' "$TS_BRIDGE/types.ts" "WI-AL0.3: TS request event carries attribution"
  assert_file src/test/fixtures/mcpRequestEnvelope.json "WI-AL0.3: Rust-generated envelope fixture"
  assert_file src/test/mcpAttributionFixture.ts "WI-AL0.3: typed fixture helper"
  assert_test_file "$RS_BRIDGE/attribution.test.rs" "WI-AL0.3: Rust attribution tests"
  assert_test_file "$TS_BRIDGE/attribution.test.ts" "WI-AL0.3: TS envelope parity tests"
  al_require_tests WI-AL0.3

  echo "  — the gates themselves"
  assert_file scripts/check-al-slice.sh "WI-AL0.7: slice gate"
  assert_file scripts/lib/al-gate.sh "WI-AL0.7: gate helpers"
  assert_file scripts/check-al-spike-results.mjs "WI-AL0.7: spike-artifact checker"
  assert_file scripts/lib/alSpikeFingerprint.mjs "WI-AL0.7: shared spike input fingerprint"
  assert_file scripts/lib/alSpikeVerdicts.mjs "WI-AL0.7: per-area spike verdicts"
  assert_file scripts/lib/alSpikeImportGraph.mjs "WI-AL0.7: spike import closure (src/ code a probe runs)"
  al_require_tests WI-AL0.7
}

phase_1() {
  local s all="WI-AL1.1 WI-AL1.2 WI-AL1.3 WI-AL1.4 WI-AL1.5 WI-AL1.6 WI-AL1.7"
  echo "Phase 1 — durable journal"
  for s in 1 2 3 4 5 6 7; do "al_slice_1_$s"; done
  echo "  — phase-wide Definition of Done"
  al_tests_cover "$all" 'compact'                         "phase 1: two windows lose no entries after compaction"
  al_tests_cover "$all" 'temp|fsync|rename|dir.?sync'     "phase 1: crash at temp write / fsync / rename / dir-sync recovers"
  al_tests_cover "$all" 'save.?as'                        "phase 1: untitled → Save As → rename keeps one document UUID"
  al_tests_cover "$all" 'cop(y|ied)'                      "phase 1: a copied file gets a new document UUID"
  al_tests_cover "$all" 'cjk|byte.?cap'                   "phase 1: CJK byte cap enforced"
  al_tests_cover "$all" 'legacy'                          "phase 1: legacy entries survive as legacy"
  al_tests_cover "$all" 'ENOSPC|disk.?full'               "phase 1: disk-full fails loud"
  al_tests_cover "$all" 'EACCES|permission'               "phase 1: permission-denied fails loud"
  al_tests_cover "$all" 'rapid|burst|100 writes'          "phase 1: 100 writes in 1 s all recorded"
  al_tests_cover "$all" 'restart|reopen'                  "phase 1: restart keeps everything"
  # One test per fact, naming its scenarios together: a keyword spread over
  # unrelated files above can pass while no single test proves the fact.
  al_test_has WI-AL1.5 'mcpCapture\.connections\.test\.ts$' "phase 1: two concurrent clients keep separate reads and attribution" \
    'two-client read isolation' 'concurrent writes by two clients' 'recorded under the actor'
  al_test_has WI-AL1.2 'window_convergence\.test\.rs$' "phase 1: two windows converge and lose no entries after compaction" \
    'HydratedView' 'collect\(' 'drop_next_broadcasts' 'reopen'
  al_test_has WI-AL1.2 'durability\.test\.rs$' "phase 1: a crash at append, temp write, fsync, rename or dir-sync recovers" \
    'tear_next_append_after' 'TempWritten' 'TempSynced' 'Renamed' 'DirSynced'
  al_test_has WI-AL1.3 'controller\.test\.rs$' "phase 1: a failed commit answers applied but not durable" \
    'out\.applied && !out\.durable'
  al_test_has WI-AL1.6 'identity\.test\.rs$' "phase 1: untitled, Save As, rename and reopen keep one document; a copy gets a new one" \
    'untitled_save_as_then_rename_then_reopen' 'a_copy_is_a_new_document'
  al_test_has WI-AL1.2 'schema\.test\.rs$' "phase 1: the session label byte cap counts CJK bytes" \
    'bytes_not_chars' '中'
  al_test_has WI-AL1.2 'protocol\.test\.rs$' "phase 1: legacy entries stay legacy and a restart keeps everything" \
    'legacy_checkpoints_migrate_once_and_stay_outside_revision_chains' 'restart_projection_equals_live_projection'
  al_test_has WI-AL1.2 'failure_modes\.test\.rs$' "phase 1: disk full and permission denied fail loud" \
    'StorageFull' 'PermissionDenied' 'JOURNAL_IO' 'Phase::Failed'
  al_test_has WI-AL1.7 'generation_events\.test\.rs$' "phase 1: a burst of 100 writes all land" \
    '100_rapid_writes'
  assert_exec "phase 1: lint:ipc-contract" pnpm lint:ipc-contract
  assert_exec "phase 1: lint:command-errors" pnpm lint:command-errors
  al_exec_when_green "phase 1: cargo test (whole crate)" cargo test --manifest-path src-tauri/Cargo.toml
  al_exec_when_green "phase 1: cargo clippy -D warnings" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
  al_exec_when_green "phase 1: check:all" pnpm check:all
}

phase_2() {
  local wi all="WI-AL2.1 WI-AL2.2 WI-AL2.3 WI-AL2.4 WI-AL2.5"
  echo "Phase 2 — review"
  for wi in $all; do al_require_tests "$wi"; done
  # The revert spike's decision: diff-match-patch, run in a worker that is
  # terminated at the deadline. A different choice changes this line.
  al_pkg_dep diff-match-patch "WI-AL2.1: the spike's diff library is a dependency"
  al_tests_cover WI-AL2.2 'prepare'                       "WI-AL2.2: injected prepare failure leaves content unchanged"
  al_tests_cover WI-AL2.2 'durable'                       "WI-AL2.2: commit failure returns applied without durable"
  al_test_has WI-AL2.2 '.' "WI-AL2.2: CJK and emoji fixtures" 'cjk' 'emoji'
  al_tests_cover WI-AL2.2 'rtl'                           "WI-AL2.2: RTL fixtures"
  al_tests_cover WI-AL2.3 'settled'                       "WI-AL2.3: Clear reviewed settles"
  al_tests_cover WI-AL2.3 'restart'                       "WI-AL2.3: keep B of {A, B}, restart → only A pending"
  al_tests_cover WI-AL2.3 'revert.{0,40}revert'           "WI-AL2.3: revert of a revert restores exactly"
  al_tests_cover WI-AL2.3 '501'                           "WI-AL2.3: 501 disjoint human revisions still map a pending hunk"
  al_tests_cover WI-AL2.4 'conflicted'                    "WI-AL2.4: overlap → conflicted with a message"
  al_tests_cover WI-AL2.4 'REVIEW_BACKLOG_FULL'           "WI-AL2.4: backlog-full banner and agent message"
  al_tests_cover WI-AL2.5 'crlf'                          "WI-AL2.5: CRLF-only save shows no hunks"
  al_tests_cover WI-AL2.5 'bom'                           "WI-AL2.5: BOM-only save shows no hunks"
  al_tests_cover WI-AL2.5 'whitespace'                    "WI-AL2.5: a real whitespace edit shows"
  al_tests_cover "$all" 'cpuClock|measureGrowth|growthExponent' "phase 2: budgets measured with src/test/cpuClock.ts"
  assert_exec "phase 2: lint:i18n" pnpm lint:i18n
}

phase_3() {
  local wi op loc all="WI-AL3.1 WI-AL3.2 WI-AL3.3"
  echo "Phase 3 — anchored comments and MCP tools"
  for wi in $all; do al_require_tests "$wi"; done
  al_tests_cover WI-AL3.1 'ambiguous'                     "WI-AL3.1: duplicated passage → ambiguous"
  al_tests_cover WI-AL3.1 'orphan'                        "WI-AL3.1: deleted passage → orphaned"
  al_tests_cover WI-AL3.1 'heading'                       "WI-AL3.1: heading rename still resolves by context"
  al_test_has WI-AL3.1 '.' "WI-AL3.1: CJK, emoji and RTL offsets exact" 'cjk' 'emoji' 'rtl'
  al_tests_cover WI-AL3.1 'bound|limit|too (long|many)'   "WI-AL3.1: bound violations refused"
  al_tests_cover WI-AL3.2 'reopen'                        "WI-AL3.2: user resolve and reopen"
  al_tests_cover "$all" '<script|text only|textContent'   "phase 3: comment HTML renders as text only"
  al_tests_cover WI-AL3.3 'resolve'                       "WI-AL3.3: agent resolve refused"
  al_tests_cover WI-AL3.3 'addresses'                     "WI-AL3.3: revision metadata addresses: [commentId]"
  for op in comments.list comments.reply comments.mark_addressed; do
    # In the module's CODE (the name is a literal there, so literals are kept;
    # a comment naming a planned operation is not a schema).
    assert_ts_code_grep "${op//./\\.}" server/mcp/src/bridge/operationSchemas.ts "WI-AL3.3: $op schema" --keep-strings
    assert_grep "$op" server/mcp/README.md "WI-AL3.3: $op in server/mcp/README.md"
    for loc in website/guide website/{de,es,fr,it,ja,ko,pt-BR,zh-CN,zh-TW}/guide; do
      assert_grep "$op" "$loc/mcp-tools.md" "WI-AL3.3: $op in $loc/mcp-tools.md"
    done
  done
  assert_exec "phase 3: lint:mcp-contracts" pnpm lint:mcp-contracts
  assert_exec "phase 3: lint:mcp-docs" pnpm lint:mcp-docs
}

phase_4() {
  local wi=WI-AL4.1 t='git_export/[^/]*\.test\.rs$'
  echo "Phase 4 — Git export"
  al_require_tests "$wi"
  # One linked test names each DoD fact (al_test_has), so a fact cannot be
  # satisfied by a stray word in an unrelated file.
  al_test_has "$wi" "$t" "phase 4: the collected-run fixture exports one synthetic commit with sorted VMark-Actors, and re-export is idempotent" \
    'collected_run_fixture_exports_one_synthetic_commit_and_re_export_is_idempotent' 'VMark-Collected' 'VMark-Actors'
  al_test_has "$wi" "$t" "phase 4: the synthetic commit's tree is the next retained revision's before-text" \
    'collected_run_fixture_plans_exactly_one_synthetic_commit' 'the_synthetic_tree_is_the_linear_before_text'
  al_test_has "$wi" "$t" "phase 4: re-export after journal GC appends only new revisions" \
    're_export_after_journal_gc_appends_only_new_revisions'
  al_test_has "$wi" "$t" "phase 4: a branch advanced elsewhere is a conflict, by compare-and-swap" \
    'a_branch_advanced_elsewhere_is_a_conflict_not_an_overwrite' 'a_ref_moved_during_export_is_a_conflict_by_compare_and_swap'
  al_test_has "$wi" "$t" "phase 4: export into a non-empty unrelated branch is refused" \
    'export_into_a_non_empty_unrelated_branch_is_refused'
  al_test_has "$wi" "$t" "phase 4: round-trip on a fixture journal" \
    'round_trip_on_a_fixture_journal_reads_every_revision_back'
  # The host runs the two all-platform tests and the platform test its own
  # build compiles; the other platform's test cannot run here.
  local own_platform='foreign_platform_spellings_are_relative_on_unix'
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) own_platform='drive_and_unc_spellings_are_absolute_on_windows' ;;
  esac
  al_test_has "$wi" "$t" "phase 4: Windows path handling" \
    'tree_file_name_splits_windows_backslash_paths_on_every_platform' 'repository_paths_must_be_absolute_on_this_platform' \
    "$own_platform"
  # The Windows-only test, judged statically: mounted and compiled for
  # windows. Nothing here executes it; only a Windows build can.
  al_test_for_target "$wi" "$t" "phase 4: Windows path handling" windows \
    'drive_and_unc_spellings_are_absolute_on_windows'
  al_test_has "$wi" "$t" "phase 4: missing Git gives a clear message" \
    'missing_git_is_a_clear_message'
  al_code_has 'build_command' src-tauri/src/agent_journal/git_export "phase 4: Git runs through ai_provider::build_command"
  al_code_has 'vmark-journal/' src-tauri/src                        "phase 4: exports to a vmark-journal/<document-uuid> branch" --keep-strings
  # Reachable means registered by the composition root and wired to the IPC
  # command, proven by a linked test that runs both; a module that merely
  # spells the command name (an orphaned client) proves neither.
  al_test_has "$wi" '^src/services/commands/[^/]*\.test\.ts$' \
    "phase 4: the export is reachable from the app: registerAllCommands registers history.exportToGit, and running it invokes agent_journal_git_export" \
    'registerAllCommands' 'history\.exportToGit' 'agent_journal_git_export'
  al_exec_when_green "phase 4: cargo clippy -D warnings" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
}

"phase_$AL_TARGET"
al_summary "Phase $AL_TARGET"
