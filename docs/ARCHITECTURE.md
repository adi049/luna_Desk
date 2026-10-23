# Architecture

A static React app, a Postgres database with row-level security, three Edge
Functions. No application server, no queue, no cron box to babysit.

```
┌──────────────────────── Browser (GitHub Pages) ─────────────────────────┐
│  React 18 · TypeScript · Vite · Tailwind · Framer Motion · R3F           │
│                                                                          │
│  LoginPage ──► AuthAdapter ──► access-code-login (Edge Function)          │
│  pages ─────► DataAdapter ──┬─► SupabaseAdapter ─► PostgREST + RLS        │
│                             │                    └► RPC (money/access)   │
│                             └─► DemoAdapter ───► localStorage (demo only) │
│                                                                          │
│  service worker (sw.js): push display + notification click               │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ publishable (anon) key + user JWT
┌──────────────────────────────────▼───────────────────────────────────────┐
│ Supabase                                                                  │
│  Postgres: tables + RLS + SECURITY DEFINER RPCs + audit triggers          │
│  Auth: admin sessions (password / magic link / MFA)                       │
│  Storage: `branding` bucket (logo)                                        │
│  Edge Functions: access-code-login · admin-clients · send-reminders       │
│  Scheduler: pg_cron/pg_net → send-reminders every minute                  │
└──────────────────────────────────────────────────────────────────────────┘
```

## The adapter contract

Every page talks to `DataAdapter`/`AuthAdapter` (`src/lib/data/types.ts`) — never
to `supabase` directly for reads. That keeps two things true:

1. **One place to enforce the shape of a query.** `TABLES` and `RpcName` are
   literal unions; adding a table means updating the type, the migration and the
   demo store together. TypeScript fails the build otherwise.
2. **A demo that behaves like production.** The demo adapter reproduces client
   scoping, admin-only RPCs and internal-note stripping, so what you click in the
   demo is what you get live. Differences that matter are labelled in the UI.

Mode is chosen by one env var:

```ts
// src/lib/data/index.ts
const MODE = import.meta.env.VITE_DATA_MODE === 'demo' ? 'demo' : 'live';
```

Live mode is the default. It starts empty — no invented clients, invoices or
revenue — and shows honest empty states. Demo mode is opt-in, imports
`src/lib/data/seed.ts` (the only fixture file), and shows a permanent
"Demo data" banner.

## Money

- All amounts are **integer paise** (`bigint` in Postgres, `number` in TS —
  safe far beyond any realistic invoice).
- `src/lib/finance.ts` is the only module allowed to derive a balance:
  `paidMinor`, `balanceMinor`, `effectiveStatus`, `summariseReceivables`,
  `receivedInRange`, `monthlyReceivedSeries`. Components never recompute totals.
- `src/lib/money.ts` is the only display path (`formatMoney`, en-IN INR).
- Outstanding is computed **per invoice period**, never lifetime-vs-lifetime. A
  October retainer of ₹5,000 with ₹3,000 received is ₹2,000 outstanding, even
  when the client has paid ₹83,000 in total.
- In the database the same rules are enforced independently: the invoice total
  must equal subtotal − discount + tax, payments are locked and balance-checked
  inside `rpc_record_payment`, and a trigger re-derives the stored status.

## Receipts

A receipt is a **document**, not a view. `rpc_issue_receipt` assembles the
snapshot (company + branding, client identity, invoice number, billing period,
previous payments, this payment, remaining balance, method, reference, notes,
line items) on the server at issue time and stores it as JSON. The print page
renders `receipt.snapshot`, so reprinting five months later produces the same
paper even if the client has been renamed or the logo changed.

Numbering is race-safe: `next_document_number()` increments a row in
`document_sequences` under an `ON CONFLICT … DO UPDATE … RETURNING`, which
serialises concurrent issuers. One receipt per payment is enforced by
`unique(payment_id)`.

## Routing

`HashRouter` because GitHub Pages cannot rewrite deep links. Print routes
(`/admin/receipts/:id`, `/portal/receipts/:id`) deliberately sit **outside** the
app shell so no sidebar or header reaches the paper.

```
/                     login
/#/admin/*            16 sections (RequireAdmin)
/#/portal/*           5 portal pages (RequireClient)
/#/portal/tools       stopwatch + calculator for client users
/#/admin/receipts/:id print sheet (no shell)
```

`RequireAdmin` / `RequireClient` are a UX convenience. The database decides.

## Rendering rules

- Pages are lazy-loaded; `AppShell` mounts once per layout and renders
  `<Outlet/>`. The page transition is **enter-only** (`motion.div` keyed on
  `location.pathname`) — wrapping a router `Outlet` in `AnimatePresence
  mode="wait"` deadlocks lazy children during the exit phase.
- Collections come from `useCollection` (loading → error → empty → data), so no
  page can silently render a spinner forever.
- Notifications are only created in explicit handlers ("Scan for due alerts",
  recording a payment), never during render, and are deduped by
  `notifications.dedupe_key` so a re-render or a refresh cannot duplicate them.
- Rich text is sanitised on write *and* on render (`src/lib/sanitize.ts`).
- The calculator is a hand-written tokeniser + parser (`src/lib/calc.ts`); no
  `eval`, no `Function`.

## Accessibility & motion

Skip link, focus-visible rings, labelled form controls (every field is wired to
its input by id), `role="alertdialog"` on the alarm overlay, keyboard-dismissible
overlays, and a command palette bound to `⌘K`/`Ctrl K`. Motion is transform/
opacity only and collapses under `prefers-reduced-motion`. Colour is never the
only signal — status always has a word next to the dot.

## What lives where

| Concern | File |
| --- | --- |
| Theme tokens (dark + light, incl. contrast-safe accent text) | `src/index.css`, `tailwind.config.js` |
| Finance rules | `src/lib/finance.ts` |
| Money formatting | `src/lib/money.ts` |
| Date/period helpers (timezone-aware) | `src/lib/dates.ts` |
| Calendar expansion, DST-correct recurrence | `src/lib/calendar.ts` |
| Alarm synthesis | `src/lib/alarm.ts` |
| Reminder math (ringing / missed / repeats) | `src/lib/reminders.ts` |
| Push subscription | `src/lib/push.ts` + `public/sw.js` |
| Schema, RLS, RPCs, guards | `supabase/migrations/*.sql` |
| Verification | `scripts/verify-migrations.sh`, `supabase/tests/rls.sql` |
