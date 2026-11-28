import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  preparePublicOutcomeIntent, preparePublicOutcomeIntents, stagedSourceTree, testedImageConfigId, verifyPreparedPublicOutcome,
} from './verify-public-outcome.mjs';
import { COMPANION_TARGETS } from './companion-targets.mjs';

const SCRIPT = fileURLToPath(new URL('./verify-public-outcome.mjs', import.meta.url));
const NOW = new Date('2026-11-24T23:59:00.000Z');
const CONFIG_BYTES = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] }, config: {} }));
const IMAGE_ID = `sha256:${createHash('sha256').update(CONFIG_BYTES).digest('hex')}`;
const MANIFEST_DIGEST = `sha256:${'c'.repeat(64)}`;
const DISPOSITION = { publishable: true, validateOnly: false };
const json = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function archiveChecksum(root) {
  const archive = path.join(root, 'tested-image.tar.gz');
  const checksum = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(`${archive}.sha256`, `${checksum}  tested-image.tar.gz\n`);
}

// Tiny real Docker-save-shaped gzip/tar archives: no Docker or network I/O.
function savedImage(root, { containerd = false, files: overrides = {}, manifest, duplicate } = {}) {
  const input = fs.mkdtempSync(path.join(root, 'archive-input-'));
  const configPath = containerd ? `blobs/sha256/${IMAGE_ID.slice(7)}` : `${IMAGE_ID.slice(7)}.json`;
  const files = {
    'manifest.json': JSON.stringify(manifest ?? [{ Config: configPath, RepoTags: ['burrow-public-candidate:latest'], Layers: [] }]),
    [configPath]: CONFIG_BYTES,
  };
  let runtimeId = IMAGE_ID;
  if (containerd) {
    const runtimeManifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: IMAGE_ID, size: CONFIG_BYTES.length }, layers: [] });
    const digest = createHash('sha256').update(runtimeManifest).digest('hex');
    const index = JSON.stringify({ schemaVersion: 2, manifests: [{ digest: `sha256:${digest}`, platform: { os: 'linux', architecture: 'amd64' } }] });
    runtimeId = `sha256:${createHash('sha256').update(index).digest('hex')}`;
    files[`blobs/sha256/${digest}`] = runtimeManifest;
    files[`blobs/sha256/${runtimeId.slice(7)}`] = index;
    files['index.json'] = JSON.stringify({ schemaVersion: 2, manifests: [{ digest: runtimeId }] });
  }
  Object.assign(files, overrides);
  for (const [name, content] of Object.entries(files)) {
    if (content === null) { delete files[name]; continue; }
    fs.mkdirSync(path.dirname(path.join(input, name)), { recursive: true });
    fs.writeFileSync(path.join(input, name), content);
  }
  const archive = path.join(root, 'tested-image.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', input, '--', ...Object.keys(files), ...(duplicate ? [duplicate] : [])]);
  archiveChecksum(root);
  fs.rmSync(input, { recursive: true, force: true });
  return { configPath, runtimeId };
}

