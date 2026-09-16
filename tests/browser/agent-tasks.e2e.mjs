import { test, expect } from '@playwright/test';

test('agent queue shows real ownership, blocked steps and a distinct legacy section', async ({
  page,
}) => {
  await page.route('**/api/agent-tasks?**', async (route) => {
    const state = new URL(route.request().url()).searchParams.get('state');
    let rows =
      state === 'completed'
        ? []
        : [
            {
              id: 'resolution:demo',
              source: 'resolution',
              case_id: 'demo',
              name: 'Ana Silva',
              portfolio_name: 'Test portfolio',
              title: 'Unauthorized terms',
              owner: 'Rafael',
              status: 'blocked_policy',
              next_action: 'Find an authorized offer',
              created_at: '2026-09-16T10:00:00Z',
            },
            {
              id: 'ingestion:demo',
              source: 'document_ingestion',
              case_id: 'demo',
              name: 'Ana Silva',
              portfolio_name: 'Test portfolio',
              title: 'Loan agreement',
              owner: 'Helena',
              status: 'processing',
              next_action: 'Extract and index document evidence',
              created_at: '2026-09-16T10:00:00Z',
            },
          ];
    rows =
      state === 'ready'
        ? rows.filter((t) => t.status === 'processing')
        : state === 'waiting'
          ? rows.filter((t) => t.status === 'blocked_policy')
          : rows;
    await route.fulfill({
      json: {
        rows,
        total: rows.length,
        counts: { ready: 1, scheduled: 0, waiting: 1, open: 2, completed: 0, all: 2 },
        limit: 50,
        offset: 0,
      },
    });
  });
  await page.route('**/api/tasks', (route) =>
    route.fulfill({
      json: [
        {
          id: 'legacy',
          case_id: 'demo',
          name: 'Ana Silva',
          reason: 'paid_reported',
          status: 'open',
        },
      ],
    }),
  );
  await page.goto('/');
  await page.getByLabel('Workspace password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await page.getByRole('button', { name: 'Agent tasks', exact: true }).click();
  await expect(page.getByRole('cell', { name: /Helena/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: /Rafael/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^Waiting/ }).click();
  await expect(page.getByRole('cell', { name: /Rafael/ })).toBeVisible();
  await expect(page.getByText('Find an authorized offer', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View record', exact: true })).not.toBeVisible();
  await page.getByText(/^Legacy follow-ups ·/).click();
  await expect(
    page.getByText('These records have no agent executor attached yet.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'View record', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Closed/ }).click();
  await expect(page.getByText('No agent tasks in this view', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  ).toBeTruthy();
});

test('Marina shows future reminders separately from work ready now', async ({ page }) => {
  await page.route('**/api/agent-tasks?**', (route) => {
    const state = new URL(route.request().url()).searchParams.get('state');
    return route.fulfill({
      json: {
        rows:
          state === 'scheduled'
            ? [
                {
                  id: 'payment:future',
                  source: 'payment_task',
                  case_id: 'demo',
                  name: 'Ana Silva',
                  title: 'Installment reminder',
                  owner: 'Marina',
                  status: 'queued',
                  bucket: 'scheduled',
                  due_at: '2030-01-10',
                  next_action: 'Recheck payment evidence on the due date.',
                },
              ]
            : [],
        total: state === 'scheduled' ? 12 : 0,
        counts: { ready: 0, scheduled: 12, waiting: 0, open: 12, completed: 0, all: 12 },
        limit: 5,
        offset: 0,
      },
    });
  });
  await page.goto('/');
  await page.getByLabel('Workspace password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'View Marina', exact: true }).click();
  await expect(page.getByText('0 ready now', { exact: true })).toBeVisible();
  await expect(page.getByText(/Nothing needs to run now/)).toBeVisible();
  await page.getByRole('button', { name: /^Scheduled\s*12$/ }).click();
  await expect(page.getByText('12 scheduled', { exact: true })).toBeVisible();
  await expect(page.getByText(/Scheduled · 10 Jan 2030/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  ).toBeTruthy();
});
