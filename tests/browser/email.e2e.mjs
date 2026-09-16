import { test, expect } from '@playwright/test';

async function open(page, configured, bindings = []) {
  const actions = [];
  const data = {
    configured,
    enabled: configured,
    sender: 'louiz@rescova.de',
    recipient: 'louiz@rescova.de',
    missing: configured ? [] : ['GMAIL_REFRESH_TOKEN'],
    conversations: [{ id: 'email-demo', caseName: 'Ana Silva', status: 'active' }],
    deliveries: [],
    bindings,
  };
  await page.route('**/api/email-test**', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (route.request().method() === 'POST') actions.push(action);
    if (action === 'preview')
      return route.fulfill({
        json: {
          subject: '[Demo] Payment options',
          text: 'Three monthly installments are available.',
          recipient: data.recipient,
          attachments: [{ filename: 'Demo loan agreement.txt' }],
        },
      });
    if (action === 'start') {
      data.bindings = [{ conversationId: 'email-demo', status: 'active' }];
      data.deliveries = [
        {
          id: 'delivery-1',
          conversationId: 'email-demo',
          subject: '[Demo] Payment options',
          status: 'submitted',
          createdAt: new Date().toISOString(),
        },
      ];
    }
    if (action === 'pause') data.bindings[0].status = 'paused';
    await route.fulfill({ json: data });
  });
  await page.goto('/?emailTest=1');
  await page.getByLabel('Workspace password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Email test', exact: true })).toBeVisible();
  return actions;
}

test('email test requires configuration and keeps recipient fixed', async ({ page }) => {
  const actions = await open(page, false);
  await expect(page.getByRole('region', { name: 'Email setup' })).toContainText(
    'GMAIL_REFRESH_TOKEN',
  );
  await expect(page.getByRole('button', { name: 'Send test email' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Check replies now' })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview email' }).click();
  await expect(page.getByRole('region', { name: 'Email preview' })).toContainText(
    'Demo loan agreement.txt',
  );
  await expect(page.getByRole('button', { name: 'Send test email' })).toBeDisabled();
  expect(actions).toEqual(['preview']);
});

test('email preview precedes explicit send, sync and pause', async ({ page }) => {
  const actions = await open(page, true);
  await expect(page.getByRole('button', { name: 'Send test email' })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview email' }).click();
  await page.getByRole('button', { name: 'Send test email' }).click();
  await expect(page.getByRole('region', { name: 'Email delivery timeline' })).toContainText(
    'submitted',
  );
  await expect(page.getByRole('button', { name: 'Send test email' })).toBeDisabled();
  await page.getByRole('button', { name: 'Check replies now' }).click();
  await expect(page.getByRole('status')).toContainText('Mailbox checked');
  await page.getByRole('button', { name: 'Pause email' }).click();
  await expect(page.getByRole('status')).toContainText('Email follow-up paused');
  expect(actions).toEqual(['preview', 'start', 'sync', 'pause']);
});

test('email and demo SMS share case history and the SMS composer stays available', async ({
  page,
}) => {
  const conversation = {
    id: 'email-demo',
    caseId: 'case-demo',
    caseName: 'Ana Silva',
    status: 'active',
    channel: 'email',
    transport: 'gmail_test',
  };
  const replies = [];
  await page.route('**/api/agent-workflows**', (route) => {
    if (route.request().method() === 'POST') replies.push(route.request().postDataJSON());
    return route.fulfill({
      json:
        new URL(route.request().url()).pathname === '/api/agent-workflows'
          ? { conversations: [conversation] }
          : {
              conversation,
              tasks: [],
              messages: [
                {
                  id: 'historical',
                  direction: 'outbound',
                  text: 'Earlier demo message',
                  status: 'simulated_delivered',
                },
                {
                  id: 'email',
                  direction: 'outbound',
                  text: 'Your agreement',
                  delivery: { channel: 'email', status: 'submitted' },
                },
                {
                  id: 'reply',
                  direction: 'inbound',
                  text: 'Thank you',
                  channel: 'email',
                },
              ],
            },
    });
  });
  await open(page, true);
  await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Shared case history · Email and demo SMS.')).toBeVisible();
  await expect(dialog.getByRole('list', { name: 'Case messages' })).toContainText(
    'Demo SMS · simulated delivery',
  );
  await expect(dialog.getByRole('list', { name: 'Case messages' })).toContainText(
    'Email · submitted',
  );
  await expect(dialog.getByRole('list', { name: 'Case messages' })).toContainText(
    'Email · received',
  );
  await expect(dialog.getByLabel('Reply as the demo person')).toBeEnabled();
  await dialog
    .getByLabel('Reply as the demo person')
    .fill('Yes, I accept the three-installment plan.');
  await dialog.getByRole('button', { name: 'Send demo SMS', exact: true }).click();
  await expect.poll(() => replies.length).toBe(1);
  expect(replies[0]).toMatchObject({
    text: 'Yes, I accept the three-installment plan.',
    channel: 'virtual_sms',
  });
  expect(replies[0].requestId).toBeTruthy();
  await expect(dialog.getByText('Virtual SMS · no real messages sent.')).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: 'Email test' }).first()).toHaveAttribute(
    'href',
    '?emailTest=1',
  );
});

test('automatically requested email shows setup dependency without manual sending', async ({
  page,
}) => {
  const actions = await open(page, false, [
    { conversationId: 'email-demo', status: 'awaiting_configuration' },
  ]);
  const status = page.getByRole('region', { name: 'Email automation status' });
  await expect(status).toContainText('awaiting configuration');
  await expect(status).toContainText('continue automatically');
  expect(actions).toEqual([]);
});

test('active automatic email explains that manual send is unnecessary', async ({ page }) => {
  const actions = await open(page, true, [{ conversationId: 'email-demo', status: 'active' }]);
  await expect(page.getByRole('region', { name: 'Email automation status' })).toContainText(
    'no manual send is needed',
  );
  await expect(page.getByRole('button', { name: 'Send test email' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Pause email' })).toBeEnabled();
  expect(actions).toEqual([]);
});
