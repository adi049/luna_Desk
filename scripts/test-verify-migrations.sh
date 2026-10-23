#!/usr/bin/env bash
# =============================================================================
# Meta-test for scripts/verify-migrations.sh.
#
# The verifier is the gate that decides whether the schema is trustworthy, so a
# verifier that silently passes on a broken migration is worse than no verifier
# at all. This script proves the gate really closes:
#
#   1. a syntax error in a migration      → exit 1, psql error text preserved
#   2. a failing assertion in the suite   → exit 1, the failed assertion named
#   3. a suite that never reaches the end → exit 1 ("ALL TESTS PASSED" missing)
#   4. an empty migrations directory      → exit 1
#   5. an unmodified copy of the tree     → exit 0 (the gate is not just always
#                                            failing)
#
# Case 5 is the important control: a verifier that always exits non-zero would
# also "detect" a broken migration, and would be useless.
#
# Every mutated input is written to a temporary directory and passed to the
# verifier through MIGRATIONS_DIR / TEST_SUITE. Nothing tracked is modified —
# an earlier version edited supabase/tests/rls.sql in place, which left a broken
# suite behind when a run was interrupted and made this test intermittently fail.
#
#   PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… scripts/test-verify-migrations.sh
# =============================================================================
set -uo pipefail

cd "$(dirname "$0")/.."

VERIFIER="scripts/verify-migrations.sh"
MIGRATIONS="supabase/migrations"
SUITE="supabase/tests/rls.sql"
DB_PREFIX="lunadesk_meta"

if [[ ! -x "$VERIFIER" ]]; then
  printf '✗ %s is missing or not executable\n' "$VERIFIER" >&2
  exit 1
fi

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/lunadesk-meta.XXXXXX")"
drop_scratch() {
  local name
  for name in ok broken assert noend empty; do
    dropdb --if-exists --force "${DB_PREFIX}_${name}" >/dev/null 2>&1 || true
  done
}
cleanup() {
  rm -rf "$WORKDIR"
  drop_scratch
}
trap cleanup EXIT INT TERM

PASSED=0
FAILED=0

#
# Why a helper instead of `printf ... | grep -q ...`:
# under `set -o pipefail`, grep -q exits as soon as it matches, printf then dies
# of SIGPIPE, and the *pipeline* reports failure even though the match
# succeeded. That made these checks fail intermittently — roughly one run in
# three — with no change to the code under test. A here-string has no pipe and
# no SIGPIPE, so the status is grep's own.

contains() { grep -qF -- "$1" <<<"$2"; }
matches()  { grep -qiE -- "$1" <<<"$2"; }

pass() { printf 'ok — %s\n' "$1"; PASSED=$((PASSED + 1)); }
bad() {
  printf '✗ FAIL: %s\n' "$1" >&2
  FAILED=$((FAILED + 1))
}

# check_case <case> <expected-exit> <actual-exit> <combined-output> <needle>
check_case() {
  local name="$1" expected="$2" actual="$3" output="$4" needle="$5"

  if [[ "$actual" == "$expected" ]]; then
    pass "$name exits $expected"
  else
    bad "$name exited $actual, expected $expected"
    printf '%s\n' "$output" | tail -20 >&2
    return
  fi

  if [[ -n "$needle" ]]; then
    if contains "$needle" "$output"; then
      pass "$name output contains: $needle"
    else
      bad "$name output does not contain: $needle"
      printf '%s\n' "$output" | tail -20 >&2
    fi
  fi
}

