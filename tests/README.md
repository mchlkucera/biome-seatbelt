# biome-seatbelt test harness

Variant-agnostic test suite for biome-seatbelt. Pass any implementation as a command prefix and the same 14 tests run against it.

## Prerequisites

- `biome` must be in PATH (tests skip gracefully if missing)
- bash 4+ (macOS ships bash 3 but the script avoids bash 4-only features)

## Usage

```bash
# Test the Bun variant
./tests/run-tests.sh "bun run variants/a-bun/biome-seatbelt.ts"

# Test the Node variant
./tests/run-tests.sh "node variants/b-node/biome-seatbelt.js"

# Test the Deno variant
./tests/run-tests.sh "deno run --allow-run --allow-read --allow-write variants/c-deno/biome-seatbelt.ts"

# Test an installed binary
./tests/run-tests.sh "biome-seatbelt"
```

The command prefix is resolved relative to the project root. Absolute paths also work.

## Test scenarios

### Core functionality (1-9)

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | init creates baseline | `biome-seatbelt.tsv` exists after `init` |
| 2 | baseline is correct | All file+rule+count entries match expected values |
| 3 | check passes on match | `check` exits 0 when violations equal baseline |
| 4 | check catches new violation | `check` exits 1 when a violation is added to existing file |
| 5 | check catches new file | `check` exits 1 when a new file with violations appears |
| 6 | update tightens | Fixing a violation reduces the baseline count |
| 7 | update won't loosen | Adding violations does not increase baseline counts |
| 8 | update removes zeros | Fully fixing a file removes its entries from baseline |
| 9 | status shows output | `status` prints human-readable violation info |

### Edge cases (10-14)

| # | Test | What it verifies |
|---|------|-----------------|
| 10 | no baseline | `check` fails with a message when no baseline exists |
| 11 | empty project | `init` works when there are zero violations |
| 12 | deleted file | `check` handles files disappearing between init and check |
| 13 | deterministic sort | Running `init` twice produces identical data lines |
| 14 | idempotent update | Running `update` 5 times without changes preserves baseline |

## Fixture

`tests/fixture/` contains a minimal Biome project:

- `biome.json` — enables 4 rules (noConsole, useConst, noNonNullAssertion, useLiteralKeys), recommended rules disabled
- `src/good.ts` — clean file, zero violations
- `src/bad.ts` — 7 violations across 4 rules
- `src/mixed.ts` — 2 violations across 2 rules

Each test copies the fixture into a fresh temp directory, so tests are fully isolated.

## Exit codes

- `0` — all tests passed
- `1` — one or more tests failed
- `2` — usage error (no command prefix provided)
