# biome-seatbelt Real-World Test Report

**Date:** 2026-03-19
**Biome version:** 2.3.13
**Bun version:** (system bun)
**Node version:** (system node 18+)
**Tester:** automated via Claude Code

---

## Test Matrix

Tested both variants against 4 repositories:

| Repo | Files | Violations | Entries | TSV Size | Notes |
|------|-------|------------|---------|----------|-------|
| vercel-mcp-hub | ~6200 TS | 0 | 0 | 82 B | Clean project, no violations |
| biome-benchmark | 3 JS | 0 | 0 | 82 B | Clean, few files |
| next-js/examples | ~240 JS/TS | 2,124 | 1,009 | 72 KB | Medium, 56 rules violated |
| shadcn-ui | ~2800 TS/TSX | 3,874 | 1,414 | 115 KB | Large, 128 MB JSON output |

## Per-Repo Results

### vercel-mcp-hub (clean project, 0 violations)

| Command | Variant A (Bun) | Variant B (Node) |
|---------|-----------------|------------------|
| init | 0.08s, exit 0 | 0.16s, exit 0 |
| check | 0.07s, exit 0 | 0.15s, exit 0 |
| status | 0.07s, exit 0 | 0.16s, exit 0 |
| update | 0.08s, exit 0 | 0.16s, exit 0 |
| check (2nd) | 0.08s, exit 0 | 0.16s, exit 0 |
| Baselines match | Yes | |

Both variants handle clean projects correctly. No issues.

### biome-benchmark (clean, tiny project)

| Command | Variant A (Bun) | Variant B (Node) |
|---------|-----------------|------------------|
| init | 0.06s, exit 0 | 0.20s, exit 0 |
| check | 0.05s, exit 0 | 0.20s, exit 0 |
| status | 0.07s, exit 0 | 0.18s, exit 0 |
| update | 0.08s, exit 0 | 0.21s, exit 0 |
| check (2nd) | 0.07s, exit 0 | 0.20s, exit 0 |
| Baselines match | Yes | |

No issues. Variant A is ~3x faster on tiny projects (Bun startup vs Node).

### next-js/examples (2,124 violations, 56 rules, 747 files)

| Command | Variant A (Bun) | Variant B (Node) |
|---------|-----------------|------------------|
| init | 2.93s, exit 0 | 1.70s, exit 0 |
| check | 2.19s, exit 0 | 1.71s, exit 0 |
| status | 2.16s, exit 0 | 1.73s, exit 0 |
| update | 2.26s, exit 0 | 1.82s, exit 0 |
| check (2nd) | 1.98s, exit 0 | 1.72s, exit 0 |
| Baselines match | **NO** (sorting differs) | |

**Finding:** Baselines differ in sort order. Same entries, different ordering for paths containing hyphens and slashes (e.g., `with-chakra-ui/src/...` sorts before vs after `with-context-api/...`). See Bug #3 below.

**Observation:** Variant B is actually faster than A for medium projects. Likely because `execFileSync` is more efficient than Bun.spawn for capturing large stdout.

### shadcn-ui (3,874 violations, 47 rules, 1,022 files, 128 MB JSON output)

| Command | Variant A (Bun) | Variant B (Node) |
|---------|-----------------|------------------|
| init | 10.44s, exit 0 | **3.51s, exit 1 (CRASH)** |
| check | 8.12s, exit 0 | 1 (no baseline) |
| status | 8.31s, exit 0 | 1 (no baseline) |
| update | 9.89s, exit 0 | 1 (no baseline) |
| check (2nd) | 12.38s, exit 0 | 1 (no baseline) |
| Baselines match | N/A (B never created one) | |

**Finding:** Variant B crashes on `JSON.parse` because the Biome JSON output (128 MB) exceeds the `maxBuffer` of 50 MB set in `execFileSync`. The buffer is silently truncated, producing invalid JSON. See Bug #1 below.

---

## Bugs Found

### Bug #1 (CRITICAL): Variant B maxBuffer overflow on large projects

