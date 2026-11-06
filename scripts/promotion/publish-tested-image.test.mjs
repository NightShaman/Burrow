import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { publishTestedImage, candidateIdentity, pushDigest } from './publish-tested-image.mjs';
const tested = 'sha256:' + 'a'.repeat(64), changed = 'sha256:' + 'b'.repeat(64), digest = 'sha256:' + 'd'.repeat(64);
const identity = { schemaVersion: 1, imageId: tested };
function fake({ load = tested, tag = tested, secondDigest = digest, remote = digest, existing = false, preflightError = '' } = {}) {
  const calls = [];
  const docker = args => {
    calls.push(args);
    if (args[0] === 'image') return args.at(-1) === 'burrow-public-candidate' ? load : tag;
    if (args[0] === 'push') return `push\ndigest: ${args.at(-1).endsWith(':latest') ? secondDigest : digest} size: 123\n`;
    if (args[0] === 'buildx') {
      if (calls.filter(call => call[0] === 'buildx').length === 1) {
        if (preflightError) throw Object.assign(new Error(preflightError), { stderr: preflightError });
        if (!existing) throw Object.assign(new Error('manifest unknown'), { stderr: 'manifest unknown' });
      }
      return remote;
    }
    return 'ok';
  };
  return { docker, calls };
}
test('publication loads smoke-tested image and confirms both local IDs and remote tag digests without rebuilding', () => {
  const { docker, calls } = fake();
  const result = publishTestedImage({ version: '2026.11.06', identity, docker });
  assert.deepEqual(result, { testedImageId: tested, publicDigest: digest, references: ['ghcr.io/goblinking-burrow/burrow:2026.11.06', 'ghcr.io/goblinking-burrow/burrow:latest'] });
  assert.deepEqual(calls[0], ['load', '-i', 'tested-image.tar']);
  assert.equal(calls.filter(args => args[0] === 'push').length, 2);
  assert.equal(calls.filter(args => args[0] === 'buildx').length, 3);
  assert.equal(calls.some(args => args.includes('build')), false);
});
test('image missing or changed at handoff fails before any public push', () => {
  for (const [options, error] of [[{ load: changed }, /restored candidate image differs/], [{ tag: changed }, /tagged image differs/], [{ existing: true, tag: changed }, /refusing to move existing immutable date tag/], [{ preflightError: 'denied: unauthorized' }, /denied: unauthorized/]]) {
    const { docker, calls } = fake(options);
    assert.throws(() => publishTestedImage({ version: '2026.11.06', identity, docker }), error);
    assert.equal(calls.some(args => args[0] === 'push'), false);
  }
  assert.throws(() => candidateIdentity({ ...identity, imageId: 'mutable' }), /missing tested image identity/);
  assert.throws(() => pushDigest('no digest'), /digest missing/);
});
test('native Buildx exact missing-reference diagnostic allows first publication, but generic not-found does not', () => {
  const reference = 'ghcr.io/goblinking-burrow/burrow:2026.11.06';
  const native = fake({ preflightError: `ERROR: ${reference}: not found` });
  assert.equal(publishTestedImage({ version: '2026.11.06', identity, docker: native.docker }).publicDigest, digest);
  assert.equal(native.calls.filter(args => args[0] === 'push').length, 2);
  for (const message of ['docker executable not found', `ERROR: ${reference}: not found; denied: unauthorized`]) {
    const { docker, calls } = fake({ preflightError: message });
    assert.throws(() => publishTestedImage({ version: '2026.11.06', identity, docker }), /not found/);
    assert.equal(calls.some(args => args[0] === 'push'), false);
  }
});
test('matching existing immutable date tag is reused, never repushed', () => {
  const { docker, calls } = fake({ existing: true });
  assert.equal(publishTestedImage({ version: '2026.11.06', identity, docker }).publicDigest, digest);
  assert.deepEqual(calls.filter(args => args[0] === 'push').map(args => args[1]), ['ghcr.io/goblinking-burrow/burrow:latest']);
  assert.ok(calls.some(args => args[0] === 'pull' && args[1].endsWith(':2026.11.06')));
});
test('divergent published tag or remote registry digest blocks release', () => {
  for (const [options, error] of [[{ secondDigest: changed }, /public tag digests differ/], [{ remote: changed }, /remote image digest mismatch/]]) {
    const { docker } = fake(options);
    assert.throws(() => publishTestedImage({ version: '2026.11.06', identity, docker }), error);
  }
});
test('live workflow archives tested image and does not rebuild after smoke', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/daily-public-promotion.yml', import.meta.url), 'utf8');
  const smoke = workflow.indexOf('packaged-smoke.mjs burrow-public-candidate');
  const save = workflow.indexOf('docker save burrow-public-candidate');
  const bundle = workflow.indexOf('tar -cpf public-promotion.tar');
  const restore = workflow.indexOf('gzip -dc tested-image.tar.gz > tested-image.tar');
  const publish = workflow.indexOf('publish-tested-image.mjs "$VERSION" tested-image.json');
  assert.ok(smoke > 0 && smoke < save && save < bundle && bundle < restore && restore < publish);
  assert.match(workflow.slice(bundle, restore), /tested-image\.json tested-image\.tar\.gz tested-image\.tar\.gz\.sha256/);
  assert.doesNotMatch(workflow.slice(restore), /docker\/build-push-action|docker build/);
  assert.match(workflow.slice(0, smoke), /if: steps.plan.outputs.validation_required == 'true'/);
  assert.match(workflow.slice(bundle, restore), /if: needs.stage.outputs.publishable == 'true'/);
});
