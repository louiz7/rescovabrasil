import { test, expect } from '@playwright/test';

test('document ticket explains linked steps and provider submission evidence', async ({ page }) => {
  await page.route('**/api/agent-tasks?**', (route) =>
    route.fulfill({
      json: {
        rows: [
          {
            id: 'ticket:ticket-demo',
            source: 'document_ticket',
            title: 'Document fulfillment',
            case_id: 'case-demo',
            name: 'Ana Silva',
            portfolio_name: 'Voice test demos',
            owner: 'Marina',
            status: 'completed',
            channel: 'email',
            next_action: 'Submitted to Gmail.',
            created_at: '2026-09-16T15:00:00Z',
          },
        ],
        counts: { open: 0, completed: 1, all: 1 },
        total: 1,
        offset: 0,
        limit: 50,
      },
    }),
  );
  await page.route('**/api/document-tickets/ticket-demo', (route) =>
    route.fulfill({
      json: {
        id: 'ticket-demo',
        status: 'completed',
        owner: 'Marina',
        nextAction: 'Submitted to Gmail.',
        channel: 'email',
        documentVersion: 2,
        attempts: 1,
        maxAttempts: 3,
        providerMessageId: 'gmail-evidence-123',
        createdAt: '2026-09-16T15:00:00Z',
        deadlineAt: '2026-09-23T15:00:00Z',
        completedAt: '2026-09-16T15:01:00Z',
        steps: [
          {
            key: 'retrieval',
            title: 'Retrieve document',
            owner: 'Helena',
            status: 'completed',
            evidence: 'Version 2',
          },
          { key: 'compose', title: 'Compose message', owner: 'Marina', status: 'completed' },
          {
            key: 'delivery',
            title: 'Submit email',
            owner: 'Delivery worker',
            status: 'submitted',
            evidence: 'gmail-evidence-123',
          },
        ],
      },
    }),
  );
  await page.request.post('/api/login', { data: { password: 'browser-test-password' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent tasks', exact: true }).click();
  await page.getByRole('button', { name: 'View ticket', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Document fulfillment' })).toBeVisible();
  await expect(dialog.getByText('Retrieve document', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Helena', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Gmail submission reference', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText('It does not confirm email delivery or reading.', { exact: false }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
