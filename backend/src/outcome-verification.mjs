import { createHash } from 'node:crypto';

// Technical work budgets, not release/promotion policy. At most five GETs (one index child when present), no retries.
const REQUEST_TIMEOUT_MS = 10_000;
const JSON_BODY_BYTES = 1024 * 1024;
const TOKEN_BODY_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const DOCKER_INDEX = 'application/vnd.docker.distribution.manifest.list.v2+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';
const DOCKER_CONFIG = 'application/vnd.docker.container.image.v1+json';
const TREE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const IMAGE_ID = /^sha256:[a-fA-F0-9]{64}$/;
const DIGEST = /^(?:sha256:[a-fA-F0-9]{64}|sha512:[a-fA-F0-9]{128})$/;
const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const REPO = /^[a-z0-9_.-]{1,100}$/i;
const IMAGE_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const SUCCESS_REASON = 'The exact public final release, source tree, and all requested artifact identities match caller-supplied intent.';

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function field(value, name) {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Missing or non-data field');
  return descriptor.value;
}
function has(value, name) { return Object.hasOwn(value, name); }
function assert(value) { if (!value) throw new TypeError('Invalid shape'); }
function onlyKeys(value, keys) {
  assert(record(value));
  assert(Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)));
}
// RegExp '$' alone permits a final newline; identities must match every byte.
function fullMatch(pattern, value) { return typeof value === 'string' && pattern.exec(value)?.[0] === value; }
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value); }
function repositoryValid(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  return parts.length === 2 && fullMatch(OWNER, parts[0]) && !parts[0].includes('--') && fullMatch(REPO, parts[1]) && !['.', '..'].includes(parts[1]);
}
function versionValid(value) {
  if (typeof value !== 'string' || !fullMatch(/^\d{4}\.\d{2}\.\d{2}$/, value)) return false;
  const [year, month, day] = value.split('.').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}
