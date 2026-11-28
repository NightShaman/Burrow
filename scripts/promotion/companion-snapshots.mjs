import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COMPANION_TARGETS } from './companion-targets.mjs';

const publicFiles = ['LICENSE', 'burrow.mod.json', 'package.json', 'docs/assets/hero.png'];
export const COMPANION_SNAPSHOTS = {
  burrowAuditor: {
    paths: [...publicFiles, 'docs/api.md',
      'server/index.mjs', 'server/prompt.mjs', 'server/report.mjs', 'server/verdict.mjs',
      'ui/archive.js', 'ui/control.css', 'ui/control.js', 'ui/run-dialog.js', 'ui/settings.js', 'ui/shared.js'],
    excludes: []
  },
  burrowPlug: {
    paths: [...publicFiles, 'catalog/index.json', 'connectors/outlook-calendar.json',
      'server/broker-catalog.mjs', 'server/broker-logos.mjs', 'server/broker.mjs', 'server/composio.mjs',
      'server/eligibility.mjs', 'server/errors.mjs', 'server/http.mjs', 'server/index.mjs',
      'server/legacy.mjs', 'server/manifest.mjs', 'server/microsoft.mjs',
      'server/vendor/ajv-formats.LICENSE', 'server/vendor/ajv.LICENSE', 'server/vendor/schema-validator.mjs',
      'ui/access-settings.js', 'ui/broker-settings.js', 'ui/control.css', 'ui/control.js',
      'ui/legacy.js', 'ui/settings.js', 'ui/view.js'],
    excludes: []
  }
};

export const AUDITOR_SKILL = {
  id: 'burrow-auditor',
  repository: 'https://github.com/GoblinKing-Burrow/Burrow-Skills.git',
  path: 'burrow-auditor'
};

const connector = 'connectors/outlook-calendar.json';
const rawRoot = (version) => `https://raw.githubusercontent.com/GoblinKing-Burrow/Burrow-Plug/v${version}`;
export const publicPlugCatalog = (version) => `${rawRoot(version)}/catalog/index.json`;

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

export function exportCompanionFiles(root, output, revision, files) {
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  // Plug's Development archive excludes the Outlook connector. The Public
  // allowlist is authoritative and includes that exact tracked blob.
  const listing = git(['ls-tree', '-z', revision, '--', ...files]).toString('utf8');
  const blobs = new Map();
  for (const entry of listing.split('\0')) {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    if (match) blobs.set(match[3], { mode: Number.parseInt(match[1].slice(-3), 8), hash: match[2] });
  }
  for (const file of files) {
    if (!blobs.has(file)) throw new Error(`promotion_mod_file_missing_or_invalid:${file}`);
  }
  for (const file of files) {
    const { mode, hash } = blobs.get(file);
    const destination = path.join(output, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, git(['cat-file', 'blob', hash]), { mode });
  }
}

export function checkRuntimePackage(pkg, id) {
  if (pkg.name !== id || pkg.type !== 'module'
    || ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']
      .some(key => Object.hasOwn(pkg, key) && (!pkg[key] || typeof pkg[key] !== 'object' || Object.keys(pkg[key]).length))) {
    throw new Error(`promotion_mod_runtime_package_invalid:${id}`);
  }
}

export function readPlugCatalog(root) {
  const catalogPath = path.join(root, 'catalog/index.json');
  const catalog = readJson(catalogPath);
  const connectorManifest = readJson(path.join(root, connector));
  const digest = createHash('sha256').update(fs.readFileSync(path.join(root, connector))).digest('hex');
  const entry = catalog.entries?.[0];
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries) || catalog.entries.length !== 1 || entry?.id !== 'outlook-calendar'
    || connectorManifest.id !== entry.id || connectorManifest.version !== entry.version || entry.digest !== digest) {
    throw new Error('promotion_plug_catalog_mismatch');
  }
  return catalog;
}

export function publicPlugConnector(version) {
  return `${rawRoot(version)}/${connector}`;
}

function stampPlug(root, version) {
  // Keep the legacy connector usable with verifiable bytes under the same public tag.
  const catalog = readPlugCatalog(root);
  catalog.entries[0].url = publicPlugConnector(version);
  writeJson(path.join(root, 'catalog/index.json'), catalog);
  const legacy = path.join(root, 'server/legacy.mjs');
  const authority = /^export const DEFAULT_CATALOG_URL = '[^'\r\n]+';$/gm;
  const source = fs.readFileSync(legacy, 'utf8');
  if ([...source.matchAll(authority)].length !== 1) throw new Error('promotion_plug_catalog_authority_missing');
  fs.writeFileSync(legacy, source.replace(authority, `export const DEFAULT_CATALOG_URL = '${publicPlugCatalog(version)}';`));
}

export function stampCompanionSnapshot(root, key, version, sources) {
  const { repository, id, name } = COMPANION_TARGETS[key];
  const manifestFile = path.join(root, 'burrow.mod.json');
  const manifest = readJson(manifestFile);
  const packageFile = path.join(root, 'package.json');
  const pkg = readJson(packageFile);
  checkRuntimePackage(pkg, id);
  if (manifest.id !== id || manifest.name !== name || manifest.system || Object.hasOwn(manifest, 'systemCapabilities')
    || manifest.version !== pkg.version || !manifest.minCoreVersion) {
    throw new Error(`promotion_mod_manifest_invalid:${id}`);
  }
  if (key === 'burrowPlug') stampPlug(root, version);
  const repositoryUrl = `https://github.com/GoblinKing-Burrow/${repository}`;
  writeJson(manifestFile, { ...manifest, version });
  writeJson(packageFile, { name: id, version, type: pkg.type, private: true, engines: pkg.engines,
    repository: { type: 'git', url: `git+${repositoryUrl}.git` }, homepage: repositoryUrl });
  fs.copyFileSync(new URL(`./public-readmes/${repository}.md`, import.meta.url), path.join(root, 'README.md'));
  writeJson(path.join(root, 'PUBLIC_RELEASE.json'), { schemaVersion: 1, releaseDate: version, sources });
}
