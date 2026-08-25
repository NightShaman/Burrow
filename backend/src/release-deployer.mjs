import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const RELEASE_DIRECTORIES = Object.freeze(['bin', 'deploy', 'docs', 'global-skills', 'public', 'scripts', 'src']);
export const RELEASE_FILES = Object.freeze(['package.json', 'package-lock.json', 'README.md']);

export function calendarReleasePrefix(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('release_date_invalid');
  return date.toISOString().slice(0, 10).replaceAll('-', '.');
}

export async function nextCalendarReleaseId({ releasesRoot, date = new Date() } = {}) {
  const root = path.resolve(releasesRoot || '');
  const prefix = calendarReleasePrefix(date);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  const revisions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => new RegExp(`^${prefix.replaceAll('.', '\\.')}(?:-(\\d+))?$`).exec(entry.name))
    .filter(Boolean)
    .map((match) => match[1] ? Number(match[1]) : 0);
  if (!revisions.length) return prefix;
  return `${prefix}-${Math.max(...revisions) + 1}`;
}

function assertSafeName(value, label) {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) throw new Error(`${label}_invalid`);
  return normalized;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function copyTree(source, destination) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`release_source_symlink_forbidden:${sourcePath}`);
    if (entry.isDirectory()) await copyTree(sourcePath, destinationPath);
    else if (entry.isFile()) await fs.copyFile(sourcePath, destinationPath);
    else throw new Error(`release_source_entry_unsupported:${sourcePath}`);
  }
}

async function removePackageBinDirs(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.bin') await fs.rm(child, { recursive: true, force: true });
      else await removePackageBinDirs(child);
    }
  }
}

async function filesUnder(root, relative = '') {
  const current = path.join(root, relative);
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const childRelative = path.posix.join(relative.split(path.sep).join('/'), entry.name);
    const childPath = path.join(root, childRelative);
    if (entry.isSymbolicLink()) throw new Error(`release_symlink_forbidden:${childRelative}`);
    if (entry.isDirectory()) files.push(...await filesUnder(root, childRelative));
    else if (entry.isFile()) files.push(childRelative);
    else throw new Error(`release_entry_unsupported:${childRelative}`);
  }
  return files;
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex');
}

async function sha256Stream(filePath) {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(filePath).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve);
  });
  return hash.digest('hex');
}

export function releaseUiTitle(sourceRevision, releaseId = null) {
  const revision = String(sourceRevision || '').trim();
  const shortRevision = /^[a-f0-9]{7,64}$/i.test(revision) ? revision.slice(0, 7) : null;
  // A normal deployment always has a Git revision. Retain a safe fallback for
  // explicitly source-less release builds without exposing a long release ID.
  return `Burrow [${shortRevision || assertSafeName(releaseId, 'release_id').slice(0, 7)}]`;
}

export async function stampReleaseUiTitle({ releaseRoot, releaseId, sourceRevision = null }) {
  const indexPath = path.join(path.resolve(releaseRoot), 'public', 'ui', 'index.html');
  const source = await fs.readFile(indexPath, 'utf8');
  const title = releaseUiTitle(sourceRevision, releaseId);
  let stamped = source.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);
  if (stamped === source) {
    stamped = /<head[^>]*>/i.test(source)
      ? source.replace(/<head[^>]*>/i, (head) => `${head}\n<title>${title}</title>`)
      : `<title>${title}</title>\n${source}`;
  }
  await fs.writeFile(indexPath, stamped);
  return { indexPath, title };
}

export async function replaceReleaseUi({ releaseRoot, uiDist, releaseId, sourceRevision = null, stampTitle = true } = {}) {
  const root = path.resolve(releaseRoot);
  const source = path.resolve(uiDist);
  if (!(await exists(path.join(source, 'index.html')))) throw new Error('ui_dist_index_missing');
  const target = path.join(root, 'public', 'ui');
  if (!inside(root, target)) throw new Error('release_ui_path_escape');
  await fs.rm(target, { recursive: true, force: true });
  await copyTree(source, target);
  if (!stampTitle) return { indexPath: path.join(target, 'index.html'), title: null, stamped: false };
  return { ...await stampReleaseUiTitle({ releaseRoot: root, releaseId, sourceRevision }), stamped: true };
}

