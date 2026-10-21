import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const ignored = /^(?:build:\s+assemble Burrow|Release\s+)/i;

export const releaseTargets = Object.freeze({
  burrow: {
    title: 'Burrow',
    projects: [
      ['burrow', 'Burrow'],
      ['burrowBackend', 'Backend'],
      ['burrowUi', 'UI']
    ]
  },
  nodeGoblin: { title: 'Node Goblin', projects: [['nodeGoblin', 'Node Goblin']] },
  goblinSecretStore: { title: 'Goblin Secret Store', projects: [['goblinSecretStore', 'Goblin Secret Store']] },
  burrowSkills: { title: 'Burrow Skills', projects: [['burrowSkills', 'Burrow Skills']] },
  burrowBackdoor: { title: 'Burrow Backdoor', projects: [['burrowBackdoor', 'Burrow Backdoor']] },
  burrowTutor: { title: 'Burrow Tutor', projects: [['burrowTutor', 'Burrow Tutor']] }
});

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

export function generateReleaseNotes({ target, releaseDate, sources, previousSources = {}, roots }) {
  const definition = releaseTargets[target];
  if (!definition) throw new Error(`unknown release-note target: ${target}`);

  const sections = [];
  for (const [key, label] of definition.projects) {
    if (!roots[key] || !SHA.test(String(sources[key] || '')) || previousSources[key] === sources[key]) continue;
    const entries = commits(path.resolve(roots[key]), previousSources[key], sources[key]);
    if (!entries.length) continue;
    const changes = entries.map(({ subject }) => `- ${subject}`).join('\n');
    sections.push(definition.projects.length === 1 ? changes : `## ${label}\n\n${changes}`);
  }

  return [
    `# ${definition.title} ${releaseDate}`,
    '',
    sections.length ? sections.join('\n\n') : 'No release-note changes were found for this repository.'
  ].join('\n') + '\n';
}

async function main() {
  const [target, releaseDate, sourcesFile, previousFile, rootsFile, outputFile] = process.argv.slice(2);
  if (!target || !releaseDate || !sourcesFile || !previousFile || !rootsFile || !outputFile) {
    throw new Error('usage: node release-notes.mjs TARGET RELEASE_DATE SOURCES_JSON PREVIOUS_JSON ROOTS_JSON OUTPUT_MD');
  }
  const read = file => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const previous = read(previousFile);
  const notes = generateReleaseNotes({ target, releaseDate, sources: read(sourcesFile), previousSources: previous?.sources || {}, roots: read(rootsFile) });
  fs.writeFileSync(path.resolve(outputFile), notes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
