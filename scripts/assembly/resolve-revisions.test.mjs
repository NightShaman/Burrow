import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveRevisions, recordedPins } from './resolve-revisions.mjs';

const old = 'a'.repeat(40), newer = 'b'.repeat(40), newest = 'c'.repeat(40);
const metadata = `Burrow-Build-Version 2026.11.06.1\nBurrow-Backend ${old}\nBurrow-UI ${newer}\n`;
const source = 'NightShaman/Burrow-UI';
const run = async ({ recorded = metadata, eventSource = source, eventSha = newest, eventRef = 'main', eventName = 'repository_dispatch', backendInput = '', uiInput = '', statuses = {} } = {}) => {
  const calls = [];
  const result = await resolveRevisions({ recorded, eventSource, eventSha, eventRef, eventName, backendInput, uiInput, api: async (endpoint, field) => {
    calls.push(endpoint);
    if (field === 'sha') return endpoint.endsWith('/main') ? (endpoint.includes('Burrow-Backend') ? old : newer) : endpoint.split('/').at(-1);
    return statuses[endpoint] ?? 'ahead';
  } });
  return { result, calls };
};
test('canonical UI metadata is read exactly, never Burrow-Ui', () => {
  assert.deepEqual(recordedPins(metadata), { backend: old, ui: newer });
  for (const wrong of [metadata.replace('Burrow-UI', 'Burrow-Ui'), metadata.replace(`Burrow-UI ${newer}`, ''), metadata + `Burrow-UI ${old}\n`, metadata.replace(newer, 'invalid')]) {
    assert.throws(() => recordedPins(wrong), /required canonical Burrow-UI revision metadata/);
  }
});
test('forward UI dispatch compares recorded UI pin; identical dispatch omits compare', async () => {
  const forward = await run();
  assert.equal(forward.result.ui, newest);
  assert.deepEqual(forward.calls.filter(x => x.includes('/compare/')), [`repos/${source}/compare/${newer}...${newest}`]);
  assert.deepEqual((await run({ eventSha: newer })).calls.filter(x => x.includes('/compare/')), []);
});
test('delayed UI dispatch cannot roll back a newer recorded UI revision; diverged also fails', async () => {
  const comparison = `repos/${source}/compare/${newer}...${old}`;
  for (const status of ['behind', 'diverged', 'identical']) {
    await assert.rejects(run({ eventSha: old, statuses: { [comparison]: status } }), /Refusing non-forward ui pin/);
  }
});
test('canonical dispatch identity and SHA required; casing variations cannot fall through to moving main', async () => {
  for (const eventSource of ['NightShaman/Burrow-Ui', 'nightshaman/Burrow-UI', 'NightShaman/Unknown', '']) {
    await assert.rejects(run({ eventSource }), /canonical source_repository/);
  }
  await assert.rejects(run({ eventSha: '' }), /immutable source_sha/);
  await assert.rejects(run({ eventRef: 'feature' }), /source_ref=main/);
  assert.equal((await run({ eventName: 'workflow_dispatch', uiInput: newest })).result.ui, newest);
});
test('live workflow invokes the tested resolver before component CI or publication', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/assemble.yml', import.meta.url), 'utf8');
  const resolver = workflow.indexOf('run: node assembled/scripts/assembly/resolve-revisions.mjs assembled/SOURCE_VERSIONS');
  const gate = workflow.indexOf('- name: Require trusted component CI');
  const publish = workflow.indexOf('- name: Publish tested development image');
  assert.ok(resolver > 0 && resolver < gate && gate < publish);
  assert.match(workflow, /EVENT_NAME: \$\{\{ github.event_name \}\}/);
});
