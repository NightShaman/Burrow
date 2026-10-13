import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
// Only a per-run, isolated test identity. Never use the smoke token as auth:
// /health is public, but the docs endpoints follow the normal UI auth gate.
export function smokeCredentials() {
  const username = 'smoke', password = randomBytes(24).toString('base64url');
  const salt = randomBytes(16);
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    username, passwordHash: `scrypt:16384:${salt.toString('base64url')}:${scryptSync(password, salt, 32, { N: 16384 }).toString('base64url')}` };
}

export function verifyOpenApi(document) {
  if (document?.openapi !== '3.1.0' || document?.paths?.['/api/sessions']?.get?.operationId !== 'listSessions') {
    throw new Error('Packaged OpenAPI lacks current sessions operation');
  }
}

export function docsAssetPaths(html) {
  if (!/<script\b[^>]*id=["']api-reference["'][^>]*data-configuration=["'][^>]*\/api\/openapi\.json/.test(html)) {
    throw new Error('API docs HTML does not configure the local schema');
  }
  const paths = [...html.matchAll(/(?:src|href)=["'](\/api\/docs\/[^"']+)["']/g)].map(m => m[1]);
  if (!paths.includes('/api/docs/scalar.js') || !paths.includes('/api/docs/scalar.css')) throw new Error('API docs lack local Scalar assets');
  return [...new Set(paths)];
}

export async function verifyDocsHttp(base, authorization) {
  const request = (path, headers = {}) => fetch(base + path, { headers, signal: AbortSignal.timeout(10000) });
  // A public /health token is not an authorization bypass. Assert the configured
  // Basic mode really rejects an unauthenticated docs request first.
  const denied = await request('/api/openapi.json');
  if (denied.status !== 401) throw new Error(`Unauthenticated OpenAPI expected 401, got ${denied.status}`);
  const headers = { authorization };
  const schema = await request('/api/openapi.json', headers);
  if (!schema.ok || !schema.headers.get('content-type')?.includes('application/json')) throw new Error(`Packaged OpenAPI HTTP ${schema.status}`);
  verifyOpenApi(await schema.json());
  const page = await request('/api/docs', headers);
  if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) throw new Error(`Packaged API docs HTTP ${page.status}`);
  for (const asset of docsAssetPaths(await page.text())) {
    const response = await request(asset, headers);
    const body = await response.arrayBuffer();
    if (!response.ok || !body.byteLength || response.headers.get('content-type')?.includes('text/html')) throw new Error(`Invalid packaged Scalar asset ${asset}`);
  }
}

// Native --source-dir uses the *same assembled root* as the Docker image. This
// deliberately omits dependencies and service registration, so it checks the
// real installer's packaging/activation without pretending HTTP readiness.
export function verifyNativePayload(root) {
  const temp = mkdtempSync(join(tmpdir(), 'burrow-packaged-native-'));
  const home = join(temp, 'home'), target = join(home, 'install');
  try {
    for (const dir of [home, target, join(temp, 'config'), join(temp, 'run'), join(temp, 'tmp')]) mkdirSync(dir, { recursive: true });
    // External mode is a configuration prerequisite only here: no database or
    // service is started. The installer is never pointed at an operator home.
    writeFileSync(join(target, 'burrow.env'), 'BURROW_POSTGRES_LIFECYCLE=external\nBURROW_POSTGRES_URL=postgres://127.0.0.1/unused\n');
    const result = spawnSync('sh', [join(root, 'install.sh'), '--source-dir', root, '--dir', target, '--no-install-dependencies', '--no-service'], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(temp, 'config'), XDG_RUNTIME_DIR: join(temp, 'run'), TMPDIR: join(temp, 'tmp'), BURROW_INSTALL_TEST_ROOT: temp },
    });
    if (result.error || result.status !== 0) throw new Error(`Disposable native install failed: ${result.error || result.stderr}`);
    const source = readFileSync(join(root, 'backend/docs/openapi.json'));
    const installed = readFileSync(join(target, 'app/backend/docs/openapi.json'));
    if (!source.equals(installed)) throw new Error('Native install changed or omitted packaged OpenAPI');
    verifyOpenApi(JSON.parse(installed.toString('utf8')));
    if (!existsSync(join(target, 'app/backend/public/api-docs/scalar.js')) || !existsSync(join(target, 'app/backend/public/api-docs/scalar.css'))) {
      throw new Error('Native install omitted local Scalar assets');
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export async function smoke(image, root) {
  const expected = JSON.parse(readFileSync(`${root}/backend/RELEASE_PROVENANCE.json`, 'utf8'));
  const name = `burrow-smoke-${randomUUID()}`;
  const volume = `${name}-data`, token = randomUUID(), credentials = smokeCredentials();
  const docker = (...args) => execFileSync(process.env.BURROW_SMOKE_DOCKER || 'docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    docker('volume', 'create', volume);
    docker('run', '-d', '--name', name, '--mount', `type=volume,source=${volume},target=/data`, '-p', '127.0.0.1::42817', '-e', `BURROW_SMOKE_TOKEN=${token}`, '-e', 'BURROW_UI_AUTH_MODE=basic', '-e', `BURROW_UI_AUTH_BASIC_USERNAME=${credentials.username}`, '-e', `BURROW_UI_AUTH_BASIC_PASSWORD_HASH=${credentials.passwordHash}`, image);
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
    const index = await fetch(base, { headers: { authorization: credentials.authorization }, signal: AbortSignal.timeout(10000) });
    if (!index.ok || !index.headers.get('content-type')?.includes('text/html')) throw new Error('UI index not served');
    let identity = false;
    for (const asset of assetPaths(await index.text())) {
      const response = await fetch(base + asset, { headers: { authorization: credentials.authorization }, signal: AbortSignal.timeout(10000) });
      const body = await response.text();
      if (!response.ok || !body.length || response.headers.get('content-type')?.includes('text/html')) throw new Error(`Invalid UI asset ${asset}`);
      identity ||= body.includes(expected.ui);
    }
    if (!identity) throw new Error('Served UI assets lack exact UI SHA');
    await verifyDocsHttp(base, credentials.authorization);
    verifyNativePayload(root);
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
