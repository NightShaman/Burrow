import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE = /^\d{4}\.\d{2}\.\d{2}$/;
const SHA = /^[0-9a-f]{40}$/;

export function utcReleaseDate(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('promotion_date_invalid');
  return now.toISOString().slice(0, 10).replaceAll('-', '.');
}

function normalizedSources(value = {}) {
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) throw new Error('promotion_sources_required');
  return Object.fromEntries(entries.map(([name, sha]) => {
    const normalized = String(sha || '').trim().toLowerCase();
    if (!SHA.test(normalized)) throw new Error(`promotion_source_sha_invalid:${name}`);
    return [name, normalized];
  }));
}

export function createPromotionPlan({ config, sources, previous = null, now = new Date() } = {}) {
  if (!config || config.schemaVersion !== 1 || !config.targets) throw new Error('promotion_config_invalid');
  const releaseDate = utcReleaseDate(now);
  const frozenSources = normalizedSources(sources);
  const priorSources = previous?.sources ? normalizedSources(previous.sources) : {};
  const changed = JSON.stringify(frozenSources) !== JSON.stringify(priorSources);
  const publishedToday = previous?.releaseDate === releaseDate;
  const action = !changed ? 'skip-unchanged' : publishedToday ? 'defer-next-utc-day' : 'stage';
  const targets = Object.entries(config.targets).map(([id, target]) => {
    const selected = Object.fromEntries((target.dependsOn || []).map((name) => {
      if (!frozenSources[name]) throw new Error(`promotion_source_missing:${id}:${name}`);
      return [name, frozenSources[name]];
    }));
    return {
      id,
      repository: `${config.publicOwner}/${target.repository}`,
      version: releaseDate,
      changed,
      action,
      sources: selected,
      releaseAssets: target.releaseAssets || []
    };
  });
  return {
    schemaVersion: 1,
    releaseDate,
    developmentOwner: config.developmentOwner,
    publicOwner: config.publicOwner,
    sources: frozenSources,
    targets,
    publishable: action === 'stage'
  };
}

async function main() {
  const [configPath, sourcesPath, previousPath = ''] = process.argv.slice(2);
  if (!configPath || !sourcesPath) throw new Error('usage: node plan.mjs TARGETS_JSON SOURCES_JSON [PREVIOUS_MANIFEST_JSON]');
  const read = async file => JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
  const plan = createPromotionPlan({
    config: await read(configPath),
    sources: await read(sourcesPath),
    previous: previousPath ? await read(previousPath) : null,
    now: process.env.PROMOTION_NOW ? new Date(process.env.PROMOTION_NOW) : new Date()
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
