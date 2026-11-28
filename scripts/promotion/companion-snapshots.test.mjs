import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AUDITOR_SKILL, publicPlugCatalog } from './companion-snapshots.mjs';
import { COMPANION_TARGETS } from './companion-targets.mjs';
import { PUBLIC_SKILL_IDS, TARGETS, stageSnapshots } from './stage-snapshots.mjs';
import { meetsCoreMinimum, validateCompanionReadiness, validatePublicReadiness } from './validate-public-readiness.mjs';

const version = '2026.11.28';
const devVersion = '2026.11.26.7';
const burrowInstaller = 'DEFAULT_REPOSITORY="NightShaman/Burrow"\n';
const nodeInstaller = 'REPOSITORY=${NODE_GOBLIN_REPOSITORY:-NightShaman/Node-Goblin}\n';
const hero = Buffer.alloc(24);
Buffer.from('89504e470d0a1a0a', 'hex').copy(hero);
hero.writeUInt32BE(1536, 16);
hero.writeUInt32BE(1024, 20);

const connector = '{"id":"outlook-calendar","version":"2026.11.25"}\n';
const catalog = { schemaVersion: 1, entries: [{
  id: 'outlook-calendar', version: '2026.11.25', digest: createHash('sha256').update(connector).digest('hex'),
  url: 'https://raw.githubusercontent.com/NightShaman/Burrow-Plug-Connectors/v2026.11.25/connectors/outlook-calendar.json'
}] };

function write(root, files) {
  for (const [file, value] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  }
}

function seedRepo(root, files) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  write(root, files);
  git('init', '-q');
  git('add', '.');
  const tree = git('write-tree');
  const commit = git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-m', 'fixture');
  git('update-ref', 'HEAD', commit);
  return commit;
}

