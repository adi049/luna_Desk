#!/usr/bin/env bash
# =============================================================================
# Concurrency regression test: two administrators deactivating each other.
#
# SQL cannot express "two overlapping transactions", and a single psql session
# cannot open them, so this test drives two real connections in parallel. That
# is the only honest way to prove the guard holds.
#
# The scenario, repeated ROUNDS times:
#
#     session A  begin; deactivate(B); sleep; commit;
#     session B  (starts slightly later) begin; deactivate(A); commit;
#
# Session A holds the workspace lock for the duration of its sleep. Without the
# advisory lock added in migration 0012, B's guard counts A — still active in
# B's snapshot — as the surviving administrator, so both deactivations commit
# and the workspace is left with zero active administrators. With the lock, B
# waits for A and is then refused.
#
# Pass condition, after every round: at least one active administrator remains,
# and the two sessions did not both succeed.
#
# Requires a database with the migrations applied. If DATABASE does not exist,
# scripts/verify-migrations.sh is run first to create it.
#
#   PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… scripts/test-admin-concurrency.sh
# =============================================================================
set -uo pipefail

cd "$(dirname "$0")/.."

DATABASE="${DATABASE:-lunadesk_verify}"
ROUNDS="${ROUNDS:-5}"

ADMIN_A="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
ADMIN_B="aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/lunadesk-race.XXXXXX")"
cleanup() {
  rm -rf "$WORKDIR"
  psql -X -q -d "$DATABASE" -c "
    delete from public.user_roles  where user_id in ('$ADMIN_A','$ADMIN_B');
    delete from public.audit_logs  where actor_id in ('$ADMIN_A','$ADMIN_B')
                                      or entity_id in ('$ADMIN_A','$ADMIN_B');
    delete from public.profiles    where id in ('$ADMIN_A','$ADMIN_B');
    delete from auth.users         where id in ('$ADMIN_A','$ADMIN_B');
  " >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql_x() { psql -X -q -t -A -v ON_ERROR_STOP=1 -d "$DATABASE" "$@"; }

if ! psql_x -c 'select 1' >/dev/null 2>&1; then
  echo "→ $DATABASE does not exist; creating it with scripts/verify-migrations.sh"
  DATABASE="$DATABASE" bash scripts/verify-migrations.sh >/dev/null 2>&1 || {
    echo "✗ could not prepare $DATABASE" >&2
    exit 1
  }
fi

echo "→ seeding exactly two administrators in $DATABASE"
psql_x -c "
  insert into auth.users (id, email) values
    ('$ADMIN_A', 'race-a@example.test'),
    ('$ADMIN_B', 'race-b@example.test')
  on conflict (id) do nothing;

  insert into public.profiles (id, full_name, email, role, is_active) values
    ('$ADMIN_A', 'Race A', 'race-a@example.test', 'admin', true),
    ('$ADMIN_B', 'Race B', 'race-b@example.test', 'admin', true)
  on conflict (id) do update set role = 'admin', is_active = true;

  insert into public.user_roles (user_id, role) values
    ('$ADMIN_A','admin'), ('$ADMIN_B','admin')
  on conflict (user_id, role) do nothing;
" >/dev/null

# One session's script.
#   $1 output file, $2 acting user, $3 target, $4 seconds to hold the
#   transaction open before committing.
write_session() {
  cat >"$1" <<SQL
\set ON_ERROR_STOP off
begin;
select set_config('request.jwt.claim.sub', '$2', false);
set local role authenticated;
select public.rpc_set_admin_active('$3', false) as result;
select pg_sleep($4);
commit;
SQL
}

PASS=0
FAIL=0
pass() { printf 'ok — %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '✗ FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

for round in $(seq 1 "$ROUNDS"); do
  # Reset: everybody active again.
  psql_x -c "
    update public.profiles set is_active = true
     where id in ('$ADMIN_A','$ADMIN_B');
    insert into public.user_roles (user_id, role)
      select id, 'admin' from public.profiles
       where id in ('$ADMIN_A','$ADMIN_B')
      on conflict (user_id, role) do nothing;
  " >/dev/null

  # A acts as A deactivating B, and holds its transaction open.
  # A acts as A deactivating B, and holds its transaction open for two seconds.
  write_session "$WORKDIR/a.sql" "$ADMIN_A" "$ADMIN_B" "2"
  # B acts as B deactivating A, starting 0.6s later — while A is still open.
  write_session "$WORKDIR/b.sql" "$ADMIN_B" "$ADMIN_A" "0"

  psql -X -q -t -A -v ON_ERROR_STOP=0 -d "$DATABASE" -f "$WORKDIR/a.sql" \
    >"$WORKDIR/a.out" 2>"$WORKDIR/a.err" &
  pid_a=$!
  sleep 0.6
  psql -X -q -t -A -v ON_ERROR_STOP=0 -d "$DATABASE" -f "$WORKDIR/b.sql" \
    >"$WORKDIR/b.out" 2>"$WORKDIR/b.err" &
  pid_b=$!

  wait "$pid_a"
  wait "$pid_b"

  successes=0
  grep -q '"changed": true' "$WORKDIR/a.out" && successes=$((successes + 1))
  grep -q '"changed": true' "$WORKDIR/b.out" && successes=$((successes + 1))

  remaining="$(psql_x -c "
    select count(*) from public.profiles
     where role = 'admin' and is_active
       and id in ('$ADMIN_A','$ADMIN_B');")"

  if [[ "$remaining" -ge 1 ]]; then
    pass "round $round: an active administrator survives the race ($remaining remain)"
  else
    fail "round $round: BOTH deactivations committed — the workspace has no active admin"
    sed -n '1,6p' "$WORKDIR/a.out" "$WORKDIR/b.out" >&2
  fi

  if [[ "$successes" -le 1 ]]; then
    pass "round $round: only one of the two deactivations took effect ($successes)"
  else
    fail "round $round: both concurrent deactivations were allowed"
  fi
done

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [[ "$FAIL" -ne 0 ]]; then
  printf '✗ concurrent admin deactivation is not serialised\n' >&2
  exit 1
fi
printf '✓ concurrent admin deactivation cannot empty the workspace\n'
