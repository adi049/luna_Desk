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
#   3. a suite that never reaches the end → exit 1 ("never printed ALL TESTS
#                                            PASSED")
#   4. an empty migrations directory      → exit 1
#   5. an unmodified copy of the tree     → exit 0 (the gate is not just always
#                                            failing)
#
# Case 5 is the important control: a verifier that always exits non-zero would
# also "detect" a broken migration, and would be useless.
#
# Scratch copies are made in a temporary directory and use their own throwaway
# database, so the real migrations and the real scratch database are untouched.
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
cleanup() {
  rm -rf "$WORKDIR"
  dropdb --if-exists --force "${DB_PREFIX}_ok" >/dev/null 2>&1 || true
  dropdb --if-exists --force "${DB_PREFIX}_broken" >/dev/null 2>&1 || true
  dropdb --if-exists --force "${DB_PREFIX}_assert" >/dev/null 2>&1 || true
  dropdb --if-exists --force "${DB_PREFIX}_noend" >/dev/null 2>&1 || true
  dropdb --if-exists --force "${DB_PREFIX}_empty" >/dev/null 2>&1 || true
}
trap cleanup EXIT

PASSED=0
FAILED=0

pass() { printf 'ok — %s\n' "$1"; PASSED=$((PASSED + 1)); }
bad() {
  printf '✗ FAIL: %s\n' "$1" >&2
  FAILED=$((FAILED + 1))
}

# check_exit <case> <expected-exit> <actual-exit> <combined-output> <expected-substring>
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
    if printf '%s\n' "$output" | grep -qF -- "$needle"; then
      pass "$name output contains: $needle"
    else
      bad "$name output does not contain: $needle"
      printf '%s\n' "$output" | tail -20 >&2
    fi
  fi
}

# --- fixtures ---------------------------------------------------------------
fresh_copy() {
  local dir="$1"
  mkdir -p "$dir"
  cp "$MIGRATIONS"/*.sql "$dir"/
}

# 1. Control: an untouched copy must verify cleanly.
CONTROL="$WORKDIR/control"
fresh_copy "$CONTROL"
out="$(DATABASE="${DB_PREFIX}_ok" MIGRATIONS_DIR="$CONTROL" bash "$VERIFIER" 2>&1)"
status=$?
check_case "unmodified tree (control)" 0 "$status" "$out" "schema verified"

# 2. A migration with a syntax error must stop the run.
BROKEN="$WORKDIR/broken"
fresh_copy "$BROKEN"
printf 'create table deliberately_broken (\n  id uuid primary key,\n  bad syntax here\n);\n' \
  >"$BROKEN/9999_deliberately_broken.sql"
out="$(DATABASE="${DB_PREFIX}_broken" MIGRATIONS_DIR="$BROKEN" bash "$VERIFIER" 2>&1)"
status=$?
check_case "syntax error in a migration" 1 "$status" "$out" "9999_deliberately_broken.sql"

if printf '%s\n' "$out" | grep -qiE 'syntax error'; then
  pass "syntax error text is preserved in the output"
else
  bad "syntax error text is missing from the output"
fi

if printf '%s\n' "$out" | grep -q "schema verified"; then
  bad "a failed run still printed the success banner"
else
  pass "a failed run does not print the success banner"
fi

# 3. A failing assertion in the RLS/RPC suite must stop the run.
#
# The suite file is copied into place temporarily and restored by the trap, so
# an interrupted run cannot leave a mutated test suite behind.
SUITE_BACKUP="$WORKDIR/rls.sql.backup"
cp "$SUITE" "$SUITE_BACKUP"
restore_suite() {
  cp "$SUITE_BACKUP" "$SUITE"
  dropdb --if-exists --force "${DB_PREFIX}_assert" >/dev/null 2>&1 || true
  dropdb --if-exists --force "${DB_PREFIX}_noend" >/dev/null 2>&1 || true
  dropdb --if-exists --force "${DB_PREFIX}_broken" >/dev/null 2>&1 || true
  dropdb --if-exists --force "${DB_PREFIX}_empty" >/dev/null 2>&1 || true
  dropdb --if-exists --force "${DB_PREFIX}_ok" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap restore_suite EXIT INT TERM

python3 - "$SUITE" <<'PY'
import sys
path = sys.argv[1]
source = open(path).read()
anchor = "\nrollback;\n"
if anchor not in source:
    sys.exit("could not find the rollback anchor in the test suite")
injected = (
    "\n-- Injected by scripts/test-verify-migrations.sh\n"
    "select public.test_assert(false, 'injected failure that must abort the run');\n"
)
open(path, "w").write(source.replace(anchor, injected + anchor, 1))
PY
if [[ $? -ne 0 ]]; then
  bad "could not inject a failing assertion into the suite"
fi

FRESH="$WORKDIR/fresh"
fresh_copy "$FRESH"
out="$(DATABASE="${DB_PREFIX}_assert" MIGRATIONS_DIR="$FRESH" bash "$VERIFIER" 2>&1)"
status=$?
check_case "failing assertion in the suite" 1 "$status" "$out" "RLS / RPC suite FAILED"

if printf '%s\n' "$out" | grep -q "injected failure that must abort the run"; then
  pass "the failing assertion is named in the output"
else
  bad "the failing assertion is not named in the output"
fi

# 4. A suite that exits 0 without reaching "ALL TESTS PASSED" must be caught.
#
# This models the realistic silent-pass bug: the SQL runs, prints some notices,
# and stops early — for example because a block was accidentally commented out.
cp "$SUITE_BACKUP" "$SUITE"
python3 - "$SUITE" <<'PY'
import sys
path = sys.argv[1]
source = open(path).read()
marker = "do $$ begin raise notice 'ALL TESTS PASSED'; end $$;"
if marker not in source:
    # Fall back to a softer marker; the exact form may differ by file revision.
    lowered = [line for line in source.splitlines() if "ALL TESTS PASSED" in line]
    if not lowered:
        sys.exit("could not find the ALL TESTS PASSED marker in the suite")
    source = source.replace(lowered[0], "-- removed by meta-test", 1)
else:
    source = source.replace(marker, "-- removed by meta-test", 1)
open(path, "w").write(source)
PY
if [[ $? -ne 0 ]]; then
  bad "could not remove the ALL TESTS PASSED marker from the suite"
fi

out="$(DATABASE="${DB_PREFIX}_noend" MIGRATIONS_DIR="$FRESH" bash "$VERIFIER" 2>&1)"
status=$?
check_case "suite that stops before the end" 1 "$status" "$out" "ALL TESTS PASSED"

# 5. An empty migrations directory must be refused, not silently "verified".
EMPTY="$WORKDIR/empty"
mkdir -p "$EMPTY"
out="$(DATABASE="${DB_PREFIX}_empty" MIGRATIONS_DIR="$EMPTY" bash "$VERIFIER" 2>&1)"
status=$?
check_case "empty migrations directory" 1 "$status" "$out" "no migrations found"

# --- summary ----------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
if [[ "$FAILED" -ne 0 ]]; then
  printf '✗ the migration verifier does not reliably detect failures\n' >&2
  exit 1
fi
printf '✓ verify-migrations.sh detects broken, failing and truncated runs\n'
