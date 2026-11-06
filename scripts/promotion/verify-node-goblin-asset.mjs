import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function verifyNodeGoblinAsset({ stageRoot, assetRoot, version, run = execFileSync }) {
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(version)) throw new Error('invalid Node Goblin public version');
  const gateway = path.join(stageRoot, 'Node-Goblin/gateway');
  const expected = `node-goblin-${version}`;
  const archive = path.join(assetRoot, `${expected}.tar.gz`);
  const checksum = `${archive}.sha256`;
  const installer = fs.readFileSync(path.join(stageRoot, 'Node-Goblin/install.sh'), 'utf8');
  if (!/^REPOSITORY=\$\{NODE_GOBLIN_REPOSITORY:-GoblinKing-Burrow\/Node-Goblin\}$/m.test(installer) ||
      !installer.includes('releases/download/v$VERSION') || !installer.includes('sha256sum -c')) {
    throw new Error('Node Goblin public installer authority or checksum contract mismatch');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(stageRoot, 'Node-Goblin/PUBLIC_RELEASE.json'), 'utf8'));
  if (manifest.releaseDate !== version || !/^[0-9a-f]{40}$/.test(manifest.sources?.nodeGoblin || '')) throw new Error('Node Goblin source manifest mismatch');
  if (fs.readFileSync(path.join(gateway, 'VERSION'), 'utf8').trim() !== version || JSON.parse(fs.readFileSync(path.join(gateway, 'package.json'), 'utf8')).version !== version) throw new Error('Node Goblin gateway identity mismatch');
  const checksumContent = fs.readFileSync(checksum, 'utf8');
  if (!new RegExp(`^[a-f0-9]{64}  ${expected}\\.tar\\.gz\\n?$`).test(checksumContent)) throw new Error('Node Goblin checksum name mismatch');
  run('sha256sum', ['-c', path.basename(checksum)], { cwd: assetRoot, stdio: 'pipe' });
  const archivedVersion = String(run('tar', ['-xOf', archive, `${expected}/VERSION`], { encoding: 'utf8' })).trim();
  const archivedPackage = JSON.parse(String(run('tar', ['-xOf', archive, `${expected}/package.json`], { encoding: 'utf8' })));
  if (archivedVersion !== version || archivedPackage.version !== version) throw new Error('Node Goblin release archive identity mismatch');
  // Compare the entire packaged runtime/deployment tree to the staged source,
  // not merely the archive name/version/checksum. The build-release allowlist is
  // defined in the frozen Node Goblin source's own build script.
  const paths = ['cli.mjs', 'node-goblin.mjs', 'index.mjs', 'package.json', 'VERSION'];
  for (const subtree of ['lib', 'deploy']) {
    function walk(directory, relative = subtree) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const name = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(path.join(directory, entry.name), name);
        else if (entry.isFile()) paths.push(name);
        else throw new Error(`Node Goblin staged package contains unsupported file type: ${name}`);
      }
    }
    walk(path.join(gateway, subtree));
  }
  const archivePaths = String(run('tar', ['-tzf', archive], { encoding: 'utf8' })).trim().split(/\r?\n/)
    .filter(item => item !== expected && item !== `${expected}/` && !item.endsWith('/'))
    .map(item => item.replace(`${expected}/`, '')).sort();
  if (JSON.stringify(archivePaths) !== JSON.stringify(paths.sort())) throw new Error('Node Goblin release asset contains missing or unexpected package files');
  for (const relative of paths) {
    const source = fs.readFileSync(path.join(gateway, relative));
    const archived = run('tar', ['-xOf', archive, `${expected}/${relative}`], { encoding: 'buffer' });
    if (!Buffer.from(archived).equals(source)) throw new Error(`Node Goblin release asset differs from staged source: ${relative}`);
  }
  return { version, sourceSha: manifest.sources.nodeGoblin, checksum: checksumContent.trim() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [stageRoot, assetRoot, version] = process.argv.slice(2);
  console.log(JSON.stringify(verifyNodeGoblinAsset({ stageRoot, assetRoot, version })));
}