function imageRepositoryValid(value) {
  if (typeof value !== 'string' || !value.startsWith('ghcr.io/') || value.length > 255) return false;
  const parts = value.slice('ghcr.io/'.length).split('/');
  return parts.length >= 2 && parts.every(part => fullMatch(IMAGE_COMPONENT, part));
}
function sourceRefs(value, rejectUnknown = false) {
  assert(Array.isArray(value));
  if (rejectUnknown) assert(Reflect.ownKeys(value).every(key => key === 'length' ||
    (typeof key === 'string' && fullMatch(/^(?:0|[1-9]\d*)$/, key) && Number(key) < value.length)));
  return Array.from({ length: value.length }, (_, index) => {
    const ref = field(value, String(index));
    assert(nonempty(ref));
    return ref;
  });
}
function artifact(value, rejectUnknown = false) {
  assert(record(value));
  if (rejectUnknown) onlyKeys(value, ['sourceTreeSha', 'imageRepository', 'imageId']);
  const sourceTreeSha = field(value, 'sourceTreeSha');
  assert(typeof sourceTreeSha === 'string' && fullMatch(TREE_SHA, sourceTreeSha));
  const result = { sourceTreeSha };
  assert(has(value, 'imageRepository') === has(value, 'imageId'));
  if (has(value, 'imageRepository')) {
    const imageRepository = field(value, 'imageRepository');
    const imageId = field(value, 'imageId');
    assert(imageRepositoryValid(imageRepository) && typeof imageId === 'string' && fullMatch(IMAGE_ID, imageId));
    Object.assign(result, { imageRepository, imageId });
  }
  return result;
}
function invalidInput() {
  return Object.assign(new TypeError('outcome_verification_invalid_input: expected an exact repository, calendar-date version, immutable source tree, and optional paired GHCR image identity'), { code: 'outcome_verification_invalid_input' });
}
function parseInput(value) {
  try {
    onlyKeys(value, ['repository', 'version', 'expectedArtifact', 'sourceRefs']);
    const repository = field(value, 'repository');
    const version = field(value, 'version');
    assert(repositoryValid(repository) && versionValid(version));
    const expectedArtifact = artifact(field(value, 'expectedArtifact'), true);
    return { repository, version, expectedArtifact, sourceRefs: has(value, 'sourceRefs') ? sourceRefs(field(value, 'sourceRefs'), true) : [] };
  } catch { throw invalidInput(); }
}
function endpoints(repository, version, imageRepository) {
  const base = `https://api.github.com/repos/${repository}`;
  const result = {
    github_release: `${base}/releases/tags/v${version}`,
    github_commit: `${base}/commits/v${version}`,
  };
  if (imageRepository) {
    const path = imageRepository.slice('ghcr.io/'.length);
    result.ghcr_token = `https://ghcr.io/token?${new URLSearchParams({ service: 'ghcr.io', scope: `repository:${path}:pull` })}`;
    result.ghcr_manifest = `https://ghcr.io/v2/${path}/manifests/${version}`;
  }
  return result;
}
function equalDigest(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }
function isoTimestamp(value) {
  if (typeof value !== 'string' || !fullMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

/**
 * Strict, non-coercing projection of the receipt, or null. Unknown keys are not
 * read and never copied (including nested secrets). This validates structure,
 * identities and fixed-endpoint provenance, not authenticity: only the runtime
 * may promote a receipt from its executed verify_outcome tool result.
 */
export function normalizeOutcomeCheck(value) {
  try {
    assert(record(value));
    assert(field(value, 'schemaVersion') === 1 && field(value, 'kind') === 'outcome-check' && field(value, 'verifier') === 'github_public_release');
    const status = field(value, 'status');
    assert(['verified', 'mismatch', 'unverified'].includes(status));
    const expectedValue = field(value, 'expected');
    assert(record(expectedValue));
    const repository = field(expectedValue, 'repository');
    const version = field(expectedValue, 'version');
    assert(repositoryValid(repository) && versionValid(version));
    const expectedArtifact = artifact(field(expectedValue, 'artifact'));
    const observedValue = field(value, 'observed');
    assert(record(observedValue) && field(observedValue, 'repository') === repository);
    const observedVersion = field(observedValue, 'version');
    assert(observedVersion === null || nonempty(observedVersion));
    const observedArtifactValue = field(observedValue, 'artifact');
    assert(record(observedArtifactValue));
    const sourceTreeSha = field(observedArtifactValue, 'sourceTreeSha');
    assert(sourceTreeSha === null || (typeof sourceTreeSha === 'string' && fullMatch(TREE_SHA, sourceTreeSha)));
    const observedArtifact = { sourceTreeSha };
    if (expectedArtifact.imageRepository) {
      if (has(observedArtifactValue, 'imageRepository')) {
        const imageRepository = field(observedArtifactValue, 'imageRepository');
        assert(imageRepository === expectedArtifact.imageRepository);
        observedArtifact.imageRepository = imageRepository;
      }
      for (const name of ['imageId', 'manifestDigest']) {
        if (!has(observedArtifactValue, name)) continue;
        const digest = field(observedArtifactValue, name);
        assert(digest === null || (typeof digest === 'string' && fullMatch(IMAGE_ID, digest)));
        observedArtifact[name] = digest;
      }
    } else {
      assert(!has(observedArtifactValue, 'imageRepository') && !has(observedArtifactValue, 'imageId') && !has(observedArtifactValue, 'manifestDigest'));
    }
    const checkedAt = field(value, 'checkedAt');
    const reasonCode = field(value, 'reasonCode');
    const reason = field(value, 'reason');
    assert(isoTimestamp(checkedAt) && nonempty(reasonCode) && nonempty(reason));
    const urls = endpoints(repository, version, expectedArtifact.imageRepository);
    const seen = new Set();
    const evidenceValue = field(value, 'evidenceSources');
    assert(Array.isArray(evidenceValue));
    const evidenceSources = Array.from({ length: evidenceValue.length }, (_, index) => {
      const item = field(evidenceValue, String(index));
      assert(record(item));
      const kind = field(item, 'kind');
      const url = field(item, 'url');
      const time = field(item, 'checkedAt');
      const statusCode = field(item, 'statusCode');
      const childPrefix = expectedArtifact.imageRepository ? `https://ghcr.io/v2/${expectedArtifact.imageRepository.slice('ghcr.io/'.length)}/manifests/` : null;
      const childSource = kind === 'ghcr_image_manifest' && childPrefix && typeof url === 'string' && url.startsWith(childPrefix) && fullMatch(IMAGE_ID, url.slice(childPrefix.length));
      assert(typeof kind === 'string' && !seen.has(kind) && (childSource || (has(urls, kind) && url === urls[kind])) && isoTimestamp(time));
      assert(statusCode === null || (Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599));
      seen.add(kind);
      return { kind, url, checkedAt: time, statusCode };
    });
    if (status === 'verified') {
      assert(observedVersion === version && equalDigest(sourceTreeSha, expectedArtifact.sourceTreeSha));
      assert(!expectedArtifact.imageRepository || (observedArtifact.imageRepository === expectedArtifact.imageRepository && equalDigest(observedArtifact.imageId, expectedArtifact.imageId) && typeof observedArtifact.manifestDigest === 'string'));
      assert(Object.keys(urls).every(kind => seen.has(kind)) && evidenceSources.every(item => item.statusCode === 200));
    }
    if (status === 'mismatch') assert(evidenceSources.length > 0);
    const intent = field(value, 'intentSource');
    assert(record(intent) && field(intent, 'kind') === 'caller_supplied');
    return {
      schemaVersion: 1, kind: 'outcome-check', verifier: 'github_public_release', status,
      expected: { repository, version, artifact: expectedArtifact },
      observed: { repository, version: observedVersion, artifact: observedArtifact },
      checkedAt, reasonCode, reason, evidenceSources,
      intentSource: { kind: 'caller_supplied', sourceRefs: sourceRefs(field(intent, 'sourceRefs')) },
    };
  } catch { return null; }
}

class ReadFailure extends Error {
  constructor(message) { super(message); this.name = 'OutcomeReadFailure'; }
}
function cancelBody(response) {
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* Cancellation is best-effort; never expose response/error content. */ }
}
function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return operation();
    }).then(result => { signal.removeEventListener('abort', abort); resolve(result); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}
// Never interpolate raw errors, statusText, response bodies, headers or tokens.
// Report actual safe error types/codes and recognized transport causes instead.
function safeReadError(error) {
  if (error instanceof ReadFailure) return error.message;
  const codes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'EPIPE', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_RESPONSE_STATUS_CODE']);
  try {
    const code = codes.has(error?.code) ? error.code : codes.has(error?.cause?.code) ? error.cause.code : null;
    const name = ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error';
    if (code) return `Public read failed (${name}, ${code}).`;
    const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
    const descriptions = ['network unavailable', 'network unreachable', 'network failure', 'network error', 'offline', 'fetch failed', 'failed to fetch', 'connection reset', 'connection refused', 'socket closed', 'socket hang up', 'certificate has expired', 'self-signed certificate'];
    const description = descriptions.find(text => message.includes(text));
    return `Public read failed (${name}${description ? `: ${description}` : ''}).`;
  } catch { return 'Public read failed (Error).'; }
}
async function bodyBytes(response, limit, signal) {
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > limit) throw new ReadFailure(`Public response exceeds the ${limit}-byte body budget.`);
  if (!response.body || typeof response.body.getReader !== 'function') throw new ReadFailure('Public response has no readable Fetch body.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await abortable(() => reader.read(), signal);
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) throw new ReadFailure('Public response has a malformed byte stream.');
      total += value.byteLength;
      if (total > limit) throw new ReadFailure(`Public response exceeds the ${limit}-byte body budget.`);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (!complete) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* No error content is retained. */ } }
    try { reader.releaseLock(); } catch { /* A non-cooperating read may still be pending. */ }
  }
}
async function publicRead(kind, url, { fetchImpl, signal, checkedAt, headers = {}, limit = JSON_BODY_BYTES }) {
  if (signal?.aborted) return { failure: 'Public read was cancelled before the request.', evidenceSources: [] };
  const controller = new AbortController();
  const onAbort = () => controller.abort(new ReadFailure('Public read was cancelled.'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new ReadFailure(`Public read timed out after ${REQUEST_TIMEOUT_MS} ms.`)), REQUEST_TIMEOUT_MS);
  const evidence = { kind, url, checkedAt, statusCode: null };
  let response;
  let attempted = false;
  try {
    response = await abortable(() => {
      attempted = true;
      return fetchImpl(url, {
        method: 'GET', headers: { accept: 'application/json', ...headers },
        credentials: 'omit', redirect: 'manual', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
      });
    }, controller.signal);
    if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) throw new ReadFailure('Public endpoint returned a malformed HTTP response.');
    evidence.statusCode = response.status;
    if (response.redirected || (response.url && response.url !== url)) throw new ReadFailure('Public endpoint redirected; redirects are not followed.');
    if (response.status !== 200) { cancelBody(response); return { statusCode: response.status, evidenceSources: [evidence] }; }
    const bytes = await bodyBytes(response, limit, controller.signal);
    return { statusCode: 200, bytes, response, evidenceSources: [evidence] };
  } catch (error) {
    cancelBody(response);
    return { failure: safeReadError(controller.signal.aborted ? controller.signal.reason : error), evidenceSources: attempted ? [evidence] : [] };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
function issue(status, reasonCode, reason) { return { status, reasonCode, reason }; }
function readIssue(read, prefix, label, missingCode, missingReason) {
  if (read.failure) return issue('unverified', `${prefix}_read_failed`, `${label}: ${read.failure}`);
  if (read.statusCode === 404) return issue('mismatch', missingCode, `${missingReason} (HTTP 404).`);
  if (read.statusCode !== 200) return issue('unverified', `${prefix}_http_error`, `${label} returned HTTP ${read.statusCode}${read.statusCode >= 300 && read.statusCode < 400 ? '; redirects are not followed' : ''}.`);
  return null;
}
function jsonBody(read) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)); }
function responseHeader(read, name) {
  try {
    const value = read.response?.headers?.get?.(name);
    return typeof value === 'string' ? value : null;
  } catch { return null; }
}
async function checkRelease(input, urls, context) {
  const read = await publicRead('github_release', urls.github_release, context);
  const issues = [];
  let version = null;
  const failure = readIssue(read, 'release', 'GitHub release read', 'release_missing', `The exact public release tag v${input.version} was not found`);
  if (failure) issues.push(failure);
  else {
    try {
      const body = jsonBody(read);
      assert(record(body) && nonempty(body.tag_name));
      const observedVersion = body.tag_name.startsWith('v') ? body.tag_name.slice(1) : body.tag_name;
      assert(nonempty(observedVersion));
      version = observedVersion;
      assert(typeof body.draft === 'boolean' && typeof body.prerelease === 'boolean');
      if (body.tag_name !== `v${input.version}`) issues.push(issue('mismatch', 'release_version_mismatch', `The exact release endpoint did not return tag v${input.version}.`));
      if (body.draft || body.prerelease) issues.push(issue('mismatch', 'release_not_final', `The release for v${input.version} is ${body.draft ? 'a draft' : 'a prerelease'}, not a public final release.`));
    } catch { issues.push(issue('unverified', 'release_malformed', 'GitHub release response has malformed or missing tag/draft/prerelease fields.')); }
  }
  return { version, issues, evidenceSources: read.evidenceSources };
}
async function checkSource(input, urls, context) {
  const read = await publicRead('github_commit', urls.github_commit, context);
  const issues = [];
  let sourceTreeSha = null;
  const failure = readIssue(read, 'source', 'GitHub source-tree read', 'source_ref_missing', `The exact source ref v${input.version} was not found`);
  if (failure) issues.push(failure);
  else {
    try {
      const body = jsonBody(read);
      assert(record(body) && record(body.commit) && record(body.commit.tree) && typeof body.commit.tree.sha === 'string' && fullMatch(TREE_SHA, body.commit.tree.sha));
      sourceTreeSha = body.commit.tree.sha;
      if (!equalDigest(sourceTreeSha, input.expectedArtifact.sourceTreeSha)) issues.push(issue('mismatch', 'source_tree_mismatch', `The source tree at v${input.version} does not match the expected immutable tree.`));
    } catch { issues.push(issue('unverified', 'source_malformed', 'GitHub commit response has no valid commit.tree.sha.')); }
  }
  return { sourceTreeSha, issues, evidenceSources: read.evidenceSources };
}
function descriptorValid(value) {
  return record(value) && fullMatch(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i, value.mediaType) &&
    typeof value.digest === 'string' && fullMatch(DIGEST, value.digest) && Number.isSafeInteger(value.size) && value.size >= 0;
}

