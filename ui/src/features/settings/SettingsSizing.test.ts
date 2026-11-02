import { expect, it } from 'vitest';
import sizingSource from './settingsSizing.css?raw';
import normalizedSource from './normalizedWorkspace.css?raw';
import personalizationSource from './personalizationWorkspace.css?raw';
import modelsSource from './modelsWorkspace.css?raw';
import retentionSource from './retention.css?raw';

// Source contracts ignore formatter-only whitespace and CSS quote changes.
const canonicalCss = (source: string) =>
  source.replace(/'/g, '"').replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
const [sizing, normalized, personalization, models, retention] = [
  sizingSource,
  normalizedSource,
  personalizationSource,
  modelsSource,
  retentionSource,
].map(canonicalCss);

it('allocates single forms the paired left track at the shared container breakpoint', () => {
  const desktop = normalized.slice(
    normalized.indexOf('@container settings-workspace (min-width: 640px)'),
  );
  const rule = desktop.slice(
    desktop.indexOf('[data-composition="single"]'),
    desktop.indexOf('.settings-family-documents'),
  );
  expect(rule).toContain('grid-column: 1;');
  expect(rule).not.toContain('grid-column: 1 / -1');
  expect(rule).toContain('[data-settings-layout="form"]');
  expect(rule).toContain('[data-settings-layout="activity"]');
  expect(rule).toContain('padding-right: var(--settings-pane-inset, 16px)');
  expect(normalized.slice(0, normalized.indexOf('@container'))).toContain('grid-column: 1 / -1');
  expect(retention).toContain('.settings-fidgit .retention-actions { flex-wrap: wrap; }');
});

it('keeps active form sizing pane-owned rather than page-specific hard caps', () => {
  const sheets = [sizing, normalized, personalization, models];
  for (const sheet of sheets) {
    for (const [, selector, declarations] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (
        !/\.setting-section|\.settings-form|\.settings-personalization-|\.model-capability-editor/.test(
          selector,
        )
      )
        continue;
      // Controls may have a declared quantity width; whole form surfaces may not.
      if (/\binput\b|\bbutton\b|\bselect\b|\btextarea\b/.test(selector)) continue;
      expect(declarations, selector.trim()).not.toMatch(/max-width\s*:\s*\d+(?:px|rem|ch|vw)/);
    }
  }
  expect(personalization).toContain('max-width: none');
  expect(normalized).not.toContain('max-width: 1100px');
});

it('defines shared spacing and semantic quantity/unit tokens without styling imperative internals', () => {
  for (const [token, value] of Object.entries({
    'pane-gap': '20px',
    'pane-inset': '16px',
    'workspace-inset': '16px',
    'section-gap': '24px',
    'field-pair-gap': '12px',
    'control-gap': '8px',
    'quantity-width': '220px',
    'unit-width': '88px',
  })) {
    expect(sizing).toContain(`--settings-${token}: ${value};`);
  }
  expect(sizing).toContain('.mod-settings-mount:not([data-settings-layout="imperative"])');
  expect(sizing).toContain('.field:not(.settings-quantity-field) >');
  for (const type of ['checkbox', 'radio', 'file', 'hidden'])
    expect(sizing).toContain(`:not([type="${type}"])`);
  expect(sizing).toContain('box-sizing: border-box');
  expect(sizing).toContain('max-width: var(--settings-quantity-width)');
});

it('uses shared outer insets and separator spacing without changing collection row density', () => {
  expect(sizing).toContain('padding: var(--settings-workspace-inset)');
  expect(sizing).toContain('--settings-workspace-inset: 12px');
  expect(sizing).toContain('--settings-workspace-inset: 8px');
  expect(normalized).toContain('padding-right: var(--settings-pane-inset, 16px)');
});

it('keeps field-pair policy stronger than inventory variants and removes vacant name action tracks', () => {
  expect(sizing).toContain(
    '.settings-blank-slate.settings-fidgit .settings-content-workspace:is(.settings-content-standard, .settings-content-models) :is(.field-pair, .settings-field-pair)',
  );
  expect(sizing).toMatch(
    /\.operator-profile-actions:has\(> \.field:only-child\)\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/,
  );
});

it('opts action buttons into compact sizing without shrinking selection tiles', () => {
  expect(sizing).toMatch(
    /\.settings-content-standard \.settings-action\s*\{\s*width: auto;\s*max-width: 100%;\s*justify-self: end;/,
  );
});
