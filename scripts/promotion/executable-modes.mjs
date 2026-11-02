import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The Actions artifact service does not preserve file modes. Record every
// executable in the staged snapshot, then compare after unpacking the tarball.
export function executableModes(root) {
  const files = [];
  function visit(relative) {
    const absolute = path.join(root, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && (fs.statSync(path.join(root, child)).mode & 0o111)) files.push(child);
    }
  }
  visit('');
  return { schemaVersion: 1, executableFiles: files.sort() };
}

export function verifyExecutableModes(root, manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.executableFiles) ||
      manifest.executableFiles.some(file => typeof file !== 'string' || !file) ||
      new Set(manifest.executableFiles).size !== manifest.executableFiles.length) {
    throw new Error('promotion_executable_manifest_invalid');
  }
  const expected = new Set(manifest.executableFiles);
  const actual = new Set(executableModes(root).executableFiles);
  const missing = [...expected].filter(file => !actual.has(file));
  const unexpected = [...actual].filter(file => !expected.has(file));
  if (missing.length || unexpected.length) {
    throw new Error(`promotion_executable_modes_changed: missing=${missing.join(',')} unexpected=${unexpected.join(',')}`);
  }
  return actual.size;
}

function main() {
  const [action, root, manifestFile] = process.argv.slice(2);
  if (!['record', 'verify'].includes(action) || !root || !manifestFile) {
    throw new Error('usage: node executable-modes.mjs record|verify STAGED_ROOT MANIFEST_JSON');
  }
  if (action === 'record') {
    fs.writeFileSync(manifestFile, `${JSON.stringify(executableModes(root), null, 2)}\n`);
  } else {
    const count = verifyExecutableModes(root, JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
    console.log(`public promotion executable permissions: ${count} verified`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