function fixture(t, { releaseDate = '2026.11.24', originRunId = '1234' } = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'burrow-outcome-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, 'staged/Burrow');
  fs.mkdirSync(path.join(payload, '.github'), { recursive: true });
  const sources = Object.fromEntries(['burrow', 'burrowBackend', 'burrowUi', 'nodeGoblin', 'goblinSecretStore', 'burrowSkills', 'burrowBackdoor', 'burrowTutor', 'burrowTheater', 'burrowSwitchboard'].map((key, index) => [key, String(index).repeat(40)]));
  json(path.join(payload, 'PUBLIC_RELEASE.json'), { schemaVersion: 1, releaseDate, promotionRunId: originRunId, sources });
  json(path.join(root, 'plan.json'), {
    schemaVersion: 1, releaseDate, sources, publishable: true, resumeRunId: null,
    targets: [{ id: 'burrow', repository: 'GoblinKing-Burrow/Burrow', version: releaseDate, action: 'stage' }],
  });
  savedImage(root);
  json(path.join(root, 'tested-image.json'), { schemaVersion: 1, imageId: IMAGE_ID });
  fs.writeFileSync(path.join(payload, '.gitignore'), 'ignored.tmp\n');
  fs.writeFileSync(path.join(payload, 'ignored.tmp'), 'not added by the publisher');
  fs.writeFileSync(path.join(payload, '.gitattributes'), '*.txt text eol=lf\n');
  fs.writeFileSync(path.join(payload, 'normalized.txt'), 'line one\r\nline two\r\n');
  fs.writeFileSync(path.join(payload, 'README.md'), 'frozen public payload\n');
  fs.writeFileSync(path.join(payload, '.github/hidden.txt'), 'allowlisted hidden file\n');
  fs.writeFileSync(path.join(payload, 'install.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync('README.md', path.join(payload, 'readme-link'));
  return {
    root, payload,
    options: {
      ...DISPOSITION, artifactRoot: root, releaseDate, originRunId,
      handlingRepository: 'NightShaman/Burrow', handlingRunId: '9876', handlingRunAttempt: '2',
    },
    outputFile: path.join(root, 'public-outcome.json'),
  };
}

test('classic Docker archive prepares the config digest equal to its schema-v1 runtime ID', t => {
  const f = fixture(t);
  assert.equal(testedImageConfigId(f.root), IMAGE_ID);
  assert.equal(preparePublicOutcomeIntent(f.options).expectedArtifact.imageId, IMAGE_ID);
});

test('containerd index runtime ID stays unchanged while intent uses the archived config digest', async t => {
  const f = fixture(t);
  const { runtimeId } = savedImage(f.root, { containerd: true });
  assert.notEqual(runtimeId, IMAGE_ID);
  const identityFile = path.join(f.root, 'tested-image.json');
  json(identityFile, { schemaVersion: 1, imageId: runtimeId });
  const before = fs.readFileSync(identityFile);
  const intent = preparePublicOutcomeIntent(f.options);
  assert.equal(intent.expectedArtifact.imageId, IMAGE_ID);
  assert.deepEqual(fs.readFileSync(identityFile), before, 'publisher still receives the original local-store ID');
  let calls = 0;
  const result = await verifyPreparedPublicOutcome(verifyOptions(f, intent), { verifyOutcome: async input => {
    calls++;
    assert.equal(input.expectedArtifact.imageId, IMAGE_ID);
    assert.notEqual(input.expectedArtifact.imageId, runtimeId);
    return nativeResult(input);
  } });
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 0);
});

test('missing, malformed, ambiguous or checksum-unbound saved image metadata fails closed', async t => {
  const configPath = `${IMAGE_ID.slice(7)}.json`;
  for (const [name, mutate] of [
    ['missing archive', f => fs.rmSync(path.join(f.root, 'tested-image.tar.gz'))],
    ['missing checksum', f => fs.rmSync(path.join(f.root, 'tested-image.tar.gz.sha256'))],
    ['wrong checksum', f => fs.writeFileSync(path.join(f.root, 'tested-image.tar.gz.sha256'), `${'0'.repeat(64)}  tested-image.tar.gz\n`)],
    ['malformed checksum path', f => fs.writeFileSync(path.join(f.root, 'tested-image.tar.gz.sha256'), `${'0'.repeat(64)}  other.tar.gz\n`)],
    ['extra checksum record', f => fs.appendFileSync(path.join(f.root, 'tested-image.tar.gz.sha256'), '\n')],
    ['invalid gzip despite matching checksum', f => {
      fs.writeFileSync(path.join(f.root, 'tested-image.tar.gz'), 'not a gzip archive');
      archiveChecksum(f.root);
    }],
    ['invalid tar despite matching checksum', f => {
      fs.writeFileSync(path.join(f.root, 'tested-image.tar.gz'), gzipSync('not a tar archive'));
      archiveChecksum(f.root);
    }],
    ['missing manifest', f => savedImage(f.root, { files: { 'manifest.json': null } })],
    ['invalid JSON manifest', f => savedImage(f.root, { files: { 'manifest.json': '{' } })],
    ['nonarray manifest', f => savedImage(f.root, { manifest: {} })],
    ['empty manifest', f => savedImage(f.root, { manifest: [] })],
    ['multiple images', f => savedImage(f.root, { manifest: [{ Config: configPath }, { Config: configPath }] })],
    ['missing config reference', f => savedImage(f.root, { manifest: [{}] })],
    ['unsafe config reference', f => savedImage(f.root, { manifest: [{ Config: '../config.json' }] })],
    ['missing config member', f => savedImage(f.root, { files: { [configPath]: null } })],
    ['config digest mismatch', f => savedImage(f.root, { files: { [configPath]: '{}' } })],
    ['duplicate manifest member', f => savedImage(f.root, { duplicate: 'manifest.json' })],
    ['duplicate config member', f => savedImage(f.root, { duplicate: configPath })],
    ['invalid config JSON', f => {
      const bytes = '{';
      const member = `${createHash('sha256').update(bytes).digest('hex')}.json`;
      savedImage(f.root, { manifest: [{ Config: member }], files: { [member]: bytes } });
    }],
    ['nonconfig JSON blob', f => {
      const bytes = '{}';
      const member = `${createHash('sha256').update(bytes).digest('hex')}.json`;
      savedImage(f.root, { manifest: [{ Config: member }], files: { [member]: bytes } });
    }],
  ]) await t.test(name, t => {
    const f = fixture(t);
    mutate(f);
    assert.throws(() => preparePublicOutcomeIntent(f.options), /promotion_outcome_tested_image_archive_invalid/);
    assert.equal(fs.existsSync(f.outputFile), false);
  });
});

// These are inert native-verifier-shaped receipts, not HTTP observations.
function nativeResult(intent, status = 'verified') {
  const urls = {
    github_release: `https://api.github.com/repos/${intent.repository}/releases/tags/v${intent.version}`,
    github_commit: `https://api.github.com/repos/${intent.repository}/commits/v${intent.version}`,
    ghcr_token: 'https://ghcr.io/token?service=ghcr.io&scope=repository%3Agoblinking-burrow%2Fburrow%3Apull',
    ghcr_manifest: `https://ghcr.io/v2/goblinking-burrow/burrow/manifests/${intent.version}`,
  };
  return { ok: true, outcomeCheck: {
    schemaVersion: 1, kind: 'outcome-check', verifier: 'github_public_release', status,
    expected: { repository: intent.repository, version: intent.version, artifact: structuredClone(intent.expectedArtifact) },
    observed: { repository: intent.repository, version: intent.version, artifact: {
      ...intent.expectedArtifact, manifestDigest: MANIFEST_DIGEST,
    } },
    checkedAt: NOW.toISOString(), reasonCode: status === 'verified' ? 'public_release_verified' : `fixture_${status}`,
    reason: 'Injected inert outcome; no live public validation.',
    evidenceSources: Object.entries(urls).map(([kind, url]) => ({ kind, url, statusCode: 200, checkedAt: NOW.toISOString() })),
    intentSource: { kind: 'caller_supplied', sourceRefs: [...intent.sourceRefs] },
  } };
}

function verifyOptions(f, intent, overrides = {}) {
  return { ...DISPOSITION, intent, outputFile: f.outputFile, ...overrides };
}

test('expected tree matches publisher git add semantics, modes, symlinks and hidden files without changing payload or enclosing index', t => {
  const f = fixture(t);
  git(f.root, ['init', '--quiet']);
  fs.writeFileSync(path.join(f.root, 'sentinel'), 'keep existing index\n');
  git(f.root, ['add', 'sentinel']);
  const indexBefore = fs.readFileSync(path.join(f.root, '.git/index'));
  const payloadBefore = fs.readFileSync(path.join(f.payload, 'normalized.txt'));
  const executableModeBefore = fs.statSync(path.join(f.payload, 'install.sh')).mode & 0o777;
  const expectedRoot = path.join(f.root, 'publisher-copy');
  fs.mkdirSync(expectedRoot);
  git(expectedRoot, ['init', '--quiet']);
  fs.cpSync(f.payload, expectedRoot, { recursive: true, verbatimSymlinks: true });
  git(expectedRoot, ['add', '-A']);
  const expected = git(expectedRoot, ['write-tree']);
  const listing = git(expectedRoot, ['ls-files', '--stage']);
  assert.match(listing, /100755 .*\tinstall\.sh/);
  assert.match(listing, /120000 .*\treadme-link/);
  assert.match(listing, /\.github\/hidden\.txt/);
  assert.doesNotMatch(listing, /ignored\.tmp/);
  const actual = stagedSourceTree(f.payload);
  assert.equal(actual, expected);
  assert.equal(stagedSourceTree(f.payload), expected);
  assert.notEqual(actual, read(path.join(f.payload, 'PUBLIC_RELEASE.json')).sources.burrow);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), indexBefore);
  assert.deepEqual(fs.readFileSync(path.join(f.payload, 'normalized.txt')), payloadBefore);
  assert.equal(fs.existsSync(path.join(f.payload, '.git')), false);
  assert.equal(fs.statSync(path.join(f.payload, 'install.sh')).mode & 0o777, executableModeBefore);
});

