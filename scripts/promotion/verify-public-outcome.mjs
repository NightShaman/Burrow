import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { COMPANION_TARGETS, restoredCompanions } from './companion-targets.mjs';

const REPOSITORY = 'GoblinKing-Burrow/Burrow';
const IMAGE_REPOSITORY = 'ghcr.io/goblinking-burrow/burrow';
const TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const RUN_ID = /^[1-9][0-9]*$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;

function fail(code) { throw new Error(code); }
function fullMatch(pattern, value) { return typeof value === 'string' && pattern.exec(value)?.[0] === value; }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function calendarDate(value) {
  if (!fullMatch(/^\d{4}\.\d{2}\.\d{2}$/, value)) return false;
  const date = new Date(`${value.replaceAll('.', '-')}T00:00:00.000Z`);
  return Number(value.slice(0, 4)) >= 1 && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10).replaceAll('-', '.') === value;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }

// A frozen plan can still be used for validate-only. The current invocation's
// disposition is therefore required separately, at both prepare and check time.
export function assertPublishDisposition({ publishable, validateOnly } = {}) {
  if (publishable !== true || validateOnly !== false) fail('promotion_outcome_not_publishable');
}

/** Same git add -A/write-tree semantics as publish-snapshot.sh, without touching
 * the payload, its enclosing checkout/index, or any remote repository. */
export function stagedSourceTree(payloadRoot) {
  const root = path.resolve(payloadRoot);
  if (!fs.statSync(root).isDirectory() || fs.existsSync(path.join(root, '.git'))) fail('promotion_outcome_payload_invalid');
  const disposable = fs.mkdtempSync(path.join(tmpdir(), 'burrow-public-outcome-'));
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete env[key];
  const git = args => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const gitDir = path.join(disposable, 'git');
    git(['init', '--quiet', '--bare', gitDir]);
    Object.assign(env, { GIT_DIR: gitDir, GIT_WORK_TREE: root, GIT_INDEX_FILE: path.join(disposable, 'index') });
    git(['add', '-A']);
    const tree = git(['write-tree']);
    if (!fullMatch(TREE, tree)) fail('promotion_outcome_tree_invalid');
    return tree;
  } finally {
    fs.rmSync(disposable, { recursive: true, force: true });
  }
}

/** Docker .Id is a local-store identity (possibly an OCI index), not always
 * the config digest required by the canonical verifier. Read the single saved
 * image's Docker compatibility manifest instead; never consult a live daemon,
 * registry, or later build. This also works with existing schema-v1 artifacts. */
export function testedImageConfigId(artifactRoot) {
  try {
    const archive = path.join(artifactRoot, 'tested-image.tar.gz');
    const checksum = fs.readFileSync(`${archive}.sha256`, 'utf8');
    if (!fullMatch(/^[0-9a-f]{64} [ *]tested-image\.tar\.gz\n?$/, checksum)) throw new Error('checksum invalid');
    const hash = createHash('sha256');
    const fd = fs.openSync(archive, 'r');
    try {
      const chunk = Buffer.alloc(1024 * 1024);
      let size;
      while ((size = fs.readSync(fd, chunk, 0, chunk.length, null))) hash.update(chunk.subarray(0, size));
    } finally { fs.closeSync(fd); }
    if (hash.digest('hex') !== checksum.slice(0, 64)) throw new Error('checksum mismatch');
    // Bounded metadata only, no filesystem extraction or layer buffering. Count
    // members so duplicate tar entries cannot be concatenated into valid JSON.
    const tar = args => execFileSync('tar', args, {
      maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TAR_OPTIONS: '' },
    });
    const members = tar(['-tzf', archive]).toString('utf8').split('\n');
    const member = name => {
      if (members.filter(item => item === name).length !== 1) throw new Error('member missing or ambiguous');
      return tar(['-xOzf', archive, '--', name]);
    };
    const manifest = JSON.parse(member('manifest.json'));
    if (!Array.isArray(manifest) || manifest.length !== 1 || !record(manifest[0])) throw new Error('image ambiguous');
    const configPath = manifest[0].Config;
    if (!fullMatch(/^(?:[0-9a-f]{64}\.json|blobs\/sha256\/[0-9a-f]{64})$/, configPath)) throw new Error('config path invalid');
    const bytes = member(configPath);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== path.basename(configPath, '.json')) throw new Error('config digest mismatch');
    const config = JSON.parse(bytes);
    if (!record(config) || typeof config.architecture !== 'string' || !config.architecture ||
        typeof config.os !== 'string' || !config.os || !record(config.rootfs) ||
        config.rootfs.type !== 'layers' || !Array.isArray(config.rootfs.diff_ids) ||
        !config.rootfs.diff_ids.every(id => fullMatch(IMAGE_ID, id))) throw new Error('config invalid');
    return `sha256:${digest}`;
  } catch { fail('promotion_outcome_tested_image_archive_invalid'); }
}