**Severity:** Critical -- tool fails silently on real-world repos
**Variant:** B (Node)
**Reproduction:**
```bash
cd /tmp/shadcn-ui  # or any project with >50MB of biome JSON output
node biome-seatbelt.mjs init
# Error: "Failed to parse Biome JSON output."
```
**Root cause:** `execFileSync` has `maxBuffer: 50 * 1024 * 1024` (50 MB). The shadcn-ui repo produces 128 MB of JSON. Node silently truncates stdout, producing invalid JSON.
**Fix:** Increase `maxBuffer` to 500 MB or switch to streaming (`spawn` + collect chunks). Alternatively, use `--max-diagnostics` biome flag if available.

### Bug #2 (CRITICAL): Variant A silently swallows biome config errors

**Severity:** Critical -- produces incorrect empty baseline
**Variant:** A (Bun)
**Reproduction:**
```bash
# Create a project with a broken biome.json
echo '{ "linter": { "rules": { "INVALID_RULE": true } } }' > biome.json
echo 'var x;' > test.js
bun run biome-seatbelt.ts init
# Output: "Congratulations! No violations found." (WRONG!)
```
**Root cause:** When biome exits with code 1 due to config errors, it writes errors to stderr only and produces no stdout. Variant A treats empty stdout as "no diagnostics" (clean project) instead of checking stderr for errors.
**Fix:** After running biome, if stdout is empty AND exit code is non-zero, check stderr for error messages and report them. Alternatively, if stdout is empty and exit code != 0, treat it as an error.

### Bug #3 (MEDIUM): Baseline sorting differs between variants

**Severity:** Medium -- causes unnecessary merge conflicts, breaks reproducibility
**Both variants**
**Reproduction:**
```bash
cd /tmp/next-js/examples
bun run biome-seatbelt.ts init --file a.tsv
node biome-seatbelt.mjs init --file b.tsv
diff <(grep -v "^# Generated:" a.tsv) <(grep -v "^# Generated:" b.tsv)
# Shows ordering differences for paths with hyphens vs slashes
```
**Root cause:** Both variants use `localeCompare` for sorting, but they sort at different levels. Variant A sorts `BaselineEntry[]` objects by comparing `file` then `rule`. Variant B sorts `Map` entries where keys are `"file\trule"` and splits on tab before comparing. The actual sort order difference is for paths like `with-chakra-ui/src/...` vs `with-chakra-ui-ts/...` -- the `/` vs `-` comparison differs.
**Fix:** Both variants should use the same sort: compare raw `file\trule` strings with a simple byte-level comparison (`a < b ? -1 : a > b ? 1 : 0`) rather than `localeCompare`. This ensures deterministic output regardless of locale.

### Bug #4 (LOW): Variant A doesn't support --flag=value syntax

**Severity:** Low -- usability issue
**Variant:** A (Bun)
**Reproduction:**
```bash
bun run biome-seatbelt.ts check --file=baseline.tsv
# Error: "Unknown flag: --file=baseline.tsv"
```
**Root cause:** The argument parser in Variant A only handles `--file <value>` (space-separated), not `--file=<value>`.
**Fix:** Add `startsWith("--file=")` handling like Variant B does.

### Bug #5 (LOW): Variant A doesn't support --version flag

**Severity:** Low -- feature parity issue
**Variant:** A (Bun)
**Reproduction:**
```bash
bun run biome-seatbelt.ts --version
# Error: "Unknown flag: --version"
```

### Bug #6 (LOW): Variant A outputs ANSI codes when piped

**Severity:** Low -- breaks output when piped to files or other tools
**Variant:** A (Bun)
**Reproduction:**
```bash
bun run biome-seatbelt.ts status | cat -v
# Shows ^[[1m, ^[[0m etc.
```
**Root cause:** Variant A only checks `NO_COLOR` env var. Variant B also checks `!process.stdout.isTTY`, which auto-disables color when piped.
**Fix:** Add `|| !process.stdout.isTTY` check to Variant A's `NO_COLOR` detection.

---

## Inconsistencies Between Variants (not bugs, but worth aligning)

