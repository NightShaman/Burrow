// Test-only module loaded through the same dynamic import path as a mod.
export const settingsSections = [{ id: 'vault', label: 'Vault' }];
export function mountSettings() { return () => {}; }
