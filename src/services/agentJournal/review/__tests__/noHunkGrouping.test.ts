// @vitest-environment node
// WI-AL2.1b — source-level guard: nothing the history panel or the declared-script writer path loads imports a hunk-grouping helper (the spike's line-level groupIntoHunks, which merged ab12cd → aX12Yd's two runs, or any helper named like it); the panel loads no client re-diff either, so the hunks it lists are only the ones the journal persisted
//
// Imports are found with the TypeScript parser over the real module graph,
// not by searching text: every static import, re-export, dynamic import()
// and `new URL(…, import.meta.url)` worker entry is followed from the entry
// files through `@/` and relative specifiers. An import that cannot be
// resolved fails the test rather than ending the walk unseen.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../../../..");

const GROUP_WORDS = new Set(["group", "groups", "grouped", "grouping", "regroup", "cluster", "coalesce", "merge"]);
const CHANGE_WORDS = new Set(["hunk", "hunks", "change", "changes", "run", "runs", "edit", "edits", "line", "lines"]);

/**
 * A grouping helper by name, word by camelCase word: a grouping word with
 * a change word (groupIntoHunks, regroupChanges, mergeHunks, changeGroups)
 * or hunks by line. Whole words, so mergeInlineHtmlTags is not one.
 */
function isGrouping(name: string): boolean {
  const words = name.split(/(?<=[a-z0-9])(?=[A-Z])|_/).map((w) => w.toLowerCase());
  const has = (set: Set<string>) => words.some((w) => set.has(w));
  return (has(GROUP_WORDS) && has(CHANGE_WORDS)) || (words.some((w) => w.startsWith("hunk")) && words.includes("by") && words.some((w) => w.startsWith("line")));
}
/** The spike's grouping module, by path. */
const GROUPING_MODULE = /textOps|groupHunks|revert\/lib\//i;
/** Modules that re-derive changes from two texts. */
const REDIFF = ["services/agentJournal/review/canonicalDiff.ts", "services/agentJournal/review/budgetedDiff.ts", "services/agentJournal/review/diffWorker.ts", "services/agentJournal/review/textChanges.ts"];

interface Import {
  from: string;
  specifier: string;
  names: string[];
}

function resolveLocal(from: string, specifier: string): string | null {
  const bare = specifier.split("?")[0];
  let base: string;
  if (bare.startsWith("@/")) base = join(SRC, bare.slice(2));
  else if (bare.startsWith(".")) base = resolve(dirname(from), bare);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (/\.(ts|tsx)$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  if (/\.(css|json|svg|png|md|txt|wasm)$/.test(bare) && existsSync(base)) return "asset";
  throw new Error(`${relative(SRC, from)}: cannot resolve ${specifier}`);
}

function importsOf(file: string): Import[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Import[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names: string[] = [];
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.name) names.push(clause.name.text);
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const e of bindings.elements) names.push(e.name.text, (e.propertyName ?? e.name).getText(sf));
        if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const e of node.exportClause.elements) names.push(e.name.text, (e.propertyName ?? e.name).getText(sf));
      }
      out.push({ from: file, specifier: node.moduleSpecifier.text, names });
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      out.push({ from: file, specifier: node.arguments[0].text, names: [] });
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL" && node.arguments?.[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[1]?.getText(sf) === "import.meta.url") {
      out.push({ from: file, specifier: node.arguments[0].text, names: [] });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every module reachable from `entries`, and every import made along the way. */
function graph(entries: string[]): { modules: Set<string>; imports: Import[] } {
  const modules = new Set<string>();
  const imports: Import[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (modules.has(file)) continue;
    modules.add(file);
    for (const imp of importsOf(file)) {
      imports.push(imp);
      const target = resolveLocal(file, imp.specifier);
      if (target && target !== "asset") queue.push(target);
    }
  }
  return { modules, imports };
}

function groupingImports(imports: Import[]): string[] {
  return imports
    .filter((i) => GROUPING_MODULE.test(i.specifier) || i.names.some(isGrouping))
    .map((i) => `${relative(SRC, i.from)}: ${i.names.join(", ")} from ${i.specifier}`);
}

const PANEL = readdirSync(join(SRC, "components/McpHistory"))
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => join(SRC, "components/McpHistory", f));
const WRITER = [join(SRC, "services/mcpBridge/v2/journaledEdit.ts"), join(SRC, "services/agentJournal/review/declaredScript.ts")];

describe("no hunk grouping on the panel or writer path", () => {
  it("recognizes the grouping helpers it guards against", () => {
    for (const name of ["groupIntoHunks", "groupHunks", "regroupChanges", "mergeHunks", "hunksByLine", "changeGroups", "coalesce_hunks", "GroupedEdits"]) expect(isGrouping(name), name).toBe(true);
    for (const name of ["declaredScriptCertificate", "repairAndMerge", "mergedRuns", "mergeInlineHtmlTags", "groupSpan", "LiveHunk", "hunkLabel", "lineHeight"]) expect(isGrouping(name), name).toBe(false);
  });

  it("the history panel imports no grouping helper and no client re-diff", () => {
    const { modules, imports } = graph(PANEL);
    expect(modules.size).toBeGreaterThan(PANEL.length);
    expect(groupingImports(imports)).toEqual([]);
    expect([...modules].map((m) => relative(SRC, m)).filter((m) => REDIFF.includes(m))).toEqual([]);
  });

  it("the declared-script writer path imports no grouping helper", () => {
    const { modules, imports } = graph(WRITER);
    // The walk really reaches the diff the script is built from.
    expect([...modules].map((m) => relative(SRC, m))).toEqual(expect.arrayContaining(["services/agentJournal/review/budgetedDiff.ts", "services/agentJournal/review/diffWorker.ts"]));
    expect(groupingImports(imports)).toEqual([]);
  });
});
