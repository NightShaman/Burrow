import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { discoverPublication } from './discover-publication.mjs';
import { createPromotionPlan } from './plan.mjs';

const config = JSON.parse(await readFile(new URL('./targets.json', import.meta.url), 'utf8'));
const sources = Object.fromEntries(['burrow', 'burrowBackend', 'burrowUi', 'nodeGoblin', 'goblinSecretStore', 'burrowSkills', 'burrowBackdoor', 'burrowTutor', 'burrowTheater', 'burrowSwitchboard', 'burrowAuditor', 'burrowPlug'].map((key, i) => [key, i.toString(16).repeat(40)]));
const manifest = (date, run, pins = sources) => ({ schemaVersion: 1, releaseDate: date, promotionRunId: run, sources: pins });
const old = manifest('2026.11.27', '100');
const pending = manifest('2026.11.28', '200');
const repositories = Object.values(config.targets).map(target => target.repository);
const publicationOrder = [...repositories.filter(repo => repo !== 'Burrow'), 'Burrow'];
function readFixture(snapshots, complete = [old.releaseDate]) {
  return async url => {
    const match = url.match(/\/([^/]+)\/main\/PUBLIC_RELEASE.json$/);
    if (match) return snapshots[match[1]] || null;
    const version = url.split('/releases/tags/v')[1];
    assert.ok(version, url);
    return complete.includes(version) ? { tag_name: `v${version}`, draft: false, prerelease: false } : null;
  };
}

test('every partial publication prefix restores original artifact/date/pins on same and later UTC dates', async () => {
  for (let count = 1; count <= publicationOrder.length; count++) {
    const snapshots = Object.fromEntries(repositories.map(repo => [repo, old]));
    for (const repo of publicationOrder.slice(0, count)) snapshots[repo] = pending;
    const discovery = await discoverPublication({ config, readJson: readFixture(snapshots) });
    assert.equal(discovery.terminalComplete, false);
    for (const now of ['2026-11-28T06:30:00Z', '2026-11-29T05:30:00Z']) {
      const plan = createPromotionPlan({ config, sources: { ...sources, burrow: 'f'.repeat(40) }, ...discovery, now: new Date(now) });
      assert.equal(plan.resumeRunId, '200');
      assert.equal(plan.releaseDate, pending.releaseDate);
      assert.deepEqual(plan.sources, pending.sources);
      assert.ok(plan.targets.every(target => target.action === 'resume'));
    }
  }
});

test('first ever component push is sufficient even with no terminal Burrow snapshot', async () => {
  const discovery = await discoverPublication({ config, readJson: readFixture({ 'Node-Goblin': pending }, []) });
  assert.deepEqual(discovery, { previous: pending, terminalComplete: false });
});

test('legacy eight-target partial artifact retains its original scope with missing new repositories', async () => {
  const { burrowAuditor, burrowPlug, ...legacy } = sources;
  const legacyPending = manifest('2026.11.28', '200', legacy);
  const discovery = await discoverPublication({ config, readJson: readFixture({ Burrow: old, 'Node-Goblin': legacyPending }) });
  const plan = createPromotionPlan({ config, sources, ...discovery });
  assert.equal(plan.resumeRunId, '200');
  assert.equal(plan.targets.length, 8);
  assert.deepEqual(plan.sources, legacy);
});

test('completed terminal publication selects newest manifest and preserves once-per-day deferral', async () => {
  const discovery = await discoverPublication({ config, readJson: readFixture({ Burrow: pending, 'Node-Goblin': old }, [old.releaseDate, pending.releaseDate]) });
  assert.deepEqual(discovery, { previous: pending, terminalComplete: true });
  const plan = createPromotionPlan({ config, sources: { ...sources, burrow: 'f'.repeat(40) }, ...discovery, now: new Date('2026-11-28T06:30:00Z') });
  assert.equal(plan.publishable, false);
  assert.ok(plan.targets.every(target => target.action === 'defer-next-utc-day'));
});

test('missing snapshots do not manufacture previous publication', async () => {
  assert.deepEqual(await discoverPublication({ config, readJson: readFixture({}) }), { previous: null, terminalComplete: true });
});

test('conflicting run identities or pins for one date fail closed', async () => {
  for (const conflict of [{ ...pending, promotionRunId: '201' }, { ...pending, sources: { ...sources, burrow: 'f'.repeat(40) } }]) {
    await assert.rejects(discoverPublication({ config, readJson: readFixture({ Burrow: pending, 'Node-Goblin': conflict }) }), /promotion_manifest_conflict/);
  }
});

test('multiple unfinished dates and missing artifact origins fail closed', async () => {
  await assert.rejects(discoverPublication({ config, readJson: readFixture({ Burrow: old, 'Node-Goblin': pending }, []) }), /promotion_multiple_pending_publications/);
  await assert.rejects(discoverPublication({ config, readJson: readFixture({ 'Node-Goblin': { ...pending, promotionRunId: null } }) }), /promotion_resume_artifact_origin_required/);
});

test('malformed manifests, terminal evidence and network/API failures fail closed', async () => {
  await assert.rejects(discoverPublication({ config, readJson: readFixture({ Burrow: { ...old, sources: { burrow: 'main' } } }) }), /promotion_manifest_invalid/);
  for (const terminal of [{ tag_name: 'vwrong' }, { tag_name: `v${old.releaseDate}`, draft: true }, { tag_name: `v${old.releaseDate}`, prerelease: true }]) {
    await assert.rejects(discoverPublication({ config, readJson: async url => url.includes('/main/') ? old : terminal }), /promotion_terminal_release_invalid/);
  }
  await assert.rejects(discoverPublication({ config, readJson: async () => { throw new Error('HTTP 503'); } }), /HTTP 503/);
  await assert.rejects(discoverPublication({ config, readJson: async url => { if (url.includes('/main/')) return old; throw new Error('HTTP 403'); } }), /HTTP 403/);
});
