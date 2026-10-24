import { expect, test, type Page } from '@playwright/test';

/**
 * Reproducible browser smoke tests.
 *
 * These replace the ad-hoc Playwright session described in the older audit:
 * that proved the app worked on the day, but nothing in the repository could
 * re-run it. Everything here runs in demo mode against `vite preview`, so it
 * needs no Supabase project.
 *
 * What is covered: every route renders, the role guards hold, hash routing
 * survives a reload, deep links work, the layout does not overflow at mobile /
 * tablet / desktop widths, and the primary admin action (recording a payment)
 * actually changes state.
 *
 * What is NOT covered, and cannot be without a live project: real sign-in,
 * PostgREST, RLS and Edge Functions.
 */

const ADMIN_ROUTES = [
  '/admin/clients',
  '/admin/services',
  '/admin/projects',
  '/admin/payments',
  '/admin/invoices',
  '/admin/receipts',
  '/admin/tasks',
  '/admin/calendar',
  '/admin/notes',
  '/admin/reminders',
  '/admin/stopwatch',
  '/admin/calculator',
  '/admin/reports',
  '/admin/notifications',
  '/admin/settings',
  '/admin/security',
];

const PORTAL_ROUTES = [
  '/portal',
  '/portal/services',
  '/portal/projects',
  '/portal/billing',
  '/portal/receipts',
  '/portal/tasks',
  '/portal/notes',
  '/portal/reminders',
  '/portal/tools',
  '/portal/settings',
];

/** Collect console errors and uncaught page errors for the whole test. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

/**
 * Sign in through the real form.
 *
 * The demo build offers "Fill admin credentials" / a demo client code as
 * convenience buttons; using them keeps the test on the real submit path while
 * avoiding a dependency on the exact form layout of the administrator tab.
 */
