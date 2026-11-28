import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { restoredCompanions } from './companion-targets.mjs';
import { createPromotionPlan, utcReleaseDate } from './plan.mjs';

const config = JSON.parse(await readFile(new URL('./targets.json', import.meta.url), 'utf8'));
const sha = character => character.repeat(40);
const sources = { burrow:sha('f'), burrowBackend:sha('a'), burrowUi:sha('b'), nodeGoblin:sha('c'), goblinSecretStore:sha('d'), burrowSkills:sha('e'), burrowBackdoor:sha('1'), burrowTutor:sha('2'), burrowTheater:sha('3'), burrowSwitchboard:sha('4'), burrowAuditor:sha('5'), burrowPlug:sha('6') };

test('assigns one atomic UTC calendar release to every target', () => {
  const plan = createPromotionPlan({ config, sources, now:new Date('2026-10-18T01:02:03Z') });
  assert.equal(plan.releaseDate, '2026.10.18');
  assert.equal(plan.publishable, true);
  assert.deepEqual(plan.targets.map(target => target.version), Array(10).fill('2026.10.18'));
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

test('missing terminal release resumes original date, SHAs and artifact even after sources advance', () => {
  for (const candidate of [sources, { ...sources, burrow: sha('0') }]) {
    const previous = { releaseDate: '2026.10.17', sources, promotionRunId: '12345' };
    const plan = createPromotionPlan({ config, sources: candidate, previous, terminalComplete: false, now: new Date('2026-10-19T12:00:00Z') });
    assert.equal(plan.publishable, true);
    assert.equal(plan.releaseDate, previous.releaseDate);
    assert.equal(plan.resumeRunId, '12345');
    assert.deepEqual(plan.sources, sources);
    assert(plan.targets.every(target => target.action === 'resume' && target.version === previous.releaseDate));
  }
});
test('incomplete legacy promotion fails closed without an artifact origin', () => {
  assert.throws(() => createPromotionPlan({ config, sources, previous: { releaseDate: '2026.10.17', sources }, terminalComplete: false }), /resume_artifact_origin_required/);
});

test('rollout defers on an already-published day and stages both mods the next day', () => {
  const { burrowAuditor, burrowPlug, ...previousSources } = sources;
  const previous = { releaseDate: '2026.10.17', sources: previousSources, promotionRunId: '42' };
  const sameDay = createPromotionPlan({ config, sources, previous, now: new Date('2026-10-17T22:00:00Z') });
  assert.equal(sameDay.publishable, false);
  const nextDay = createPromotionPlan({ config, sources, previous, now: new Date('2026-10-18T05:30:00Z') });
  assert.equal(nextDay.publishable, true);
  assert.equal(restoredCompanions(nextDay), true);
  for (const key of ['burrowAuditor', 'burrowPlug']) {
    const target = nextDay.targets.find(target => target.id === key);
    assert.deepEqual(target.sources, { [key]: sources[key], burrowBackend: sources.burrowBackend, burrowUi: sources.burrowUi });
  }
});

test('resume keeps the original target scope across the rollout', () => {
  const { burrowAuditor, burrowPlug, ...previousSources } = sources;
  const previous = { releaseDate: '2026.10.17', sources: previousSources, promotionRunId: '42' };
  const plan = createPromotionPlan({ config, sources, previous, terminalComplete: false, now: new Date('2026-10-19T05:30:00Z') });
  assert.equal(plan.resumeRunId, '42');
  assert.equal(plan.releaseDate, '2026.10.17');
  assert.deepEqual(plan.sources, previousSources);
  assert.equal(plan.targets.length, 8);
  assert.equal(restoredCompanions(plan), false);
});

test('restored promotion rejects incomplete or inconsistent companion targets', () => {
  const plan = createPromotionPlan({ config, sources });
  assert.throws(() => restoredCompanions({ ...plan, targets: plan.targets.filter(target => target.id !== 'burrowPlug') }), /promotion_companion_plan_mismatch:burrowPlug/);
  const { burrowPlug, ...partialSources } = sources;
  assert.throws(() => restoredCompanions({ ...plan, sources: partialSources }), /promotion_companion_sources_incomplete/);
});
