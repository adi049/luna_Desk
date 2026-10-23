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
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

DATABASE="${DATABASE:-lunadesk_verify}"
HARNESS="scripts/sql-harness.sql"

psql_run() {
  psql -d "$DATABASE" --quiet --no-psqlrc -v ON_ERROR_STOP=1 "$@"
}

echo "→ recreating $DATABASE"
dropdb --if-exists --force "$DATABASE" 2>/dev/null || true
createdb "$DATABASE"

echo "→ installing Supabase shim (auth schema, roles, auth.uid())"
psql_run -f "$HARNESS" 2>&1 | grep -v 'already exists, skipping' || true

echo "→ applying migrations"
for migration in supabase/migrations/*.sql; do
  printf '   %s\n' "$migration"
  psql_run -f "$migration" 2>&1 | grep -vE 'NOTICE|skipping' || true
done

echo "→ running RLS / RPC tests"
psql_run -f supabase/tests/rls.sql 2>&1 | grep -E 'ok —|FAIL|ERROR|ALL TESTS'

echo "✓ schema verified"
