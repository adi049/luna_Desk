# Setup — from empty project to live workspace

About 20 minutes. You need a Supabase project and a GitHub repository.

---

## 1. Supabase project

1. Create a project at [supabase.com](https://supabase.com) (any region close to
   you; Postgres 15+).
2. **Settings → API** — copy:
   - `Project URL` → `VITE_SUPABASE_URL`
   - `anon` / publishable key → `VITE_SUPABASE_ANON_KEY`

   The `service_role` key is **not** used by the frontend at all. Never put it in
   `.env.local`, never in a GitHub secret that the build reads.

3. **Authentication → URL configuration**

   | Field | Value |
   | --- | --- |
   | Site URL | `https://<you>.github.io/lunadesk/` |
   | Redirect URLs | `https://<you>.github.io/lunadesk/**`, `http://localhost:5173/**` |

4. **Authentication → Providers → Email**: keep "Enable email provider" on
   (needed for admin magic links), and set the minimum password length to 12.

## 2. Apply the schema

Either use the CLI:

```bash
npm i -g supabase
supabase login
supabase link --project-ref <your-ref>
supabase db push          # applies supabase/migrations in order
```

…or paste the files from `supabase/migrations/` into the SQL editor **in order**,
`0001` through `0014`. `0013` makes a client's role and portal link immutable
from the API; `0014` is what makes that usable — it lets the sanctioned portal
RPC through the guard, closes the "no JWT" exemption, binds each authorisation
to one profile, refuses invoice-line moves between invoices, and steps daily and
weekly recurrences on the wall clock so a 09:00 reminder stays at 09:00 across
a DST change.

Verify locally before you push (recommended):

```bash
PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=postgres scripts/verify-migrations.sh
# → ALL TESTS PASSED / ✓ schema verified
```

The same command is `npm run verify:db`. It needs a local PostgreSQL 15+ and
**never** connects to a hosted project: it drops and recreates a scratch
database named `lunadesk_verify`.

The script recreates a scratch database, applies every migration and runs
`supabase/tests/rls.sql` (237 assertions on isolation, money, access, identity
immutability, receipts, line-item integrity and DST-safe recurrence).

### Changing a customer's portal link

Identity changes are deliberately not an API endpoint. From the **SQL editor**
(owner credentials) only:

```sql
-- Preferred: the sanctioned, audited call (owner-only, needs an 8+ character
-- reason, refuses to remove the last active administrator).
select public.rpc_set_profile_identity(
  '<auth-user-uuid>',
  'client',
  '<client-uuid>',
  're-created under the correct account, user never signed in'
);
```

If you are repairing rows by hand instead, authorise the statement first — the
guard refuses every writer without one, including the SQL editor:

```sql
select public.rpc_authorise_identity_change(
  '<auth-user-uuid>', 'repair: wrong client after re-import');

update public.profiles
   set role = 'client', client_id = '<client-uuid>'
 where id = '<auth-user-uuid>';
```

One authorisation covers one profile and one statement, and expires in two
minutes.

The call is audited (`profile.identity.change`), refuses to remove the last
active administrator, and refuses to link a profile that is not a `client`.
There is no UI for it, by design: a mis-click should not be able to move a
customer's invoices to another company.

## 3. Storage bucket for the logo

Create a **public** bucket named `branding` (Storage → New bucket). Then add
policies so only admins may write:

```sql
create policy "branding read" on storage.objects
  for select using (bucket_id = 'branding');

create policy "branding admin write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'branding' and public.is_admin());

create policy "branding admin update" on storage.objects
  for update to authenticated
  using (bucket_id = 'branding' and public.is_admin());

create policy "branding admin delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'branding' and public.is_admin());
```

Logo uploads are capped at 2 MB and must be images. The app never redraws the
logo: the uploaded file is used as-is on receipts and in the sidebar.

## 4. Edge Functions

```bash
supabase functions deploy access-code-login     # public: code → token hash
supabase functions deploy admin-clients         # admin-only: portal identities
supabase functions deploy send-reminders        # scheduler: reminders + push
```

`APP_ORIGINS` is **required**. The functions answer only the exact origins you
list (comma separated, no trailing slash). If it is unset, CORS refuses every
browser request — fail-closed by design, because `access-code-login` accepts a
credential.

Secrets (server side only):

```bash
node scripts/generate-vapid-keys.mjs    # prints a fresh key pair + CRON_SECRET

supabase secrets set \
  APP_ORIGINS="https://<you>.github.io,http://localhost:5173" \
  VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
  VAPID_SUBJECT="mailto:hello@managedbyluna.com" \
  CRON_SECRET=...
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase — do not
set them yourself.

### Scheduling the reminder job

The job is idempotent (it dedupes per occurrence), so running it every minute is
safe. Pick whichever scheduler you already pay for:

- **pg_cron + pg_net** inside Supabase (Database → Extensions → enable both):

  ```sql
  select cron.schedule(
    'lunadesk-reminders',
    '* * * * *',
    $$
    select net.http_post(
      url     := 'https://<project-ref>.supabase.co/functions/v1/send-reminders',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'x-cron-secret', '<CRON_SECRET>'),
      body    := '{}'::jsonb
    );
    $$
  );
  ```

- or a GitHub Actions cron calling the same URL with the same header.

## 5. Create the administrator

1. **Authentication → Users → Add user** — the owner's email, a strong password,
   "Auto confirm user" ticked.
2. Run `scripts/bootstrap-admin.sql` in the SQL editor with your email and your
   own lookup code (change `ADI000` to something only you know).
3. Sign in at `/#/login`: enter the code → the app asks for the password →
   session starts. **The code alone never signs you in.**

