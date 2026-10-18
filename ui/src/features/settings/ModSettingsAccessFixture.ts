import type { SettingsContributionContext } from './SettingsContribution';

let observedContext: SettingsContributionContext | null = null;

export function createSettingsContribution(context: SettingsContributionContext) {
  observedContext = context;
  return { sections: [{ id: 'access', label: 'Access', layout: 'form' as const }] };
}

export function getObservedContext() {
  return observedContext;
}

export function resetObservedContext() {
  observedContext = null;
}
