# Pre-Supabase audit — LunaDesk

Date: 2026-10-23, extended 2026-10-24
Scope: the repository as committed at `0e38f7d`, hardened locally in two rounds
(§9 is the second round).
**No live Supabase project was contacted, created or modified.** Every database
result below comes from a local PostgreSQL 17 instance running the migrations in
`supabase/migrations/`.

Everything in the "Verified" sections was produced by a command that is listed
next to it and can be re-run. Anything I could not execute is listed under
"Not run" with the reason.

---

## 1. Bugs fixed

### Blocking: live mode could not perform any financial or portal action

`src/lib/data/supabase.ts` called Postgres functions by their short names
(`record_payment`, `issue_receipt`, `void_payment`,
`change_client_access_code`, `create_client_portal`, `revoke_client_access`,
`refresh_invoice_status`), but the migrations define `rpc_record_payment(p_invoice_id, …)`
and friends. Parameter names differed too. Against a real project every one of
these calls would have failed with "function not found".

The demo adapter implements the short names, so **demo mode worked perfectly and
hid the defect entirely**. This was the single highest-risk problem found: it
would have surfaced only after connecting a real project, and would have looked
like a broken app rather than a naming mismatch.

Fixed by introducing an explicit binding table (`RPC_BINDINGS`) in the Supabase
adapter that maps each UI operation to its SQL function and parameter names, and
by adding `scripts/check-rpc-contract.mjs`, which parses both sides and fails the
build if they drift. The check was verified to fail when the old mapping is
restored (see §5).

### Status precedence disagreed between layers

`recomputeInvoiceStatus()` in the demo adapter, the SQL payment trigger and
`finance.ts#effectiveStatus` computed "partially paid" vs "overdue" in different
orders, so a past-due part-paid invoice could read differently in the UI, the
demo store and the database. All three now use the same precedence:
`cancelled > paid > overdue > partially_paid > pending`.

### Receipt numbering could reuse a number

The demo adapter derived the next document number from a **row count**
(`count + 1`). Deleting any receipt would make the next issue reuse an existing
number. It now takes the highest existing number for the year and adds one.

### Voiding a payment did not void its receipt (demo)

`void_payment` reported `receipt_voided: true` in the demo adapter but left the
receipt row untouched, so a reprint still looked valid. It now marks the receipt
voided with the same reason, matching `rpc_void_payment`.

### Cancelled invoices accepted payments (demo)

The SQL RPC refuses a payment against a cancelled invoice; the demo adapter did
not. Both refuse now.

### Expired/disabled portal identities could still sign in

`rpc_redeem_access_code` did not check `expires_at`, and did not re-check that
the linked profile was still active — so deactivating a portal identity did not
stop an existing code from working. Both are now enforced.

### Invoice totals could drift from line items (demo)

The SQL guard exists; the demo path allowed an inconsistent total. *(Carried
forward: the demo adapter's invoice creation is unchanged, but the derived-status
recompute now runs on every write.)*

### Mobile: Reports page overflowed horizontally

`grid`/`flex` children default to `min-width: auto`, so a wide financial table
pushed the page wider than a 390 px viewport instead of scrolling inside
`.table-wrap`. Fixed once in `src/index.css` (`.grid > *, .flex > * { min-width: 0 }`)
so every page benefits, not just Reports. Verified across all 17 admin routes and
5 portal routes at 390 px.

### Internal notes could not be saved in live mode

The adapter upserts one note per client via `onConflict: 'client_id'`, but the
matching unique index was **partial** (`where client_id is not null`), which
PostgREST cannot use for `ON CONFLICT`. Reproduced in isolation:

```
-- against a partial index
ERROR:  there is no unique or exclusion constraint matching the ON CONFLICT specification
-- against a total index
INSERT 0 1
```

The indexes are now total (in Postgres, NULLs are distinct in a unique index, so
notes for different owners still do not collide).

### Frontend robustness

- `PaymentsPage` — "Issue receipt" had no in-flight guard; double-clicking fired
  two requests. Now one per payment.
- `NotesPage` pin/unpin and `ProjectDetailPage` visibility toggle could reject
  without any user-visible feedback. Both now surface an error toast.
- Client portal flows called **two conflicting RPCs in sequence**
  (`create_client_portal` then `change_client_access_code`); they now pick the
  correct single operation from the portal's current state.