test('verified terminal outcome persists native receipt, calls once and stays bound to prepared payload rather than later observations', async t => {
  const f = fixture(t);
  const intent = preparePublicOutcomeIntent(f.options);
  const frozenTree = intent.expectedArtifact.sourceTreeSha;
  fs.writeFileSync(path.join(f.payload, 'README.md'), 'later local mutation must not redefine the prepared intent\n');
  assert.notEqual(stagedSourceTree(f.payload), frozenTree);
  let calls = 0;
  const result = await verifyPreparedPublicOutcome(verifyOptions(f, intent), { verifyOutcome: async input => {
    calls++;
    assert.deepEqual(input, intent);
    assert.equal(input.expectedArtifact.imageId, IMAGE_ID);
    assert.equal(input.expectedArtifact.sourceTreeSha, frozenTree);
    return nativeResult(input);
  } });
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcomeCheck.status, 'verified');
  assert.deepEqual(read(f.outputFile), result.outcomeCheck);
  assert.equal(intent.sourceRefs[0], 'https://github.com/NightShaman/Burrow/actions/runs/1234');
  assert.equal(intent.sourceRefs[1], 'actions-artifact:NightShaman/Burrow/1234/public-promotion-2026.11.24/public-promotion.tar');
  assert.equal(intent.sourceRefs[2], 'https://github.com/NightShaman/Burrow/actions/runs/9876/attempts/2');
});

