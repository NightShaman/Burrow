import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const ignored = /^(?:build:\s+assemble Burrow|Release\s+)/i;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function commits(root, from, to) {
  let range = to;
  if (SHA.test(String(from || ''))) {
    try {
      git(root, ['merge-base', '--is-ancestor', from, to]);
      range = `${from}..${to}`;
    } catch {
      // Public source history is intentionally not mirrored. If a previous
      // frozen SHA is no longer reachable in a rewritten development history,
      // retain useful current history instead of failing release notes.
    }
  }
  const output = git(root, ['log', '--format=%H%x09%s', '--no-merges', range]);
  return output ? output.split(/\r?\n/).map((line) => {
    const [sha, ...subject] = line.split('\t');
    return { sha, subject: subject.join('\t') };
  }).filter((entry) => entry.subject && !ignored.test(entry.subject)) : [];
}

export function generateReleaseNotes({ releaseDate, sources, previousSources = {}, roots }) {
  const sections = [];
  const projects = [
    ['burrow', 'Burrow'],
    ['burrowBackend', 'Burrow Backend'],
    ['burrowUi', 'Burrow UI'],
    ['nodeGoblin', 'Node Goblin'],
    ['goblinSecretStore', 'Goblin Secret Store'],
    ['burrowSkills', 'Burrow Skills'],
    ['burrowBackdoor', 'Burrow Backdoor']
  ];
  for (const [key, label] of projects) {
    if (!roots[key] || !SHA.test(String(sources[key] || '')) || previousSources[key] === sources[key]) continue;
    const entries = commits(path.resolve(roots[key]), previousSources[key], sources[key]);
    if (!entries.length) continue;
    sections.push(`## ${label}\n\n${entries.map(({ sha, subject }) => `- ${subject} (\`${sha.slice(0, 7)}\`)`).join('\n')}`);
  }
  const body = [
    `# GoblinKing Burrow ${releaseDate}`,
    '',
    'Validated daily promotion from frozen NightShaman development revisions.',
    '',
    sections.length ? sections.join('\n\n') : 'No user-facing commit subjects were found in the promoted ranges.',
    '',
    '## Frozen sources',
    '',
    ...Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)).map(([key, sha]) => `- ${key}: \`${sha}\``)
  ];
  return `${body.join('\n')}\n`;
}

async function main() {
  const [releaseDate, sourcesFile, previousFile, rootsFile, outputFile] = process.argv.slice(2);
  if (!releaseDate || !sourcesFile || !previousFile || !rootsFile || !outputFile) throw new Error('usage: node release-notes.mjs RELEASE_DATE SOURCES_JSON PREVIOUS_JSON ROOTS_JSON OUTPUT_MD');
  const read = file => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const previous = read(previousFile);
  const notes = generateReleaseNotes({ releaseDate, sources: read(sourcesFile), previousSources: previous?.sources || {}, roots: read(rootsFile) });
  fs.writeFileSync(path.resolve(outputFile), notes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