function manifestValid(body) {
  return record(body) && body.schemaVersion === 2 && [OCI_MANIFEST, DOCKER_MANIFEST].includes(body.mediaType) && !has(body, 'manifests') &&
    descriptorValid(body.config) && body.config.mediaType === (body.mediaType === OCI_MANIFEST ? OCI_CONFIG : DOCKER_CONFIG) && fullMatch(IMAGE_ID, body.config.digest) &&
    Array.isArray(body.layers) && body.layers.every(descriptorValid);
}
async function checkImage(input, urls, context) {
  const issues = [];
  const tokenRead = await publicRead('ghcr_token', urls.ghcr_token, { ...context, limit: TOKEN_BODY_BYTES });
  // This is an access-service read, not the requested artifact. Even a 404
  // here says nothing about the date tag's existence; retain the uncertainty
  // while still attempting the independent manifest observation below.
  const tokenIssue = tokenRead.failure
    ? issue('unverified', 'image_token_read_failed', `GHCR anonymous-token read: ${tokenRead.failure}`)
    : tokenRead.statusCode !== 200
      ? issue('unverified', 'image_token_http_error', `GHCR anonymous-token read returned HTTP ${tokenRead.statusCode}.`)
      : null;
  let token;
  if (tokenIssue) issues.push(tokenIssue);
  else {
    try {
      const body = jsonBody(tokenRead);
      assert(record(body));
      token = body.token ?? body.access_token;
      assert(typeof token === 'string' && token.length <= MAX_TOKEN_BYTES && fullMatch(/^[a-z0-9._~+/-]+={0,2}$/i, token));
      assert(!body.token || !body.access_token || body.token === body.access_token);
    } catch { token = undefined; issues.push(issue('unverified', 'image_token_malformed', 'GHCR anonymous-token response has no valid public bearer token.')); }
  }
  // A failed token endpoint does not suppress the independent public manifest
  // observation. Never retry, follow a challenge URL, or use configured credentials.
  const manifestRead = await publicRead('ghcr_manifest', urls.ghcr_manifest, {
    ...context, headers: { accept: `${OCI_MANIFEST}, ${DOCKER_MANIFEST}, ${OCI_INDEX}, ${DOCKER_INDEX}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const childEvidence = [];
  let imageId = null;
  let manifestDigest = null;
  const failure = readIssue(manifestRead, 'image_manifest', 'GHCR date-manifest read', 'image_tag_missing', `The exact public image date tag ${input.version} was not found`);
  if (failure) issues.push(failure);
  else {
    manifestDigest = `sha256:${createHash('sha256').update(manifestRead.bytes).digest('hex')}`;
    let valid = false;
    try {
      let body = jsonBody(manifestRead);
      const contentType = responseHeader(manifestRead, 'content-type')?.split(';')[0].trim().toLowerCase();
      if ([OCI_INDEX, DOCKER_INDEX].includes(body?.mediaType)) {
        // BuildKit wraps its single runtime image with a provenance attestation.
        // Follow that one immutable image descriptor, not a guessed platform or
        // an expected-ID-selected child from a genuinely multi-platform index.
        assert(body.schemaVersion === 2 && Array.isArray(body.manifests) && body.manifests.every(descriptorValid));
        const images = body.manifests.filter(item => item.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest');
        assert(images.length === 1 && fullMatch(IMAGE_ID, images[0].digest) && [OCI_MANIFEST, DOCKER_MANIFEST].includes(images[0].mediaType));
        assert(body.manifests.every(item => item === images[0] || item.annotations?.['vnd.docker.reference.digest'] === images[0].digest));
        const childUrl = urls.ghcr_manifest.slice(0, urls.ghcr_manifest.lastIndexOf('/') + 1) + images[0].digest;
        const child = await publicRead('ghcr_image_manifest', childUrl, {
          ...context, headers: { accept: `${OCI_MANIFEST}, ${DOCKER_MANIFEST}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        });
        childEvidence.push(...child.evidenceSources);
        const childIssue = readIssue(child, 'image_child', 'GHCR immutable image-manifest read', 'image_manifest_missing', 'The indexed public image manifest was not found');
        if (childIssue) issues.push(childIssue);
        else {
          const digest = `sha256:${createHash('sha256').update(child.bytes).digest('hex')}`;
          assert(equalDigest(digest, images[0].digest) && equalDigest(responseHeader(child, 'docker-content-digest'), digest) && child.bytes.length === images[0].size);
          body = jsonBody(child);
          if (record(body) && record(body.config) && fullMatch(IMAGE_ID, body.config.digest)) imageId = body.config.digest;
          valid = manifestValid(body);
        }
      } else {
        if (record(body) && record(body.config) && fullMatch(IMAGE_ID, body.config.digest)) imageId = body.config.digest;
        valid = manifestValid(body) && ![OCI_INDEX, DOCKER_INDEX].includes(contentType);
      }
    } catch { /* Keep real top-level digest, but never promote malformed/unbound image data. */ }
    if (!valid) issues.push(issue('unverified', 'image_manifest_malformed', 'GHCR response is not a valid single runtime OCI/Docker image manifest or a digest-bound single-image index with attestations.'));
    const header = responseHeader(manifestRead, 'docker-content-digest');
    if (typeof header !== 'string' || !fullMatch(IMAGE_ID, header)) issues.push(issue('unverified', 'image_manifest_digest_unavailable', 'GHCR manifest has no valid Docker-Content-Digest header to corroborate its raw-body SHA256.'));
    else if (!equalDigest(header, manifestDigest)) issues.push(issue('unverified', 'image_manifest_digest_mismatch', 'GHCR Docker-Content-Digest does not match the SHA256 of the raw manifest response.'));
    else if (valid && !equalDigest(imageId, input.expectedArtifact.imageId)) issues.push(issue('mismatch', 'image_id_mismatch', `The image config digest at date tag ${input.version} does not match the expected image ID.`));
  }
  token = undefined;
  return { imageId, manifestDigest, issues, evidenceSources: [...tokenRead.evidenceSources, ...manifestRead.evidenceSources, ...childEvidence] };
}