- "Restore portal access" could report success while the portal still had no
  usable code. It now fails with an actionable message instead.

---

## 2. Security issues fixed

### `is_admin()` ignored profile deactivation (critical)

```sql
-- before: the user_roles branch short-circuited the is_active check
select exists (select 1 from profiles where id = auth.uid() and role='admin' and is_active)
    or exists (select 1 from user_roles where user_id = auth.uid() and role='admin');
```

Deactivating an admin revoked nothing if a `user_roles` row existed — which the
bootstrap script creates for every admin. Fixed so the profile must be active
**and** hold the role by either path. `rpc_set_admin_active()` also deletes the
`user_roles` grant on deactivation, so re-activation is deliberate. Covered by
tests in §5 (4 assertions).

### Financial tables were writable through the REST API

RLS policies granted `ALL` on `payments`, `receipts` and `document_sequences` to
admins. RLS is row-level, so an admin session could insert a payment, rewrite a
receipt snapshot, delete financial history or seed the receipt sequence —
bypassing the transactional RPCs that enforce overpayment rules and numbering.

These privileges are now revoked from `authenticated` (INSERT/UPDATE/DELETE/
TRUNCATE) on `payments`, `receipts`, `document_sequences`, `audit_logs` and
`access_attempts`. The RPCs are SECURITY DEFINER and unaffected. Covered by 6
assertions.

### Invoice status could be forged

Nothing stopped an admin setting `invoices.status = 'paid'` with no payments,
which would have shown as revenue in reports and in the client portal. A trigger
now recomputes status from the payments on every write; `cancelled` remains an
explicit admin action. Covered by 2 assertions.

### Admin-code rate limiting allowed global lockout

`rpc_lookup_admin_code` counted failures with a **constant** hint (`'ADI'`), so
ten bad requests from anyone locked out every administrator. Limits are now
per-IP (10) and per code prefix (40), and no global counter exists. Covered by 2
assertions, including one asserting a second IP still succeeds.

### Access-code weaknesses

- No expiry — added `expires_at` (admin-only `rpc_set_client_code_expiry`).
- Attempt counting was per client code prefix only; the ledger now records
  `code_kind` and the real prefix, and the limiter is shared by both entry points.
- A valid code for a deactivated client now returns `access_disabled`; unknown,
  malformed and revoked codes remain indistinguishable.

### CORS failed open

`_shared/http.ts` reflected **any** origin when `APP_ORIGINS` was unset. On an
endpoint that accepts a credential that is backwards. It now allows nothing
cross-origin unless listed, and normalises trailing slashes.

### Client IP was spoofable

`x-forwarded-for`'s **first** entry is caller-controlled. The functions now prefer
`cf-connecting-ip` and otherwise take the **last** hop. The per-prefix bucket
remains the backstop if an IP is still spoofed.

### Admin deactivation / self-lockout

`rpc_set_admin_active` refuses to let an admin deactivate their own account,
which would otherwise strand a single-admin workspace.

---

## 3. Reminder & notification correctness

The scheduler selected `remind_at <= now()` with no claim and no
`fired_at is null` filter, so:

1. one-time reminders were re-selected on every run and pushed again;
2. two overlapping scheduler runs could both push the same occurrence;
3. a crash between push and state-update re-sent on the next run;
4. after downtime, repeating reminders replayed the whole backlog;
5. `fired_at` was set on every occurrence, so the "already fired" concept was
   meaningless for repeating reminders.

Now:

- the scan filters `fired_at is null`;
- **`reminder_deliveries`** has `unique (reminder_id, occurrence)`; the unique key
  is taken as a claim **before** any send, and every later query is scoped to
  the claimed occurrence;
- `notifications.dedupe_key` (already unique) remains as the third layer;
- repeating reminders advance **past now** in one step, so a backlog notifies
  once instead of N times, and `fired_at` is cleared so the next occurrence can
  fire;
- failures are recorded with `rpc_mark_reminder_delivery`, so a dead subscription
  is visible instead of silently re-firing;
- `push_subscriptions` rows answering 404/410 are deleted (previously only
  logged).

In the browser, `ReminderWatcher` keyed its in-flight set on `reminder.id`, so a
repeating reminder could never ring a second time in the same session, while its
"dismiss" path cleared that key and could re-fire the same occurrence.
It now keys on `reminder.id + occurrence`, uses the same dedupe key as the
scheduler, and deep-links client notifications to `/portal/reminders` instead of
an admin route clients cannot open.