| Aspect | Variant A (Bun) | Variant B (Node) |
|--------|-----------------|------------------|
| Exit code for unknown command | 1 | 2 |
| Exit code for missing biome | 1 | 127 |
| `update` reports | "X violations remaining" | "X entries remaining" |
| `init` output | "X violations across Y rules in Z files" | "Baseline created: file (X entries)" + "Y total violations..." |
| `check` header | (none) | "biome-seatbelt check" |
| `status` header | "biome-seatbelt status" + separator line | "biome-seatbelt status" |
| `--version` support | No | Yes ("biome-seatbelt 0.1.0") |
| `--flag=value` syntax | No | Yes |
| ANSI in pipes | Yes (bug) | No (correct) |
| Regression display | Grouped by file | Flat list |
| Status shows | Per-rule table with alignment | Grouped by improving/regressed/unchanged |

---

## Performance Observations

| Project Size | Variant A (Bun) | Variant B (Node) | Winner |
|-------------|-----------------|------------------|--------|
| Tiny (0 violations) | ~0.07s | ~0.18s | A (3x) |
| Medium (2,124 violations) | ~2.3s | ~1.7s | B (1.3x) |
| Large (3,874 violations, 128MB JSON) | ~10s | CRASH | A* |

- **Small projects:** Variant A wins due to faster Bun startup
- **Medium projects:** Variant B wins, likely because `execFileSync` is more efficient for large stdout than Bun.spawn + Response streaming
- **Large projects:** Only Variant A works (B crashes on buffer overflow)
- **Dominant cost:** Biome lint itself, not the seatbelt tool. The tool adds < 50ms overhead.

---

## Stability Testing

- **init then check (immediately):** Both variants pass consistently. Exit 0.
- **init then check then check:** Stable, no flakes observed.
- **init then update then check:** Stable across both variants.
- **Deterministic output:** TSV content is identical between runs of the same variant. But differs between A and B due to Bug #3.

---

## Edge Cases Tested

| Scenario | Variant A | Variant B | Notes |
|----------|-----------|-----------|-------|
| No violations (clean project) | PASS | PASS | |
| No JS/TS files at all | PASS | PASS | Empty baseline created |
| Missing baseline file | PASS | PASS | Clear error message |
| Missing biome binary | PASS | PASS | Different exit codes (1 vs 127) |
| Broken biome.json | **FAIL** (silent empty baseline) | PASS (error reported) | Bug #2 |
| 128 MB JSON output | PASS | **FAIL** (buffer overflow) | Bug #1 |
| Deeply nested file paths | PASS | PASS | |
| --frozen env var | PASS | PASS | |
| --severity info | PASS | PASS | |
| --severity error | PASS | PASS | |
| -- biome args forwarding | PASS | PASS | |
| Regression detection | PASS | PASS | |
| Update ratcheting | PASS | PASS | Only tightens, never loosens |
| Nested biome.json configs | **FAIL** (silent) | PASS (error) | Same as Bug #2 |

---

## Recommendations

### P0 (Must fix before any release)

1. **Variant B:** Increase `maxBuffer` to at least 500 MB, or better, switch to `child_process.spawn` with streaming stdout collection (like Variant A does with `Bun.spawn`). Real-world repos easily produce 100+ MB of JSON.

2. **Variant A:** When biome exits non-zero and stdout is empty, check stderr and report the error instead of creating an empty baseline. The current behavior is dangerous -- users think their project is clean when biome actually had a fatal config error.

### P1 (Should fix)

3. **Both variants:** Normalize the sort algorithm to use byte-level string comparison instead of `localeCompare`. This ensures baselines are identical regardless of which variant generated them, and avoids locale-dependent ordering.

4. **Variant A:** Add `!process.stdout.isTTY` to color detection so ANSI codes are suppressed when piped.

### P2 (Nice to have)

5. **Variant A:** Add `--flag=value` syntax support for all flags.
6. **Variant A:** Add `--version` flag.
7. **Both:** Align exit codes (suggest: 0=success, 1=regressions found, 2=user error, 127=biome not found).
8. **Both:** Align output format and phrasing (especially "violations remaining" vs "entries remaining").
9. **Both:** Consider adding `--max-diagnostics N` passthrough to biome to limit JSON output size for huge repos.

---

## Raw Test Data

Full test output saved in `/tmp/seatbelt-results/`:
- `summary.csv` -- timing data for all runs
- `*/A-*.txt` and `*/B-*.txt` -- captured stdout/stderr per command
- `*/baseline-diff.txt` -- diff between variant baselines
