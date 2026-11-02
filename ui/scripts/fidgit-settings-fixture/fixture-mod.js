// Synthetic imperative extension exercising the production ModSettingsHost contract.
export const settingsSections = [
  { id: 'overview', label: 'Overview' },
  { id: 'advanced', label: 'Advanced' },
];
export function mountSettings(context) {
  const primary = document.createElement('section');
  primary.className = 'setting-section fixture-extension-editor';
  primary.innerHTML = `<h2>Fixture extension ${context.section}</h2><p class="settings-description">Inherited mod settings surface, synthetic data only.</p><label class="field">Extension label<input value="Synthetic extension" /></label><div class="model-actions"><button type="button" class="primary">Save extension</button></div>`;
  const overflow = document.createElement('section');
  overflow.className = 'settings-overflow-content';
  overflow.innerHTML =
    '<section class="setting-section"><h2>Extension context</h2><p>Secondary surface from the same inherited host contract.</p></section>';
  context.primary.replace(primary);
  context.overflow?.replace(overflow);
  return () => {
    primary.remove();
    overflow.remove();
  };
}
// Mixed module regression: empty metadata falls back to imperative, populated definitions render declaratively.
export function createSettingsContribution() {
  const items = Array.from({ length: 3 }, (_, i) => ({
    id: `fixture-item-${i + 1}`,
    label: `Synthetic item ${i + 1}`,
    description: `Synthetic extension record ${i + 1}`,
    meta: 'Local fixture only',
    detail: `Validated detail for synthetic item ${i + 1}.`,
    fields: [{ id: `item-${i + 1}-label`, label: 'Item label', value: `Synthetic value ${i + 1}` }],
    actions: [{ id: `item-${i + 1}-save`, label: 'Save item', tone: 'primary' }],
  }));
  return {
    sections: [
      { id: 'overview', label: 'Overview', layout: 'form' },
      { id: 'advanced', label: 'Advanced', layout: 'form' },
      {
        id: 'form',
        label: 'Form',
        layout: 'form',
        description: 'Declarative single form.',
        fields: [
          { id: 'extension-label', label: 'Extension label', value: 'Synthetic declarative form' },
        ],
        actions: [{ id: 'save-form', label: 'Save form', tone: 'primary' }],
      },
      {
        id: 'inventory',
        label: 'Inventory',
        layout: 'form-inventory',
        description: 'Inventory selection edits the selected record.',
        items,
      },
      {
        id: 'details',
        label: 'Details',
        layout: 'list-detail',
        description: 'Select a record to inspect its details.',
        items,
      },
      {
        id: 'activity',
        label: 'Activity',
        layout: 'activity',
        description: 'Read-only synthetic activity history.',
        items: items.map(({ id, label, description, meta }) => ({ id, label, description, meta })),
      },
    ],
  };
}