Docs were corrected: `docs/ALARMS_AND_NOTIFICATIONS.md` now states plainly that
no web API can guarantee a loud alarm from a closed browser, that push is
best-effort, and that a notification is not proof of delivery.

---

## 4. Files changed

**New**

| File | Purpose |
| --- | --- |
| `supabase/migrations/0007_authorization_hardening.sql` | `is_admin` fix, revoked financial writes, derived invoice status, code expiry, total note indexes |
| `supabase/migrations/0008_code_and_reminder_hardening.sql` | scoped rate limiter, code redemption rewrite, reminder claims, portal lifecycle RPCs |
| `scripts/check-rpc-contract.mjs` | fails the build when the browser/SQL RPC contract drifts |
| `scripts/scan-secrets.mjs` | credential scan of the tree and of git history |
| `docs/AUDIT.md` | this report |

**Modified**

`supabase/migrations/0003_rpc.sql` (idempotent receipt issue) ·
`supabase/tests/rls.sql` (48 → 70 assertions) ·
`supabase/functions/send-reminders/index.ts` (claim-based scheduler) ·
`supabase/functions/_shared/http.ts` (CORS + IP) ·
`src/lib/data/supabase.ts` (RPC bridge) ·
`src/lib/data/demo.ts` (parity fixes) ·
`src/components/reminders/ReminderWatcher.tsx` ·
`src/pages/admin/ClientDetailPage.tsx` · `src/pages/admin/PaymentsPage.tsx` ·
`src/pages/admin/ProjectDetailPage.tsx` · `src/pages/shared/NotesPage.tsx` ·
`src/index.css` · `vite.config.ts` (build guard, CI sourcemaps) ·
`.github/workflows/deploy.yml` (env guard, contract check, secret scan) ·
`package.json` · `.env.example` · `README.md` ·
`docs/SECURITY.md` · `docs/SETUP.md` · `docs/ALARMS_AND_NOTIFICATIONS.md`

No route, page, feature, colour token or component was removed. The visual
identity is unchanged: the only CSS change is a `min-width: 0` rule that affects
layout overflow, verified against desktop screenshots before and after.

---

## 5. Tests actually run (with results)

All commands were executed in this environment. "Passed" below means the command
exited 0 and the quoted output was observed.

### `npm run typecheck` — **passed**

`tsc --noEmit`, strict, `noUnusedLocals`. No output, exit 0.

### `npm run check:rpc` — **passed** (and proven to catch the bug)

```
Parsed 35 SQL functions, 7 bridged calls.
✓ RPC contract holds: every bridged call maps to an existing, granted function with matching parameters.
```

Negative control — restoring the original bad mapping:

```
✗ Bridge alias 'record_payment' → record_payment() does not exist in the migrations.
exit=1
```

### `npm run check:secrets` / `:history` — **passed**

```
✓ No credential-shaped strings in tracked files.
✓ No credential-shaped strings in any committed blob.
```

Negative control: a file containing a JWT-shaped string was staged and detected:

```
✗ .tmp-secret-check.ts:1 — JWT (eyJhbG…7890)
exit=1
```

### `npm run verify:db` (`scripts/verify-migrations.sh`) — **passed**

Recreates a scratch database, installs a Supabase shim (auth schema, roles,
`auth.uid()`), applies all 8 migrations, runs `supabase/tests/rls.sql`.

```
ALL TESTS PASSED
✓ schema verified
```
**70 assertions** (up from 48). New coverage:

| Area | Assertions |
| --- | --- |
| Deactivated admin loses auth via both role paths; cannot read rows or call financial RPCs | 4 |
| Direct INSERT/UPDATE/DELETE on payments, receipt snapshot rewrite, sequence seeding | 6 |
| Forged invoice status corrected; deliberate cancel still allowed | 2 |
| Expired code rejected; unexpired code accepted | 2 |
| Per-IP limiter trips; **a different IP is not locked out** | 2 |
| Deactivated portal profile blocked despite a valid code | 1 |
| Reminder claim is atomic; second worker refused; next occurrence claimable; failure recorded | 5 |
| Internal-notes upsert on `(client_id)` updates in place | 2 |
| Receipt issue is idempotent; one payment → one receipt | 2 |