fresh_copy() {
  local dir="$1"
  mkdir -p "$dir"
  cp "$MIGRATIONS"/*.sql "$dir"/
}
# Run the body of the injected-suite mutation in python without nesting heredocs.
mutate_failing() {
  python3 "$WORKDIR/mutate.py" failing "$SUITE" "$WORKDIR/failing.sql"
}
mutate_truncated() {
  python3 "$WORKDIR/mutate.py" truncated "$SUITE" "$WORKDIR/truncated.sql"
}

# A pristine copy, used only to prove the tracked suite was never touched.
cp "$SUITE" "$WORKDIR/rls.sql.backup"

cat >"$WORKDIR/mutate.py" <<'PYTHON'
"""Write a deliberately broken copy of the RLS suite.

  failing   — inject an assertion that always fails
  truncated — remove the final "ALL TESTS PASSED" marker
"""
import sys

mode, source_path, target_path = sys.argv[1], sys.argv[2], sys.argv[3]
source = open(source_path).read()

if mode == "failing":
    anchor = "\nrollback;\n"
    if anchor not in source:
        sys.exit("could not find the rollback anchor in the test suite")
    injected = (
        "\n-- Injected by scripts/test-verify-migrations.sh\n"
        "select public.test_assert(false, 'injected failure that must abort the run');\n"
    )
    open(target_path, "w").write(source.replace(anchor, injected + anchor, 1))
elif mode == "truncated":
    marker_lines = [line for line in source.splitlines() if "ALL TESTS PASSED" in line]
    if not marker_lines:
        sys.exit("could not find the ALL TESTS PASSED marker in the suite")
    open(target_path, "w").write(source.replace(marker_lines[0], "-- removed by meta-test", 1))
else:
    sys.exit(f"unknown mode {mode}")
PYTHON

# --- 1. Control: an untouched copy must verify cleanly ----------------------
CONTROL="$WORKDIR/control"
fresh_copy "$CONTROL"
out="$(DATABASE="${DB_PREFIX}_ok" MIGRATIONS_DIR="$CONTROL" bash "$VERIFIER" 2>&1)"
status=$?
check_case "unmodified tree (control)" 0 "$status" "$out" "schema verified"

# --- 2. A migration with a syntax error must stop the run -------------------
BROKEN="$WORKDIR/broken"
fresh_copy "$BROKEN"
printf 'create table deliberately_broken (\n  id uuid primary key,\n  bad syntax here\n);\n' \
  >"$BROKEN/9999_deliberately_broken.sql"
out="$(DATABASE="${DB_PREFIX}_broken" MIGRATIONS_DIR="$BROKEN" bash "$VERIFIER" 2>&1)"
status=$?
check_case "syntax error in a migration" 1 "$status" "$out" "9999_deliberately_broken.sql"

if matches 'syntax error' "$out"; then
  pass "syntax error text is preserved in the output"
else
  bad "syntax error text is missing from the output"
fi

if contains "schema verified" "$out"; then
  bad "a failed run still printed the success banner"
else
  pass "a failed run does not print the success banner"
fi

# --- 3. A failing assertion in the suite must stop the run ------------------
FRESH="$WORKDIR/fresh"
fresh_copy "$FRESH"

if mutate_failing; then
  out="$(DATABASE="${DB_PREFIX}_assert" MIGRATIONS_DIR="$FRESH" TEST_SUITE="$WORKDIR/failing.sql" bash "$VERIFIER" 2>&1)"
  status=$?
  check_case "failing assertion in the suite" 1 "$status" "$out" "RLS / RPC suite FAILED"

  if contains "injected failure that must abort the run" "$out"; then
    pass "the failing assertion is named in the output"
  else
    bad "the failing assertion is not named in the output"
  fi
else
  bad "could not build a copy of the suite with a failing assertion"
fi

# --- 4. A suite that stops before the end must be caught --------------------
if mutate_truncated; then
  out="$(DATABASE="${DB_PREFIX}_noend" MIGRATIONS_DIR="$FRESH" TEST_SUITE="$WORKDIR/truncated.sql" bash "$VERIFIER" 2>&1)"
  status=$?
  check_case "suite that stops before the end" 1 "$status" "$out" "ALL TESTS PASSED"
else
  bad "could not build a truncated copy of the suite"
fi

# --- 4b. None of the above may have touched the tracked suite ---------------
if cmp -s "$SUITE" "$WORKDIR/rls.sql.backup"; then
  pass "the tracked test suite was never modified by this script"
else
  bad "the tracked test suite changed during this run"
  cp "$WORKDIR/rls.sql.backup" "$SUITE"
fi

# --- 5. An empty migrations directory must be refused ----------------------
EMPTY="$WORKDIR/empty"
mkdir -p "$EMPTY"
out="$(DATABASE="${DB_PREFIX}_empty" MIGRATIONS_DIR="$EMPTY" bash "$VERIFIER" 2>&1)"
status=$?
check_case "empty migrations directory" 1 "$status" "$out" "no migrations found"

# --- summary ---------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
if [[ "$FAILED" -ne 0 ]]; then
  printf '✗ the migration verifier does not reliably detect failures\n' >&2
  exit 1
fi
printf '✓ verify-migrations.sh detects broken, failing and truncated runs\n'
