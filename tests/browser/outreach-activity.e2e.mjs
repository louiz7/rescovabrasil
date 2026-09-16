import { test, expect } from '@playwright/test';

test('outreach overview shows a compact channel legend without status lists on mobile', async ({
  page,
}) => {
  await page.request.post('/api/login', { data: { password: 'browser-test-password' } });
  await page.goto('/');
  const activity = page.locator('.activity-card');
  await expect(activity.getByRole('heading', { name: 'Outreach activity' })).toBeVisible();
  const legend = activity.getByLabel('Outreach channels');
  for (const channel of ['Calling', 'SMS', 'Email']) {
    await expect(legend.getByText(channel, { exact: true })).toBeVisible();
  }
  await expect(activity.locator('.outreach-channel-row')).toHaveCount(0);
  await expect(activity.getByRole('img')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(legend).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
