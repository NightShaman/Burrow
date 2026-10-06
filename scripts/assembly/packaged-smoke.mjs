import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

export function verifyHealth(health, expected, token) {
  if (health.ok !== true || health.runtime !== 'burrow' || health.version !== expected.assembly ||
      health.smokeToken !== token || !isDeepStrictEqual(health.releaseProvenance, expected)) {
    throw new Error('Packaged health identity/provenance mismatch');
  }
}
export function assetPaths(html) {
  const paths = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(m => m[1]).filter(p => p.startsWith('/assets/'));
  if (!paths.some(p => p.endsWith('.js')) || !paths.some(p => p.endsWith('.css'))) throw new Error('UI index lacks JS/CSS assets');
  return [...new Set(paths)];
}
export async function smoke(image, root) {
  const expected = JSON.parse(readFileSync(`${root}/backend/RELEASE_PROVENANCE.json`, 'utf8'));
  const name = `burrow-smoke-${randomUUID()}`;
  const volume = `${name}-data`, token = randomUUID();
  const docker = (...args) => execFileSync(process.env.BURROW_SMOKE_DOCKER || 'docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    docker('volume', 'create', volume);
    docker('run', '-d', '--name', name, '--mount', `type=volume,source=${volume},target=/data`, '-p', '127.0.0.1::42817', '-e', `BURROW_SMOKE_TOKEN=${token}`, image);
    docker('exec', name, 'sh', '-ec', 'test -x /usr/local/bin/burrow-docker-entrypoint; test -x /opt/burrow/bin/burrow.mjs; test -f /opt/burrow/scripts/postgres-supervisor.mjs; node /opt/burrow/bin/burrow.mjs --help');
    const port = docker('port', name, '42817/tcp').split(':').at(-1);
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + Number(process.env.BURROW_SMOKE_TIMEOUT_MS || 300000);
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${base}/health`, { headers: { 'x-burrow-smoke-token': token }, signal: AbortSignal.timeout(5000) });
        if (response.ok) { verifyHealth(await response.json(), expected, token); ready = true; break; }
      } catch (error) { if (error.message.includes('mismatch')) throw error; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error('Packaged runtime readiness deadline exceeded');
    const index = await fetch(base, { signal: AbortSignal.timeout(10000) });
    if (!index.ok || !index.headers.get('content-type')?.includes('text/html')) throw new Error('UI index not served');
    let identity = false;
    for (const asset of assetPaths(await index.text())) {
      const response = await fetch(base + asset, { signal: AbortSignal.timeout(10000) });
      const body = await response.text();
      if (!response.ok || !body.length || response.headers.get('content-type')?.includes('text/html')) throw new Error(`Invalid UI asset ${asset}`);
      identity ||= body.includes(expected.ui);
    }
    if (!identity) throw new Error('Served UI assets lack exact UI SHA');
    console.log(`Packaged smoke passed: ${image}; ${JSON.stringify(expected)}`);
  } catch (error) {
    try { console.error(docker('logs', name)); } catch {}
    throw error;
  } finally {
    // Attempt both cleanups even if the container was never created.
    const failures = [];
    try { docker('rm', '-f', '-v', name); } catch (error) { if (!String(error.stderr).includes('No such container')) failures.push(error); }
    try { docker('volume', 'rm', '-f', volume); } catch (error) { if (!String(error.stderr).includes('no such volume')) failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Smoke cleanup failed');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: packaged-smoke.mjs IMAGE ASSEMBLED_ROOT');
  await smoke(process.argv[2], process.argv[3]);
}
