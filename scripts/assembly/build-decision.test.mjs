import test from 'node:test';
import assert from 'node:assert/strict';
import { assemblyDecision } from './build-decision.mjs';
const backend = 'a'.repeat(40), ui = 'b'.repeat(40), inputs = 'c'.repeat(64);
const recorded = `Burrow-Backend ${backend}\nBurrow-UI ${ui}\nBurrow-Assembly-Inputs ${inputs}\n`;
const args = { eventName: 'repository_dispatch', recorded, backend, ui, inputs };
test('coalesced source events skip only identical pins and assembly inputs', () => {
  assert.equal(assemblyDecision(args), false);
  for (const change of [{ backend: 'd'.repeat(40) }, { ui: 'd'.repeat(40) }, { inputs: 'd'.repeat(64) }, { eventName: 'workflow_dispatch' }, { recorded: recorded.split('Burrow-Assembly-Inputs')[0] }]) {
    assert.equal(assemblyDecision({ ...args, ...change }), true);
  }
});

test('every expensive or publishing step is behind decision and fingerprint is persisted', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../../.github/workflows/assemble.yml', import.meta.url), 'utf8');
  const rest = workflow.slice(workflow.indexOf('      - name: Require trusted component CI'));
  const steps = rest.split(/(?=      - (?:name:|uses:))/).filter(part => part.trim());
  for (const step of steps) assert.match(step, /if: steps.decision.outputs.required == 'true'/);
  assert.match(workflow, /Burrow-Assembly-Inputs %s/);
  assert.match(workflow, /steps.decision.outputs.inputs/);
});
