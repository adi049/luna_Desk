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

…or paste the files from `supabase/migrations/` into the SQL editor **in order**:
`0001_schema.sql` → `0002_rls.sql` → `0003_rpc.sql` → `0004_audit_and_guards.sql`
→ `0005_grants.sql` → `0006_admin_codes.sql`.

Verify locally before you push (recommended):

```bash
PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=postgres scripts/verify-migrations.sh
# → ALL TESTS PASSED / ✓ schema verified
```

The same command is `npm run verify:db`. It needs a local PostgreSQL 15+ and
**never** connects to a hosted project: it drops and recreates a scratch
database named `lunadesk_verify`.

The script recreates a scratch database, applies every migration and runs
`supabase/tests/rls.sql` (~48 assertions on isolation, money and access).

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
   of publishing an app that cannot sign anyone in. It also runs the RPC
   contract check (`scripts/check-rpc-contract.mjs`) and a secret scan
   (`scripts/scan-secrets.mjs`).
5. Push to `main`. The workflow typechecks, builds, and publishes `dist/`.

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
