import { test, expect } from '@playwright/test';

for (const status of ['awaiting_information', 'awaiting_specialist', 'blocked_policy']) {
  test(`supervisor owns ${status} and accepts clarification or recheck`, async ({ page }) => {
    const conversation = {
      id: 'supervised-demo',
      caseId: 'case-demo',
      caseName: 'Ana Silva',
      status,
      resolution: {
        status,
        owner: 'supervisor',
        reason: 'The requested evidence is missing.',
        nextAction: 'Retrieve the updated statement when it becomes available.',
      },
    };
    const actions = [];
    const messages = [];
    await page.route('**/api/agent-workflows**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === 'POST') {
        actions.push(path.split('/').at(-1));
        if (path.endsWith('/messages'))
          messages.push({
            id: 'inbound',
            direction: 'inbound',
            text: route.request().postDataJSON().text,
          });
      }
      await route.fulfill({
        json:
          path === '/api/agent-workflows'
            ? { conversations: [conversation] }
            : { conversation, messages, tasks: [] },
      });
    });
    await page.goto('/');
    await page.getByLabel('Workspace password').fill('browser-test-password');
    await page.getByRole('button', { name: 'Sign in to workspace' }).click();
    await page.getByRole('button', { name: 'Demo SMS conversations', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const resolution = dialog.getByRole('region', { name: 'Case resolution' });
    await expect(resolution).toContainText('Rafael · Case supervisor');
    await expect(resolution).toContainText('The requested evidence is missing.');
    await expect(resolution).toContainText('Retrieve the updated statement');
    const reply = dialog.getByLabel('Reply as the demo person');
    await expect(reply).toBeEnabled();
    await reply.fill('My statement was uploaded today.');
    await dialog.getByRole('button', { name: 'Send demo reply' }).click();
    await expect(dialog.getByText('My statement was uploaded today.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Recheck case' }).click();
    await expect.poll(() => actions).toEqual(['messages', 'recheck']);
  });
}

test('legacy human review is not presented as supervisor ownership', async ({ page }) => {
  const conversation = {
    id: 'legacy',
    caseId: 'case',
    caseName: 'Ana Silva',
    status: 'human_review',
  };
  await page.route('**/api/agent-workflows**', (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).pathname === '/api/agent-workflows'
          ? { conversations: [conversation] }
          : { conversation, messages: [], tasks: [] },
    }),
  );
  await page.goto('/');
  await page.getByLabel('Workspace password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await page.getByRole('button', { name: 'Demo SMS conversations', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Legacy review', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Reply as the demo person')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Recheck case' })).toHaveCount(0);
});

test('escalation history filters and opens the exact conversation', async ({ page }) => {
  const entries = [
    {
      id: 'one',
      caseId: 'case-one',
      conversationId: 'conversation-one',
      caseName: 'Ana Silva',
      caseReference: 'ANA-1',
      trigger: 'model_uncertainty',
      reason: 'Payment options were missing.',
      status: 'resolved',
      nextAction: 'Marina explains the approved catalog.',
      createdAt: '2026-09-15T12:00:00Z',
    },
    {
      id: 'two',
      caseId: 'case-two',
      conversationId: 'conversation-two',
      caseName: 'Bruno Lima',
      caseReference: 'BRU-2',
      trigger: 'document_request',
      reason: 'Statement unavailable.',
      status: 'awaiting_information',
      nextAction: 'Await updated statement.',
      createdAt: '2026-09-15T13:00:00Z',
    },
  ];
  const conversations = entries.map((item) => ({
    id: item.conversationId,
    caseId: item.caseId,
    caseName: item.caseName,
    status: 'active',
  }));
  await page.route('**/api/agent-workflows**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/escalations'))
      return route.fulfill({
        json: { escalations: entries, summary: { total: 2, open: 1, resolved: 1 } },
      });
    const conversation = conversations.find((item) => path.endsWith('/' + item.id));
    return route.fulfill({
      json: conversation
        ? {
            conversation,
            tasks: [],
            messages: [
              {
                id: 'message',
                direction: 'outbound',
                text: 'Conversation for ' + conversation.caseName,
              },
            ],
          }
        : { conversations },
    });
  });
  await page.goto('/');
  await page.getByLabel('Workspace password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const section = page.getByRole('region', { name: 'Supervisor escalations' });
  await expect(section.getByText('Payment options were missing.')).toBeVisible();
  await section.getByLabel('Escalation status').selectOption('open');
  await expect(section.getByText('Payment options were missing.')).toHaveCount(0);
  await expect(section.getByText('Statement unavailable.')).toBeVisible();
  await section.getByLabel('Escalation status').selectOption('all');
  await section.getByLabel('Search escalations').fill('BRU-2');
  await expect(section.getByText('Payment options were missing.')).toHaveCount(0);
  await section.getByRole('button', { name: 'Open conversation' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Conversation for Bruno Lima')).toBeVisible();
  await expect(dialog.getByLabel('Agent conversation', { exact: true })).toHaveValue(
    'conversation-two',
  );
});

test('agent cards stack independently and retain original mobile order', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Workspace password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const columns = page.locator('.agents-column');
  await expect(columns).toHaveCount(2);
  const first = columns.nth(0).locator('.agent-card').first();
  const neighbor = columns.nth(1).locator('.agent-card').first();
  const next = columns.nth(1).locator('.agent-card').nth(1);
  const before = await neighbor.boundingBox();
  const nextBefore = await next.boundingBox();
  const summary = first.locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(first.locator('details')).toHaveAttribute('open', '');
  const after = await neighbor.boundingBox();
  const nextAfter = await next.boundingBox();
  expect(after.height).toBe(before.height);
  expect(nextAfter.y).toBe(nextBefore.y);
  expect(Math.round(nextAfter.y - after.y - after.height)).toBe(20);
  await page.screenshot({ path: '/tmp/rescova-agents-stacks-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const positions = await page
    .locator('.agent-card')
    .evaluateAll((cards) =>
      cards
        .map((card) => ({ order: Number(card.style.order), y: card.getBoundingClientRect().y }))
        .sort((a, b) => a.y - b.y),
    );
  expect(positions.map((item) => item.order)).toEqual(positions.map((_, index) => index));
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  ).toBeTruthy();
  await page.screenshot({ path: '/tmp/rescova-agents-stacks-mobile.png', fullPage: true });
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(first.locator('details')).not.toHaveAttribute('open', '');
});
