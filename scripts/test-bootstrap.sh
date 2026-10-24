#!/usr/bin/env bash
# =============================================================================
# Regression test for scripts/bootstrap-admin.sql.
#
# The bootstrap is run by hand, once, in the SQL editor — which is exactly the
# kind of script that rots. These are the properties that matter:
#
#   1. It refuses to run while the placeholders are still in place. (The old
#      version shipped with a plausible-looking default address and the code
#      ADI000, so running it unchanged silently created a working admin with a
#      code published in the repository.)
#   2. A global find-and-replace over the file does not trip that check — the
#      sentinels are built by concatenation so only an untouched run matches.
#   3. It refuses when the auth user does not exist, instead of half-applying.
#   4. It succeeds for a real user, and leaves exactly one live lookup code
#      even when run twice.
#   5. It never prints the access code. SQL editor output ends up in
#      screenshots and tickets.
#
# Requires a migrated database (DATABASE, default lunadesk_verify); if it does
# not exist, scripts/verify-migrations.sh is run first.
#
#   PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=… scripts/test-bootstrap.sh
# =============================================================================
set -uo pipefail

cd "$(dirname "$0")/.."

DATABASE="${DATABASE:-lunadesk_verify}"
SCRIPT="scripts/bootstrap-admin.sql"
EMAIL="bootstrap-test@example.test"
USER_ID="cccccccc-1111-4111-8111-cccccccccccc"
CODE="BOOTSTRP1"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/lunadesk-boot.XXXXXX")"
cleanup() {
  rm -rf "$WORKDIR"
  psql -X -q -d "$DATABASE" -c "
    delete from public.admin_access_codes where user_id = '$USER_ID';
    delete from public.audit_logs where entity_id = '$USER_ID';
    delete from public.user_roles where user_id = '$USER_ID';
    delete from public.profiles where id = '$USER_ID';
    delete from auth.users where id = '$USER_ID';
  " >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql_x() { psql -X -q -t -A -v ON_ERROR_STOP=1 -d "$DATABASE" "$@"; }

# Rebuild the scratch database every run (SKIP_MIGRATE=1 opts out).
#
# Checking only that the database *exists* was a trap: an older scratch
# database from a previous round is missing the newest functions, and the
# failure surfaces as "function does not exist" in the middle of a test that
# looks unrelated. Applying the migrations first makes the result depend on the
# repository, not on what happens to be lying around in the cluster.
if [[ "${SKIP_MIGRATE:-0}" != "1" ]]; then
  echo "→ applying migrations to $DATABASE"
  DATABASE="$DATABASE" bash scripts/verify-migrations.sh >/dev/null 2>&1 || {
    echo "✗ could not prepare $DATABASE" >&2
    exit 1
  }
fi

PASS=0
FAIL=0

# Why a helper instead of `printf ... | grep -q ...`:
# under `set -o pipefail`, grep -q exits as soon as it matches, printf then dies
# of SIGPIPE, and the *pipeline* reports failure even though the match
# succeeded. That made these checks fail intermittently — roughly one run in
# three — with no change to the code under test. A here-string has no pipe and
# no SIGPIPE, so the status is grep's own.

contains() { grep -qF -- "$1" <<<"$2"; }
matches()  { grep -qiE -- "$1" <<<"$2"; }

pass() { printf 'ok — %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '✗ FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

check() { # name, expected-exit ("0" or "nonzero"), needle, actual-exit, output
  local name="$1" want="$2" needle="$3" got="$4" out="$5"
  # psql exits 3 for a script error, 1 for a connection problem; both mean the
  # script refused to run, so only "zero" vs "non-zero" is meaningful here.
  local ok=1
  if [[ "$want" = "nonzero" ]]; then
    [[ "$got" -ne 0 ]] && ok=0
  else
    [[ "$got" -eq "$want" ]] && ok=0
  fi
  if [[ "$ok" -ne 0 ]]; then
    fail "$name (exit $got, expected $want)"
    printf '%s\n' "$out" | tail -5 >&2
    return
  fi
  if [[ -n "$needle" ]] && ! contains "$needle" "$out"; then
    fail "$name (output does not mention: $needle)"
    printf '%s\n' "$out" | tail -5 >&2
    return
  fi
  pass "$name"
}

# --- 1. untouched file refuses to run ---------------------------------------
out="$(psql -X -q -v ON_ERROR_STOP=1 -d "$DATABASE" -f "$SCRIPT" 2>&1)"
status=$?
check "an untouched bootstrap refuses to run" nonzero "placeholder values are still in place" "$status" "$out"

admin_count="$(psql_x -c "select count(*) from public.profiles where email = '$EMAIL'")"
[[ "$admin_count" = "0" ]] \
  && pass "the refused run created no administrator" \
  || fail "the refused run created an administrator anyway"

# --- 2. a global replace is not mistaken for an untouched file --------------
sed "s/REPLACE-WITH-THE-ADMIN-EMAIL/$EMAIL/; s/REPLACE-WITH-YOUR-OWN-CODE/$CODE/" \
  "$SCRIPT" >"$WORKDIR/replaced.sql"
out="$(psql -X -q -v ON_ERROR_STOP=1 -d "$DATABASE" -f "$WORKDIR/replaced.sql" 2>&1)"
status=$?
check "an edited bootstrap passes the placeholder check" nonzero "no auth user with email" "$status" "$out"

# --- 3. a real user: success, no code printed, one live code ----------------
psql_x -c "insert into auth.users (id, email) values ('$USER_ID', '$EMAIL') on conflict (id) do nothing;" >/dev/null

out="$(psql -X -q -v ON_ERROR_STOP=1 -d "$DATABASE" -f "$WORKDIR/replaced.sql" 2>&1)"
status=$?
check "the bootstrap succeeds for an existing auth user" 0 "Admin ready" "$status" "$out"

if contains "$CODE" "$out"; then
  fail "the bootstrap printed the access code"
  printf '%s\n' "$out" >&2
else
  pass "the bootstrap never prints the access code"
fi

role="$(psql_x -c "select role from public.profiles where id = '$USER_ID'")"
[[ "$role" = "admin" ]] && pass "the account is an admin" || fail "role is '$role', expected admin"

grant="$(psql_x -c "select count(*) from public.user_roles where user_id = '$USER_ID' and role = 'admin'")"
[[ "$grant" = "1" ]] && pass "the admin grant exists on both authorisation paths" \
                    || fail "user_roles grant missing"

# --- 4. idempotent: a second run leaves exactly one live code ---------------
psql -X -q -v ON_ERROR_STOP=1 -d "$DATABASE" -f "$WORKDIR/replaced.sql" >/dev/null 2>&1
live="$(psql_x -c "select count(*) from public.admin_access_codes where user_id = '$USER_ID' and not is_revoked")"
[[ "$live" = "1" ]] \
  && pass "running the bootstrap twice leaves exactly one live lookup code" \
  || fail "found $live live codes after two runs; expected 1"

audited="$(psql_x -c "select count(*) from public.audit_logs where entity_id = '$USER_ID' and action = 'admin.bootstrap'")"
[[ "$audited" -ge 1 ]] && pass "the bootstrap is audited" || fail "no audit row was written"

# --- 5. the code only contains a hash --------------------------------------
plain="$(psql_x -c "select count(*) from public.admin_access_codes where user_id = '$USER_ID' and code_hash like '%$CODE%'")"
[[ "$plain" = "0" ]] && pass "the access code is stored only as a hash" \
                     || fail "the access code is stored in plain text"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [[ "$FAIL" -ne 0 ]]; then
  printf '✗ scripts/bootstrap-admin.sql does not behave as documented\n' >&2
  exit 1
fi
printf '✓ bootstrap script is safe to run\n'
