// Test-only module loaded through the same dynamic import path as a mod.
export const settingsSections = [{ id: 'vault', label: 'Vault' }];
export function mountSettings(context: { primary: { replace: (node: Node) => void } }) {
 const node = document.createElement('span'); node.textContent = 'Fixture mounted';
 context.primary.replace(node);
 return () => node.remove();
}