export async function writeReleaseManifest(releaseRoot) {
  const root = path.resolve(releaseRoot);
  const manifestFiles = (await filesUnder(root)).filter((file) => file !== 'MANIFEST.sha256');
  const manifest = [];
  for (const relative of manifestFiles) manifest.push(`${await sha256(path.join(root, relative))}  ${relative}`);
  await fs.writeFile(path.join(root, 'MANIFEST.sha256'), `${manifest.join('\n')}\n`);
  return { fileCount: manifestFiles.length, manifestPath: path.join(root, 'MANIFEST.sha256') };
}

export async function buildReleaseArtifact({ sourceRoot, releasesRoot, releaseId, sourceRevision = null, uiDist = null, installProductionDependencies = false, stampUiTitle = true } = {}) {
  if (!uiDist) throw new Error('release_ui_dist_required');
  const resolvedSource = path.resolve(sourceRoot || '.');
  const resolvedReleases = path.resolve(releasesRoot || '');
  const safeId = assertSafeName(releaseId, 'release_id');
  const stagingRoot = path.join(resolvedReleases, `.staging-${safeId}`);
  const releaseRoot = path.join(resolvedReleases, safeId);
  if (!inside(resolvedReleases, stagingRoot) || !inside(resolvedReleases, releaseRoot)) throw new Error('release_path_escape');
  if (await exists(stagingRoot) || await exists(releaseRoot)) throw new Error('release_already_exists');

  await fs.mkdir(resolvedReleases, { recursive: true });
  await fs.mkdir(stagingRoot, { recursive: false });
  try {
    for (const directory of RELEASE_DIRECTORIES) {
      const sourcePath = path.join(resolvedSource, directory);
      if (!(await exists(sourcePath))) throw new Error(`release_source_missing:${directory}`);
      await copyTree(sourcePath, path.join(stagingRoot, directory));
    }
    for (const file of RELEASE_FILES) {
      const sourcePath = path.join(resolvedSource, file);
      if (!(await exists(sourcePath))) throw new Error(`release_source_missing:${file}`);
      await fs.copyFile(sourcePath, path.join(stagingRoot, file));
    }
    await fs.writeFile(path.join(stagingRoot, 'RELEASE_ID'), `${safeId}\n`, { mode: 0o444 });
    await fs.writeFile(path.join(stagingRoot, 'BUILD_SOURCE'), `${String(sourceRevision || 'unknown').trim()}\n`, { mode: 0o444 });
    // The deployed artifact—not the source checkout that happened to build it—is
    // authoritative for the runtime release identifier. This keeps /health in
    // lockstep with YYYY.MM.DD[-N] when multiple releases ship in one day.
    await fs.writeFile(path.join(stagingRoot, 'src', 'release-version.mjs'), `// Generated for this release artifact.\nexport const releaseVersion = ${JSON.stringify(safeId)};\n`);

    if (installProductionDependencies) {
      await execFileAsync('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: stagingRoot, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
      await removePackageBinDirs(path.join(stagingRoot, 'node_modules'));
    }
    const ui = await replaceReleaseUi({ releaseRoot: stagingRoot, uiDist, releaseId: safeId, sourceRevision, stampTitle: stampUiTitle });
    const manifest = await writeReleaseManifest(stagingRoot);
    await fs.rename(stagingRoot, releaseRoot);
    return { releaseId: safeId, releaseRoot, ui, ...manifest };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function pruneReleases({ releasesRoot, protectedReleaseRoots = [], retainNewest = 3 } = {}) {
  const root = path.resolve(releasesRoot || '');
  if (!Number.isSafeInteger(retainNewest) || retainNewest < 0) throw new Error('release_retention_invalid');
  if (!(await exists(root))) return { removed: [], retained: [] };

  const protectedRoots = new Set(protectedReleaseRoots
    .filter(Boolean)
    .map((releaseRoot) => path.resolve(releaseRoot))
    .filter((releaseRoot) => inside(root, releaseRoot) && releaseRoot !== root));
  const entries = await fs.readdir(root, { withFileTypes: true });
  const releases = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.staging-')) continue;
    const releaseRoot = path.join(root, entry.name);
    releases.push({ releaseRoot, modifiedAtMs: (await fs.stat(releaseRoot)).mtimeMs });
  }
  const additional = releases
    .filter(({ releaseRoot }) => !protectedRoots.has(releaseRoot))
    .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
    .slice(0, retainNewest)
    .map(({ releaseRoot }) => releaseRoot);
  const retained = new Set([...protectedRoots, ...additional]);
  const removed = [];
  for (const { releaseRoot } of releases) {
    if (retained.has(releaseRoot)) continue;
    await fs.rm(releaseRoot, { recursive: true, force: true });
    removed.push(releaseRoot);
  }
  return { removed, retained: [...retained].filter((releaseRoot) => releases.some((release) => release.releaseRoot === releaseRoot)) };
}

export async function exportReleaseArchive({ releaseRoot, outputDir = null, archiveName = null } = {}) {
  const root = path.resolve(releaseRoot || '');
  const verified = await verifyReleaseArtifact(root);
  const destinationDir = path.resolve(outputDir || path.dirname(root));
  await fs.mkdir(destinationDir, { recursive: true });
  const safeArchiveName = archiveName ? assertSafeName(archiveName.replace(/\.tar\.gz$/i, ''), 'archive_name') : verified.releaseId;
  const archivePath = path.join(destinationDir, `${safeArchiveName}.tar.gz`);
  const checksumPath = `${archivePath}.sha256`;
  if (await exists(archivePath) || await exists(checksumPath)) throw new Error('release_archive_already_exists');
  await execFileAsync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', archivePath, '-C', path.dirname(root), path.basename(root)], { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  const digest = await sha256Stream(archivePath);
  await fs.writeFile(checksumPath, `${digest}  ${path.basename(archivePath)}\n`, { mode: 0o644 });
  return { ok: true, releaseId: verified.releaseId, archivePath, checksumPath, sha256: digest, fileCount: verified.fileCount };
}

export async function verifyReleaseArtifact(releaseRoot) {
  const root = path.resolve(releaseRoot);
  const releaseId = String(await fs.readFile(path.join(root, 'RELEASE_ID'), 'utf8')).trim();
  assertSafeName(releaseId, 'release_id');
  for (const required of ['bin/burrow.mjs', 'scripts/burrow-ui.mjs', 'public/ui/index.html', 'package.json', 'package-lock.json', 'MANIFEST.sha256']) {
    if (!(await exists(path.join(root, required)))) throw new Error(`release_required_file_missing:${required}`);
  }
  const lines = String(await fs.readFile(path.join(root, 'MANIFEST.sha256'), 'utf8')).trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error('release_manifest_invalid');
    const relative = match[2];
    const filePath = path.resolve(root, relative);
    if (!inside(root, filePath) || relative === 'MANIFEST.sha256') throw new Error(`release_manifest_path_invalid:${relative}`);
    if (await sha256(filePath) !== match[1]) throw new Error(`release_manifest_mismatch:${relative}`);
  }
  const actual = (await filesUnder(root)).filter((file) => file !== 'MANIFEST.sha256').sort();
  const declared = lines.map((line) => line.slice(66)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(declared)) throw new Error('release_manifest_inventory_mismatch');
  return { ok: true, releaseId, releaseRoot: root, fileCount: actual.length };
}
