import { test, expect } from '@playwright/test';

test('payment simulator records partial receipts and updates an existing payment for a refund', async ({
  page,
}) => {
  const caseId = 'payments-ui-case';
  const conversation = {
    id: 'payments-ui-conversation',
    caseId,
    caseName: 'Ana Silva',
    status: 'active',
  };
  await page.route('**/api/agent-workflows**', (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).pathname === '/api/agent-workflows'
          ? { conversations: [conversation] }
          : { conversation, messages: [], tasks: [], runs: [], events: [] },
    }),
  );
  await page.route(`**/api/cases/${caseId}`, (route) =>
    route.fulfill({
      json: {
        id: caseId,
        name: 'Ana Silva',
        reference: 'PAYMENT-UI',
        portfolio_name: 'Payment demo',
        amount_minor: 125000,
        due_date: '2026-09-01',
        status: 'ready',
        timezone: 'America/Sao_Paulo',
        attempts: [],
        events: [],
        tasks: [],
        paymentFollowups: [],
        paymentAgreements: [],
      },
    }),
  );
  const installment = {
    id: 'installment-1',
    sequence: 1,
    amount_minor: 41667,
    due_date: '2026-09-23',
    paidMinor: 0,
    remainingMinor: 41667,
    status: 'pending',
    request: { id: 'request-1', mode: 'simulation', provider: 'simulator' },
  };
  const data = {
    agreements: [
      {
        id: 'agreement-1',
        currency: 'BRL',
        total_minor: 41667,
        status: 'active',
        installments: [installment],
      },
    ],
    payments: [],
    tasks: [],
    summary: {
      receivedMinor: 0,
      remainingMinor: 41667,
      unallocatedMinor: 0,
      currency: 'BRL',
      mode: 'simulation',
    },
  };
  const events = [];
  await page.route(`**/api/cases/${caseId}/payments**`, (route) => {
    if (route.request().method() === 'POST') {
      const event = route.request().postDataJSON();
      events.push(event);
      const net = event.status === 'refunded' ? 10000 - event.amountMinor : event.amountMinor;
      data.payments = [
        {
          id: event.paymentId,
          request_id: event.requestId,
          amount_minor: 10000,
          netMinor: net,
          currency: 'BRL',
          status: event.status,
          version: event.version,
        },
      ];
      installment.paidMinor = net;
      installment.remainingMinor = 41667 - net;
      data.summary.receivedMinor = net;
      data.summary.remainingMinor = 41667 - net;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: data });
  });
  await page.goto('/');
  await page.getByLabel('Workspace password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await page.getByRole('button', { name: 'Demo SMS conversations', exact: true }).click();
  await page.getByRole('button', { name: 'Open case', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Payments', exact: true }).click();
  await dialog.getByText('Test a payment event', { exact: true }).click();
  await dialog
    .getByRole('combobox', { name: 'Installment', exact: true })
    .selectOption('request-1');
  await dialog.getByLabel('Amount (BRL)', { exact: true }).fill('100.00');
  await dialog.getByRole('button', { name: 'Record simulated event', exact: true }).click();
  await expect(
    dialog.getByRole('region', { name: 'Payment ledger' }).getByRole('status'),
  ).toContainText('Simulated payment event recorded');
  expect(events[0]).toMatchObject({
    requestId: 'request-1',
    amountMinor: 10000,
    version: 1,
    status: 'succeeded',
  });
  expect(events[0].eventId).not.toBe(events[0].paymentId);
  await dialog
    .getByRole('combobox', { name: 'Payment', exact: true })
    .selectOption(events[0].paymentId);
  await dialog.getByRole('combobox', { name: 'Event', exact: true }).selectOption('refunded');
  await dialog.getByLabel('Total refunded so far (BRL)', { exact: true }).fill('25.00');
  await dialog.getByRole('button', { name: 'Record simulated event', exact: true }).click();
  await expect.poll(() => events.length).toBe(2);
  expect(events[1]).toMatchObject({
    paymentId: events[0].paymentId,
    amountMinor: 2500,
    version: 2,
    status: 'refunded',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    dialog.getByRole('button', { name: 'Record simulated event', exact: true }),
  ).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
});

test('accepted voice agreement can be paid through the browser against the real backend', async ({
  page,
}) => {
  const { createApp } = await import('../../server/app.mjs');
  const { configuration } = await import('../../server/providers.mjs');
  const { openDb } = await import('../../server/db.mjs');
  const db = openDb();
  const config = configuration({
    OUTREACH_MODE: 'demo',
    OPERATOR_PASSWORD: 'browser-test-password',
    AGENT_WORKFLOWS_ENABLED: 'true',
    OPENAI_API_KEY: 'test-only-key',
    SEED_DEMO: 'false',
  });
  const app = createApp(db, config, {
    voiceFetch: async (url) =>
      url.endsWith('/hangup')
        ? new Response(null)
        : Response.json({
            session: { id: 'live_payment_ui' },
            transport: { sdp: 'v=0\r\nanswer' },
          }),
    agentRun: async () => ({
      action: 'reply',
      text: 'Your agreed payment schedule is recorded.',
      model: 'test',
      provider: 'test',
    }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  config.port = server.address().port;
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.goto(base);
    await page.getByLabel('Workspace password').fill('browser-test-password');
    await page.getByRole('button', { name: 'Sign in to workspace' }).click();
    await expect(
      page.getByRole('heading', { name: 'Every conversation, a new way forward.' }),
    ).toBeVisible();
    async function req(path, body, method = 'POST') {
      const response = await page.request.fetch(base + '/api' + path, {
        method,
        ...(body ? { data: body } : {}),
      });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    }
    const session = await req('/voice-test/session', {
      sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
    });
    await req(`/voice-test/${session.id}/tool`, {
      name: 'confirm_identity',
      args: { confirmed: true, name: 'Ana Silva' },
      callId: 'identity',
    });
    const accepted = await req(`/voice-test/${session.id}/tool`, {
      name: 'agree_payment_solution',
      args: { offerId: 'three_installments', accepted: true },
      callId: 'agree',
    });
    await req(`/voice-test/${session.id}`, undefined, 'DELETE');
    await app.locals.agentWorkflows.tick();
    const caseId = accepted.platform.caseId;
    const state = await req(`/cases/${caseId}/payments`, undefined, 'GET');
    expect(state.agreements[0].installments).toHaveLength(3);
    await page.getByRole('button', { name: 'Demo SMS conversations', exact: true }).click();
    await page.getByRole('button', { name: 'Open case', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Payments', exact: true }).click();
    await dialog.getByText('Test a payment event', { exact: true }).click();
    const installment = state.agreements[0].installments[0];
    await dialog
      .getByRole('combobox', { name: 'Installment', exact: true })
      .selectOption(installment.request.id);
    await dialog.getByRole('button', { name: 'Record simulated event', exact: true }).click();
    await expect(
      dialog.getByRole('region', { name: 'Payment ledger' }).getByRole('status'),
    ).toContainText('Simulated payment event recorded');
    const paid = await req(`/cases/${caseId}/payments`, undefined, 'GET');
    expect(paid.agreements[0].installments[0].status).toBe('paid');
    expect(paid.summary.receivedMinor).toBe(installment.amount_minor);
    expect(paid.summary.remainingMinor).toBe(125000 - installment.amount_minor);
    await app.locals.agentWorkflows.tick();
    const final = await req(`/cases/${caseId}/payments`, undefined, 'GET');
    expect(
      final.tasks.some(
        (task) => task.kind === 'payment_update' && task.status === 'simulated_completed',
      ),
    ).toBe(true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Portfolios', exact: true }).click();
    await page.getByRole('button', { name: 'View progress', exact: true }).click();
    const metric = page
      .getByText('Simulated receipts · no real money collected', { exact: true })
      .locator('..');
    await expect(metric).toContainText('416.67');
    await expect(
      page.getByText('Verified recovery · payment data not connected', { exact: true }),
    ).toBeVisible();
  } finally {
    await app.locals.agentWorkflows.closeAll();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    db.close();
  }
});
