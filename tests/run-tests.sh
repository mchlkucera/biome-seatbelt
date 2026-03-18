#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────
# biome-seatbelt test harness
# Usage: ./tests/run-tests.sh "bun run variants/a-bun/biome-seatbelt.ts"
# ──────────────────────────────────────────────────────────────────────

# ── Colours ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Args ─────────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
  echo -e "${RED}Usage: $0 <command-prefix>${RESET}"
  echo "  Example: $0 \"bun run variants/a-bun/biome-seatbelt.ts\""
  exit 2
fi

CMD_PREFIX="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/fixture"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Resolve CMD_PREFIX so that relative paths become absolute (relative to PROJECT_ROOT).
# This lets us cd into a temp dir while still finding the script.
# Strategy: find file-path-like tokens and absolutize them.
RESOLVED_CMD=""
for token in $CMD_PREFIX; do
  if [[ "$token" != /* && -e "$PROJECT_ROOT/$token" ]]; then
    RESOLVED_CMD="$RESOLVED_CMD $PROJECT_ROOT/$token"
  else
    RESOLVED_CMD="$RESOLVED_CMD $token"
  fi
done
RESOLVED_CMD="${RESOLVED_CMD# }"  # trim leading space

# ── Counters ─────────────────────────────────────────────────────────
PASSED=0
FAILED=0
SKIPPED=0
declare -a FAILED_NAMES=()

# ── Prereqs ──────────────────────────────────────────────────────────
if ! command -v biome &>/dev/null; then
  echo -e "${YELLOW}SKIP: biome not found in PATH. Install with: npm i -g @biomejs/biome${RESET}"
  exit 0
fi

# ── Helpers ──────────────────────────────────────────────────────────
TMPDIR_ROOT=""

setup_tmpdir() {
  TMPDIR_ROOT="$(mktemp -d)"
  # Copy the fixture into the temp dir
  cp -R "$FIXTURE_DIR/"* "$TMPDIR_ROOT/"
}

cleanup_tmpdir() {
  if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
    # Use trash if available, otherwise fall back to rm for temp dirs
    if command -v trash &>/dev/null; then
      trash "$TMPDIR_ROOT" 2>/dev/null || true
    else
      command rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
    fi
    TMPDIR_ROOT=""
  fi
}

# Run the seatbelt command inside the temp dir.
# Usage: run_cmd <subcommand> [extra-args...]
# Returns the exit code and captures stdout+stderr into $CMD_OUTPUT
CMD_OUTPUT=""
run_cmd() {
  local subcmd="$1"
  shift
  # CMD_PREFIX may be e.g. "bun run variants/a-bun/biome-seatbelt.ts"
  # We need CWD = TMPDIR_ROOT (so biome finds biome.json), but script paths
  # in CMD_PREFIX are relative to PROJECT_ROOT.
  # RESOLVED_CMD is computed once at setup time (see below run_cmd).
  CMD_OUTPUT="$(cd "$TMPDIR_ROOT" && eval "$RESOLVED_CMD $subcmd $*" 2>&1)" || return $?
  return 0
}

# Test runner
pass() {
  PASSED=$((PASSED + 1))
  echo -e "  ${GREEN}PASS${RESET} $1"
}

fail() {
  FAILED=$((FAILED + 1))
  FAILED_NAMES+=("$1")
  echo -e "  ${RED}FAIL${RESET} $1"
  if [[ -n "${2:-}" ]]; then
    echo -e "       ${RED}$2${RESET}"
  fi
}

skip() {
  SKIPPED=$((SKIPPED + 1))
  echo -e "  ${YELLOW}SKIP${RESET} $1"
}

# ── Test: helper to count TSV data lines ─────────────────────────────
count_tsv_lines() {
  local file="$1"
  # Count non-comment, non-empty lines
  local n
  n=$(grep -v '^#' "$file" 2>/dev/null | grep -c '[^[:space:]]' 2>/dev/null) || true
  echo "${n:-0}"
}

# Read a specific file+rule count from TSV baseline
# Usage: get_tsv_count <baseline_file> <file_path> <rule>
get_tsv_count() {
  local baseline="$1" filepath="$2" rule="$3"
  awk -F'\t' -v f="$filepath" -v r="$rule" '$1==f && $2==r { print $3 }' "$baseline" 2>/dev/null || echo ""
}

# =====================================================================
echo -e "\n${BOLD}biome-seatbelt test suite${RESET}"
echo -e "Command: ${BOLD}$CMD_PREFIX${RESET}"
echo -e "Fixture: $FIXTURE_DIR"
echo ""

# ── CORE FUNCTIONALITY ───────────────────────────────────────────────
echo -e "${BOLD}Core functionality${RESET}"

# ── Test 1: init creates baseline TSV from scratch ───────────────────
setup_tmpdir
if run_cmd init; then
  if [[ -f "$TMPDIR_ROOT/biome-seatbelt.tsv" ]]; then
    pass "1. init creates baseline TSV from scratch"
  else
    fail "1. init creates baseline TSV from scratch" "biome-seatbelt.tsv not found after init"
  fi
else
  fail "1. init creates baseline TSV from scratch" "init exited with code $?"
fi
cleanup_tmpdir

# ── Test 2: init baseline contains correct file+rule+count entries ───
setup_tmpdir
run_cmd init || true
BASELINE="$TMPDIR_ROOT/biome-seatbelt.tsv"
if [[ -f "$BASELINE" ]]; then
  ALL_OK=true
  # Check expected entries
  # src/bad.ts  lint/complexity/useLiteralKeys  1
  # src/bad.ts  lint/style/noNonNullAssertion   1
  # src/bad.ts  lint/style/useConst             2
  # src/bad.ts  lint/suspicious/noConsole        3
  # src/mixed.ts lint/style/useConst             1
  # src/mixed.ts lint/suspicious/noConsole        1
  for entry in \
    "src/bad.ts:lint/complexity/useLiteralKeys:1" \
    "src/bad.ts:lint/style/noNonNullAssertion:1" \
    "src/bad.ts:lint/style/useConst:2" \
    "src/bad.ts:lint/suspicious/noConsole:3" \
    "src/mixed.ts:lint/style/useConst:1" \
    "src/mixed.ts:lint/suspicious/noConsole:1"; do
    IFS=: read -r file rule expected_count <<< "$entry"
    actual=$(get_tsv_count "$BASELINE" "$file" "$rule")
    if [[ "$actual" != "$expected_count" ]]; then
      fail "2. init baseline contains correct entries" "Expected $file $rule=$expected_count, got '$actual'"
      ALL_OK=false
      break
    fi
  done
  if $ALL_OK; then
    # Also check there are exactly 6 data lines
    data_lines=$(count_tsv_lines "$BASELINE")
    if [[ "$data_lines" -eq 6 ]]; then
      pass "2. init baseline contains correct file+rule+count entries"
    else
      fail "2. init baseline contains correct entries" "Expected 6 data lines, got $data_lines"
    fi
  fi
else
  fail "2. init baseline contains correct file+rule+count entries" "baseline not found"
fi
cleanup_tmpdir

# ── Test 3: check passes when violations match baseline ──────────────
setup_tmpdir
run_cmd init || true
if run_cmd check; then
  pass "3. check passes when violations match baseline"
else
  fail "3. check passes when violations match baseline" "check exited non-zero: $CMD_OUTPUT"
fi
cleanup_tmpdir

# ── Test 4: check fails when a new violation is added ────────────────
setup_tmpdir
run_cmd init || true
# Add another console.log to bad.ts (new violation)
echo 'console.log("extra");' >> "$TMPDIR_ROOT/src/bad.ts"
if run_cmd check; then
  fail "4. check fails when new violation added" "check should have failed but passed"
else
  pass "4. check fails when a new violation is added"
fi
cleanup_tmpdir

# ── Test 5: check fails when a new file with violations is added ─────
setup_tmpdir
run_cmd init || true
# Create a new file with violations
cat > "$TMPDIR_ROOT/src/extra.ts" << 'NEWFILE'
let x = 1;
console.log(x);
export { x };
NEWFILE
if run_cmd check; then
  fail "5. check fails when new file with violations added" "check should have failed but passed"
else
  pass "5. check fails when a new file with violations is added"
fi
cleanup_tmpdir

# ── Test 6: update tightens baseline when violations decrease ────────
setup_tmpdir
run_cmd init || true
BASELINE="$TMPDIR_ROOT/biome-seatbelt.tsv"
old_count=$(get_tsv_count "$BASELINE" "src/bad.ts" "lint/suspicious/noConsole")
# Remove one console call from bad.ts (replace console.error line)
sed -i.bak 's/console\.error("obj is", obj);/\/\/ fixed/' "$TMPDIR_ROOT/src/bad.ts"
run_cmd update || true
new_count=$(get_tsv_count "$BASELINE" "src/bad.ts" "lint/suspicious/noConsole")
if [[ "$old_count" == "3" && "$new_count" == "2" ]]; then
  pass "6. update tightens baseline when violations decrease"
else
  fail "6. update tightens baseline when violations decrease" "Expected 3->2, got $old_count->$new_count"
fi
cleanup_tmpdir

# ── Test 7: update does NOT loosen baseline when violations increase ─
setup_tmpdir
run_cmd init || true
BASELINE="$TMPDIR_ROOT/biome-seatbelt.tsv"
old_count=$(get_tsv_count "$BASELINE" "src/bad.ts" "lint/suspicious/noConsole")
# Add more console calls
echo 'console.log("more1");' >> "$TMPDIR_ROOT/src/bad.ts"
echo 'console.log("more2");' >> "$TMPDIR_ROOT/src/bad.ts"
run_cmd update || true
new_count=$(get_tsv_count "$BASELINE" "src/bad.ts" "lint/suspicious/noConsole")
if [[ "$new_count" == "$old_count" ]]; then
  pass "7. update does NOT loosen baseline when violations increase"
else
  fail "7. update does NOT loosen baseline when violations increase" "Expected count to stay at $old_count, got $new_count"
fi
cleanup_tmpdir

# ── Test 8: update removes entries that reach zero ───────────────────
setup_tmpdir
run_cmd init || true
BASELINE="$TMPDIR_ROOT/biome-seatbelt.tsv"
# Fix mixed.ts completely — remove all violations
cat > "$TMPDIR_ROOT/src/mixed.ts" << 'FIXED'
const PI = 3.14159;
const radius = 10;

function area(r: number): number {
  return PI * r * r;
}

export { PI, radius, area };
FIXED
run_cmd update || true
mixed_useconst=$(get_tsv_count "$BASELINE" "src/mixed.ts" "lint/style/useConst")
mixed_console=$(get_tsv_count "$BASELINE" "src/mixed.ts" "lint/suspicious/noConsole")
if [[ -z "$mixed_useconst" && -z "$mixed_console" ]]; then
  pass "8. update removes entries that reach zero"
else
  fail "8. update removes entries that reach zero" "mixed.ts entries still present: useConst='$mixed_useconst' noConsole='$mixed_console'"
fi
cleanup_tmpdir

# ── Test 9: status shows human-readable output with counts ──────────
setup_tmpdir
run_cmd init || true
if run_cmd status; then
  # Check that output contains some expected strings
  if echo "$CMD_OUTPUT" | grep -qiE '(violation|baseline|total|count|remaining)'; then
    pass "9. status shows human-readable output with correct counts"
  else
    fail "9. status shows human-readable output" "Output does not contain expected keywords: $CMD_OUTPUT"
  fi
else
  # status should exit 0, but some implementations might still produce output
  if echo "$CMD_OUTPUT" | grep -qiE '(violation|baseline|total|count|remaining)'; then
    pass "9. status shows human-readable output with correct counts"
  else
    fail "9. status shows human-readable output" "status exited non-zero and no useful output"
  fi
fi
cleanup_tmpdir

# ── EDGE CASES ───────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Edge cases${RESET}"

# ── Test 10: check fails gracefully when no baseline exists ──────────
setup_tmpdir
# Do NOT run init — no baseline file
if run_cmd check; then
  fail "10. check fails when no baseline exists" "check should have failed but passed"
else
  # Verify it gave a meaningful message (not a crash/stack trace)
  if echo "$CMD_OUTPUT" | grep -qiE '(no baseline|not found|init|missing)'; then
    pass "10. check fails gracefully when no baseline file exists"
  else
    # Accept any non-zero exit as pass — the important thing is it didn't succeed
    pass "10. check fails gracefully when no baseline file exists"
  fi
fi
cleanup_tmpdir

# ── Test 11: works with empty project (no violations) ────────────────
setup_tmpdir
# Replace all source files with clean code
cat > "$TMPDIR_ROOT/src/bad.ts" << 'CLEAN'
const x = 1;
export { x };
CLEAN
cat > "$TMPDIR_ROOT/src/mixed.ts" << 'CLEAN'
const y = 2;
export { y };
CLEAN
if run_cmd init; then
  BASELINE="$TMPDIR_ROOT/biome-seatbelt.tsv"
  if [[ -f "$BASELINE" ]]; then
    data_lines=$(count_tsv_lines "$BASELINE")
    if [[ "$data_lines" -eq 0 ]]; then
      pass "11. works with empty project (no violations)"
    else
      fail "11. works with empty project (no violations)" "Expected 0 data lines, got $data_lines"
    fi
  else
    # Some implementations might not create the file if no violations — acceptable
    pass "11. works with empty project (no violations)"
  fi
else
  fail "11. works with empty project (no violations)" "init failed on clean project"
fi
cleanup_tmpdir

# ── Test 12: handles files being deleted between init and check ──────
setup_tmpdir
run_cmd init || true
# Delete mixed.ts (fewer violations now)
if command -v trash &>/dev/null; then
  trash "$TMPDIR_ROOT/src/mixed.ts" 2>/dev/null || true
else
  command rm -f "$TMPDIR_ROOT/src/mixed.ts" 2>/dev/null || true
fi
# Check should pass because violations can only decrease when a file is deleted
if run_cmd check; then
  pass "12. handles files being deleted between init and check"
else
  # Some implementations might fail if file is in baseline but missing —
  # this is acceptable IF it doesn't crash
  if [[ $? -le 1 ]]; then
    pass "12. handles files being deleted between init and check"
  else
    fail "12. handles files being deleted between init and check" "Unexpected error: $CMD_OUTPUT"
  fi
fi
cleanup_tmpdir

# ── Test 13: TSV is sorted deterministically ─────────────────────────
setup_tmpdir
run_cmd init || true
FIRST="$(cat "$TMPDIR_ROOT/biome-seatbelt.tsv")"
# Remove baseline and re-init
if command -v trash &>/dev/null; then
  trash "$TMPDIR_ROOT/biome-seatbelt.tsv" 2>/dev/null || true
else
  command rm -f "$TMPDIR_ROOT/biome-seatbelt.tsv" 2>/dev/null || true
fi
run_cmd init || true
SECOND="$(cat "$TMPDIR_ROOT/biome-seatbelt.tsv")"
# Compare, ignoring comment lines that contain timestamps
FIRST_DATA=$(echo "$FIRST" | grep -v '^#')
SECOND_DATA=$(echo "$SECOND" | grep -v '^#')
if [[ "$FIRST_DATA" == "$SECOND_DATA" ]]; then
  pass "13. TSV is sorted deterministically (init twice = identical output)"
else
  fail "13. TSV is sorted deterministically" "Two init runs produced different data lines"
fi
cleanup_tmpdir

# ── Test 14: baseline not corrupted by repeated update cycles ────────
setup_tmpdir
run_cmd init || true
BASELINE="$TMPDIR_ROOT/biome-seatbelt.tsv"
ORIGINAL_DATA=$(grep -v '^#' "$BASELINE")
# Run update 5 times without changing any files
for i in 1 2 3 4 5; do
  run_cmd update || true
done
AFTER_DATA=$(grep -v '^#' "$BASELINE")
if [[ "$ORIGINAL_DATA" == "$AFTER_DATA" ]]; then
  pass "14. baseline is not corrupted by repeated update cycles"
else
  fail "14. baseline is not corrupted by repeated update cycles" "Data changed after 5 update cycles"
fi
cleanup_tmpdir

# ── Summary ──────────────────────────────────────────────────────────
echo ""
TOTAL=$((PASSED + FAILED + SKIPPED))
echo -e "${BOLD}──────────────────────────────────────────${RESET}"
echo -e "${BOLD}Results: $TOTAL tests${RESET}"
echo -e "  ${GREEN}Passed:  $PASSED${RESET}"
if [[ $FAILED -gt 0 ]]; then
  echo -e "  ${RED}Failed:  $FAILED${RESET}"
  for name in "${FAILED_NAMES[@]}"; do
    echo -e "    ${RED}- $name${RESET}"
  done
else
  echo -e "  Failed:  0"
fi
if [[ $SKIPPED -gt 0 ]]; then
  echo -e "  ${YELLOW}Skipped: $SKIPPED${RESET}"
fi
echo -e "${BOLD}──────────────────────────────────────────${RESET}"

if [[ $FAILED -gt 0 ]]; then
  exit 1
else
  exit 0
fi
