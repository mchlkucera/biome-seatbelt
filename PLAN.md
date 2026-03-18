# biome-seatbelt — Plan

## Outcome

A ratcheting tool for Biome that gradually tightens lint rules across a codebase.

**What it does:**
- Runs `biome lint --reporter=json`, parses structured output
- Maintains a TSV baseline file tracking allowed violation counts per file per rule
- Blocks commits/CI when any count increases
- Auto-tightens counts when developers fix violations
- Bootstraps from an existing codebase (snapshot current state as baseline)
- Reports progress (delta from baseline, rules improving/stuck)

**What success looks like:** Run `biome-seatbelt check` on a codebase with Biome configured, and it tells you if you made things worse. Run `biome-seatbelt update` and it tightens the ratchet.

---

## Approach: Two variants, pick the winner

### Variant 1: Single-file Bun script (`biome-seatbelt.ts`)

One TypeScript file, zero dependencies, run with `bun run biome-seatbelt.ts`.
Fastest path to a working prototype. If it works well, becomes the core of Variant 2.

### Variant 2: npm CLI package

Proper `package.json`, bin entry, publishable to npm as `biome-seatbelt`.
Built on top of whatever works from Variant 1.

We start with Variant 1. If the core logic is solid, wrapping it as Variant 2 is trivial.

---

## TSV Baseline Format

Same format as eslint-seatbelt for familiarity:

```
# biome-seatbelt baseline — do not edit manually
# file	rule	count
src/components/Button.tsx	lint/complexity/noForEach	2
src/utils/parse.ts	lint/suspicious/noExplicitAny	5
src/utils/parse.ts	lint/style/useConst	1
```

Tab-separated. Sorted by file, then rule. Minimal merge conflicts.

---

## Commands

```
biome-seatbelt init          # Run biome lint, snapshot all violations as baseline
biome-seatbelt check         # Run biome lint, fail if any count exceeds baseline
biome-seatbelt update        # Run biome lint, tighten baseline to current counts (ratchet down)
biome-seatbelt status        # Show summary: total violations, delta from baseline, top rules
```

### Environment variables

- `BIOME_SEATBELT_FILE` — custom path to baseline file (default: `biome-seatbelt.tsv`)
- `BIOME_SEATBELT_FROZEN=1` — same as `check`, for CI
- `BIOME_SEATBELT_BIOME_BIN` — custom path to biome binary

---

## Implementation Steps

### Step 1: Parse Biome JSON output

- Run `biome lint --reporter=json` and capture stdout
- Parse the JSON structure into `Map<file, Map<rule, count>>`
- Handle: biome not installed, no files matched, biome config errors

### Step 2: TSV baseline read/write

- Read TSV into same `Map<file, Map<rule, count>>` structure
- Write map back to sorted TSV
- Handle: file doesn't exist yet (first run)

### Step 3: Diff engine

- Compare current violations against baseline
- Produce a diff: new violations, reduced violations, removed files
- This is the core logic everything else depends on

### Step 4: Commands

- `init` — run biome, write baseline from current state
- `check` — run biome, diff against baseline, exit 1 if regressions
- `update` — run biome, tighten baseline (only decrease counts, never increase)
- `status` — run biome, print human-readable summary

### Step 5: CLI argument parsing

- Minimal arg parsing (no libraries for Variant 1, maybe `commander` for Variant 2)
- Support `--file`, `--frozen`, `--verbose` flags
- Forward unknown flags to `biome lint`

### Step 6: Output formatting

- Clear, colorized terminal output
- Show exactly which files/rules regressed on `check` failure
- Show progress stats on `status`

---

## Later (not in prototype)

- GitHub Action wrapper
- Git hook integration (husky/lefthook recipe in README)
- VS Code problem matcher
- `--json` output mode for tooling
- Auto-commit tightened baseline
- Per-directory or per-team baselines
- Biome plugin (when plugin system stabilizes)