Pre-existing coverage retained: cross-tenant isolation, internal notes hidden
from clients, owner-only personal tasks, client-visible flags, overpayment
refusal, per-period outstanding, void-and-recompute, archive guard, receipt
numbering, admin lookup identity-only.

### `npm run build` — **passed** (CI configuration)

```
✓ built in 13.89s
2.4M dist
```
`CI=true` omits sourcemaps (13.9 s, 2.4 MB instead of 11 MB — the three.js map
alone is 2.6 MB, and a public Pages site does not need to ship readable source).

A full heap-exhaustion was hit on this 2 GB sandbox when sourcemaps were on:

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed
```

It builds successfully with a bounded heap:
`NODE_OPTIONS=--max-old-space-size=1024 npx vite build` → `✓ built in 19.54s`.
This is an environment limit, not a code defect; both workarounds are documented
in the README.

### Live-build guard — **passed in both directions**

```
VITE_DATA_MODE=live npx vite build   (no secrets)
Error: [lunadesk] Refusing to build a live bundle: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are missing.

VITE_DATA_MODE=live VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… npx vite build
✓ built in 23.61s
```

### Browser audit (Chromium via Playwright, demo mode) — **passed**

- **17 admin routes + 5 portal routes**: every route rendered a heading; **zero
  console errors, zero page errors**.
- **Guards**: a client session navigating to `#/admin/clients` and `#/admin/settings`
  is redirected to `#/portal`.
- **Routing**: deep link `#/admin/payments` survives a reload; browser back/forward
  move between `#/admin/payments` and `#/admin/clients` correctly; the receipt
  print route `#/admin/receipts/:id` renders `.print-sheet`, contains **no
  sidebar**, shows a print control, and survives a reload.
- **Responsive**: 390×844, 768×1024, 1440×900 — no horizontal overflow on any of
  the 22 routes after the CSS fix (one overflow was found and fixed on Reports at
  390 px), mobile and tablet navigation drawers open.
- **Golden path**: recorded a payment through the dialog — rows 8 → 9, dialog
  closed, amount reflected, no errors.

---

## 6. Tests NOT run, and why

| Not run | Reason |
| --- | --- |
| Edge Functions executed (`access-code-login`, `admin-clients`, `send-reminders`) | They require the Deno runtime plus a Supabase project's Auth Admin API and secrets. Not installable/runable here without a live project, which the task forbids. Their **database half** is tested (`rpc_redeem_access_code`, `rpc_lookup_admin_code`, `rpc_claim_reminder`, `rpc_mark_reminder_delivery`). |
| RLS against a real Supabase instance | No project permitted. Tested against local PostgreSQL 17 with a shim for `auth.uid()`/roles; Supabase-specific behaviour (JWT claims, PostgREST `on_conflict`) is *inferred* from documentation and reproduced where possible (see the partial-index reproduction). |
| Supabase Storage logo upload | Needs a real bucket. |
| Real Web Push delivery to a device | Needs VAPID keys, a live function and a subscribed device. |
| `Notification.requestPermission()` granted path | Headless Chromium cannot grant a real OS-level permission; the denied path renders correctly (verified visually). |
| Magic-link / MFA admin sign-in | Requires a live Auth project and a mailbox. |
| Lighthouse / axe accessibility audit | Not available in this sandbox. Manual checks only: skip link, labelled controls, `role="alertdialog"` on the alarm overlay, keyboard-dismissible overlays, focus-visible rings. |

No test above is reported as passing without the command and output being shown.

---

## 7. Remaining issues that require a real Supabase project

These are **unverified** by definition and must be checked after connecting:

1. **`verifyOtp({ token_hash, type: 'magiclink' })`** — the type was corrected to
   match `generateLink({ type: 'magiclink' })`, but the round trip has never run
   against a live Auth server.
2. **PostgREST `on_conflict` for internal notes** — fixed on the schema side and
   proven locally, but PostgREST's own behaviour should be confirmed once.
3. **`pg_cron`/`pg_net` scheduling** of `send-reminders`, and whether the
   function's 60-second horizon is reliable under real timing.
4. **Edge Function cold-start and CORS** against the real Pages origin — set
   `APP_ORIGINS` exactly, including the scheme and no trailing slash.
5. **Storage bucket policies** for `branding` (documented in `docs/SETUP.md`;
   cannot be applied here).
