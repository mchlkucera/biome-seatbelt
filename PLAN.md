# biome-seatbelt — Production Merge Plan

## Decision: One variant, Node.js base

Merging Variant B (Node.js) as the production version at repo root, with fixes from Variant A's strengths. Node.js wins on portability — every JS project already has it.

## Changes to make

### P0: Critical bug fixes

1. **Streaming stdout** — Replace `execFileSync` with `child_process.spawn` + chunk collection. Removes the 50MB buffer limit that crashed on shadcn-ui (128MB JSON). Take the pattern from Variant A's `Bun.spawn` approach.

2. **Config error detection** — When biome exits non-zero AND stdout is empty/unparseable, read stderr and surface the error. Never create an empty baseline silently. Both variants had this wrong in different ways.

3. **Byte-level sort** — Replace `localeCompare` with `a < b ? -1 : a > b ? 1 : 0` for TSV sorting. Deterministic regardless of locale. Both variants must produce identical baselines.

### P1: Integration features (the real value)

4. **`CI=1` auto-detection** — If `CI` env var is set and no command given, default to `check`. This means CI pipelines just run `biome-seatbelt` with no args.

5. **`--json` output mode** — Structured JSON output for agents. Format:
   ```json
   { "status": "fail", "regressions": [...], "improvements": [...], "summary": { "total": N, "delta": N } }
   ```

6. **`init --update` flag** — Add new violations to existing baseline without resetting existing entries. For when you enable a new rule mid-project.

### P2: Distribution & docs

7. **package.json at root** — Proper npm package with bin entry, description, keywords, repository URL.

8. **README.md** — Two sections: "For humans" (hook recipes for husky, lefthook, lint-staged) and "For agents" (CLAUDE.md snippet, --json usage).

9. **Move variants to `variants/` (archive)** — Keep for reference, production is root `biome-seatbelt.mjs`.

### P3: Test updates

10. **Update test harness** — Point tests at root `biome-seatbelt.mjs`, add tests for new features (CI=1, --json, init --update, large output handling, config error detection).

## Execution order

Steps 1-3 in parallel (independent bug fixes in the same file).
Then 4-6 (features building on fixed base).
Then 7-9 (packaging).
Then 10 (verify everything).