export function preparePublicOutcomeIntents({
  artifactRoot = '.', releaseDate, originRunId, handlingRepository,
  handlingRunId, handlingRunAttempt, serverUrl = 'https://github.com',
  publishable, validateOnly,
}) {
  assertPublishDisposition({ publishable, validateOnly });
  if (!calendarDate(releaseDate) || !fullMatch(RUN_ID, originRunId) ||
      !fullMatch(RUN_ID, handlingRunId) || !fullMatch(RUN_ID, handlingRunAttempt) ||
      !fullMatch(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, handlingRepository) || serverUrl !== 'https://github.com') {
    fail('promotion_outcome_restore_intent_invalid');
  }
  const root = path.resolve(artifactRoot);
  const payloadRoot = path.join(root, 'staged/Burrow');
  const manifest = readJson(path.join(payloadRoot, 'PUBLIC_RELEASE.json'));
  const plan = readJson(path.join(root, 'plan.json'));
  const image = readJson(path.join(root, 'tested-image.json'));
  const target = plan.targets?.filter(item => item.id === 'burrow');
  if (manifest.schemaVersion !== 1 || plan.schemaVersion !== 1 ||
      manifest.releaseDate !== releaseDate || plan.releaseDate !== releaseDate ||
      String(manifest.promotionRunId) !== originRunId ||
      !record(manifest.sources) || !Object.keys(manifest.sources).length ||
      !Object.values(manifest.sources).every(sha => fullMatch(SOURCE_SHA, sha)) ||
      !isDeepStrictEqual(plan.sources, manifest.sources)) {
    fail('promotion_outcome_artifact_identity_mismatch');
  }
  if (plan.publishable !== true || target?.length !== 1 ||
      !['stage', 'resume'].includes(target[0].action) || target[0].repository !== REPOSITORY ||
      target[0].version !== releaseDate || (plan.resumeRunId != null && String(plan.resumeRunId) !== originRunId)) {
    fail('promotion_outcome_not_publishable');
  }
  if (image.schemaVersion !== 1 || !fullMatch(IMAGE_ID, image.imageId)) fail('promotion_outcome_tested_image_invalid');
  const originRun = `${serverUrl}/${handlingRepository}/actions/runs/${originRunId}`;
  const sourceRefs = [
    originRun,
    // This names the original artifact, not a made-up downloadable GitHub URL.
    `actions-artifact:${handlingRepository}/${originRunId}/public-promotion-${releaseDate}/public-promotion.tar`,
    `${serverUrl}/${handlingRepository}/actions/runs/${handlingRunId}/attempts/${handlingRunAttempt}`,
  ];
  const burrow = {
    repository: REPOSITORY,
    version: releaseDate,
    expectedArtifact: {
      sourceTreeSha: stagedSourceTree(payloadRoot),
      imageRepository: IMAGE_REPOSITORY,
      imageId: testedImageConfigId(root),
    },
    sourceRefs,
  };
  const intents = { burrow };
  if (restoredCompanions(plan)) {
    for (const [key, { repository }] of Object.entries(COMPANION_TARGETS)) {
      const payload = path.join(root, 'staged', repository);
      if (!isDeepStrictEqual(readJson(path.join(payload, 'PUBLIC_RELEASE.json')), manifest)) {
        fail('promotion_outcome_companion_artifact_mismatch');
      }
      if (!fs.readFileSync(path.join(root, 'release-notes', `${key}.md`), 'utf8').trim()) {
        fail('promotion_outcome_companion_notes_missing');
      }
      intents[key] = {
        repository: `GoblinKing-Burrow/${repository}`,
        version: releaseDate,
        expectedArtifact: { sourceTreeSha: stagedSourceTree(payload) },
        sourceRefs,
      };
    }
  }
  return intents;
}

