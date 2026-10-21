import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPromotionPlan, utcReleaseDate } from './plan.mjs';

const config = JSON.parse(await readFile(new URL('./targets.json', import.meta.url), 'utf8'));
const sha = character => character.repeat(40);
const sources = { burrow:sha('f'), burrowBackend:sha('a'), burrowUi:sha('b'), nodeGoblin:sha('c'), goblinSecretStore:sha('d'), burrowSkills:sha('e'), burrowBackdoor:sha('1'), burrowTutor:sha('2') };

test('assigns one atomic UTC calendar release to every target', () => {
  const plan = createPromotionPlan({ config, sources, now:new Date('2026-10-18T01:02:03Z') });
  assert.equal(plan.releaseDate, '2026.10.18');
  assert.equal(plan.publishable, true);
  assert.deepEqual(plan.targets.map(target => target.version), Array(6).fill('2026.10.18'));
  assert(plan.targets.every(target => target.action === 'stage'));
});

test('skips the coordinated release when every source is unchanged', () => {
  const previous = { releaseDate:'2026.10.17', sources };
  const plan = createPromotionPlan({ config, sources, previous, now:new Date('2026-10-18T12:00:00Z') });
  assert.equal(plan.publishable, false);
  assert(plan.targets.every(target => target.action === 'skip-unchanged'));
});

test('one changed source stages every repository under the same manifest', () => {
  const previous = { releaseDate:'2026.10.17', sources:{...sources, goblinSecretStore:sha('0')} };
  const plan = createPromotionPlan({ config, sources, previous, now:new Date('2026-10-18T12:00:00Z') });
  assert.equal(plan.publishable, true);
  assert(plan.targets.every(target => target.action === 'stage'));
});

test('defers any changed coordinated release after publication on the same UTC date', () => {
  const previous = { releaseDate:'2026.10.18', sources:{...sources, nodeGoblin:sha('0')} };
  const plan = createPromotionPlan({ config, sources, previous, now:new Date('2026-10-18T23:59:59Z') });
  assert.equal(plan.publishable, false);
  assert(plan.targets.every(target => target.action === 'defer-next-utc-day'));
});

test('rejects mutable-looking or malformed source identities', () => {
  assert.throws(() => createPromotionPlan({ config, sources:{...sources, nodeGoblin:'main'} }), /source_sha_invalid/);
});

test('UTC boundary selects the calendar date', () => {
  assert.equal(utcReleaseDate(new Date('2026-10-18T00:00:00Z')), '2026.10.18');
});