/** One bounded anonymous public check of exactly the caller's requested identity. */
export async function verifyPublicReleaseOutcome(input, { fetchImpl = globalThis.fetch, clock = () => new Date(), signal } = {}) {
  const intent = parseInput(input); // Reject all caller-supplied observations/status before any I/O.
  let checkedAt;
  try {
    assert(typeof fetchImpl === 'function' && typeof clock === 'function');
    assert(signal === undefined || (signal instanceof AbortSignal));
    const now = clock();
    assert(now instanceof Date && Number.isFinite(now.getTime()));
    checkedAt = now.toISOString();
    assert(isoTimestamp(checkedAt));
  } catch { throw invalidInput(); }
  const urls = endpoints(intent.repository, intent.version, intent.expectedArtifact.imageRepository);
  const context = { fetchImpl, signal, checkedAt };
  const [release, source, image] = await Promise.all([
    checkRelease(intent, urls, context), checkSource(intent, urls, context),
    intent.expectedArtifact.imageRepository ? checkImage(intent, urls, context) : null,
  ]);
  const issues = [...release.issues, ...source.issues, ...(image?.issues || [])];
  // A known contradiction remains a mismatch even when another independent read
  // is unknown. All unknowns remain in reason/evidence; neither can be verified.
  const primary = issues.find(item => item.status === 'mismatch') || issues[0];
  const observedArtifact = { sourceTreeSha: source.sourceTreeSha };
  if (image) Object.assign(observedArtifact, { imageRepository: intent.expectedArtifact.imageRepository, imageId: image.imageId, manifestDigest: image.manifestDigest });
  return {
    ok: true,
    outcomeCheck: {
      schemaVersion: 1, kind: 'outcome-check', verifier: 'github_public_release', status: primary?.status || 'verified',
      expected: { repository: intent.repository, version: intent.version, artifact: intent.expectedArtifact },
      observed: { repository: intent.repository, version: release.version, artifact: observedArtifact },
      checkedAt, reasonCode: primary?.reasonCode || 'public_release_verified', reason: issues.length ? issues.map(item => item.reason).join(' ') : SUCCESS_REASON,
      evidenceSources: [...release.evidenceSources, ...source.evidenceSources, ...(image?.evidenceSources || [])],
      intentSource: { kind: 'caller_supplied', sourceRefs: intent.sourceRefs },
    },
  };
}