export function preparePublicOutcomeIntent(options) {
  return preparePublicOutcomeIntents(options).burrow;
}

function assertPreparedIntent(intent, target) {
  const isBurrow = target === 'burrow';
  const companion = Object.hasOwn(COMPANION_TARGETS, target) ? COMPANION_TARGETS[target] : null;
  const repository = isBurrow ? REPOSITORY : companion && `GoblinKing-Burrow/${companion.repository}`;
  const artifactKeys = isBurrow ? ['imageId', 'imageRepository', 'sourceTreeSha'] : ['sourceTreeSha'];
  if (!repository || !record(intent) || intent.repository !== repository || !calendarDate(intent.version) ||
      !record(intent.expectedArtifact) || !fullMatch(TREE, intent.expectedArtifact.sourceTreeSha) ||
      (isBurrow && (intent.expectedArtifact.imageRepository !== IMAGE_REPOSITORY || !fullMatch(IMAGE_ID, intent.expectedArtifact.imageId))) ||
      !Array.isArray(intent.sourceRefs) || intent.sourceRefs.length !== 3 ||
      !intent.sourceRefs.every(ref => typeof ref === 'string' && ref.length > 0 && !/[\u0000-\u001f\u007f]/.test(ref)) ||
      !isDeepStrictEqual(Object.keys(intent).sort(), ['expectedArtifact', 'repository', 'sourceRefs', 'version']) ||
      !isDeepStrictEqual(Object.keys(intent.expectedArtifact).sort(), artifactKeys)) {
    fail('promotion_outcome_prepared_intent_invalid');
  }
}

function safeFailureCode(error) {
  const value = error?.code || error?.message;
  return typeof value === 'string' && /^(?:[A-Z][A-Z0-9_]{0,79}|promotion_outcome_[a-z_]+)$/.test(value) ? value : 'unexpected_verifier_error';
}

function unverifiedReceipt(intent, clock, reasonCode, detail = '') {
  const artifact = { sourceTreeSha: null };
  if (intent.expectedArtifact.imageRepository) {
    Object.assign(artifact, { imageRepository: intent.expectedArtifact.imageRepository, imageId: null, manifestDigest: null });
  }
  return {
    schemaVersion: 1, kind: 'outcome-check', verifier: 'github_public_release', status: 'unverified',
    expected: { repository: intent.repository, version: intent.version, artifact: intent.expectedArtifact },
    observed: { repository: intent.repository, version: null, artifact },
    checkedAt: clock().toISOString(), reasonCode,
    reason: `The canonical public outcome verifier did not return a receipt bound to the frozen promotion intent. Public outcome remains unverified.${detail ? ` Reason: ${detail}.` : ''}`,
    evidenceSources: [], intentSource: { kind: 'caller_supplied', sourceRefs: intent.sourceRefs },
  };
}

