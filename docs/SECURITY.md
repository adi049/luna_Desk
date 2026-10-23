# Security model

The entire app runs in a browser on a static host. Nothing in the bundle is
trusted, so every rule that matters is enforced in Postgres or in an Edge
Function.

---

## Who can do what

| Actor | Credential | Enforced by |
| --- | --- | --- |
| Admin (agency) | Supabase Auth session from email + password, optional MFA / magic link. A lookup code identifies the account, never authenticates it. | `public.is_admin()` re-read server-side in RLS and inside every RPC; the browser cannot pass a role. |
| Client | Access code (5–20 A–Z/0–9) exchanged for a session by `access-code-login` | bcrypt hash in `client_access_codes`, verified in `rpc_redeem_access_code` (SECURITY DEFINER, service role only), then a single-use magic-link token hash. |
| Anonymous | none | `anon` has **no** table privileges; the only callable endpoint is `access-code-login`, and it answers only origins listed in `APP_ORIGINS`. |
| Scheduler | `x-cron-secret` or service key | checked inside `send-reminders` before any query. |

Client sessions carry **no** client id of their own choosing. `current_client_id()`
resolves it from `auth.uid()` → `profiles.client_id`, and returns `null` unless
the profile is active **and** the client is `active` with `portal_status = 'active'`.
A revoked portal therefore loses every row at once, without waiting for token
expiry. `RequireClient` on the client side is convenience only — the database is
what actually stops the request.

`ADI000` is not an admin credential. `rpc_lookup_admin_code` returns an email
address and nothing else; the password (or a magic link, or MFA) still has to
succeed. If the lookup code leaks, an attacker learns one address.

## What protects the data

- **RLS on every table** (`supabase/migrations/0002_rls.sql`). Row-level, not
  column-level: any field a client can read is a field they are allowed to read.
- **Deactivation is authoritative.** `is_admin()` requires an *active* profile
  and only then considers the `user_roles` grant, so deactivating an admin
  revokes authorization through both paths at once. `rpc_set_admin_active()`
  only ever changes `is_active`; it never writes `role`. That asymmetry is
  deliberate. An earlier version did `set is_active = p_active, role = 'admin'`,
  which meant any signed-in user could call the RPC and promote themselves — it
  was both an escalation *and* a role rewrite. The function now refuses any
  target whose profile is not already an administrator (SQLSTATE `42501`),
  refuses client-linked profiles, refuses self-deactivation and refuses to
  remove the last active administrator, and it writes an `admin.deactivate` /
  `admin.reactivate` audit row before and after the change.
- **Admin bootstrap is not an API.** `rpc_promote_admin()` is executable by no
  role at all (not `anon`, not `authenticated`, not even `service_role`), so it
  can only be run from the SQL editor as the function owner. Migration 0009 also
  installs a tripwire that fails the migration if any future function assigns
  `role = 'admin'` outside the two reviewed ones.
- **Internal notes are a separate table.** `public.internal_notes` has no client
  policy at all, because RLS filters rows, not columns — an `internal_notes`
  column on `clients` would be readable by the client whose row it describes.
  The Supabase adapter joins it back in for admin screens only.
- **Personal productivity data is owner-scoped.** Tasks, notes, reminders,
  calendar events and stopwatch sessions are visible only to `owner_id =
  auth.uid()`. The agency owner cannot read a teammate's private notes — and the
  database, not the UI, enforces that.
- **Client-visible sharing is explicit.** `projects.client_visible`,
  `project_updates.client_visible`, `calendar_events.client_visible` all default
  to off/false; a client only ever sees rows flagged for them *and* belonging to
  their own client id.
- **Money is only written through RPCs — and the tables enforce it.**
  `payments`, `receipts`, `document_sequences` and `audit_logs` have their
  INSERT/UPDATE/DELETE/DELETE privileges **revoked from `authenticated`**
  (migration 0007). Only `SELECT` remains, so an admin session using PostgREST
  or supabase-js directly cannot insert a payment, edit a receipt snapshot,
  delete financial history or seed the numbering sequence. The RPCs are
  SECURITY DEFINER and run as the schema owner, so they are unaffected.
  `rpc_record_payment` locks the invoice row, rejects overpayment, recomputes
  the status and writes an audit row in one transaction.
- **Invoice status is derived, never supplied.** A trigger recomputes the stored
  status from the payments on every write, so nobody can mark an unpaid invoice
  `paid` and have it read as revenue. `cancelled` is the one status an admin may
  set deliberately.
- **Receipt numbers cannot collide.** `next_document_number()` increments a row
  in `document_sequences` with an `ON CONFLICT … DO UPDATE` returning the new
  value, which serialises concurrent issuers. A payment can have exactly one
  receipt (`unique (payment_id)`).
- **Receipts are snapshots.** The document is assembled server-side at issue time
  and stored as JSON. A later correction cannot silently rewrite a receipt the
  client already has; voiding the payment marks the receipt void and keeps it.

## Credential hygiene

- Access codes are stored as `crypt(code, gen_salt('bf', 10))`. The plain text
  exists only in the request that creates it and in the agency's own records.
