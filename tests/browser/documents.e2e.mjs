import { test, expect } from '@playwright/test';

test('case library uploads and downloads a document and shows the virtual SMS attachment', async ({
  page,
}) => {
  const caseId = 'documents-ui-case';
  const conversation = {
    id: 'documents-ui-conversation',
    caseId,
    caseName: 'Ana Silva',
    status: 'active',
  };
  const documents = [];
  const uploaded = [];
  const content = 'DEMO ONLY\nOriginal loan agreement for Ana Silva. Reference DOCUMENT-UI.';
  const documentPath = `/api/cases/${caseId}/documents`;
  await page.route('**/api/agent-workflows**', async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      json:
        url.pathname === '/api/agent-workflows'
          ? { conversations: [conversation] }
          : {
              conversation,
              messages: documents.length
                ? [
                    {
                      id: 'document-message',
                      direction: 'outbound',
                      text: 'Here is the original loan agreement you requested.',
                      documents,
                    },
                  ]
                : [],
              tasks: [],
              runs: [],
              events: [],
            },
    });
  });
  await page.route(`**/api/cases/${caseId}`, (route) =>
    route.fulfill({
      json: {
        id: caseId,
        name: 'Ana Silva',
        reference: 'DOCUMENT-UI',
        portfolio_name: 'Documents UI demo',
        amount_minor: 125000,
        due_date: '2026-01-01',
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
  await page.context().route(`**${documentPath}**`, async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/content'))
      return route.fulfill({
        status: 200,
        contentType: 'text/plain',
        headers: { 'Content-Disposition': 'attachment; filename="agreement.txt"' },
        body: content,
      });
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      uploaded.push(body);
      documents.push({
        id: 'document-ui-1',
        title: body.title,
        kind: body.kind,
        version: 1,
        source: 'operator_upload',
        created_at: new Date().toISOString(),
      });
      return route.fulfill({ status: 201, json: documents[0] });
    }
    return route.fulfill({
      json: {
        documents,
        requests: [
          {
            id: 'request-ui-1',
            kind: 'loan_agreement',
            status: 'delivered',
            created_at: new Date().toISOString(),
          },
        ],
      },
    });
  });
  await page.goto('/');
  await page.getByLabel('Workspace password').fill('browser-test-password');
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await page.getByRole('button', { name: 'Demo SMS conversations', exact: true }).click();
  await page.getByRole('button', { name: 'Open case', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(dialog.getByText('Demo only', { exact: true })).toBeVisible();
  await expect(dialog.getByText('No documents yet.', { exact: false })).toBeVisible();
  await dialog.getByLabel('Document title').fill('Original loan agreement');
  await dialog.getByLabel('Document type').selectOption('loan_agreement');
  await dialog
    .getByLabel('Plain text file')
    .setInputFiles({ name: 'agreement.txt', mimeType: 'text/plain', buffer: Buffer.from(content) });
  await dialog.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Demo document uploaded');
  expect(uploaded).toEqual([{ title: 'Original loan agreement', kind: 'loan_agreement', content }]);
  const downloadLink = dialog.getByRole('link', { name: 'Download Original loan agreement' });
  await expect(downloadLink).toHaveAttribute('href', `${documentPath}/document-ui-1/content`);
  await expect(downloadLink).toHaveAttribute('download', '');
  // Chromium bypasses route mocks for native download links. Let the mocked
  // Content-Disposition response initiate this download instead.
  await downloadLink.evaluate((link) => link.removeAttribute('download'));
  const downloaded = page.waitForEvent('download');
  await downloadLink.click();
  expect((await downloaded).suggestedFilename()).toBe('agreement.txt');
  await expect(dialog.getByText('delivered', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Conversations', exact: true }).click();
  await expect(
    dialog.getByText('Here is the original loan agreement you requested.'),
  ).toBeVisible();
  const attachment = dialog.getByRole('link', { name: /Original loan agreement.*Download/ });
  await expect(attachment).toHaveAttribute('href', `${documentPath}/document-ui-1/content`);
  await expect(attachment).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  ).toBeTruthy();
});
