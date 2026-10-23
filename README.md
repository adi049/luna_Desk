# LunaDesk

The workspace for **Managed by Luna**: one place where the agency runs clients,
services, projects, billing and its own day — and where each client gets a
read-only portal that shows exactly what they are paying for.

Three surfaces, one app:

| Surface | Who | What it does |
| --- | --- | --- |
| **Admin Workspace** | the agency (Supabase Auth account) | Clients, services, projects, payments, invoices & receipts, tasks, calendar, notes, reminders, stopwatch, calculator, reports, notifications, settings, security |
| **Client Portal** | clients (access code) | Read-only: services, agreed prices, projects & updates, per-period billing, payments, receipts, announcements, upcoming deadlines, agency contact |
| **Personal workspace** | everyone, private | Tasks, notes, calendar, reminders & alarms, stopwatch, calculator — owner-scoped, invisible to the agency's other users |

There is **no backend server to run**. The frontend is static
(React + Vite, deployed to GitHub Pages) and talks directly to Supabase:
Postgres with Row Level Security, Auth, Storage and a handful of Edge
Functions. No `service_role` key ever reaches the browser.

---

## Quick start

```bash
npm install

# 1. Try it instantly with labelled demo data (no accounts, no network)
echo 'VITE_DATA_MODE=demo' > .env.local
npm run dev          # http://localhost:5173
```

In demo mode the login screen offers the demo credentials:
`PR103` / `ANS005` for the two client portals, and the admin code + password
shown in the "Demo data" panel. Everything you do is stored in `localStorage`
and a permanent banner reminds you the data is not real.

```bash
# 2. Point it at your Supabase project
cp .env.example .env.local     # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run dev
```

Then follow **[docs/SETUP.md](docs/SETUP.md)** — create the project, push the
migrations, create the admin user and deploy the Edge Functions. Live mode
starts **empty** and shows honest empty states; it never seeds fictional
finances.

---

## Verification

```bash
npm run verify                         # tsc + RPC contract + secret scan
npm run build                          # production bundle (refuses live build
                                       # without Supabase env — by design)
npm run verify:db                      # apply every migration to a scratch
                                       # Postgres and run the RLS/RPC suite
```

`npm run check:rpc` is worth calling out: it parses the migrations and the
Supabase adapter's binding table and fails if the browser calls a function that
does not exist or passes a parameter it does not take. The audit found exactly
that class of bug (the UI called `record_payment`; SQL defined
`rpc_record_payment`), which demo mode hid completely.

`scripts/verify-migrations.sh` recreates a throwaway database
(`lunadesk_verify`), installs a small Supabase shim (auth schema, roles,
`auth.uid()`), applies `supabase/migrations/*.sql` in order and runs
`supabase/tests/rls.sql`. The suite impersonates users the way PostgREST does
(`SET ROLE authenticated` + JWT claim) and asserts the things that matter:
cross-tenant isolation, owner-only personal data, overpayment refusal, receipt
numbering, void-and-recompute, archive guards, access-code rate limiting and
revocation. It refuses to pass silently — an errored assertion aborts the run.

---

### If the build runs out of memory

`vite build` serialises sourcemaps and the three.js chunk is large, so on a
machine with ~2 GB free it can exhaust Node's default heap. Either build the
way CI does (no sourcemaps):

```bash
CI=true npm run build
```

or cap the heap explicitly:

```bash
NODE_OPTIONS=--max-old-space-size=1024 npm run build
```

## Layout

```
src/
  App.tsx                 routes, lazy pages, admin/client guards, print routes
  pages/
    LoginPage.tsx         "Your Workspace. Your World." + access-code form
    admin/                the 16 workspace sections
    client/               the 5 read-only portal pages
    shared/               tasks, notes, calendar, reminders, stopwatch, calculator
  components/             UI kit, layout shell, charts, 3D scene, dialogs
  context/                app (theme, toasts, adapters) + auth
  lib/
    finance.ts            the ONLY place balances are derived
    money.ts              integer paise ↔ ₹ display
    calc.ts               restricted expression parser (no eval)
    alarm.ts              Web Audio alarm synthesis
    data/                 DataAdapter contract + demo & Supabase adapters
  hooks/                  debounce, interval, online status, hotkeys, async
supabase/
  migrations/             0001 schema · 0002 RLS · 0003 RPCs · 0004 guards
                          0005 privileges · 0006 admin lookup codes
  functions/              access-code-login, admin-clients, send-reminders
  tests/rls.sql           the RLS/RPC suite
scripts/                  bootstrap-admin.sql, verify-migrations.sh, VAPID keys
docs/                     setup, architecture, security, alarms & notifications
```

## Documentation

- **[docs/SETUP.md](docs/SETUP.md)** — Supabase project, migrations, storage,
  Edge Functions, admin bootstrap, GitHub Pages deployment.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — data flow, the adapter
  contract, money rules, route map.
- **[docs/SECURITY.md](docs/SECURITY.md)** — auth model, access codes, RLS,
  rate limits, audit trail, threat table.
- **[docs/ALARMS_AND_NOTIFICATIONS.md](docs/ALARMS_AND_NOTIFICATIONS.md)** —
  what reminders actually guarantee (and what they cannot), plus the push
  architecture.
- **[docs/AUDIT.md](docs/AUDIT.md)** — the pre-deployment audit: what was
  broken, what was fixed, what was actually tested.

## Design

Charcoal `#09090D` canvas, `#15151D` surfaces, magenta `#FF2D95` as the single
primary accent, with mint `#B8F28B` (paid/complete), butter `#FFE27A`
(upcoming), sky `#A8D8FF` (information) and pink `#FFB5D5` used only where
they carry meaning. Light and dark themes share one token set, so contrast is
never an accident. Motion is enter-only and disabled under
`prefers-reduced-motion`. The 3D scene appears on the login page only.

The wordmark is typeset, not a reproduction of the agency logo. Upload the real
logo in **Settings → Branding** and it is used verbatim on receipts.
