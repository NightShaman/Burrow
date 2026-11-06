import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const IMAGE = 'ghcr.io/goblinking-burrow/burrow';
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const idPattern = /^sha256:[0-9a-f]{64}$/;

export function candidateIdentity(value) {
  if (!value || !idPattern.test(value.imageId) || value.schemaVersion !== 1) throw new Error('missing tested image identity');
  return value.imageId;
}

export function pushDigest(output) {
  const matches = [...output.matchAll(/\bdigest: (sha256:[0-9a-f]{64})\b/g)];
  if (matches.length !== 1) throw new Error('published image digest missing or ambiguous');
  return matches[0][1];
}

// This is the only public image publisher. Both tags are made from the restored
// smoke-tested image archive, not from a second build. Tests inject an inert
// docker adapter; they never issue a real push, dispatch or public publication.
export function publishTestedImage({ version, identity, docker, summaryFile = '' }) {
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(version)) throw new Error('invalid public image version');
  const expected = candidateIdentity(identity);
  docker(['load', '-i', 'tested-image.tar']);
  const actual = docker(['image', 'inspect', '--format', '{{.Id}}', 'burrow-public-candidate']).trim();
  if (actual !== expected) throw new Error(`restored candidate image differs from smoke-tested image: ${expected} -> ${actual}`);
  const references = [version, 'latest'].map(tag => `${IMAGE}:${tag}`);
  // Registry pull-through avoids moving a previously published immutable date
  // tag on a partial-run retry. If present, reuse it only after verifying the
  // exact image config ID, not just an equal-looking tag name. The login action
  // is required before this step; a failed pull must never mean "tag absent".
  let existingVersion = false;
  const versionRef = references[0];
  let inspect;
  try { inspect = docker(['buildx', 'imagetools', 'inspect', versionRef, '--format', '{{.Manifest.Digest}}']); }
  catch (error) {
    const stderr = String(error?.stderr || error?.message || '');
    // Buildx emits 'ERROR: <exact reference>: not found' on a missing tag.
    // Do not treat generic errors containing 'not found' (e.g. missing Docker
    // executable) or authentication failures as an absent public tag.
    const missing = /manifest unknown|manifest not found|no such manifest/i.test(stderr) ||
      stderr.split(/\r?\n/).some(line => line.trim() === `ERROR: ${versionRef}: not found`);
    if (!missing || /unauthorized|denied|forbidden/i.test(stderr)) throw error;
  }
  if (inspect?.trim()) {
    if (!digestPattern.test(inspect.trim())) throw new Error(`invalid existing immutable date-tag digest: ${versionRef}`);
    docker(['pull', versionRef]);
    const previousId = docker(['image', 'inspect', '--format', '{{.Id}}', versionRef]).trim();
    if (previousId !== expected) throw new Error(`refusing to move existing immutable date tag: ${versionRef} (${previousId} != ${expected})`);
    existingVersion = true;
  } else if (inspect !== undefined) throw new Error(`empty existing immutable date-tag preflight: ${versionRef}`);
  let firstDigest = existingVersion ? inspect.trim() : undefined;
  for (const reference of references) {
    if (existingVersion && reference === versionRef) continue;
    docker(['tag', 'burrow-public-candidate', reference]);
    const tagged = docker(['image', 'inspect', '--format', '{{.Id}}', reference]).trim();
    if (tagged !== expected) throw new Error(`tagged image differs from smoke-tested image: ${reference}`);
    const digest = pushDigest(docker(['push', reference]));
    if (firstDigest && firstDigest !== digest) throw new Error(`public tag digests differ: ${firstDigest} != ${digest}`);
    firstDigest = digest;
  }
  for (const reference of references) {
    const published = docker(['buildx', 'imagetools', 'inspect', reference, '--format', '{{.Manifest.Digest}}']).trim();
    if (!digestPattern.test(published) || published !== firstDigest) throw new Error(`remote image digest mismatch: ${reference} -> ${published}`);
  }
  if (summaryFile) fs.appendFileSync(summaryFile, `\nBurrow public image ${version}: smoke-tested image ID ${expected}; ${references.join(', ')} => ${firstDigest}\n`);
  return { testedImageId: expected, publicDigest: firstDigest, references };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, identityFile] = process.argv.slice(2);
  const docker = args => {
    // Docker push prints its digest on stdout but can emit progress on stderr.
    return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const result = publishTestedImage({ version, identity: JSON.parse(fs.readFileSync(identityFile, 'utf8')), docker, summaryFile: process.env.GITHUB_STEP_SUMMARY });
  console.log(JSON.stringify(result));
}