test('resume verifies the original prior date/artifact/run, not the current handling date or run', async t => {
  const f = fixture(t, { releaseDate: '2026.11.22', originRunId: '1100' });
  const intent = preparePublicOutcomeIntent(f.options);
  assert.equal(intent.version, '2026.11.22');
  assert.match(intent.sourceRefs[0], /runs\/1100$/);
  assert.match(intent.sourceRefs[1], /1100\/public-promotion-2026\.11\.22\/public-promotion\.tar$/);
  assert.match(intent.sourceRefs[2], /runs\/9876\/attempts\/2$/);
  const result = await verifyPreparedPublicOutcome(verifyOptions(f, intent), { verifyOutcome: async input => {
    assert.equal(input.version, '2026.11.22');
    return nativeResult(input);
  } });
  assert.equal(result.exitCode, 0);
});

for (const [name, change] of [
  ['missing intended release', check => { check.observed.version = null; check.reasonCode = 'release_missing'; }],
  ['wrong intended version despite a green producer', check => { check.observed.version = '2026.11.23'; check.reasonCode = 'release_version_mismatch'; }],
  ['wrong source tree', check => { check.observed.artifact.sourceTreeSha = 'd'.repeat(40); check.reasonCode = 'source_tree_mismatch'; }],
  ['wrong tested image config identity', check => { check.observed.artifact.imageId = `sha256:${'d'.repeat(64)}`; check.reasonCode = 'image_id_mismatch'; }],
]) {
  test(`${name}: native mismatch persists and returns nonzero without retry`, async t => {
    const f = fixture(t);
    const intent = preparePublicOutcomeIntent(f.options);
    let calls = 0;
    const result = await verifyPreparedPublicOutcome(verifyOptions(f, intent), { verifyOutcome: async input => {
      calls++;
      const result = nativeResult(input, 'mismatch');
      change(result.outcomeCheck);
      return { ...result, conclusion: 'success' };
    } });
    assert.equal(calls, 1);
    assert.equal(result.exitCode, 1);
    assert.equal(read(f.outputFile).status, 'mismatch');
    assert.deepEqual(read(f.outputFile).expected.artifact, intent.expectedArtifact);
  });
}

test('unknown/network-failed native outcome remains unverified and nonzero', async t => {
  const f = fixture(t);
  const intent = preparePublicOutcomeIntent(f.options);
  let calls = 0;
  const result = await verifyPreparedPublicOutcome(verifyOptions(f, intent), { verifyOutcome: async input => {
    calls++;
    const result = nativeResult(input, 'unverified');
    result.outcomeCheck.reasonCode = 'release_read_failed';
    result.outcomeCheck.observed.version = null;
    return result;
  } });
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 1);
  assert.equal(read(f.outputFile).status, 'unverified');
  assert.equal(read(f.outputFile).reasonCode, 'release_read_failed');
});

test('thrown verifier/import failure produces an unverified receipt without leaking exception text or retrying', async t => {
  const f = fixture(t);
  const intent = preparePublicOutcomeIntent(f.options);
  let calls = 0;
  const result = await verifyPreparedPublicOutcome(verifyOptions(f, intent), {
    verifyOutcome: async () => { calls++; throw new Error('network failure sensitive-token-not-for-receipt'); }, clock: () => NOW,
  });
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 1);
  assert.equal(read(f.outputFile).status, 'unverified');
  assert.equal(read(f.outputFile).reasonCode, 'promotion_outcome_verifier_failed');
  assert.equal(read(f.outputFile).checkedAt, NOW.toISOString());
  assert.doesNotMatch(fs.readFileSync(f.outputFile, 'utf8'), /sensitive-token/);
});

