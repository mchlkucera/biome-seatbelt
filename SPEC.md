# biome-seatbelt — Specification

## What This Is

A ratcheting tool for [Biome](https://biomejs.dev) that gradually tightens lint rules across a codebase. Inspired by Notion's [eslint-seatbelt](https://github.com/justjake/eslint-seatbelt).

**Problem:** You want to enable a strict Biome rule on a large codebase, but there are 500 existing violations. You can't fix them all at once, and you can't leave the rule off.

**Solution:** Snapshot current violations as a baseline. Block any commit that adds new violations. Auto-tighten the baseline when developers fix existing ones. The codebase can only get better, never worse.

## Biome JSON Reporter Format

Biome's `--reporter=json` outputs:

```json
{
  "summary": { "errors": 0, "warnings": 123, "infos": 35 },
  "diagnostics": [
    {
      "category": "lint/complexity/useLiteralKeys",
      "severity": "warning",
      "location": { "path": { "file": "src/foo.ts" }, "span": [100, 200] }
    }
  ],
  "command": "lint"
}
```

Key fields we use:
- `diagnostics[].category` → the rule ID (e.g. `lint/complexity/useLiteralKeys`)
- `diagnostics[].severity` → `"error"`, `"warning"`, or `"information"`
- `diagnostics[].location.path.file` → relative file path

**Note:** The JSON reporter is marked experimental. We must handle format changes gracefully.

## Baseline File Format

Tab-separated values, same design as eslint-seatbelt (for good reason — see Notion's blog on why TSV beats JSON for merge conflicts).

```tsv
# biome-seatbelt baseline
# Generated: 2026-03-18T12:00:00Z
# file	rule	count
src/components/Button.tsx	lint/complexity/noForEach	2
src/utils/parse.ts	lint/suspicious/noExplicitAny	5
src/utils/parse.ts	lint/style/useConst	1
```

Rules:
- Tab-separated: `file<TAB>rule<TAB>count`
- Sorted by file path, then rule name (deterministic output, minimal diffs)
- Lines starting with `#` are comments, preserved on read/write
- Zero-count entries are removed (rule is fully resolved)
- File paths are relative to project root, as Biome reports them

## Commands

### `biome-seatbelt init`

Create the initial baseline from current state.

1. Run `biome lint --reporter=json`
2. Aggregate: count violations per file per rule
3. Write `biome-seatbelt.tsv`
4. Exit 0

### `biome-seatbelt check`

Check if current violations exceed baseline. **This is the CI command.**

1. Run `biome lint --reporter=json`
2. Load baseline from `biome-seatbelt.tsv`
3. Compare current vs baseline
4. If any file+rule count **increased** → print regressions, exit 1
5. If any file+rule is **new** (not in baseline) → print new violations, exit 1
6. If all counts are equal or lower → exit 0
7. Print summary: `X regressions found` or `All clear, Y violations remaining (Z improved)`

### `biome-seatbelt update`

Tighten the baseline to current state. **This is the post-fix command.**

1. Run `biome lint --reporter=json`
2. Load baseline from `biome-seatbelt.tsv`
3. For each file+rule:
   - If current < baseline → update to current (ratchet down)
   - If current == baseline → keep
   - If current > baseline → **keep baseline** (don't allow loosening via update)
   - If current == 0 → remove entry
4. Write updated `biome-seatbelt.tsv`
5. Print summary: `Tightened X entries, removed Y resolved entries`

### `biome-seatbelt status`

Human-readable progress report.

1. Run `biome lint --reporter=json`
2. Load baseline from `biome-seatbelt.tsv`
3. Print:
   - Total violations: current vs baseline
   - Per-rule breakdown: rule name, baseline count, current count, delta
   - Top improving rules, stuck rules
4. Exit 0

## CLI Flags

```
--file <path>       Baseline file path (default: biome-seatbelt.tsv)
--frozen            Alias for `check` (for CI compat with eslint-seatbelt)
--verbose           Show per-file details
--severity <level>  Minimum severity to track: error, warning, info (default: warning)
--biome-bin <path>  Path to biome binary (default: biome)
-- <args>           Forward remaining args to biome lint
```

## Environment Variables

```
BIOME_SEATBELT_FILE=<path>        Same as --file
BIOME_SEATBELT_FROZEN=1           Same as --frozen
BIOME_SEATBELT_SEVERITY=<level>   Same as --severity
BIOME_SEATBELT_BIOME_BIN=<path>   Same as --biome-bin
```

## Edge Cases & Failure Modes

### From Notion's experience:
1. **Merge conflicts in baseline** — TSV format with one entry per line minimizes this. Sorting is deterministic. In case of conflict: re-run `update` after merge.
2. **File renames** — old path disappears, new path appears. `update` handles this naturally (old entry removed, new entry added or absent).
3. **Rule renames** — same as file renames. Old rule entry stays in baseline until manually cleaned or until `update` removes zero-count entries.
4. **Parallel linting** — not a concern for us since we run biome as a subprocess (it handles its own parallelism).
5. **Biome config changes** — changing rule severity or enabling new rules changes violation counts. User should run `init` or `update` after config changes.

### Technical:
6. **Biome not installed** — detect early, clear error message with install instructions.
7. **Biome exits non-zero** — biome returns exit code 1 when it finds diagnostics. We must not treat this as a failure. Parse stdout regardless of exit code.
8. **Empty project** — no diagnostics → empty baseline. Valid state.
9. **No baseline file** — `check` should fail with "No baseline found. Run `biome-seatbelt init` first."
10. **JSON reporter format changes** — validate expected structure, fail with clear error if shape changes.
11. **Huge baselines** — thousands of entries. TSV is line-oriented, so streaming read/write is possible but likely unnecessary for v1.
12. **Path normalization** — Biome reports paths relative to CWD. Baseline must use same convention. No absolute paths.

## What We're Building (Variants)

### Variant A: Single-file Bun script
- One `biome-seatbelt.ts` file
- Run with `bun run biome-seatbelt.ts <command>`
- Zero dependencies
- Fastest to build and test

### Variant B: Node.js CLI package
- Proper `package.json` with bin entry
- Publishable to npm
- Uses only Node.js built-ins (no deps)
- `npx biome-seatbelt <command>`

### Variant C: Deno single-file
- One `biome-seatbelt.ts` file
- Run with `deno run --allow-run --allow-read --allow-write biome-seatbelt.ts`
- Zero dependencies, different runtime

## Testing Strategy

### Unit tests (all variants):
- TSV parse/write roundtrip
- Diff engine: regressions detected, improvements detected, new violations detected
- Edge cases: empty baseline, missing baseline, zero-count removal

### Integration tests:
- Run against this project (vercel-mcp-hub) — it has real Biome violations
- Run `init` → verify TSV is correct
- Run `check` → should pass (baseline matches)
- Manually add a violation → run `check` → should fail
- Fix a violation → run `update` → baseline should tighten
- Run `status` → should show accurate report

### Stress test:
- Generate a large TSV (10k entries) → verify performance is acceptable
- Run on a project with many violations → verify output is readable

## Success Criteria

1. `init` creates accurate baseline from any Biome project
2. `check` catches regressions with zero false positives
3. `update` only tightens, never loosens
4. Output is clear and actionable
5. Works on macOS and Linux
6. Zero runtime dependencies