### How client portals are created

In **Clients → (client) → Portal**: "Create portal" asks for an access code and
(optionally) an email. The `admin-clients` function creates the auth identity,
attaches it to the client and stores the code as a bcrypt hash. Rotate or revoke
the code any time; revoking also disables the account and its RLS access
immediately.

Codes are the only thing a client needs — no password, no email round-trip. The
`access-code-login` function verifies the code server-side (hashed compare in
Postgres), rate-limits it, and returns a single-use token hash that the browser
immediately exchanges for a session.

## 6. Deploy to GitHub Pages

1. Push the repository to GitHub.
2. **Settings → Pages → Source: GitHub Actions**.
3. **Settings → Secrets and variables → Actions → New repository secret**:
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPPORT_EMAIL` (optional),
   `VITE_VAPID_PUBLIC_KEY` (optional).
4. `BASE_PATH` is derived automatically from the repository name by
   `.github/workflows/deploy.yml` (use `/` for a custom domain by editing that
   one line).

   The workflow **fails before building** if `VITE_SUPABASE_URL` or
   `VITE_SUPABASE_ANON_KEY` is missing, and `vite build` itself refuses to emit
   a live bundle without them — so a half-configured deploy stops in CI instead
   of publishing an app that cannot sign anyone in. The guard also rejects
   values that are still the `.env.example` placeholders (`YOUR-PROJECT`,
   `your-anon-publishable-key`), keys shorter than a real publishable key, and
   any URL that is not `https` (plain `http` is accepted only for `localhost` /
   `127.0.0.1`, for a local `supabase start`). Copying `.env.example` unchanged
   therefore cannot produce a "successful" deploy of a dead site — a failure
   mode that previously passed, because placeholder strings are non-empty. The
   workflow also runs the RPC contract check (`scripts/check-rpc-contract.mjs`)
   and a secret scan (`scripts/scan-secrets.mjs`).
5. Push to `main`. The workflow typechecks, builds, and publishes `dist/`.

## Bootstrap the first administrator

`scripts/bootstrap-admin.sql` is run once, in the Supabase SQL editor. It ships
with unmistakable `REPLACE-WITH-…` placeholders and **refuses to run** until you
replace both; it also refuses if the auth user does not exist, keeps exactly one
live lookup code per account, writes an audit row, and **never prints the access
code** (SQL editor output ends up in screenshots and tickets). See the comment
block at the top of the file.

## Test suites

| Command | What it proves | Needs |
| --- | --- | --- |
| `npm run typecheck` | TypeScript compiles | — |
| `npm run check:rpc` | every bridged browser call maps to a real, granted SQL function | — |
| `npm run check:secrets` | no credential-shaped strings in tracked files | — |
| `npm run check:secrets:history` | same, across all committed blobs | a git checkout |
| `npm run verify:db` | all migrations apply; 237 RLS/RPC assertions pass (the runner refuses to report success below `MIN_ASSERTIONS`) | PostgreSQL 17 |
| `npm run test:bootstrap` | the bootstrap script refuses placeholders and never leaks the code | PostgreSQL 17 |
| `npm run test:concurrency` | two simultaneous admin deactivations cannot empty the workspace | PostgreSQL 17 |
| `npm run test:verifier` | the migration verifier really fails on a broken migration | PostgreSQL 17 |
| `npm run test:e2e` | 11 Chromium tests: every route, guards, deep links, back/forward, one payment, one client creation, three viewports | Chromium (`npx playwright install --with-deps chromium`) |
| `npm run check:edge` | every Edge Function query binds and checks its `error` |
| `npm run test:edge` | the Edge query checker's own 8 cases pass |
| `npm run check:env` | the build environment is deployable (https URL, anon/publishable key, never `service_role`, valid `BASE_PATH`) | — |
| `npm run test:env` | the environment validator's own 14 cases pass | — |

The database suites run against a throwaway local database and never touch a
Supabase project. `verify:db`, `test:bootstrap`, `test:concurrency` and
`test:verifier` all run in `.github/workflows/database.yml` against a
`postgres:17` service container; `test:e2e` runs in
`.github/workflows/e2e.yml`.

Routing uses `HashRouter`, so deep links such as
`https://<you>.github.io/lunadesk/#/admin/payments` survive a refresh on a static
host with no 404 tricks.

### Custom domain

Set `BASE_PATH=/` in the workflow env and point DNS at GitHub Pages. Nothing
else changes: all asset URLs are relative to `import.meta.env.BASE_URL`.

## 7. First-run checklist

- [ ] Settings → Profile: your name, timezone, currency.
- [ ] Settings → Branding: company name, logo, receipt footer, contact details.
      Leave tax fields blank unless you have a real GSTIN/address — LunaDesk
      never invents them.
- [ ] Settings → Receipt/Invoice: prefixes (defaults `MBL-RCP` / `MBL-INV`).
- [ ] Account & Security: rotate the lookup code you used to sign in, enable MFA.
- [ ] Add the first client, then create a service, then an invoice.
- [ ] Record a partial payment → receive a receipt → print it once to check the
      A4 layout and your logo.
