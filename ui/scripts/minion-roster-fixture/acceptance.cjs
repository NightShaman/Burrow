const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE || '/mnt/local/projects/Goblin-CODEX/web/node_modules/playwright',
);
const fs = require('fs');
(async () => {
  const out = '/tmp/minion-global-agent-acceptance';
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      '/mnt/local/hatchet/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
  const errors = [];
  page.on('pageerror', (e) => (errors.push(String(e)), console.log('ERROR', String(e))));
  const results = [];
  for (const version of ['before', 'after'])
    for (const scope of ['global', 'agent'])
      for (const state of version === 'before'
        ? ['ready']
        : scope === 'global'
          ? ['ready']
          : ['inherit', 'ready', 'pending', 'save-error']) {
        const base = version === 'before' ? 'http://10.10.20.105:5193' : 'http://10.10.20.105:5174';
        await page.goto(
          `${base}/scripts/minion-roster-fixture/index.html?scope=${scope}&state=${state}`,
        );
        await page.waitForTimeout(900);
        console.log(version, scope, state, await page.locator('body').innerText());
        if (scope === 'global' && version === 'after') {
          await page.getByRole('button', { name: 'Agents', exact: true }).click();
          await page.getByRole('button', { name: 'Global', exact: true }).click();
          await page.getByRole('button', { name: 'Minions', exact: true }).click();
          await page.waitForTimeout(400);
        }
        if (scope === 'agent') {
          await page.getByText('Fixture agent', { exact: true }).first().click();
          await page.waitForTimeout(300);
        }
        if (scope === 'agent' && version === 'after') {
          await page.getByRole('button', { name: 'Minions', exact: true }).click();
          await page.getByLabel('Override global minion settings').waitFor();
        }
        if (['pending', 'save-error'].includes(state)) {
          await page.getByLabel('Maximum minion depth').selectOption('2');
          await page.getByRole('button', { name: 'Save minion defaults', exact: true }).click();
          await page.waitForTimeout(300);
        }
        const text = await page.locator('body').innerText();
        const fields = await page.locator('select').evaluateAll((es) =>
          es.map((e) => ({
            value: e.value,
            disabled: e.matches(':disabled'),
            x: e.getBoundingClientRect().x,
          })),
        );
        await page.screenshot({ path: `${out}/${version}-${scope}-${state}.png` });
        results.push({
          version,
          scope,
          state,
          text,
          fields,
          requests: await page.evaluate(() => window.fixtureRequests),
        });
      }
  fs.writeFileSync(out + '/results.json', JSON.stringify({ errors, results }, null, 2));
  console.log(
    JSON.stringify(
      { errors, captures: results.map((r) => [r.version, r.scope, r.state, r.fields]) },
      null,
      2,
    ),
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
