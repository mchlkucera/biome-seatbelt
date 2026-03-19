# biome-seatbelt

Gradually tighten Biome lint rules across your codebase. Like [eslint-seatbelt](https://github.com/justjake/eslint-seatbelt), but for Biome.

You want to enable a strict lint rule, but there are 500 existing violations. You can't fix them all at once, and you can't leave the rule off. biome-seatbelt snapshots current violations as a baseline, blocks any commit that adds new ones, and auto-tightens when developers fix existing ones. The codebase can only get better, never worse.

Zero dependencies. Node.js 18+.

## Quick start

```bash
npm install --save-dev biome-seatbelt

biome-seatbelt init       # snapshot current violations
biome-seatbelt check      # block regressions (CI command)
biome-seatbelt update     # tighten after fixing violations
```

Commit `biome-seatbelt.tsv` to your repo.

## How it works

1. **init** runs `biome lint --reporter=json` and counts violations per file per rule. Writes the counts to a TSV baseline file.
2. **check** compares current violations against the baseline. If any file+rule count increased or a new violation appeared, it exits 1.
3. **update** ratchets the baseline down. If you fixed violations, the new lower count becomes the ceiling. It never loosens -- if violations increased, the old baseline count is kept.
4. **status** shows a progress report: totals, per-rule deltas, improving and stuck rules.

## Commands

### `biome-seatbelt init`

Create the initial baseline from current state.

```bash
biome-seatbelt init
biome-seatbelt init --verbose           # show per-rule breakdown
biome-seatbelt init --severity error    # only track errors
biome-seatbelt init --update            # add new violations to existing baseline
```

### `biome-seatbelt check`

Verify no new violations were introduced. This is your CI and pre-push command.

```bash
biome-seatbelt check
biome-seatbelt check --json             # structured output for tooling
biome-seatbelt check -- --changed       # only lint changed files
```

Exits 0 if all counts are equal or lower. Exits 1 if any regression or new violation is found.

In CI environments (`CI=1`), running `biome-seatbelt` with no command defaults to `check`.

### `biome-seatbelt update`

Tighten the baseline after fixing violations.

```bash
biome-seatbelt update
```

Output: `Tightened X entries, removed Y resolved entries`.

Only ratchets down. If violations increased for a file+rule pair, the baseline count is preserved.

### `biome-seatbelt status`

Human-readable progress report.

```bash
biome-seatbelt status
biome-seatbelt status --verbose    # include unchanged rules
```

Shows baseline vs current totals, per-rule deltas, and percentage progress.

## CI setup

Add to your GitHub Actions workflow:

```yaml
- name: Lint baseline check
  run: npx biome-seatbelt check
```

Or rely on `CI` auto-detection (no command needed):

```yaml
- name: Lint baseline check
  run: npx biome-seatbelt
```

## Git hooks

Auto-run `update` on every commit so the baseline tightens as developers fix violations.

### Husky

```bash
# .husky/pre-commit
npx biome-seatbelt update
git add biome-seatbelt.tsv
```

### Lefthook

```yaml
# lefthook.yml
pre-commit:
  commands:
    biome-seatbelt:
      run: npx biome-seatbelt update && git add biome-seatbelt.tsv
```

### lint-staged

```json
{
  "*.{ts,tsx,js,jsx}": [
    "npx biome-seatbelt update",
    "git add biome-seatbelt.tsv"
  ]
}
```

## For AI agents

Add to your project's `CLAUDE.md` (or equivalent agent instructions):

```markdown
## Lint baseline

This project uses biome-seatbelt to ratchet lint violations.

- After fixing lint issues, run `npx biome-seatbelt update` and commit the updated `biome-seatbelt.tsv`.
- Before committing, run `npx biome-seatbelt check` to verify no regressions.
- Never manually edit `biome-seatbelt.tsv`.
```

Use `--json` for structured output that agents can parse:

```bash
npx biome-seatbelt check --json
```

```json
{
  "status": "fail",
  "command": "check",
  "regressions": [
    { "file": "src/foo.ts", "rule": "lint/complexity/noForEach", "baseline": 2, "current": 3, "delta": 1 }
  ],
  "newViolations": [],
  "improvements": [],
  "summary": { "baselineTotal": 120, "currentTotal": 121, "delta": 1 }
}
```

```bash
npx biome-seatbelt status --json
```

```json
{
  "status": "ok",
  "command": "status",
  "summary": { "baselineTotal": 120, "currentTotal": 95, "delta": -25 },
  "rules": [
    { "rule": "lint/complexity/noForEach", "baseline": 40, "current": 30, "delta": -10 }
  ],
  "files": { "baseline": 15, "current": 12 }
}
```

## CLI reference

```
biome-seatbelt <command> [flags] [-- <biome args>]
```

### Commands

| Command  | Description                              |
|----------|------------------------------------------|
| `init`   | Create initial baseline                  |
| `check`  | Verify no regressions (CI command)       |
| `update` | Tighten baseline after fixes             |
| `status` | Show progress report                     |

### Flags

| Flag                  | Description                                           |
|-----------------------|-------------------------------------------------------|
| `--file <path>`       | Baseline file path (default: `biome-seatbelt.tsv`)    |
| `--frozen`            | Alias for `check` (eslint-seatbelt compat)            |
| `--verbose`           | Show per-file details                                 |
| `--json`              | Output structured JSON for tooling/agents             |
| `--severity <level>`  | Minimum severity: `error`, `warning`, `info` (default: `warning`) |
| `--biome-bin <path>`  | Path to biome binary (default: `biome`)               |
| `--update`            | With `init`: add new violations without resetting existing entries |
| `-- <args>`           | Forward remaining args to `biome lint`                |

### Environment variables

| Variable                   | Equivalent flag   |
|----------------------------|-------------------|
| `CI=1`                     | Auto-run `check` when no command given |
| `BIOME_SEATBELT_FILE`     | `--file`          |
| `BIOME_SEATBELT_FROZEN=1` | `--frozen`        |
| `BIOME_SEATBELT_SEVERITY` | `--severity`      |
| `BIOME_SEATBELT_BIOME_BIN`| `--biome-bin`     |
| `NO_COLOR`                 | Disable colored output |

## Baseline file format

The baseline is a tab-separated file with one entry per file+rule pair:

```tsv
# biome-seatbelt baseline
# Generated: 2026-03-18T12:00:00Z
# file	rule	count
src/components/Button.tsx	lint/complexity/noForEach	2
src/utils/parse.ts	lint/suspicious/noExplicitAny	5
src/utils/parse.ts	lint/style/useConst	1
```

Design choices:
- **TSV over JSON** -- one entry per line means merge conflicts are rare and easy to resolve. When they do happen, re-run `biome-seatbelt update` after the merge.
- **Sorted deterministically** -- by file path, then rule name. Minimal diffs.
- **Zero-count entries removed** -- fully resolved rules disappear from the file.
- **Comment lines preserved** -- lines starting with `#` are kept.

### Handling merge conflicts

If the baseline file conflicts during a merge:

```bash
git checkout --theirs biome-seatbelt.tsv   # or --ours, doesn't matter
npx biome-seatbelt update                  # regenerates correct counts
git add biome-seatbelt.tsv
```

## Inspired by

- [eslint-seatbelt](https://github.com/justjake/eslint-seatbelt) by Jake Lazaroff (Notion)
- [Notion's blog post](https://www.notion.com/blog/linting-at-notion) on gradually adopting lint rules at scale

## License

MIT
