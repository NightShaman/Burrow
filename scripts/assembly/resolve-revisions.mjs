import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const components = [
  { name: 'backend', repo: 'NightShaman/Burrow-Backend', key: 'Burrow-Backend' },
  { name: 'ui', repo: 'NightShaman/Burrow-UI', key: 'Burrow-UI' }
];
const shaPattern = /^[0-9a-f]{40}$/;

export function recordedPins(text) {
  const lines = text.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/));
  const pins = {};
  for (const { key, name } of components) {
    const matches = lines.filter(([candidate]) => candidate === key);
    if (matches.length !== 1 || matches[0].length !== 2 || !shaPattern.test(matches[0][1])) {
      throw new Error(`${name}: required canonical ${key} revision metadata is missing, duplicated or invalid`);
    }
    pins[name] = matches[0][1];
  }
  return pins;
}

export async function resolveRevisions({ eventName, eventSource = '', eventSha = '', eventRef = '', backendInput = '', uiInput = '', recorded, api }) {
  const pins = recordedPins(recorded);
  if (eventName !== 'repository_dispatch' && eventName !== 'workflow_dispatch') throw new Error('unsupported assembly event');
  const refs = { backend: backendInput || 'main', ui: uiInput || 'main' };
  if (eventName === 'repository_dispatch') {
    if (eventRef !== 'main') throw new Error('Automatic assembly requires source_ref=main');
    // An unrecognized/case-mismatched dispatch must not silently fall back to both moving mains.
    const sender = components.find(component => component.repo === eventSource);
    if (!sender || !shaPattern.test(eventSha)) throw new Error('Automatic assembly requires a canonical source_repository and immutable source_sha');
    refs[sender.name] = eventSha;
  }
  const resolved = {};
  for (const component of components) {
    const { name, repo } = component;
    // The API is passed as a function so tests can exercise actual ordering and
    // failure semantics without external network calls or any publication.
    const sha = await api(`repos/${repo}/commits/${refs[name]}`, 'sha');
    if (!shaPattern.test(sha)) throw new Error(`${name}: source revision did not resolve to an immutable SHA`);
    resolved[name] = sha;
    if (pins[name] === sha) continue;
    const status = await api(`repos/${repo}/compare/${pins[name]}...${sha}`, 'status');
    if (status !== 'ahead') throw new Error(`Refusing non-forward ${name} pin: ${pins[name]} -> ${sha} (${status})`);
  }
  return resolved;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = (endpoint, field) => execFileSync('gh', ['api', endpoint, '--jq', `.${field}`], { encoding: 'utf8' }).trim();
  const revisions = await resolveRevisions({
    eventName: process.env.EVENT_NAME, eventSource: process.env.EVENT_SOURCE,
    eventSha: process.env.EVENT_SHA, eventRef: process.env.EVENT_REF,
    backendInput: process.env.INPUT_BACKEND_SHA, uiInput: process.env.INPUT_UI_SHA,
    recorded: fs.readFileSync(process.argv[2], 'utf8'), api
  });
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `backend=${revisions.backend}\nui=${revisions.ui}\n`);
}