- Rotating a code revokes the old row (`is_revoked`, `rotated_at`) rather than
  overwriting it, so the audit trail survives.
- Codes carry an optional hard expiry (`expires_at`, admin-only via
  `rpc_set_client_code_expiry`). An expired code is treated exactly like an
  unknown one.
- A code is also refused when the linked profile is inactive, so deactivating a
  portal identity works even if nobody rotated the code.
- No password is ever created for a client account. There is nothing to phish
  beyond a 5-character code, which is rate-limited.
- `service_role` appears only inside `supabase/functions/**`. It is never read
  from `import.meta.env`, never bundled, and the frontend has no code path that
  could reach it.
- Edge Functions verify the caller's JWT **and** their admin role in
  `requireAdmin()` before touching the Auth Admin API.

## Rate limiting and abuse

`access_attempts` records every redemption with outcome (`ok`, `bad_code`,
`rate_limited`, `access_disabled`, `admin_lookup`), a 3-character code hint and
the kind (`client` / `admin`). Every counter is scoped; **there is no global
counter**, because a single unauthenticated caller must never be able to deny
service to a legitimate user.

| Surface | Per IP | Per code prefix | Window |
| --- | --- | --- | --- |
| Client portal codes | 8 failures | 30 failures | 10 minutes |
| Admin lookup codes | 10 failures | 40 failures | 10 minutes |

The per-prefix ceiling is intentionally far above the per-IP one: it stops
distributed guessing of one code without letting one attacker lock out a shared
prefix. An earlier design keyed the admin limiter on the constant string `ADI`,
which meant ten bad requests from anywhere locked out **every** administrator;
that is fixed and covered by a test asserting a second IP still succeeds.

- Unknown, malformed and revoked codes return the same message, so the endpoint
  cannot be used to discover which codes exist.
- A code that is valid but belongs to a deactivated client returns
  `access_disabled` — the code is genuine, so telling the client to contact the
  agency is more useful than pretending it does not exist.
- Client IPs come from `cf-connecting-ip` (set by the edge network and not
  client-controlled) or the *last* hop of `x-forwarded-for`, never the first
  hop the caller can forge. The per-prefix bucket is the real backstop if an IP
  is spoofed.

## Audit trail

`audit_logs` is written by the database (`audit_row_change()` on `clients`,
`client_services`, `projects`, `invoices`, `branding_settings`) and by every
financial RPC, with `before`/`after` JSON. No-op updates are skipped. The log is
readable by admins only; there is no delete path in the app.

Financial history is never destroyed:

| Event | What happens |
| --- | --- |
| Wrong payment recorded | `rpc_void_payment` sets `voided_at` + reason, recalculates the invoice, voids the receipt — rows stay. |
| Client deactivated | Portal access is revoked; invoices, payments and receipts remain. |
| Client archived | Refused while anything is outstanding; archiving revokes portal access but keeps the financial record. |
| Invoice corrected | Update is audited with the previous values; totals must still equal subtotal − discount + tax. |

## Session handling

- JWTs expire after 1 hour; refresh rotation is on with a 10-second reuse window.
- Sign-out clears the Supabase session and the cached user id.
- A revoked portal stops matching RLS immediately (`current_client_id()` returns
  null), while the existing token simply expires.
- The admin "Account & Security" page changes the password through Supabase Auth
  (`updateUser`) and never displays a stored credential; in demo mode the control
  is disabled with an explanation instead of pretending to change anything.

## Reporting

This is a private workspace, not a multi-tenant SaaS. If you fork it for
multiple agencies, the two things you must change first are the
`branding_settings` singleton (one row per agency) and every place that assumes a
single admin `profile`.

## Threat notes

| Threat | Mitigation |
| --- | --- |
| Guessing a 5-character code | bcrypt + 8 attempts / 10 min per IP and 30 per prefix; 36⁵ space; codes are rotated when a client leaves and can be given an expiry. |
| Direct financial writes through the API | Table privileges revoked for `authenticated`; only SECURITY DEFINER RPCs can write payments/receipts/sequences. |
| Forged invoice status | A trigger derives status from payments on every write. |
| Admin lockout via the login limiter | Every rate-limit counter is per-IP or per-prefix; no global bucket exists. |
| Reading another client's invoices | RLS `is_client_of(client_id)` on every billing table; the portal never filters in the browser only. |
| Forging an admin role | Role lives in `profiles`/`user_roles`, read through SECURITY DEFINER helpers; client-side claims are ignored. |
| Overpaying an invoice to fake revenue | Invoice row locked, `paid + amount > total` rejected, status recomputed by trigger. |
| Duplicate receipt numbers | Sequence row lock; `unique(payment_id)`; retries get a clear error, not a second document. |
| Silent data loss in notes | Debounced autosave writes the full body and reports its state; nothing is dropped without an error being shown. |
| XSS through notes/projects | Stored HTML is sanitised on write **and** on render (`src/lib/sanitize.ts`); no `dangerouslySetInnerHTML` without it. |
| Arbitrary code in the calculator | `src/lib/calc.ts` tokenises and parses by hand — no `eval`, no `Function`; anything outside `0-9 . + - * / % ( )` is rejected. |