for (const [name, response] of [
  ['green job status without a receipt', () => ({ ok: true, status: 'success', conclusion: 'success' })],
  ['verified receipt for another version', input => { const r = nativeResult(input); r.outcomeCheck.expected.version = '2026.11.23'; return r; }],
  ['verified receipt for another expected artifact', input => { const r = nativeResult(input); r.outcomeCheck.expected.artifact.sourceTreeSha = 'e'.repeat(40); return r; }],
  ['verified label with contradictory observed image', input => { const r = nativeResult(input); r.outcomeCheck.observed.artifact.imageId = `sha256:${'e'.repeat(64)}`; return r; }],
  ['verifier mutating its supplied expectation', input => { input.expectedArtifact.sourceTreeSha = 'e'.repeat(40); return nativeResult(input); }],
]) {
  test(`${name} cannot manufacture a successful outcome`, async t => {
    const f = fixture(t);
    const intent = preparePublicOutcomeIntent(f.options);
    const expected = structuredClone(intent);
    const result = await verifyPreparedPublicOutcome(verifyOptions(f, intent), { verifyOutcome: async input => response(input), clock: () => NOW });
    assert.equal(result.exitCode, 1);
    assert.equal(read(f.outputFile).status, 'unverified');
    assert.equal(read(f.outputFile).reasonCode, 'promotion_outcome_receipt_invalid');
    assert.deepEqual(intent, expected);
    assert.deepEqual(read(f.outputFile).expected.artifact, expected.expectedArtifact);
  });
}

test('current nonpublish/validate-only dispositions are guarded before artifact reads or verifier execution', async t => {
  const f = fixture(t);
  const intent = preparePublicOutcomeIntent(f.options);
  for (const disposition of [
    { publishable: false, validateOnly: false },
    { publishable: true, validateOnly: true },
    { publishable: true }, {},
  ]) {
    assert.throws(() => preparePublicOutcomeIntent({ ...f.options, artifactRoot: '/does-not-exist', publishable: undefined, validateOnly: undefined, ...disposition }), /promotion_outcome_not_publishable/);
    let calls = 0;
    await assert.rejects(verifyPreparedPublicOutcome({ intent, outputFile: f.outputFile, ...disposition }, {
      verifyOutcome: async input => { calls++; return nativeResult(input); },
    }), /promotion_outcome_not_publishable/);
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(f.outputFile), false);
  }
});

for (const action of ['skip-unchanged', 'defer-next-utc-day']) {
  test(`${action} frozen plans cannot be checked even with an incorrect publishable override`, t => {
    const f = fixture(t);
    const planFile = path.join(f.root, 'plan.json');
    const plan = read(planFile);
    plan.targets[0].action = action;
    json(planFile, plan);
    assert.throws(() => preparePublicOutcomeIntent(f.options), /promotion_outcome_not_publishable/);
  });
}

test('restored date, manifest, original run and tested image are required and must agree', async t => {
  const cases = [
    ['wrong intended date', f => { f.options.releaseDate = '2026.11.23'; }],
    ['impossible date', f => { f.options.releaseDate = '2026.02.30'; }],
    ['manifest missing date', f => { const file = path.join(f.payload, 'PUBLIC_RELEASE.json'); const value = read(file); delete value.releaseDate; json(file, value); }],
    ['wrong artifact origin', f => { f.options.originRunId = '4321'; }],
    ['wrong frozen sources', f => { const file = path.join(f.root, 'plan.json'); const value = read(file); value.sources.burrowBackend = 'a'.repeat(40); json(file, value); }],
    ['nonpublishable plan', f => { const file = path.join(f.root, 'plan.json'); const value = read(file); value.publishable = false; json(file, value); }],
    ['missing tested image', f => { fs.rmSync(path.join(f.root, 'tested-image.json')); }],
    ['wrong tested image shape', f => { json(path.join(f.root, 'tested-image.json'), { schemaVersion: 1, imageId: 'image-tag-is-not-an-id' }); }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, t => {
      const f = fixture(t);
      mutate(f);
      assert.throws(() => preparePublicOutcomeIntent(f.options));
      assert.equal(fs.existsSync(f.outputFile), false);
    });
  }
});

test('missing or malformed prepared version/artifact fails before invoking even an inert verifier', async t => {
  const f = fixture(t);
  const prepared = preparePublicOutcomeIntent(f.options);
  for (const mutate of [
    intent => { delete intent.version; },
    intent => { intent.version = '2026.11.24.1'; },
    intent => { delete intent.expectedArtifact; },
    intent => { delete intent.expectedArtifact.imageId; },
    intent => { intent.expectedArtifact.sourceTreeSha = 'main'; },
  ]) {
    const intent = structuredClone(prepared);
    mutate(intent);
    let calls = 0;
    await assert.rejects(verifyPreparedPublicOutcome(verifyOptions(f, intent), {
      verifyOutcome: async input => { calls++; return nativeResult(input); },
    }), /promotion_outcome_prepared_intent_invalid/);
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(f.outputFile), false);
  }
});

