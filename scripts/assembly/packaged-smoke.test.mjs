import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyHealth, assetPaths, verifyOpenApi, docsAssetPaths, smokeCredentials, verifyNativePayload } from './packaged-smoke.mjs';
import { scryptSync } from 'node:crypto';
test('health requires actual version, exact provenance and disposable token', () => {
 const expected = { assembly:'v1', backend:'a', ui:'b' };
 const health = {ok:true,runtime:'burrow',version:'v1',releaseProvenance:expected,smokeToken:'token'};
 verifyHealth(health,expected,'token');
 for (const patch of [{version:'foreign'}, {runtime:'fixture'}, {smokeToken:'foreign'}, {releaseProvenance:{...expected,backend:'foreign'}}, {ok:false}]) assert.throws(()=>verifyHealth({...health,...patch},expected,'token'));
});
test('index must reference actual JS and CSS assets', () => {
 assert.deepEqual(assetPaths('<script src="/assets/index.js"></script><link href="/assets/index.css">'), ['/assets/index.js','/assets/index.css']);
 assert.throws(()=>assetPaths('<html>fixture</html>'));
});
test('development assembly publishes a smoke-tested dev image while complete validation stays in daily promotion', () => {
 const workflow = readFileSync(new URL('../../.github/workflows/assemble.yml',import.meta.url),'utf8');
 const promotion = readFileSync(new URL('../../.github/workflows/daily-public-promotion.yml',import.meta.url),'utf8');
 assert.match(workflow,/component-gate\.mjs NightShaman\/Burrow-Backend/);
 assert.match(workflow,/component-gate\.mjs NightShaman\/Burrow-UI/);
 assert.doesNotMatch(workflow,/npm test|apt-get|DISPOSABLE_POSTGRES/);
 assert.match(workflow,/docker\/build-push-action/);
 assert.match(workflow,/packaged-smoke\.mjs burrow-development:tested/);
 assert.match(workflow,/for tag in latest dev/);
 assert.match(workflow,/ghcr\.io\/nightshaman\/burrow:\$tag/);
 assert.match(workflow,/sha-\$\{\{ steps\.publish\.outputs\.commit \}\}/);
 assert.match(promotion,/Run complete frozen-source test suites/);
 assert.match(promotion,/npm test/);
 assert.match(promotion,/Build and smoke the public Burrow image/);
 assert.match(promotion,/packaged-smoke\.mjs/);
 assert.match(promotion,/ghcr\.io\/goblinking-burrow\/burrow/);
 assert.match(promotion,/gh release create/);
 assert.match(promotion,/Burrow-Backdoor/);
});

test('smoke uses isolated resources and cleanup in finally', () => {
 const source = readFileSync(new URL('./packaged-smoke.mjs',import.meta.url),'utf8');
 assert.match(source,/127\.0\.0\.1::42817/);
 assert.match(source,/type=volume,source=/);
 assert.match(source,/finally/);
 assert.match(source,/docker\('rm', '-f', '-v', name\)/);
 assert.match(source,/docker\('volume', 'rm', '-f', volume\)/);
 assert.match(source,/test -x \/opt\/burrow\/bin\/burrow\.mjs/);
});

test('assembly selects only the runtime OpenAPI file from canonical backend docs', () => {
 const workflow = readFileSync(new URL('../../.github/workflows/assemble.yml', import.meta.url), 'utf8');
 assert.match(workflow, /install -d backend\/docs\s+cp \.\.\/backend-source\/docs\/openapi\.json backend\/docs\/openapi\.json/);
 assert.doesNotMatch(workflow, /cp\s+-a\s+\.\.\/backend-source\/docs\b|cp\s+-R\s+\.\.\/backend-source\/docs\b/);
});
test('assembly preserves repository-owned presentation and governance files', () => {
 const workflow = readFileSync(new URL('../../.github/workflows/assemble.yml', import.meta.url), 'utf8');
 assert.doesNotMatch(workflow, /rm -rf[^\n]*(?:README\.md|docs\/|LICENSE|burrow-logo\.png)/);
 assert.doesNotMatch(workflow, /cp \.\.\/backend-source\/deploy\/README\.md README\.md/);
 assert.doesNotMatch(workflow, /cp \.\.\/ui-source\/public\/burrow-logo\.png burrow-logo\.png/);
 assert.match(workflow, /rm -rf backend ui Dockerfile docker-entrypoint\.sh compose\.yml \.dockerignore install\.sh install-node-goblin\.sh SOURCE_VERSIONS/);
});
test('smoke parses a current OpenAPI operation and requires local Scalar HTML assets', () => {
 verifyOpenApi({ openapi: '3.1.0', paths: { '/api/sessions': { get: { operationId: 'listSessions' } } } });
 assert.throws(() => verifyOpenApi({ openapi: '3.1.0', paths: {} }));
 assert.deepEqual(docsAssetPaths('<script id="api-reference" data-configuration="{&quot;url&quot;:&quot;/api/openapi.json&quot;}"></script><link href="/api/docs/scalar.css"><script src="/api/docs/scalar.js"></script>'), ['/api/docs/scalar.css','/api/docs/scalar.js']);
 assert.throws(() => docsAssetPaths('<script src="https://cdn.example/scalar.js"></script>'));
 const credentials = smokeCredentials();
 const [username, password] = Buffer.from(credentials.authorization.slice(6), 'base64').toString().split(':');
 const [kind, cost, salt, hash] = credentials.passwordHash.split(':');
 assert.equal(username, credentials.username);
 assert.equal(kind, 'scrypt');
 assert.deepEqual(scryptSync(password, Buffer.from(salt, 'base64url'), 32, { N: Number(cost) }), Buffer.from(hash, 'base64url'));
});
test('native installer preserves packaged schema and Scalar assets from same assembly root', { skip: !process.env.BURROW_TEST_ASSEMBLED_ROOT }, () => {
 verifyNativePayload(process.env.BURROW_TEST_ASSEMBLED_ROOT);
});