// This is only a local binding/consistency guard, not another outcome verifier.
// The canonical Backend module owns all HTTP observations and their semantics.
function receiptMatchesIntent(result, intent) {
  const check = result?.outcomeCheck;
  if (result?.ok !== true || check?.schemaVersion !== 1 || check.kind !== 'outcome-check' ||
      check.verifier !== 'github_public_release' || !['verified', 'mismatch', 'unverified'].includes(check.status) ||
      !isDeepStrictEqual(check.expected, { repository: intent.repository, version: intent.version, artifact: intent.expectedArtifact }) ||
      !isDeepStrictEqual(check.intentSource, { kind: 'caller_supplied', sourceRefs: intent.sourceRefs })) return false;
  if (check.status !== 'verified') return true;
  const observed = check.observed;
  return observed?.repository === intent.repository && observed.version === intent.version &&
    observed.artifact?.sourceTreeSha === intent.expectedArtifact.sourceTreeSha &&
    (intent.expectedArtifact.imageRepository
      ? observed.artifact.imageRepository === intent.expectedArtifact.imageRepository &&
        observed.artifact.imageId === intent.expectedArtifact.imageId && fullMatch(IMAGE_ID, observed.artifact.manifestDigest)
      : isDeepStrictEqual(observed.artifact, intent.expectedArtifact));
}

/** Exactly one verifier invocation. No producer/job status is accepted as proof. */
export async function verifyPreparedPublicOutcome({ intent, target = 'burrow', outputFile = 'public-outcome.json', publishable, validateOnly }, { verifyOutcome, clock = () => new Date() } = {}) {
  assertPublishDisposition({ publishable, validateOnly });
  assertPreparedIntent(intent, target);
  // Keep the expected identity independent even if an injected adapter mutates
  // its argument. Production imports the canonical module only in the CLI below.
  const frozenIntent = structuredClone(intent);
  let receipt;
  try {
    const result = await verifyOutcome(structuredClone(frozenIntent));
    receipt = receiptMatchesIntent(result, frozenIntent) ? result.outcomeCheck : unverifiedReceipt(frozenIntent, clock, 'promotion_outcome_receipt_invalid');
  } catch (error) {
    // Retain the real safe code, not exception bodies, paths or tokens.
    receipt = unverifiedReceipt(frozenIntent, clock, 'promotion_outcome_verifier_failed', safeFailureCode(error));
  }
  writeJson(outputFile, receipt);
  return { outcomeCheck: receipt, exitCode: receipt.status === 'verified' ? 0 : 1 };
}

async function main() {
  const [command, intentFile = 'public-outcome-intent.json', outputFile = 'public-outcome.json', target = 'burrow', ...extra] = process.argv.slice(2);
  if (!['prepare', 'verify'].includes(command) || extra.length) fail('usage: node verify-public-outcome.mjs prepare|verify [INTENT_JSON] [OUTCOME_JSON] [TARGET]');
  const disposition = {
    publishable: process.env.PROMOTION_PUBLISHABLE === 'true',
    validateOnly: process.env.PROMOTION_VALIDATE_ONLY === 'false' ? false : true,
  };
  assertPublishDisposition(disposition);
  if (command === 'prepare') {
    const intents = preparePublicOutcomeIntents({
      ...disposition, releaseDate: process.env.EXPECTED_DATE, originRunId: process.env.EXPECTED_RUN,
      handlingRepository: process.env.GITHUB_REPOSITORY, handlingRunId: process.env.GITHUB_RUN_ID,
      handlingRunAttempt: process.env.GITHUB_RUN_ATTEMPT, serverUrl: process.env.GITHUB_SERVER_URL,
    });
    writeJson(intentFile, intents.burrow);
    for (const key of Object.keys(COMPANION_TARGETS)) {
      if (intents[key]) writeJson(`public-outcome-intent-${key}.json`, intents[key]);
    }
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `publish_auditor_and_plug=${Boolean(intents.burrowAuditor)}\n`);
    }
    return;
  }
  const result = await verifyPreparedPublicOutcome({ ...disposition, intent: readJson(intentFile), outputFile, target }, {
    verifyOutcome: async intent => {
      const { verifyPublicReleaseOutcome } = await import('../../backend/src/outcome-verification.mjs');
      return verifyPublicReleaseOutcome(intent);
    },
  });
  console.log(`Public outcome ${result.outcomeCheck.status}: ${result.outcomeCheck.reasonCode}`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(`public_outcome_failed: ${safeFailureCode(error)}; unable to prepare or persist the frozen-intent public outcome receipt`);
  process.exitCode = 1;
});
