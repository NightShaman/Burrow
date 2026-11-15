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
  for (const state of ['before', 'after', 'pending', 'error', 'loading', 'save-error']) {
    await page.goto(
      'http://127.0.0.1:5189/scripts/minion-roster-fixture/index.html?state=' + state,
    );
    if (!['error', 'loading'].includes(state))
      await page.getByLabel('Name', { exact: true }).waitFor();
    if (['after', 'pending', 'save-error'].includes(state)) {
      await page.getByRole('button', { name: 'Implementation specialist', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('Implementation specialist — reviewed');
      await page.getByRole('button', { name: 'Save minion', exact: true }).click();
      if (state === 'after')
        await page
          .getByRole('button', { name: 'Implementation specialist — reviewed', exact: true })
          .waitFor();
      if (state === 'pending')
        await page.getByRole('button', { name: 'Saving…', exact: true }).waitFor();
      if (state === 'save-error') await page.getByRole('alert').waitFor();
    }
    await page.screenshot({ path: '/tmp/minion-roster-proof-refreshed/' + state + '.png' });
    console.log(state, await page.locator('body').innerText());
  }
  console.log('PAGE_ERRORS', errors);
  await browser.close();
})();
