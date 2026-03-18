# biome-seatbelt (Variant A: Bun single-file)

A ratcheting tool for [Biome](https://biomejs.dev) lint. Gradually tighten lint rules across a codebase — violations can only go down, never up.

Zero dependencies. Single TypeScript file. Runs with Bun.

## Quick Start

```bash
# Make it executable (optional)
chmod +x biome-seatbelt.ts

# Create initial baseline from current violations
bun run biome-seatbelt.ts init

# Check for regressions (use in CI)
bun run biome-seatbelt.ts check

# After fixing violations, tighten the baseline
bun run biome-seatbelt.ts update

# See progress report
bun run biome-seatbelt.ts status
```

## Commands

### `init`

Runs Biome lint, counts violations per file per rule, writes `biome-seatbelt.tsv`.

```bash
bun run biome-seatbelt.ts init
# Baseline created: biome-seatbelt.tsv
#   158 violations across 12 rules in 43 files
```

### `check`

Compares current violations against baseline. Exits 1 if any file+rule count increased or a new violation appeared. This is your CI gate.

```bash
bun run biome-seatbelt.ts check
# All clear! No regressions found.
#   158 violations remaining

bun run biome-seatbelt.ts check --verbose
# Also shows improvements and resolved entries
```

### `update`

Ratchets the baseline down to current state. Only tightens — never loosens. If you introduced new violations, they are not added (use `init` to reset).

```bash
bun run biome-seatbelt.ts update
# Baseline updated: biome-seatbelt.tsv
#   Tightened 3 entries
#   Removed 1 resolved entries
#   154 violations remaining
```

### `status`

Human-readable progress report with per-rule breakdown.

```bash
bun run biome-seatbelt.ts status
# biome-seatbelt status
# ──────────────────────────────────────────────────
#   Baseline:  158 violations
#   Current:   142 violations
#   Delta:     -16 (improving)
#
# Per-rule breakdown:
#   rule                                          base    now   delta
#   lint/suspicious/noExplicitAny                   45     32     -13
#   lint/complexity/noForEach                       20     18      -2
#   ...
```

## Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--file <path>` | Baseline file path | `biome-seatbelt.tsv` |
| `--frozen` | Alias for `check` (eslint-seatbelt compat) | - |
| `--verbose` | Show per-file details | off |
| `--severity <level>` | Minimum severity: `error`, `warning`, `info` | `warning` |
| `--biome-bin <path>` | Path to biome binary | `biome` |
| `-- <args>` | Forward remaining args to `biome lint` | - |

## Environment Variables

| Variable | Same as |
|----------|---------|
| `BIOME_SEATBELT_FILE` | `--file` |
| `BIOME_SEATBELT_FROZEN=1` | `--frozen` |
| `BIOME_SEATBELT_SEVERITY` | `--severity` |
| `BIOME_SEATBELT_BIOME_BIN` | `--biome-bin` |
| `NO_COLOR` | Disable colored output |

## CI Integration

### GitHub Actions

```yaml
- name: Lint ratchet check
  run: bun run biome-seatbelt.ts check
```

### Pre-push hook

```bash
#!/bin/sh
bun run biome-seatbelt.ts check
```

### Forward args to Biome

Only check changed files:

```bash
bun run biome-seatbelt.ts check -- --changed
```

## Baseline Format

Tab-separated values (TSV), one entry per line, sorted deterministically. Designed for minimal merge conflicts.

```tsv
# biome-seatbelt baseline
# Generated: 2026-03-18T12:00:00Z
# file	rule	count
src/components/Button.tsx	lint/complexity/noForEach	2
src/utils/parse.ts	lint/suspicious/noExplicitAny	5
```

Commit this file to your repo. After merge conflicts, re-run `biome-seatbelt update`.

## How It Works

1. **init** snapshots all current violations as the allowed maximum
2. **check** fails if any file+rule pair exceeds its baseline count
3. **update** ratchets down — if you fixed 3 violations, the new allowed max drops by 3
4. The codebase can only get better, never worse