async function signInAsAdmin(page: Page) {
  await page.goto('/#/');
  // Wait for the sign-in form, not the marketing heading: at mobile widths the
  // heading lives in a panel that is hidden, and the form is what matters.
  await expect(page.getByRole('tab', { name: 'Administrator' })).toBeVisible();

  // The entry-mode switch is a tablist, not buttons (Segmented component).
  await page.getByRole('tab', { name: 'Administrator' }).click();
  await page.getByRole('button', { name: /fill admin credentials/i }).first().click();
  await page.getByRole('button', { name: /^(continue|sign in)$/i }).first().click();

  await page.waitForURL(/#\/admin/, { timeout: 20_000 });
}

/**
 * A row count that has stopped changing.
 *
 * The table renders progressively, so a single count can catch a half-filled
 * body and a later comparison then reports a phantom "+4 rows".
 */
async function stableCount(locator: { count: () => Promise<number> }): Promise<number> {
  let previous = -1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await locator.count();
    if (current > 0 && current === previous) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return previous;
}

async function signInAsClient(page: Page) {
  await page.goto('/#/');
  await expect(page.getByRole('tab', { name: 'Client access' })).toBeVisible();

  // PR103 is the demo client code, offered as a quick-fill button.
  await page.getByRole('button', { name: 'PR103' }).first().click();
  await page.getByRole('button', { name: /^(continue|sign in)$/i }).first().click();

  await page.waitForURL(/#\/portal/, { timeout: 20_000 });
}

test.describe('sign-in', () => {
  test('the landing page renders the real wordmark and a heading', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/#/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('Managed by Luna').first()).toBeVisible();
    // Demo builds must say so; nothing may claim to be a live tenant.
    await expect(page.getByText(/demo/i).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a wrong access code is rejected with a readable message', async ({ page }) => {
    await page.goto('/#/');
    await page.getByLabel(/access code/i).first().fill('ZZZZZ');
    await page.getByRole('button', { name: /^(continue|sign in)$/i }).first().click();

    await expect(page.getByText(/not recognised|invalid|check the code/i).first()).toBeVisible();
    await expect(page).toHaveURL(/#\/?$/);
  });
});

test.describe('admin', () => {
  test('every admin route renders without console errors', async ({ page }) => {
    const errors = watchErrors(page);
    await signInAsAdmin(page);

    for (const route of ADMIN_ROUTES) {
      await page.goto(`/#${route}`);
      // The page must settle on something with a heading; an error boundary
      // would not.
      await expect(page.getByRole('heading').first()).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`#${route.replace(/\//g, '\\/')}`));
    }

    expect(errors).toEqual([]);
  });

  test('a deep link survives a reload (hash routing on a static host)', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/#/admin/payments');
    await expect(page.getByRole('heading').first()).toBeVisible();

    await page.reload();
    await expect(page).toHaveURL(/#\/admin\/payments/);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('back and forward move between admin routes', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/#/admin/clients');
    await page.goto('/#/admin/payments');

    await page.goBack();
    await expect(page).toHaveURL(/#\/admin\/clients/);

    await page.goForward();
    await expect(page).toHaveURL(/#\/admin\/payments/);
  });

  test('recording a payment adds a row and reports success', async ({ page }) => {
    const errors = watchErrors(page);
    await signInAsAdmin(page);
    await page.goto('/#/admin/payments');

    const rows = page.locator('tbody tr');
    // Count only once the table has settled, otherwise "before" is the empty
    // pre-fetch state and the comparison is meaningless.
    const before = await stableCount(rows);
    expect(before).toBeGreaterThan(0);

    await page.getByRole('button', { name: /record payment/i }).first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Pick the first invoice offered and enter a small amount.
    const invoiceSelect = dialog.getByLabel(/invoice/i).first();
    const options = await invoiceSelect.locator('option').count();
    expect(options).toBeGreaterThan(1);
    await invoiceSelect.selectOption({ index: 1 });
    await dialog.getByLabel(/amount/i).first().fill('100');
    await dialog.getByRole('button', { name: /save|record|add/i }).first().click();

    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect.poll(async () => rows.count(), { timeout: 15_000 }).toBe(before + 1);
    expect(errors).toEqual([]);
  });

  // The live admin path posts through an Edge Function that then calls the
  // client-portal RPCs as the *caller*. That was broken for a whole release
  // because the service key carries no auth.uid(); this test keeps the UI half
  // of that flow honest (the SQL half is covered by supabase/tests/rls.sql).
  test('adding a client closes the drawer and shows the new client', async ({ page }) => {
    const errors = watchErrors(page);
    await signInAsAdmin(page);
    await page.goto('/#/admin/clients');

    const rows = page.locator('tbody tr');
    const before = await stableCount(rows);

    await page.getByRole('button', { name: 'Add client' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const stamp = Date.now().toString().slice(-6);
    await dialog.getByLabel(/client name/i).fill(`E2E Client ${stamp}`);
    await dialog.getByLabel(/business name/i).fill(`E2E Business ${stamp}`);

    // The code is generated on request; a blank one would be rejected.
    const code = dialog.getByLabel(/client code/i);
    if ((await code.inputValue()) === '') {
      await dialog.getByRole('button', { name: /suggest a code/i }).click();
    }
    await expect(code).not.toHaveValue('');

    await dialog.getByRole('button', { name: /^add client$/i }).click();

    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(`E2E Client ${stamp}`)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => rows.count(), { timeout: 15_000 }).toBe(before + 1);
    expect(errors).toEqual([]);
  });
});

test.describe('client portal', () => {
  test('every portal route renders and the guard keeps clients out of admin', async ({ page }) => {
    const errors = watchErrors(page);
    await signInAsClient(page);

    for (const route of PORTAL_ROUTES) {
      await page.goto(`/#${route}`);
      await expect(page.getByRole('heading').first()).toBeVisible();
    }

    // The guard is enforced by routing, and the database enforces it again.
    await page.goto('/#/admin/clients');
    await expect(page).toHaveURL(/#\/portal/);
    await page.goto('/#/admin/settings');
    await expect(page).toHaveURL(/#\/portal/);

    expect(errors).toEqual([]);
  });
});

test.describe('layout', () => {
  for (const [label, width, height] of [
    ['mobile', 390, 844],
    ['tablet', 768, 1024],
    ['desktop', 1440, 900],
  ] as const) {
    test(`no horizontal overflow at ${label} (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await signInAsAdmin(page);

      for (const route of ADMIN_ROUTES) {
        await page.goto(`/#${route}`);
        await expect(page.getByRole('heading').first()).toBeVisible();

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${route} overflows by ${overflow}px at ${width}px`).toBeLessThanOrEqual(1);
      }
    });
  }
});
