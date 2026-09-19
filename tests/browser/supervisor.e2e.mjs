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
  await page.getByRole('button', { name: 'View Rafael', exact: true }).click();
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

test('agent directory, detail and team map stay focused and usable on mobile', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Workspace password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.locator('.team-card')).toHaveCount(9);
  await expect(page.getByRole('region', { name: 'Supervisor escalations' })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/rescova-team-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'View Marina', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Current work', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Responsibilities', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Setup', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/rescova-agent-detail.png', fullPage: true });
  await page.getByRole('button', { name: 'All agents', exact: true }).click();
  await page.getByRole('tab', { name: 'Team map', exact: true }).click();
  await expect(page.locator('.team-map-node')).toHaveCount(9);
  await page.getByRole('button', { name: 'Shared case context Application service' }).click();
  await expect(
    page.getByRole('heading', { name: 'Shared case context’s connections' }),
  ).toBeVisible();
  await expect(page.locator('.team-edge-list').getByText('Payment ledger')).toBeVisible();
  await page.locator('.team-map-node').filter({ hasText: 'Marina' }).click();
  await expect(page.getByRole('heading', { name: 'Marina’s connections' })).toBeVisible();
  await page.locator('.team-map-node').filter({ hasText: 'Rafael' }).click();
  await expect(page.getByRole('heading', { name: 'Rafael’s connections' })).toBeVisible();
  await page.screenshot({ path: '/tmp/rescova-team-map.png', fullPage: true });
  await page.getByRole('button', { name: 'View agent', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Supervisor escalations' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  ).toBeTruthy();
  await page.getByRole('button', { name: 'All agents', exact: true }).click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  ).toBeTruthy();
  await page.getByRole('tab', { name: 'Team', exact: true }).click();
  await expect(page.locator('.team-card')).toHaveCount(9);
  await page.screenshot({ path: '/tmp/rescova-team-mobile.png', fullPage: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  ).toBeTruthy();
});
