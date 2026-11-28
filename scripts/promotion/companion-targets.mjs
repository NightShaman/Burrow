import { isDeepStrictEqual } from 'node:util';

export const COMPANION_TARGETS = {
  burrowAuditor: { repository: 'Burrow-Auditor', id: 'burrow-auditor', name: 'Auditor' },
  burrowPlug: { repository: 'Burrow-Plug', id: 'burrow-plug', name: 'Plug-ins' }
};

export function hasCompanionSources(sources) {
  const keys = Object.keys(COMPANION_TARGETS);
  const included = keys.filter(key => Object.hasOwn(sources, key));
  if (included.length && included.length !== keys.length) throw new Error('promotion_companion_sources_incomplete');
  return included.length > 0;
}

export function restoredCompanions(plan) {
  const included = hasCompanionSources(plan.sources);
  for (const [key, { repository }] of Object.entries(COMPANION_TARGETS)) {
    const targets = plan.targets.filter(target => target.id === key);
    if (!included && targets.length === 0) continue;
    if (!included || targets.length !== 1 || targets[0].repository !== `GoblinKing-Burrow/${repository}`
      || !['stage', 'resume'].includes(targets[0].action)
      || !['burrowBackend', 'burrowUi'].every(source => Object.hasOwn(plan.sources, source))
      || !isDeepStrictEqual(targets[0].sources, Object.fromEntries(
        [key, 'burrowBackend', 'burrowUi'].map(source => [source, plan.sources[source]])))
      || targets[0].version !== plan.releaseDate) {
      throw new Error(`promotion_companion_plan_mismatch:${key}`);
    }
  }
  return included;
}
