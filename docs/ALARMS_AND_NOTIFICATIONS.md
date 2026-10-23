# Alarms, notifications and reminders — what is actually guaranteed

LunaDesk rings reminders loudly while it is open. It does **not** claim to wake a
closed browser, and there is no way for a web app to guarantee that. This
document is the honest version, plus the architecture that gets as close as
browsers allow.

---

## Guarantees, in order of strength

| # | Situation | What happens | Guaranteed? |
| --- | --- | --- | --- |
| 1 | LunaDesk open in a tab (any tab) | In-app alarm overlay + looping Web Audio tone, snooze/complete buttons, keyboard accessible | **Yes**, as long as the tab exists — even if it is in the background on desktop |
| 2 | Tab open, phone locked / browser backgrounded on iOS or Android | The tab is suspended; nothing runs. You get the **missed** state on return | No |
| 3 | Tab closed, notifications allowed, push subscription stored | The service worker *may* receive a Web Push message from the `send-reminders` job and show a notification. The alarm sound is **not** part of that — the OS controls it | **Best effort.** Offline devices, muted notifications, battery savers and browser push-service failures all drop it |
| 4 | Tab closed, notifications denied or never granted | Notification centre entry only, visible next time you open LunaDesk | **Yes** (the record is in Postgres) |

The authoritative record is always the database: every reminder that came due is
either rung in-app, pushed (best effort), or listed as **missed**. Nothing
silently disappears.

## First-run permission copy

The explainer appears the first time you touch a reminder control — never on
page load:

> **Allow reminder notifications and alarm sounds for a better productivity
> experience.**
>
> Enable notifications and sounds so LunaDesk can alert you about important
> tasks, deadlines, and scheduled reminders.

Buttons: **Allow Notifications** / **Not Now**.

- Nothing is requested before you interact with the prompt.
- "Not Now" is remembered (`localStorage`, per browser). The prompt does not
  come back; the explainer is re-openable from Settings → Notifications.
- If the OS permission was denied, the prompt is not shown again. Instead the
  panel explains how to re-enable it in the browser's site settings, because a
  denied permission cannot be re-requested from JavaScript.
- `Notification.requestPermission()` is only called from the Allow button's click
  handler, which is also what browsers require for the prompt to appear at all.

## In-app alarm

`src/lib/alarm.ts` synthesises the tone with the Web Audio API — no audio file is
bundled or fetched, so there is nothing to 404 and no license to manage.

- Two oscillators (a fundamental + a fifth) with a soft gain envelope, looping at
  a fixed interval until stopped.
- Volume is user-set (0–100%) and persisted; **Test alarm** plays 2.6 s of the
  same tone at the current volume.
- The overlay is the accessible primary alert: `role="alertdialog"`, focus moved
  to "Stop alarm", `Escape` stops it, and a visible label says which reminder is
  ringing. A mute user still sees and can dismiss it.
- Under `prefers-reduced-motion` the pulsing ring animation is removed.
- The audio context is created on the first user gesture (browser autoplay rules)
  and resumed if it was suspended.

`ReminderWatcher` (mounted once in the app shell) polls every 10 s while a tab is
alive, fires anything whose `snoozed_until ?? remind_at` has passed and that has
not already fired in this session, and writes `fired_at` so a second tab cannot
ring the same occurrence. `MISS_WINDOW_MINUTES = 10` in `src/lib/reminders.ts`
is the cut-off between "ringing now" and "missed" — so restoring a tab after a
two-hour gap shows one missed entry instead of eight stacked alarms.

## Duplicate delivery

One reminder occurrence must ring exactly once. Three separate mechanisms
guarantee that, because each covers a different failure mode:

| Mechanism | Covers |
| --- | --- |
| `reminders.fired_at` + the scan filter `fired_at is null` | The same occurrence is never re-selected on the next run |
| `reminder_deliveries` unique `(reminder_id, occurrence)` claimed **before** any send | Two overlapping scheduler runs, or a rerun after a crash |
| `notifications.dedupe_key` unique `(user_id, dedupe_key)` | A second durable alert row for the same occurrence |

The claim is taken first (`rpc_claim_reminder`), and only the caller that wins
it pushes. A claim that fails to deliver is recorded with its error
(`rpc_mark_reminder_delivery`) rather than being retried invisibly, so a broken
push subscription is visible instead of silently re-firing.

In the browser, `ReminderWatcher` keys its in-flight set on
`reminder.id + occurrence`, so the same occurrence cannot ring twice while a
repeating reminder can still ring again tomorrow.

## Push architecture

```
                 ┌──────────────────────────┐
   every minute  │  send-reminders (Edge)   │  service role, x-cron-secret
                 └────────────┬─────────────┘
                              │ 1. select reminders due (owner-scoped, RLS bypassed
                              │    deliberately — the job is server-side)
                              │ 2. insert notification (dedupe_key per occurrence)
                              │ 3. web-push to push_subscriptions rows
                              │ 4. advance repeating reminders (timezone-aware)
                              ▼
        ┌────────────────────────────────────────┐
        │ Browser push service (FCM / Mozilla …) │
        └───────────────────┬────────────────────┘
                            ▼
        ┌────────────────────────────────────────┐
        │ public/sw.js (service worker)          │  showNotification({ tag: occurrence })
        └────────────────────────────────────────┘
```

- Subscriptions are stored in `public.push_subscriptions` (endpoint, `p256dh`,
  `auth`), owner-scoped by RLS. Subscriptions that answer `404`/`410` are deleted
  on the spot.
- The notification `tag` is the reminder id + occurrence, so the OS replaces
  rather than stacks duplicates.
- Delivery requires the VAPID keys (`scripts/generate-vapid-keys.mjs`). Without
  them the job still writes notification rows and simply reports
  `push_enabled: false`.
- **Push is not a loud alarm.** The OS renders it with the user's notification
  sound and settings; a muted phone stays silent. `requireInteraction: true` asks
  the OS to keep the notification visible, but the OS may ignore it.

## PWA install

`public/manifest.webmanifest` + icons let the app be installed to a home screen
or desktop. An installed app is *not* guaranteed to stay alive: iOS suspends
installed web apps just like Safari tabs. Installing improves the odds of push
delivery; it does not change the guarantee table above.

## Missed reminders

On load, `ReminderWatcher` and the Reminders page compare `remind_at` with now:

- **Due now** — rings (if the tab is alive) and shows buttons.
- **Missed** — anything more than 10 minutes past due that never fired is listed
  under "Missed" with the original time, and can be completed, snoozed or
  dismissed.
  It is not silently replayed as a new alarm.
- **History** — completed and dismissed reminders stay in the list with
  `dismissed_at`, so there is a record of what happened.

## Reminder repeats

`none`, `daily`, `weekly`, `monthly`, `yearly`, with an optional end date. Repeat
arithmetic happens in the user's `profiles.timezone`, so a 09:00 reminder stays
09:00 across a DST change instead of drifting an hour.

## What this implementation does not do

- It does not ring a loud alarm from a closed browser. No web API can.
- It does not retry a failed push automatically; the failure is recorded and the
  reminder remains visible in-app, which is the reliable channel.
- It does not treat a notification as proof of delivery: the OS may suppress it
  (Focus modes, Do Not Disturb, muted app) and there is no reliable read receipt.

## What to tell a client

> Reminders ping you inside LunaDesk, and can also reach your device as a
> notification if you allow them — but browsers cannot wake a closed tab, so keep
> LunaDesk open (or installed) on days when a deadline matters.
