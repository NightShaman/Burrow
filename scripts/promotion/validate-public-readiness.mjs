import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AUDITOR_SKILL, checkRuntimePackage, COMPANION_SNAPSHOTS, publicPlugCatalog, publicPlugConnector, readPlugCatalog } from './companion-snapshots.mjs';
import { COMPANION_TARGETS } from './companion-targets.mjs';
import { PUBLIC_SKILL_IDS } from './stage-snapshots.mjs';

const projects = [
  ['Burrow', 'Burrow'],
  ['Node-Goblin', 'Node Goblin'],
  ['Goblin-Secret-Store', 'Goblin Secret Store'],
  ['Burrow-Skills', 'Burrow Skills'],
  ['Burrow-Backdoor', 'Burrow Backdoor'],
  ['Burrow-Tutor', 'Burrow Tutor'],
  ['Burrow-Theater', 'Burrow Theater'],
  ['Burrow-Switchboard', 'Burrow Switchboard'],
  ...Object.values(COMPANION_TARGETS).map(({ repository, name }) => [repository, name])
];

async function pngSize(file) {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== 24 || header.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('not_png');
    return [header.readUInt32BE(16), header.readUInt32BE(20)];
  } finally { await handle.close(); }
}

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

function coreVersionParts(version) {
  const match = typeof version === 'string' && /^(\d{4})\.(\d{2})\.(\d{2})(?:\.([1-9]\d*))?$/.exec(version);
  if (!match || match[0] !== version) return null;
  const [, year, month, day, revision = '0'] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.toISOString().slice(0, 10) === `${year}-${month}-${day}` ? [year, month, day, revision].map(BigInt) : null;
}

export function meetsCoreMinimum(version, minimum) {
  const installed = coreVersionParts(version);
  const required = coreVersionParts(minimum);
  if (!installed || !required) return false;
  const difference = installed.findIndex((part, index) => part !== required[index]);
  return difference === -1 || installed[difference] > required[difference];
}

export async function validateCompanionReadiness(root, key, burrowRelease, parseModManifest) {
  const { repository, id, name } = COMPANION_TARGETS[key];
  const { releaseDate } = burrowRelease;
  const expectedUrl = `https://github.com/GoblinKing-Burrow/${repository}`;
  const [manifest, pkg, release] = await Promise.all(
    ['burrow.mod.json', 'package.json', 'PUBLIC_RELEASE.json'].map(file => readJson(path.join(root, file)))
  );
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(releaseDate) || !isDeepStrictEqual(release, burrowRelease)
    || manifest.id !== id || manifest.name !== name || manifest.version !== releaseDate || pkg.version !== releaseDate
    || manifest.system || Object.hasOwn(manifest, 'systemCapabilities')
    || pkg.repository?.url !== `git+${expectedUrl}.git` || pkg.homepage !== expectedUrl || pkg.scripts) {
    throw new Error('public mod identity or package metadata mismatch');
  }
  if (!meetsCoreMinimum(releaseDate, manifest.minCoreVersion)) {
    throw new Error(`public Burrow ${releaseDate} does not meet the mod minimum ${manifest.minCoreVersion}`);
  }
  checkRuntimePackage(pkg, id);
  const files = COMPANION_SNAPSHOTS[key].paths;
  const publicFiles = [...files, 'README.md', 'PUBLIC_RELEASE.json'].sort();
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const actualFiles = entries.filter(entry => !entry.isDirectory())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name))).sort();
  if (!isDeepStrictEqual(actualFiles, publicFiles) || entries.some(entry => !entry.isDirectory() && !entry.isFile())) {
    throw new Error('public mod payload differs from its file allowlist');
  }
  for (const file of publicFiles.filter(file => /\.(?:mjs|js|json|md|css)$/i.test(file))) {
    if (/https?:\/\/[^\s"'<>]*\bNightShaman\//i.test(await fs.readFile(path.join(root, file), 'utf8'))) {
      throw new Error(`private repository URL in ${file}`);
    }
  }
  const expectedSlots = key === 'burrowAuditor' ? ['archive', 'settings'] : ['control', 'settings'];
  if (manifest.server !== 'server/index.mjs' || !isDeepStrictEqual(Object.keys(manifest.ui || {}).sort(), expectedSlots)
    || expectedSlots.some(slot => manifest.ui[slot] !== `ui/${slot}.js`)) {
    throw new Error('mod entrypoints differ from the public loader contract');
  }
  if (key === 'burrowAuditor' && !isDeepStrictEqual(manifest.managedSkills, [AUDITOR_SKILL])) {
    throw new Error('official Auditor managed skill metadata mismatch');
  }
  if (parseModManifest) await parseModManifest(root, id);
  const importFile = file => import(pathToFileURL(path.resolve(root, file)));
  const server = await importFile(manifest.server);
  if (typeof server.activate !== 'function') throw new Error('mod server is missing its activate export');
  if (key === 'burrowPlug' && (server.DEFAULT_CATALOG_URL !== publicPlugCatalog(releaseDate)
    || readPlugCatalog(root).entries[0].url !== publicPlugConnector(releaseDate))) {
    throw new Error('Plug-ins catalog authority mismatch');
  }
  for (const entry of files.filter(file => /^(server|ui)\/.*\.(mjs|js)$/.test(file))) {
    await importFile(entry);
  }
  // Auditor also ships an inert mountControl for cached manifests.
  for (const slot of ['control', ...expectedSlots.filter(slot => slot !== 'control')]) {
    const module = await importFile(`ui/${slot}.js`);
    const mount = `mount${slot[0].toUpperCase()}${slot.slice(1)}`;
    if (typeof module[mount] !== 'function') throw new Error(`mod UI is missing its ${mount} export`);
  }
}

