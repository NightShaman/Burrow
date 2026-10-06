import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyHealth, assetPaths } from './packaged-smoke.mjs';
test('health requires actual version, exact provenance and disposable token', () => {
 const expected = { assembly:'v1', backend:'a', ui:'b', nodeGoblin:'c' };
 const health = {ok:true,runtime:'burrow',version:'v1',releaseProvenance:expected,smokeToken:'token'};
 verifyHealth(health,expected,'token');
 for (const patch of [{version:'foreign'}, {runtime:'fixture'}, {smokeToken:'foreign'}, {releaseProvenance:{...expected,backend:'foreign'}}, {ok:false}]) assert.throws(()=>verifyHealth({...health,...patch},expected,'token'));
});
test('index must reference actual JS and CSS assets', () => {
 assert.deepEqual(assetPaths('<script src="/assets/index.js"></script><link href="/assets/index.css">'), ['/assets/index.js','/assets/index.css']);
 assert.throws(()=>assetPaths('<html>fixture</html>'));
});
test('assembly gates exact components, smokes loaded image before publication, never repeats component suites', () => {
 const workflow = readFileSync(new URL('../../.github/workflows/assemble.yml',import.meta.url),'utf8');
 assert.match(workflow,/component-gate\.mjs NightShaman\/Burrow-Backend/);
 assert.match(workflow,/component-gate\.mjs NightShaman\/Burrow-UI/);
 assert.doesNotMatch(workflow,/npm test|apt-get|DISPOSABLE_POSTGRES/);
 assert.equal((workflow.match(/docker\/build-push-action/g)||[]).length,1);
 assert.match(workflow,/load: true\s+push: false/);
 assert.match(workflow,/BURROW_UI_SHA=\$\{\{ steps.revisions.outputs.ui \}\}/);
 assert.ok(workflow.indexOf('Smoke disposable packaged runtime') < workflow.indexOf('Commit generated assembly'));
 assert.ok(workflow.indexOf('Smoke disposable packaged runtime') < workflow.indexOf('docker push'));
 assert.match(workflow,/docker tag burrow-assembly:tested/);
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
