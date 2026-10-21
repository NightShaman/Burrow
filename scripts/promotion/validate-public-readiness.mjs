import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projects = [
  ['Burrow', 'Burrow'],
  ['Node-Goblin', 'Node Goblin'],
  ['Goblin-Secret-Store', 'Goblin Secret Store'],
  ['Burrow-Skills', 'Burrow Skills'],
  ['Burrow-Backdoor', 'Burrow Backdoor'],
  ['Burrow-Tutor', 'Burrow Tutor']
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

export async function validatePublicReadiness(root) {
  const failures = [];
  for (const [directory, label] of projects) {
    const project = path.join(root, directory);
    const hero = path.join(project, 'docs/assets/hero.png');
    const readme = path.join(project, 'README.md');
    const license = path.join(project, 'LICENSE');
    try {
      const [width, height] = await pngSize(hero);
      if (width !== 1536 || height !== 1024) failures.push(`${label}: hero must be 1536x1024, got ${width}x${height}`);
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
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '../../..'));
  const failures = await validatePublicReadiness(root);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else console.log('public artwork readiness: ok');
}
