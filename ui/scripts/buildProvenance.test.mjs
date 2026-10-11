import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('retains the exact supplied UI SHA in index-linked production JS without a UI consumer', () => {
  const root = mkdtempSync(join(tmpdir(), 'burrow-provenance-'));
  const sha = '0123456789abcdef0123456789abcdef01234567';
  try {
    writeFileSync(join(root, 'index.html'), '<div id="root"></div><script type="module" src="/entry.js"></script>');
    // Intentionally no build-identity reference: rendering must not own provenance.
    writeFileSync(join(root, 'entry.js'), 'document.getElementById("root").textContent = "Burrow";');
    execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', root, '--config', resolve('vite.config.ts')], {
      env: { ...process.env, BURROW_UI_SHA: sha }, stdio: 'pipe',
    });
    const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
    const entry = html.match(/src="(\/assets\/[^"\s]+\.js)"/)?.[1];
    expect(entry).toBeTruthy();
    const javascript = readFileSync(join(root, 'dist', entry.slice(1)), 'utf8');
    expect(javascript).toContain(`globalThis.__BURROW_UI_BUILD_IDENTITY__="${sha}";`);
    expect(html).not.toContain(sha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