6. **Real push delivery**, including iOS Safari's stricter install requirement.
7. **Auth rate limits** — Supabase's own per-IP limits on `signInWithPassword`
   are independent of LunaDesk's and should be reviewed in the dashboard.
8. **Timezone behaviour** of the scheduler across a real DST boundary (the
   arithmetic is documented and unit-reasoned, not integration-tested).

## 8. Production readiness

**Not yet claimed.** The repository is internally consistent and every check
available offline passes, but the app has never authenticated against, or written
to, a real Supabase project. The honest statement is:

> Ready for a first deployment to a staging Supabase project, with items 1–8 in
> §7 verified before calling it production-ready.

The hard blocker that would have made a first deployment fail outright — the RPC
name mismatch — is fixed and now guarded by an automated check.

---

# 9. Second hardening round (2026-10-24)

Six defects reported after the first round were reproduced, fixed and — where
possible — proven by a test that fails without the fix. Reproductions used a
throwaway database and were deleted afterwards.

## 9.1 Privilege escalation through `rpc_set_admin_active`

**Reproduced.** A signed-in user whose profile said `role = 'client'` called
`rpc_set_admin_active(<own id>, true)` and came out as an administrator with a
`user_roles` grant. The function's body was
`set is_active = p_active, role = 'admin'`, so the "activation" toggle was a
promotion primitive available to every authenticated session, and it also
rewrote `role` on accounts that were already admins.

**Fixed** (`0008_code_and_reminder_hardening.sql`). The function now
`assert_admin()`s the caller, then requires the *target* to already be an
`admin` (`42501`), to have no `client_id` (`42501`), refuses self-deactivation
and last-active-admin deactivation (`P0001`), returns
`{ok, changed, is_active}` instead of being void, and writes an audit row with
`role_before`/`role_after`/`is_active`. It never writes `role`.

**Proven.** Five new test blocks in `supabase/tests/rls.sql` §6 (client and
ordinary users cannot be promoted; role unchanged and no grant created by a
refused call; a real admin is toggled with the role preserved and the grant
restored on reactivation; the workspace always keeps an active admin; a client
session cannot call the function at all). A **mutation test** re-introduced the
old body and the suite failed with
`FAIL: an ordinary user cannot be promoted to admin through rpc_set_admin_active`.

One honest note: the count-based "last admin" guard is currently unreachable,
because a caller who is an active admin and a target who is the *only* active
admin must be the same row, so the self-deactivation guard fires first. It is
kept as a defensive second gate, and the test asserts the reachable path by its
message rather than pretending to exercise dead code.

## 9.2 Reminder occurrences could become permanently unclaimable

**Reproduced.** After a simulated worker crash between claim and outcome,
`rpc_claim_reminder` returned `first = t, after_crash = f, later = f` on a
single row: the claim row existed, no outcome was ever recorded, and nothing
could ever reclaim it. The reminder silently never rang again.

**Fixed.** The claim is now a lease: `reminder_deliveries` gained `attempts`,
`lease_expires_at`, `last_attempt_at` and `finished_at`, and
`rpc_claim_reminder(uuid, timestamptz, text, integer lease_seconds, integer
max_attempts)` returns `{claimed, attempt, reason}` with `reason` one of `new`,
`already_delivered`, `lease_active`, `lease_expired`, `attempts_exhausted`.
`rpc_mark_reminder_delivery(…, p_retry_after_seconds)` releases the lease on
failure with a backoff. Delivered occurrences are terminal; exhausted ones are
abandoned visibly. The prune keeps undelivered rows inside their attempt budget.

**Also fixed in the caller.** `supabase/functions/send-reminders/index.ts`
compared the claim result to `true`; with the jsonb return that comparison is
always false, so *every* reminder would have been silently skipped. It now
parses the result (`normaliseClaim`, which still accepts the old boolean so a
stale deployment cannot be read as truthy) and passes lease/attempt/backoff
parameters.

**Proven.** `supabase/tests/rls.sql` §5h–5k: crash recovery, bounded attempts,
delivered-is-terminal, and a recorded failure handing the occurrence back for an
immediate retry.

## 9.3 The migration verifier could pass on a broken migration

**Reproduced.** A migration containing a syntax error printed the psql error and
then `✓ schema verified`, exit **0** — `psql … | grep … || true` discarded both
the exit status and the error text.

