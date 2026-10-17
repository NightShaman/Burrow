import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPromotionPlan, utcReleaseDate } from './plan.mjs';

const config = JSON.parse(await readFile(new URL('./targets.json', import.meta.url), 'utf8'));
const sha = character => character.repeat(40);
const sources = { burrowBackend:sha('a'), burrowUi:sha('b'), nodeGoblin:sha('c'), goblinSecretStore:sha('d'), burrowSkills:sha('e') };

test('assigns one plain UTC calendar version to every changed target', () => {
  const plan = createPromotionPlan({ config, sources, now:new Date('2026-10-18T01:02:03Z') });
  assert.equal(plan.releaseDate, '2026.10.18');
  assert.equal(plan.publishable, true);
  assert.deepEqual(plan.targets.map(target => target.version), Array(4).fill('2026.10.18'));
  assert(plan.targets.every(target => target.action === 'stage'));
});

test('skips unchanged targets independently', () => {
  const previous = { releaseDate:'2026.10.17', sources:{...sources, goblinSecretStore:sha('f')} };
  const plan = createPromotionPlan({ config, sources, previous, now:new Date('2026-10-18T12:00:00Z') });
  assert.equal(plan.targets.find(target => target.id === 'goblinSecretStore').action, 'stage');
  assert(plan.targets.filter(target => target.id !== 'goblinSecretStore').every(target => target.action === 'skip-unchanged'));
});

test('defers a second changed promotion on the same UTC date', () => {
  const previous = { releaseDate:'2026.10.18', sources:{...sources, nodeGoblin:sha('f')} };
  const plan = createPromotionPlan({ config, sources, previous, now:new Date('2026-10-18T23:59:59Z') });
  assert.equal(plan.targets.find(target => target.id === 'nodeGoblin').action, 'defer-next-utc-day');
  assert.equal(plan.targets.find(target => target.id === 'burrow').action, 'defer-next-utc-day');
  assert.equal(plan.publishable, false);
});

test('rejects mutable-looking or malformed source identities', () => {
  assert.throws(() => createPromotionPlan({ config, sources:{...sources, nodeGoblin:'main'} }), /source_sha_invalid/);
});

test('UTC boundary selects the calendar date', () => {
  assert.equal(utcReleaseDate(new Date('2026-10-18T00:00:00Z')), '2026.10.18');
});