test('frozen snapshot staging publishes only the mod loader payload and date-bound public catalog', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-companion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roots = {}, sources = { burrowBackend: 'a'.repeat(40), burrowUi: 'b'.repeat(40) };
  for (const [key, spec] of Object.entries(TARGETS)) {
    const base = path.join(root, key);
    roots[key] = base;
    const companion = COMPANION_TARGETS[key];
    const directories = ['backend', 'docs', 'gateway', 'server', 'src', 'scripts', 'scripts/docs', 'scripts/install', 'test', 'ui', ...PUBLIC_SKILL_IDS];
    const files = Object.fromEntries(spec.paths.map(file => [
      !companion && directories.includes(file) ? `${file}/.fixture` : file, 'fixture\n'
    ]));
    files['docs/assets/hero.png'] = hero;
    files['README.md'] = '<img src="docs/assets/hero.png" width="720" alt="Fixture hero" />';
    if (companion) {
      Object.assign(files, {
        LICENSE: 'fixture license', 'package.json': { name: companion.id, version: devVersion, type: 'module', scripts: { build: 'node scripts/check.mjs' }, devDependencies: { jsdom: '1' } },
        'burrow.mod.json': { id: companion.id, name: companion.name, version: devVersion, minCoreVersion: '2026.11.26.2',
          server: 'server/index.mjs', ui: { settings: 'ui/settings.js',
            ...(key === 'burrowAuditor' ? { archive: 'ui/archive.js' } : { control: 'ui/control.js' }) },
          contributions: { settings: [{ navigation: { title: companion.name }, primary: { title: `Burrow ${companion.name}` } }] },
          ...(key === 'burrowAuditor' ? { managedSkills: [AUDITOR_SKILL] } : {}) },
        'README.md': 'private setup', 'docs/evidence/audit.md': 'private audit', 'ui/test/fixture.mjs': 'private test',
        'scripts/check.mjs': 'private dev script', 'server/private.env': 'private secret', 'spike/research.md': 'private research',
        'server/index.mjs': 'export function activate() {}'
      });
      for (const file of spec.paths.filter(file => /\.(mjs|js)$/.test(file) && files[file] === 'fixture\n')) files[file] = 'export {};';
      files['ui/control.js'] = 'export function mountControl() {}';
      files['ui/settings.js'] = 'export function mountSettings() {}';
      if (key === 'burrowAuditor') files['ui/archive.js'] = 'export function mountArchive() {}';
      if (key === 'burrowPlug') Object.assign(files, {
        '.gitattributes': 'connectors/outlook-calendar.json export-ignore\n',
        'server/legacy.mjs': "export const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/NightShaman/Burrow-Plug-Connectors/v2026.11.25/catalog/index.json';\n",
        'server/index.mjs': "export { DEFAULT_CATALOG_URL } from './legacy.mjs';\nexport function activate() {}\n",
        'ui/settings.js': 'export function mountSettings() {}\nexport const title = "Burrow Plug-ins";',
        'connectors/outlook-calendar.json': connector, 'catalog/index.json': catalog
      });
    } else {
      if (spec.paths.includes('LICENSE')) files.LICENSE = 'fixture license';
      if (spec.paths.includes('SOURCE_VERSIONS')) files.SOURCE_VERSIONS = 'Burrow-Build-Version 2026.11.26.7\n';
      for (const file of ['burrow.mod.json', 'package.json', 'package-lock.json']) if (spec.paths.includes(file)) files[file] = {};
      if (key === 'burrow') Object.assign(files, { 'install.sh': burrowInstaller, 'backend/package.json': {}, 'backend/package-lock.json': {}, 'backend/src/release-version.mjs': '' });
      if (key === 'nodeGoblin') Object.assign(files, { 'install.sh': nodeInstaller, 'gateway/package.json': {}, 'gateway/VERSION': '' });
      if (key === 'burrowSkills') {
        for (const id of PUBLIC_SKILL_IDS) files[`${id}/SKILL.md`] = `---\nname: ${id}\nversion: ${devVersion}\n---\n`;
        files['burrow-auditor/audit.md'] = 'private audit';
      }
    }
    sources[key] = seedRepo(base, files);
  }
  write(roots.burrowPlug, { 'server/index.mjs': 'uncommitted edit', 'untracked.env': 'local secret' });
  const outputRoot = path.join(root, 'staged');
  const staged = stageSnapshots({ roots, outputRoot, releaseDate: version, sources });
  const readJson = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file)));
  const release = readJson(staged.burrow, 'PUBLIC_RELEASE.json');
  assert.deepEqual(await validatePublicReadiness(outputRoot), []);
  for (const [key, { name }] of Object.entries(COMPANION_TARGETS)) {
    const dir = staged[key];
    await validateCompanionReadiness(dir, key, release);
    assert.equal(readJson(dir, 'burrow.mod.json').name, name);
    assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /Mod sources/);
    assert.equal(readJson(dir, 'package.json').devDependencies, undefined);
    for (const omitted of ['scripts', 'docs/evidence', 'spike', 'server/private.env', 'ui/test', 'untracked.env', '.gitattributes']) {
      assert.equal(fs.existsSync(path.join(dir, omitted)), false, omitted);
    }
  }
  const plug = staged.burrowPlug;
  assert.match(fs.readFileSync(path.join(plug, 'server/legacy.mjs'), 'utf8'), new RegExp(RegExp.escape(publicPlugCatalog(version))));
  assert.equal(readJson(plug, 'catalog/index.json').entries[0].url, `https://raw.githubusercontent.com/GoblinKing-Burrow/Burrow-Plug/v${version}/connectors/outlook-calendar.json`);
  assert.equal(readJson(plug, 'catalog/index.json').entries[0].digest, catalog.entries[0].digest);
  assert.equal(readJson(plug, 'burrow.mod.json').contributions.settings[0].primary.title, 'Burrow Plug-ins');
  assert.deepEqual(fs.readFileSync(path.join(plug, 'ui/settings.js')), fs.readFileSync(path.join(roots.burrowPlug, 'ui/settings.js')));
  assert.ok(fs.existsSync(path.join(staged.burrowAuditor, 'ui/control.js')));
  assert.match(fs.readFileSync(path.join(staged.burrowSkills, 'burrow-auditor/SKILL.md'), 'utf8'), /version: 2026\.11\.28/);
  assert.equal(fs.existsSync(path.join(staged.burrowSkills, 'burrow-auditor/audit.md')), false);
  write(plug, { 'connectors/outlook-calendar.json': `${connector}\n` });
  await assert.rejects(validateCompanionReadiness(plug, 'burrowPlug', release), /promotion_plug_catalog_mismatch/);
  write(plug, { 'connectors/outlook-calendar.json': connector });
  write(plug, { 'docs/evidence.md': 'private evidence' });
  await assert.rejects(validateCompanionReadiness(plug, 'burrowPlug', release), /differs from its file allowlist/);
  assert.throws(() => stageSnapshots({ roots, outputRoot, releaseDate: version, sources: { ...sources, burrowPlug: 'c'.repeat(40) } }), /promotion_checkout_mismatch:burrowPlug/);
});

test('Core minimum uses calendar dates and numeric development revisions', () => {
  assert.equal(meetsCoreMinimum('2026.11.27.10', '2026.11.27.3'), true);
  assert.equal(meetsCoreMinimum('2026.11.27.3', '2026.11.27.10'), false);
  assert.equal(meetsCoreMinimum('2026.11.27', '2026.11.27.3'), false);
  assert.equal(meetsCoreMinimum('2026.11.28', '2026.11.27.3'), true);
  assert.equal(meetsCoreMinimum('2026.11.27', '2026.11.27'), true);
  assert.equal(meetsCoreMinimum('2026.02.28', '2026.02.29'), false);
  assert.equal(meetsCoreMinimum('2028.02.29', '2028.02.29'), true);
});
