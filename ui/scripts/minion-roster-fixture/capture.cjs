const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  fs.mkdirSync('/tmp/minion-roster-proof-refreshed', { recursive: true });
  for (const state of ['ready', 'pending', 'error', 'loading', 'save-error']) {
    await page.goto(
      'http://127.0.0.1:5189/scripts/minion-roster-fixture/index.html?state=' + state,
    );
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('button', { name: 'Global', exact: true }).click();
    await page.getByRole('button', { name: 'Minions', exact: true }).click();
    if (!['error', 'loading'].includes(state))
      await page.getByLabel('Burrow provider', { exact: true }).waitFor();
    if (['pending', 'save-error'].includes(state)) {
      await page.getByLabel('Maximum minion depth').selectOption('2');
      await page.getByRole('button', { name: 'Save minion defaults', exact: true }).click();
      if (state === 'save-error') await page.getByRole('alert').waitFor();
    }
    await page.screenshot({ path: '/tmp/minion-roster-proof-refreshed/' + state + '.png' });
    console.log(state, await page.locator('body').innerText());
  }
  console.log('PAGE_ERRORS', errors);
  await browser.close();
})();
