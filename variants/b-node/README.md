# biome-seatbelt

Ratcheting baseline tool for [Biome](https://biomejs.dev) lint. Your codebase can only get better, never worse.

Inspired by Notion's [eslint-seatbelt](https://github.com/justjake/eslint-seatbelt).

## Problem

You want to enable a strict Biome rule on a large codebase, but there are 500 existing violations. You can't fix them all at once, and you can't leave the rule off.

## Solution

Snapshot current violations as a baseline. Block any commit that adds new violations. Auto-tighten the baseline when developers fix existing ones.

## Quick Start

```bash
# Create baseline from current state
npx biome-seatbelt init

# Check for regressions (CI)
npx biome-seatbelt check

# After fixing violations, tighten the baseline
npx biome-seatbelt update

# See progress report
npx biome-seatbelt status
```

## Installation

```bash
# Use directly with npx (no install needed)
npx biome-seatbelt init

# Or install globally
npm install -g biome-seatbelt

# Or as a dev dependency
npm install --save-dev biome-seatbelt
```

**Requirements:** Node.js 18+ and [Biome](https://biomejs.dev) installed in your project.

## Commands

### `biome-seatbelt init`

Create the initial baseline from current violations. Runs `biome lint --reporter=json`, aggregates violations per file per rule, and writes `biome-seatbelt.tsv`.

### `biome-seatbelt check`

CI command. Compares current violations against the baseline. Exits with code 1 if any file+rule count increased or if new violations appeared. Exits 0 if all counts are equal or lower.

### `biome-seatbelt update`

Post-fix command. Ratchets the baseline down to match current state. Only tightens, never loosens -- if a count increased, the baseline value is kept.

### `biome-seatbelt status`

Human-readable progress report showing total violations (current vs baseline), per-rule breakdown with deltas, and improvement percentage.

## Flags

```
--file <path>       Baseline file path (default: biome-seatbelt.tsv)
--frozen            Alias for `check` (eslint-seatbelt compat)
--verbose           Show per-file details
--severity <level>  Min severity to track: error, warning, info (default: warning)
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

## Baseline Format

Tab-separated values for minimal merge conflicts:

```tsv
# biome-seatbelt baseline
# Generated: 2026-03-18T12:00:00Z
# file	rule	count
src/components/Button.tsx	lint/complexity/noForEach	2
src/utils/parse.ts	lint/suspicious/noExplicitAny	5
```

Commit this file to your repo. Sorting is deterministic (file path, then rule name).

## CI Integration

Add to your CI pipeline:

```yaml
# GitHub Actions
- name: Lint baseline check
  run: npx biome-seatbelt check
```

```bash
# Pre-push hook
biome-seatbelt check
```

## Workflow

1. Enable a new Biome rule (or tighten existing ones)
2. Run `biome-seatbelt init` to snapshot current violations
3. Commit `biome-seatbelt.tsv` to your repo
4. Add `biome-seatbelt check` to CI
5. When developers fix violations, run `biome-seatbelt update` and commit the updated baseline
6. Repeat until the rule is fully clean

## Zero Dependencies

This package uses only Node.js built-in modules (`child_process`, `fs`, `path`). No runtime dependencies.

## License

MIT
