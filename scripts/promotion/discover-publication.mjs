import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

function validateManifest(manifest, repository) {
  if (!manifest || manifest.schemaVersion !== 1 || !/^\d{4}\.\d{2}\.\d{2}$/.test(manifest.releaseDate)
      || !manifest.sources || typeof manifest.sources !== 'object' || Array.isArray(manifest.sources)
      || !Object.keys(manifest.sources).length || Object.values(manifest.sources).some(sha => !/^[0-9a-f]{40}$/.test(sha))) {
    throw new Error(`promotion_manifest_invalid:${repository}`);
  }
  return manifest;
}

// Every snapshot carries the same frozen manifest. Inspect all targets before
// freezing anything: the first component main push is already a durable receipt,
// even if its tag/release or the terminal Burrow snapshot was never published.
export async function discoverPublication({ config, readJson }) {
  const candidates = new Map();
  for (const target of Object.values(config.targets)) {
    const repository = `${config.publicOwner}/${target.repository}`;
    const manifest = await readJson(`https://raw.githubusercontent.com/${repository}/main/PUBLIC_RELEASE.json`);
    if (manifest === null) continue;
    validateManifest(manifest, repository);
    const existing = candidates.get(manifest.releaseDate);
    if (existing && (String(existing.promotionRunId) !== String(manifest.promotionRunId)
        || !isDeepStrictEqual(existing.sources, manifest.sources))) {
      throw new Error(`promotion_manifest_conflict:${manifest.releaseDate}`);
    }
    candidates.set(manifest.releaseDate, manifest);
  }
  const pending = [];
  const completed = [];
  for (const [version, manifest] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    const release = await readJson(`https://api.github.com/repos/${config.publicOwner}/Burrow/releases/tags/v${version}`);
    if (release === null) {
      if (!/^[1-9][0-9]*$/.test(String(manifest.promotionRunId))) throw new Error('promotion_resume_artifact_origin_required');
      pending.push(manifest);
    } else {
      if (release.draft || release.prerelease || release.tag_name !== `v${version}`) throw new Error(`promotion_terminal_release_invalid:${version}`);
      completed.push(manifest);
    }
  }
  // Never silently select one of several inconsistent unfinished publications.
  if (pending.length > 1) throw new Error('promotion_multiple_pending_publications');
  return { previous: pending[0] || completed.at(-1) || null, terminalComplete: pending.length === 0 };
}

async function readPublicJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Burrow-Public-promotion', Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`promotion_discovery_http:${response.status}:${url}`);
  return response.json();
}

async function main() {
  const [configPath, previousPath = 'previous.json'] = process.argv.slice(2);
  if (!configPath || !process.env.GITHUB_ENV) throw new Error('usage: GITHUB_ENV=... node discover-publication.mjs TARGETS_JSON [PREVIOUS_JSON]');
  const config = JSON.parse(await fs.readFile(path.resolve(configPath), 'utf8'));
  const result = await discoverPublication({ config, readJson: readPublicJson });
  await fs.writeFile(previousPath, `${JSON.stringify(result.previous, null, 2)}\n`);
  await fs.appendFile(process.env.GITHUB_ENV, `PROMOTION_TERMINAL_COMPLETE=${result.terminalComplete}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