test('CLI prepare freezes intent without loading Backend; inert fixture Backend proves terminal exit codes and missing-module failure receipt', t => {
  const f = fixture(t);
  // Copy only this adapter into a disposable fixture. The stub below is not a
  // copy of canonical Backend code and performs no network or publication I/O.
  const script = path.join(f.root, 'scripts/promotion/verify-public-outcome.mjs');
  const backend = path.join(f.root, 'backend/src/outcome-verification.mjs');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(SCRIPT, script);
  fs.copyFileSync(new URL('./companion-targets.mjs', import.meta.url), path.join(path.dirname(script), 'companion-targets.mjs'));
  const env = {
    ...process.env, PROMOTION_PUBLISHABLE: 'true', PROMOTION_VALIDATE_ONLY: 'false',
    EXPECTED_DATE: f.options.releaseDate, EXPECTED_RUN: f.options.originRunId,
    GITHUB_REPOSITORY: f.options.handlingRepository, GITHUB_RUN_ID: f.options.handlingRunId,
    GITHUB_RUN_ATTEMPT: f.options.handlingRunAttempt, GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_OUTPUT: path.join(f.root, 'outputs'),
  };
  const invoke = (command, extraEnv = {}) => spawnSync(process.execPath, [script, command], { cwd: f.root, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  const prepare = invoke('prepare');
  assert.equal(prepare.status, 0, prepare.stderr);
  assert.equal(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), 'publish_auditor_and_plug=false\n');
  const intent = read(path.join(f.root, 'public-outcome-intent.json'));
  fs.mkdirSync(path.dirname(backend), { recursive: true });
  fs.writeFileSync(backend, 'export async function verifyPublicReleaseOutcome() { return JSON.parse(process.env.INERT_OUTCOME_RESULT); }\n');
  for (const [status, code] of [['verified', 0], ['mismatch', 1], ['unverified', 1]]) {
    const result = invoke('verify', { INERT_OUTCOME_RESULT: JSON.stringify(nativeResult(intent, status)) });
    assert.equal(result.status, code, result.stderr);
    assert.equal(read(f.outputFile).status, status);
  }
  fs.rmSync(backend);
  const missing = invoke('verify');
  assert.equal(missing.status, 1);
  assert.equal(read(f.outputFile).status, 'unverified');
  assert.equal(read(f.outputFile).reasonCode, 'promotion_outcome_verifier_failed');
  fs.rmSync(f.outputFile);
  const guarded = invoke('verify', { PROMOTION_VALIDATE_ONLY: 'true' });
  assert.equal(guarded.status, 1);
  assert.equal(fs.existsSync(f.outputFile), false);
});

test('workflow runs each exact check after publication and uploads receipts even on failure', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/daily-public-promotion.yml', import.meta.url), 'utf8');
  const restore = workflow.indexOf('- name: Restore snapshots and verify executable permissions before publishing');
  const prepare = workflow.indexOf('verify-public-outcome.mjs prepare public-outcome-intent.json');
  const firstPublish = workflow.indexOf('- name: Publish immutable Git snapshots');
  const finalPublish = workflow.indexOf('- name: Publish Burrow snapshot and coordinated release last');
  const check = workflow.indexOf('- name: Check exact public Burrow outcome once');
  const upload = workflow.indexOf('- name: Upload public outcome receipt even on publication or check failure');
  assert.ok(restore < prepare && prepare < firstPublish && firstPublish < finalPublish && finalPublish < check && check < upload);
  assert.match(workflow.slice(restore, prepare), /id: restore/);
  assert.match(workflow.slice(restore, prepare), /EXPECTED_DATE: \$\{\{ needs.stage.outputs.release_date \}\}/);
  assert.match(workflow.slice(restore, prepare), /EXPECTED_RUN: \$\{\{ needs.stage.outputs.artifact_run_id \}\}/);
  assert.equal(workflow.match(/verify-public-outcome\.mjs verify /g)?.length, 3);
  assert.match(workflow.slice(check, upload), /if: \$\{\{ always\(\) && needs.stage.outputs.publishable == 'true' && steps.restore.outcome == 'success' \}\}/);
  assert.match(workflow.slice(check, upload), /PROMOTION_VALIDATE_ONLY: \$\{\{ inputs.validate_only == true \}\}/);
  assert.doesNotMatch(workflow.slice(check), /continue-on-error|retry|sleep |curl|gh api|docker push|webhook|notify/);
  assert.match(workflow.slice(upload), /if: \$\{\{ always\(\) && hashFiles\('public-outcome.json'\) != '' \}\}/);
  assert.match(workflow.slice(upload), /uses: actions\/upload-artifact@v4/);
  assert.match(workflow.slice(upload), /path: public-outcome\.json\s+if-no-files-found: error\s+retention-days: 7/);
  assert.match(workflow.slice(upload), /name: public-outcome-.*github.run_id.*github.run_attempt/);
  for (const [key, label] of [['burrowAuditor', 'Auditor'], ['burrowPlug', 'Plug-ins']]) {
    const step = workflow.slice(check, upload).split(/\n      - name: /).find(step => step.startsWith(`Check exact public ${label} outcome once`));
    assert.ok(step);
    assert.ok(step.includes("always() && needs.stage.outputs.publishable == 'true' && steps.restore.outcome == 'success' && steps.restore.outputs.publish_auditor_and_plug == 'true'"));
    assert.ok(step.includes(`verify public-outcome-intent-${key}.json public-outcome-${key}.json ${key}`));
    assert.ok(workflow.slice(upload).includes(`\n            public-outcome-${key}.json`));
  }
  assert.match(workflow.slice(upload), /always\(\) && hashFiles\('public-outcome-burrowAuditor.json', 'public-outcome-burrowPlug.json'\) != ''/);
  assert.match(workflow, /if: needs.stage.outputs.publishable == 'true'/);
  assert.match(workflow, /validate_only.*then validation_required=true; publishable=false; fi/);
  assert.equal(workflow.match(/cron:/g)?.length, 1);
  assert.match(workflow, /cron: '30 5 \* \* \*'/);
  assert.match(workflow, /run-id: \$\{\{ needs.stage.outputs.artifact_run_id \}\}/);
});

