// Test-only module exercised through the real dynamic-import boundary.
export const settingsSections = [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }];
export function mountSettings(context: unknown) {
  return (globalThis as typeof globalThis & { __modSettingsTestMount: (value: unknown) => unknown }).__modSettingsTestMount(context);
}