export async function validatePublicReadiness(root, parseModManifest) {
  const failures = [];
  for (const [directory, label] of projects) {
    const project = path.join(root, directory);
    const hero = path.join(project, 'docs/assets/hero.png');
    const readme = path.join(project, 'README.md');
    const license = path.join(project, 'LICENSE');
    try {
      const [width, height] = await pngSize(hero);
      // Newly added mods retain their existing repository artwork at its native aspect.
      const companion = Object.values(COMPANION_TARGETS).some(target => target.repository === directory);
      if (companion ? width < 1 || height < 1 : width !== 1536 || height !== 1024) {
        failures.push(companion ? `${label}: hero must have positive dimensions` : `${label}: hero must be 1536x1024, got ${width}x${height}`);
      }
    } catch (error) {
      failures.push(`${label}: missing or invalid docs/assets/hero.png (${error.code || error.message})`);
    }
    try {
      const text = await fs.readFile(readme, 'utf8');
      if (!/src=["']docs\/assets\/hero\.png["']/.test(text)) failures.push(`${label}: README does not reference docs/assets/hero.png`);
      if (!/width=["']720["']/.test(text)) failures.push(`${label}: README hero width must be 720`);
      if (!/alt=["'][^"']+["']/.test(text)) failures.push(`${label}: README hero needs alt text`);
    } catch (error) { failures.push(`${label}: README unavailable (${error.code || error.message})`); }
    try {
      const stat = await fs.stat(license);
      if (!stat.isFile() || stat.size === 0) failures.push(`${label}: LICENSE must be a non-empty file`);
    } catch (error) { failures.push(`${label}: LICENSE unavailable (${error.code || error.message})`); }
  }
  // Check the files agents actually fetch, not just the GitHub release tag.
  try {
    const skillRoot = path.join(root, 'Burrow-Skills');
    const { releaseDate } = JSON.parse(await fs.readFile(path.join(skillRoot, 'PUBLIC_RELEASE.json'), 'utf8'));
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(String(releaseDate || ''))) throw new Error('release_date_invalid');
    for (const id of PUBLIC_SKILL_IDS) {
      const content = await fs.readFile(path.join(skillRoot, id, 'SKILL.md'), 'utf8');
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
      const versions = [...(header || '').matchAll(/^version:[ \t]*([^\r\n]*)/gm)];
      if (versions.length !== 1 || versions[0][1] !== releaseDate) {
        failures.push(`Burrow Skills: ${id} version must match Public ${releaseDate}`);
      }
    }
  } catch (error) { failures.push(`Burrow Skills: release identity unavailable (${error.code || error.message})`); }
  for (const [key, { repository, name }] of Object.entries(COMPANION_TARGETS)) {
    try {
      const burrowRelease = await readJson(path.join(root, 'Burrow/PUBLIC_RELEASE.json'));
      await validateCompanionReadiness(path.join(root, repository), key, burrowRelease, parseModManifest);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '../../..'));
  const parseModManifest = process.argv[3]
    ? (await import(pathToFileURL(path.resolve(process.argv[3], 'src/mod-runtime.mjs')))).parseModManifest
    : undefined;
  const failures = await validatePublicReadiness(root, parseModManifest);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else console.log('public snapshot readiness: ok');
}