function addCompanions(f) {
  const manifestPath = path.join(f.payload, 'PUBLIC_RELEASE.json');
  const planPath = path.join(f.root, 'plan.json');
  const manifest = read(manifestPath);
  const plan = read(planPath);
  fs.mkdirSync(path.join(f.root, 'release-notes'));
  for (const [key, { repository }] of Object.entries(COMPANION_TARGETS)) {
    manifest.sources[key] = (key === 'burrowAuditor' ? 'a' : 'b').repeat(40);
    plan.targets.push({
      id: key, repository: `GoblinKing-Burrow/${repository}`, version: manifest.releaseDate, action: 'stage',
      sources: Object.fromEntries([key, 'burrowBackend', 'burrowUi'].map(source => [source, manifest.sources[source]])),
    });
    fs.writeFileSync(path.join(f.root, 'release-notes', `${key}.md`), repository);
  }
  json(planPath, { ...plan, sources: manifest.sources });
  json(manifestPath, manifest);
  for (const { repository } of Object.values(COMPANION_TARGETS)) {
    const payload = path.join(f.root, 'staged', repository);
    fs.mkdirSync(payload);
    json(path.join(payload, 'PUBLIC_RELEASE.json'), manifest);
    fs.writeFileSync(path.join(payload, 'README.md'), repository);
  }
}

test('legacy artifact freezes only Burrow, and divergent companion identity fails before publication', t => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(preparePublicOutcomeIntents(f.options)), ['burrow']);
  addCompanions(f);
  const manifestPath = path.join(f.root, 'staged/Burrow-Plug/PUBLIC_RELEASE.json');
  json(manifestPath, { ...read(manifestPath), promotionRunId: '777' });
  assert.throws(() => preparePublicOutcomeIntents(f.options), /promotion_outcome_companion_artifact_mismatch/);
});

