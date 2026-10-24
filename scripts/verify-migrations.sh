#!/usr/bin/env bash
# =============================================================================
# Verify the LunaDesk schema: apply every migration to a scratch database and
# run the RLS / RPC test suite.
#
#   scripts/verify-migrations.sh                  # local Postgres as the OS user
#   PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… scripts/verify-migrations.sh
#
# Connection settings come from the standard libpq environment variables. The
# database named by DATABASE (default: lunadesk_verify) is DROPPED and
# recreated, so never point this at a database you care about.
#
# Exit status is meaningful: any failed step stops the run and returns non-zero.
# Earlier versions piped psql through `grep … || true`, which discarded both the
# exit status and the error text — a migration with a syntax error still printed
# "✓ schema verified" and exited 0.
#
# MIGRATIONS_DIR, HARNESS and TEST_SUITE can be pointed elsewhere (used by
# scripts/test-verify-migrations.sh to prove failures are detected without
# modifying any tracked file).
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

DATABASE="${DATABASE:-lunadesk_verify}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-supabase/migrations}"
HARNESS="${HARNESS:-scripts/sql-harness.sql}"
# TEST_SUITE lets scripts/test-verify-migrations.sh point at a mutated *copy* of
# the suite instead of editing the real file. Mutating a tracked file from a
# test is a shared-state hazard: an interrupted run leaves a broken suite
# behind, and a concurrent run can read the mutated version.
TEST_SUITE="${TEST_SUITE:-supabase/tests/rls.sql}"

# One scratch file per run; the trap guarantees it is removed.
LOG="$(mktemp "${TMPDIR:-/tmp}/lunadesk-verify.XXXXXX")"
trap 'rm -f "$LOG"' EXIT

psql_run() {
  psql -d "$DATABASE" --quiet --no-psqlrc -v ON_ERROR_STOP=1 "$@"
}

# Print a captured log with routine notices removed.
#
# `awk` is used rather than `grep` because awk always exits 0: this function is
# purely presentational and must never alter the outcome of the command whose
# output it is displaying.
show_log() {
  awk '!/^NOTICE:/ && !/NOTICE:  .*already exists, skipping/' "$1"
}

fail() {
  printf '\n✗ %s\n' "$1" >&2
  exit 1
}

# run_sql_file <description> <path>
run_sql_file() {
  local description="$1"
  local file="$2"

  if [[ ! -f "$file" ]]; then
    fail "$description — file not found: $file"
  fi

  if ! psql_run -f "$file" >"$LOG" 2>&1; then
    printf '\n✗ %s FAILED: %s\n' "$description" "$file" >&2
    printf -- '---- psql output ----------------------------------------------\n' >&2
    cat "$LOG" >&2
    printf -- '--------------------------------------------------------------\n' >&2
    printf 'Migration errors are fatal: nothing was verified.\n' >&2
    exit 1
  fi

  show_log "$LOG"
}

echo "→ recreating $DATABASE"
if ! dropdb --if-exists --force "$DATABASE" >"$LOG" 2>&1; then
  printf '\n✗ could not drop the scratch database %s\n' "$DATABASE" >&2
  cat "$LOG" >&2
  printf 'Is PostgreSQL running and are the libpq variables (PGHOST/PGUSER/…) correct?\n' >&2
  exit 1
fi

if ! createdb "$DATABASE" >"$LOG" 2>&1; then
  printf '\n✗ could not create the scratch database %s\n' "$DATABASE" >&2
  cat "$LOG" >&2
  exit 1
fi

echo "→ installing Supabase shim (auth schema, roles, auth.uid())"
run_sql_file "Supabase shim" "$HARNESS"

echo "→ applying migrations from $MIGRATIONS_DIR"
shopt -s nullglob
migrations=("$MIGRATIONS_DIR"/*.sql)
shopt -u nullglob

if [[ ${#migrations[@]} -eq 0 ]]; then
  fail "no migrations found in $MIGRATIONS_DIR"
fi

for migration in "${migrations[@]}"; do
  printf '   %s\n' "$migration"
  run_sql_file "migration $migration" "$migration"
done

echo "→ running RLS / RPC tests"
if ! psql_run -f "$TEST_SUITE" >"$LOG" 2>&1; then
  printf '\n✗ RLS / RPC suite FAILED\n' >&2
  printf -- '---- psql output ----------------------------------------------\n' >&2
  cat "$LOG" >&2
  printf -- '--------------------------------------------------------------\n' >&2
  exit 1
fi

# Surface the per-assertion lines, and confirm the suite actually reached its
# end. A suite that aborts early must not be reported as a pass.
show_log "$LOG" | grep -E 'ok —|ALL TESTS' || printf '   (suite produced no assertion output — check the file)\n'

if ! grep -q 'ALL TESTS PASSED' "$LOG"; then
  printf '\n✗ the suite exited 0 but never printed "ALL TESTS PASSED"\n' >&2
  cat "$LOG" >&2
  exit 1
fi

# A floor on the number of assertions. Deleting whole blocks of tests leaves a
# suite that still says "ALL TESTS PASSED", so the count is part of the gate.
# Raise MIN_ASSERTIONS when tests are added; the suite only ever grows.
MIN_ASSERTIONS="${MIN_ASSERTIONS:-190}"
assertions="$(grep -c 'ok —' "$LOG" || true)"
if [[ "$assertions" -lt "$MIN_ASSERTIONS" ]]; then
  printf '\n✗ only %s assertions ran (expected at least %s) — tests went missing\n' \
    "$assertions" "$MIN_ASSERTIONS" >&2
  exit 1
fi

printf '\n✓ schema verified: %d migrations applied, RLS/RPC suite passed (%s assertions)\n' \
  "${#migrations[@]}" "$assertions"
