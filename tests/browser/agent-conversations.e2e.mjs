import { test, expect } from '@playwright/test';

test('virtual SMS view keeps drafts during polling, retries safely, and pauses conversation', async ({
  page,
}) => {
  const conversation = {
    id: 'conversation-demo',
    caseId: 'case-demo',
    caseName: 'Ana Silva',
    status: 'active',
    transport: 'virtual',
    channel: 'sms',
  };
  const messages = [
    {
      id: 'message-1',
      direction: 'outbound',
      text: 'Hi Ana, here is your agreed payment link: https://example.invalid/pay/demo',
      createdAt: new Date().toISOString(),
    },
  ];
  const detail = () => ({
    conversation,
    messages,
    tasks: [],
    runs: [
      {
        id: 'run-1',
        role: 'sms_followup',
        provider: 'openai',
        model: 'demo-model',
        status: 'completed',
      },
    ],
    events: [{ id: 'event-1', type: 'agreement.accepted', createdAt: new Date().toISOString() }],
  });
  const attempts = [];
  let fail = true;
  await page.route('**/api/agent-workflows**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === 'POST' && url.pathname.endsWith('/messages')) {
      attempts.push(route.request().postDataJSON());
      if (fail) {
        fail = false;
        return route.fulfill({
          status: 503,
          json: { error: 'Temporary connection problem. Please retry.' },
        });
      }
      messages.push({ id: 'message-2', direction: 'inbound', text: attempts.at(-1).text });
      messages.push({
        id: 'message-3',
        direction: 'outbound',
        text: 'The first installment is due on the agreed date.',
      });
    }
    if (url.pathname.endsWith('/pause')) conversation.status = 'paused';
    if (url.pathname.endsWith('/resume')) conversation.status = 'active';
    await route.fulfill({
      json: url.pathname === '/api/agent-workflows' ? { conversations: [conversation] } : detail(),
    });
  });
  await page.goto('/');
  await page.getByLabel('Workspace password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await page.getByRole('button', { name: 'Demo SMS conversations', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText('Virtual SMS · no real messages sent.', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(/Hi Ana, here is your agreed payment link/)).toBeVisible();
  const reply = dialog.getByLabel('Reply as the demo person');
  await reply.fill('When is my first installment due?');
  // The next background refresh must preserve the operator's unfinished reply.
  await page.waitForTimeout(2200);
  await expect(reply).toHaveValue('When is my first installment due?');
  await dialog.getByRole('button', { name: 'Send demo reply' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Temporary connection problem');
  await expect(reply).toHaveValue('When is my first installment due?');
  await dialog.getByRole('button', { name: 'Send demo reply' }).click();
  await expect(dialog.getByText('The first installment is due on the agreed date.')).toBeVisible();
  await expect(reply).toHaveValue('');
  expect(attempts).toHaveLength(2);
  expect(attempts[0].requestId).toBe(attempts[1].requestId);
  await dialog.getByRole('button', { name: 'Pause agent' }).click();
  await expect(reply).toBeDisabled();
  await dialog.getByRole('button', { name: 'Resume agent' }).click();
  await expect(reply).toBeEnabled();
  await dialog.getByText('Agent activity and model details').click();
  await expect(dialog.getByText(/openai \/ demo-model/)).toBeVisible();
});

test('agent registry exposes roles and virtual SMS on a narrow screen', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Workspace password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.getByText('Agent roles, configuration and work status')).toBeVisible();
  await expect(page.getByText('Loading agents…')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBeTruthy();
  const launch = page.getByRole('button', { name: 'Demo SMS conversations', exact: true });
  await expect(launch).toBeVisible();
  await launch.click();
  await expect(
    page.getByRole('dialog').getByText('Virtual SMS · no real messages sent.', { exact: true }),
  ).toBeVisible();
});