test('companion CLI receipts use the canonical verifier and either failed exact check exits nonzero', t => {
  const f = fixture(t);
  addCompanions(f);
  const githubOutput = path.join(f.root, 'outputs');
  const env = {
    ...process.env, PROMOTION_PUBLISHABLE: 'true', PROMOTION_VALIDATE_ONLY: 'false',
    EXPECTED_DATE: f.options.releaseDate, EXPECTED_RUN: f.options.originRunId,
    GITHUB_REPOSITORY: f.options.handlingRepository, GITHUB_RUN_ID: f.options.handlingRunId,
    GITHUB_RUN_ATTEMPT: f.options.handlingRunAttempt, GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_OUTPUT: githubOutput,
  };
  const prepare = spawnSync(process.execPath, [SCRIPT, 'prepare'], { cwd: f.root, env, encoding: 'utf8' });
  assert.equal(prepare.status, 0, prepare.stderr);
  assert.equal(fs.readFileSync(githubOutput, 'utf8'), 'publish_auditor_and_plug=true\n');
  for (const [key, { repository }] of Object.entries(COMPANION_TARGETS)) {
    const intentFile = `public-outcome-intent-${key}.json`;
    const receiptFile = `public-outcome-${key}.json`;
    const payload = path.join(f.root, 'staged', repository);
    const intent = read(path.join(f.root, intentFile));
    assert.equal(intent.repository, `GoblinKing-Burrow/${repository}`);
    assert.equal(intent.version, f.options.releaseDate);
    assert.deepEqual(intent.expectedArtifact, { sourceTreeSha: stagedSourceTree(payload) });
    fs.appendFileSync(path.join(payload, 'README.md'), ' later mutation');
    assert.notEqual(stagedSourceTree(payload), intent.expectedArtifact.sourceTreeSha);
    const api = `https://api.github.com/repos/${intent.repository}`;
    const releaseUrl = `${api}/releases/tags/v${intent.version}`;
    const commitUrl = `${api}/commits/v${intent.version}`;
    const preload = path.join(f.root, 'mock-fetch.mjs');
    const calls = path.join(f.root, 'fetch.log');
    fs.writeFileSync(preload, `
      import fs from 'node:fs';
      globalThis.fetch = async url => {
        fs.appendFileSync(${JSON.stringify(calls)}, url + '\\n');
        if (url === ${JSON.stringify(releaseUrl)}) {
          return Response.json({ tag_name: ${JSON.stringify(`v${intent.version}`)}, draft: false, prerelease: false });
        }
        if (url === ${JSON.stringify(commitUrl)}) {
          return Response.json({ commit: { tree: { sha: process.env.OBSERVED_TREE } } });
        }
        throw new Error('unexpected URL');
      };
    `);
    for (const status of ['verified', 'mismatch']) {
      fs.writeFileSync(calls, '');
      const observedTree = status === 'verified' ? intent.expectedArtifact.sourceTreeSha : 'e'.repeat(40);
      const result = spawnSync(process.execPath, ['--import', preload, SCRIPT, 'verify', intentFile, receiptFile, key], {
        cwd: f.root, env: { ...env, OBSERVED_TREE: observedTree }, encoding: 'utf8',
      });
      assert.equal(result.status, status === 'verified' ? 0 : 1, result.stderr);
      assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').sort(), [commitUrl, releaseUrl].sort());
      const receipt = read(path.join(f.root, receiptFile));
      assert.equal(receipt.status, status);
      assert.deepEqual(receipt.expected, { repository: intent.repository, version: intent.version, artifact: intent.expectedArtifact });
      assert.deepEqual(receipt.observed.artifact, { sourceTreeSha: observedTree });
    }
  }
});


test('restored frozen intent traverses the actual assembled canonical verifier and persists exact outcomes', async t => {
  const { verifyPublicReleaseOutcome, normalizeOutcomeCheck } = await import('../../backend/src/outcome-verification.mjs');
  for (const state of ['verified', 'missing-release', 'wrong-version', 'wrong-tree', 'wrong-image', 'access-unknown']) await t.test(state, async t => {
    const f = fixture(t, { releaseDate: '2026.11.23', originRunId: '1234' });
    const intent = preparePublicOutcomeIntent(f.options);
    let calls = 0;
    const fetchImpl = async url => {
      calls++;
      if (url.includes('/releases/tags/')) return Response.json({ tag_name: state === 'wrong-version' ? 'v2026.11.22' : 'v2026.11.23', draft: false, prerelease: false }, { status: state === 'missing-release' ? 404 : state === 'access-unknown' ? 403 : 200 });
      if (url.includes('/commits/')) return Response.json({ commit: { tree: { sha: state === 'wrong-tree' ? 'e'.repeat(40) : intent.expectedArtifact.sourceTreeSha } } });
      if (url.includes('/token?')) return Response.json({ token: 'inert-anonymous-token' });
      assert.equal(url, 'https://ghcr.io/v2/goblinking-burrow/burrow/manifests/2026.11.23');
      const body = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: state === 'wrong-image' ? 'sha256:'+'d'.repeat(64) : IMAGE_ID, size: 200 }, layers: [] });
      return new Response(body, { headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json', 'docker-content-digest': 'sha256:'+createHash('sha256').update(body).digest('hex') } });
    };
    const result = await verifyPreparedPublicOutcome(verifyOptions(f, intent), { verifyOutcome: value => verifyPublicReleaseOutcome(value, { fetchImpl, clock: () => NOW }) });
    const stored = read(f.outputFile);
    assert.deepEqual(stored, normalizeOutcomeCheck(stored));
    assert.equal(stored.status, state === 'verified' ? 'verified' : state === 'access-unknown' ? 'unverified' : 'mismatch');
    assert.equal(result.exitCode, state === 'verified' ? 0 : 1);
    assert.deepEqual(stored.expected.artifact, intent.expectedArtifact);
    assert.equal(stored.expected.version, '2026.11.23', 'uses original intended date, not check day');
    assert.equal(stored.intentSource.sourceRefs[0], 'https://github.com/NightShaman/Burrow/actions/runs/1234');
    assert.equal(stored.checkedAt, NOW.toISOString());
    assert.equal(calls, 4, 'one logical check, no retries/polling');
  });
});