**Fixed.** `scripts/verify-migrations.sh` was rewritten: every SQL step runs
through `run_sql_file`, which captures output to a temp file and exits non-zero
with the psql text preserved; the suite must print `ALL TESTS PASSED` or the run
fails; `MIGRATIONS_DIR` allows a different tree.

**Proven** by a new meta-test, `scripts/test-verify-migrations.sh` (13
assertions, `npm run test:verifier`), which checks that the verifier exits 1 for
a syntax error, for a failing assertion, for a suite that stops before the end,
and for an empty migrations directory — **and** exits 0 on an unmodified tree,
so a verifier that simply always fails does not pass the meta-test either.

## 9.4 Live builds accepted `.env.example` placeholders

**Found while fixing the duplicate `VITE_DATA_MODE` documentation** (the file
set `VITE_DATA_MODE=live` at line 11 and then re-explained the build guard at
lines 45–50, with no single source of truth).

The build guard only checked that the variables were non-empty. Copying
`.env.example` unchanged gives `https://YOUR-PROJECT.supabase.co` and
`your-anon-publishable-key`, which are non-empty — so the "safety" guard would
happily publish a live bundle pointing at a project that does not exist.

**Fixed.** `.env.example` is rewritten with one section per setting and a single
statement of the build rules. `vite.config.ts` now rejects placeholder values,
keys too short to be a publishable key, and any URL that is not `https`
(localhost/127.0.0.1 excepted), and reports every problem at once.

**Verified** by building with the placeholder values (fails, naming both
variables), with an `http://` URL (fails), and with realistic values in both
live and demo mode (both succeed).

## 9.5 Administrator sign-in ignored the reason a lookup failed

`signInWithAccessCode` unwrapped the Edge Function's error body, but
`signInAdminWithCode` replaced every failure with "Administrator code
verification failed" and dropped `retry_after`, so a rate-limited administrator
was told their code was wrong and retried immediately, extending the lockout.
Both paths now share one `invokeFunction` helper, and `LoginPage` passes
`retryAfterSeconds` through so the existing lockout countdown applies.

## 9.6 `rpc_promote_admin` was an unaudited admin factory

The function mints an administrator from an email address, wrote no audit row,
and was granted to `service_role` — reachable at `/rest/v1/rpc/rpc_promote_admin`
by anything holding the service key. Nothing in the app or the scripts calls it
(`scripts/bootstrap-admin.sql` does the same work inline), so it was pure
downside.

**Fixed** (`0009_admin_bootstrap_lockdown.sql`): the function is still available
for the documented SQL-editor bootstrap, but its execute grant is removed from
`public`, `anon`, `authenticated` **and** `service_role`, it validates the email,
and it writes an `admin.promote` audit row. The migration also installs a
tripwire that fails if any other function assigns `role = 'admin'`.

**Proven** by `supabase/tests/rls.sql` §7: `has_function_privilege` is false for
all three roles, and the tripwire query is asserted to flag a planted escalating
function while not flagging `is_admin()`.

## 9.7 Checks actually run in this round

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | pass, no output |
| `npm run check:rpc` | pass — 35 functions parsed, 7 bridged calls matched |
| `npm run check:secrets` | pass |
| `npm run check:secrets:history` | pass — no credential-shaped strings in any committed blob |
| `npm run verify:db` (local PostgreSQL 17) | pass — **9 migrations, 110 assertions**, `ALL TESTS PASSED` |
| `npm run test:verifier` | pass — 13/13 |
| `CI=true VITE_DATA_MODE=demo npx vite build` | pass |
| `CI=true VITE_DATA_MODE=live … npx vite build` | pass with realistic values; fails on placeholders and on `http://` |
| mutation: old `rpc_set_admin_active` restored | suite fails as intended |

Not run, and why: nothing in this round required a live Supabase project, and
none was contacted. Everything in §7 of the first audit still stands
(PostgREST `on_conflict`, `pg_cron`, real CORS, storage policies, real push
delivery, real DST boundaries).

## 9.8 Production readiness

**Still not claimed.** These fixes remove real security and reliability defects
and every offline check passes, but the application has still never
authenticated against, written to, or been deployed with a real Supabase
project. The Edge Functions have not been executed on Supabase's runtime; the
SQL has only run on stock PostgreSQL 17 with an `auth` shim. Treat the code as
ready for a staging deployment, not as production-proven.
