import normalizedCss from './normalizedWorkspace.css?raw';
import postcss from 'postcss';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { ModSettingsHost } from './ModSettingsHost';
const { createSettingsContribution, mountSettings } = vi.hoisted(() => ({
  createSettingsContribution: vi.fn(),
  mountSettings: vi.fn(),
}));
vi.mock('./ModSettingsHostFixture', () => ({
  createSettingsContribution,
  mountSettings,
  settingsContribution: undefined,
  settingsSections: [
    { id: 'main', label: 'Main', layout: 'form-inventory' },
    { id: 'overview', label: 'Overview', layout: 'form' },
    { id: 'documents', label: 'Documents', layout: 'document' },
    { id: 'advanced', label: 'Advanced', layout: 'form-inventory' },
    { id: 'legacy', label: 'Legacy', layout: 'unsupported' },
  ],
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it.each(['form', 'activity', 'form-inventory', 'list-detail'])(
  'advertises the validated %s layout without replacing portal targets',
  async (layout) => {
    createSettingsContribution.mockResolvedValue({
      sections: [
        {
          id: 'main',
          label: 'Main',
          layout,
          fields: [{ id: 'name', label: 'Name', value: 'Example' }],
          items: [{ id: 'one', label: 'Item one' }],
        },
        {
          id: 'other',
          label: 'Other',
          layout: 'form',
          fields: [{ id: 'other', label: 'Other field' }],
        },
      ],
    });
    const navigation = document.createElement('div');
    const overflow = document.createElement('div');
    document.body.append(navigation, overflow);
    try {
      const { container } = render(
        <ConfirmProvider>
          <ModSettingsHost
            modId="fixture"
            settingsUrl="./ModSettingsHostFixture"
            agents={[]}
            onAgentsChanged={async () => {}}
            navigationTarget={navigation}
            overflowTarget={overflow}
          />
        </ConfirmProvider>,
      );
      await waitFor(() =>
        expect(
          container.querySelector('.mod-settings-mount')?.getAttribute('data-settings-layout'),
        ).toBe(layout),
      );
      const host = container.querySelector('.mod-settings-mount');
      expect(mountSettings).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Other' }));
      await screen.findByLabelText('Other field');
      expect(container.querySelector('.mod-settings-mount')).toBe(host);
      expect(host?.getAttribute('data-settings-layout')).toBe('form');
      expect(overflow.isConnected).toBe(true);
    } finally {
      navigation.remove();
      overflow.remove();
    }
  },
);
it('honors explicit imperative inventory metadata without rendering empty declarative content', async () => {
  createSettingsContribution.mockResolvedValue({
    sections: [{ id: 'main', label: 'Main', layout: 'form', fields: [] }],
  });
  const { container } = render(
    <ConfirmProvider>
      <ModSettingsHost
        modId="fixture"
        settingsUrl="./ModSettingsHostFixture"
        agents={[]}
        onAgentsChanged={async () => {}}
        navigationTarget={null}
        overflowTarget={null}
      />
    </ConfirmProvider>,
  );
  await waitFor(() => expect(mountSettings).toHaveBeenCalled());
  expect(container.querySelector('.mod-settings-mount')?.getAttribute('data-settings-layout')).toBe(
    'form-inventory',
  );
});

it('switches mixed imperative and declarative sections without competing DOM ownership', async () => {
  createSettingsContribution.mockResolvedValue({
    sections: [
      { id: 'overview', label: 'Overview', layout: 'form', fields: [] },
      { id: 'advanced', label: 'Advanced', layout: 'form', fields: [] },
      { id: 'legacy', label: 'Legacy', layout: 'form', fields: [] },
      {
        id: 'form',
        label: 'Declarative form',
        layout: 'form',
        fields: [{ id: 'name', label: 'Declared name', value: 'Kept' }],
      },
      {
        id: 'inventory',
        label: 'Declarative inventory',
        layout: 'form-inventory',
        items: [
          {
            id: 'one',
            label: 'Declared item',
            fields: [{ id: 'value', label: 'Item value', value: 'Kept' }],
          },
        ],
      },
    ],
  });
  const disposed = vi.fn();
  mountSettings.mockImplementation(
    ({
      section,
      primary,
      overflow,
    }: {
      section: string;
      primary: { replace: (node: Node) => void };
      overflow: { replace: (node: Node) => void } | null;
    }) => {
      const heading = document.createElement('h2');
      heading.textContent = `Imperative ${section}`;
      primary.replace(heading);
      const detail = document.createElement('p');
      detail.textContent = `Support ${section}`;
      overflow?.replace(detail);
      return () => disposed(section);
    },
  );
  const navigation = document.createElement('div');
  const overflow = document.createElement('div');
  document.body.append(navigation, overflow);
  try {
    const { container, unmount } = render(
      <ConfirmProvider>
        <ModSettingsHost
          modId="fixture"
          settingsUrl="./ModSettingsHostFixture"
          agents={[]}
          onAgentsChanged={async () => {}}
          navigationTarget={navigation}
          overflowTarget={overflow}
        />
      </ConfirmProvider>,
    );
    await screen.findByRole('heading', { name: 'Imperative overview' });
    const host = container.querySelector('.mod-settings-mount');
    for (const label of [
      'Advanced',
      'Legacy',
      'Declarative form',
      'Overview',
      'Declarative inventory',
      'Advanced',
    ]) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      if (label === 'Declarative form') await screen.findByLabelText('Declared name');
      else if (label === 'Declarative inventory')
        await screen.findByRole('button', { name: 'Declared item' });
      else
        await screen.findByRole('heading', {
          name: `Imperative ${label.toLowerCase()}`,
        });
      expect(container.querySelector('.mod-settings-mount')).toBe(host);
      expect(host?.getAttribute('data-settings-layout')).toBe(
        label === 'Legacy'
          ? 'imperative'
          : label === 'Advanced' || label === 'Declarative inventory'
            ? 'form-inventory'
            : 'form',
      );
      expect(overflow.isConnected).toBe(true);
    }
    expect(mountSettings.mock.calls.map(([context]) => context.section)).toEqual([
      'overview',
      'advanced',
      'legacy',
      'overview',
      'advanced',
    ]);
    unmount();
    expect(disposed.mock.calls.map(([section]) => section)).toEqual([
      'overview',
      'advanced',
      'legacy',
      'overview',
      'advanced',
    ]);
  } finally {
    navigation.remove();
    overflow.remove();
  }
});

it('validates imperative document layout and keeps both portal targets across section changes', async () => {
  createSettingsContribution.mockResolvedValue(undefined);
  const navigation = document.createElement('div');
  const overflow = document.createElement('div');
  document.body.append(navigation, overflow);
  const mounted = vi.fn();
  mountSettings.mockImplementation((context) => {
    mounted(context.section, context.primary, context.overflow);
    return () => {};
  });
  try {
    const { container } = render(
      <ConfirmProvider>
        <ModSettingsHost
          modId="fixture"
          settingsUrl="./ModSettingsHostFixture"
          agents={[]}
          onAgentsChanged={async () => {}}
          navigationTarget={navigation}
          overflowTarget={overflow}
        />
      </ConfirmProvider>,
    );
    await screen.findByRole('button', { name: 'Documents' });
    const host = container.querySelector('.mod-settings-mount');
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    await waitFor(() => expect(host?.getAttribute('data-settings-layout')).toBe('document'));
    await waitFor(() => expect(mounted.mock.calls.at(-1)?.[0]).toBe('documents'));
    expect(container.querySelector('.mod-settings-mount')).toBe(host);
    expect(overflow.isConnected).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Legacy' }));
    await waitFor(() => expect(host?.getAttribute('data-settings-layout')).toBe('imperative'));
    expect(container.querySelector('.mod-settings-mount')).toBe(host);
  } finally {
    navigation.remove();
    overflow.remove();
  }
});

it('routes document metadata through shared narrow and wide pane rules', () => {
  const sheet = postcss.parse(normalizedCss);
  const rules: {
    selector: string;
    container: string;
    values: Record<string, string>;
  }[] = [];
  sheet.walkRules((rule) => {
    const values: Record<string, string> = {};
    rule.walkDecls((declaration) => {
      values[declaration.prop] = declaration.value;
    });
    rules.push({
      selector: rule.selector,
      container: rule.parent?.type === 'atrule' ? rule.parent.params : '',
      values,
    });
  });
  const documentRules = rules.filter((rule) =>
    rule.selector.includes("[data-settings-layout='document']"),
  );
  expect(
    documentRules.some(
      (rule) =>
        !rule.container &&
        rule.values['grid-template-columns'] === 'clamp(240px, 24%, 320px) minmax(0, 1fr)',
    ),
  ).toBe(true);
  expect(
    documentRules.some(
      (rule) =>
        !rule.container &&
        rule.values['grid-template-rows'] === 'minmax(0, min(220px, 35%)) minmax(0, 1fr)',
    ),
  ).toBe(true);
  expect(
    documentRules.some(
      (rule) =>
        rule.container === 'settings-workspace (min-width: 640px)' &&
        rule.values['grid-row'] === '1 / -1',
    ),
  ).toBe(true);
  expect(
    documentRules.some(
      (rule) =>
        rule.selector.endsWith('.profile-document-selector') &&
        !rule.container &&
        rule.values.display === 'flex',
    ),
  ).toBe(true);
  expect(
    documentRules.some(
      (rule) =>
        rule.selector.endsWith('.profile-document-selector') &&
        rule.container &&
        rule.values.display === 'grid',
    ),
  ).toBe(true);
  expect(documentRules.some((rule) => rule.values.display === 'none')).toBe(false);
});

it('keeps the selector DOM across sections while rejecting retired updates and callbacks', async () => {
  const contexts: any[] = [];
  mountSettings.mockImplementation((ctx) => {
    contexts.push(ctx);
  });
  const navigation = document.createElement('div'),
    overflow = document.createElement('div'),
    selector = document.createElement('div');
  document.body.append(navigation, overflow, selector);
  const onSelect = vi.fn(),
    visible = vi.fn();
  const view = render(
    <ConfirmProvider>
      <ModSettingsHost
        modId="fixture"
        settingsUrl="./ModSettingsHostFixture"
        agents={[]}
        onAgentsChanged={async () => {}}
        navigationTarget={navigation}
        overflowTarget={overflow}
        selectorTarget={selector}
        onSelectorVisibilityChange={visible}
      />
    </ConfirmProvider>,
  );
  await waitFor(() => expect(contexts).toHaveLength(1));
  const current = contexts[0];
  current.setEntitySelector({
    label: 'Residents',
    items: [{ id: 'a', label: 'Gerald' }],
    selectedId: '',
    onSelect,
  });
  await screen.findByRole('button', { name: 'Gerald' });
  const bar = selector.querySelector('.agent-toolbar-agent-list')!;
  const resident = screen.getByRole('button', { name: 'Gerald' });
  bar.scrollLeft = 83;
  resident.focus();
  await waitFor(() => expect(visible).toHaveBeenLastCalledWith(true));
  visible.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
  await waitFor(() => expect(contexts).toHaveLength(2));
  expect(selector.querySelector('.agent-toolbar-agent-list')).toBe(bar);
  expect(bar.scrollLeft).toBe(83);
  expect(document.activeElement).toBe(resident);
  expect(visible).not.toHaveBeenCalled();
  fireEvent.click(resident);
  expect(onSelect).not.toHaveBeenCalled();
  current.setEntitySelector({
    label: 'Old',
    items: [{ id: 'z', label: 'Stale' }],
    selectedId: 'z',
    onSelect,
  });
  expect(screen.queryByRole('button', { name: 'Stale' })).toBeNull();
  const nextSelect = vi.fn();
  contexts[1].setEntitySelector({
    label: 'Residents',
    items: [{ id: 'a', label: 'Gerald' }],
    selectedId: '',
    onSelect: nextSelect,
  });
  await waitFor(() => expect(resident.getAttribute('aria-pressed')).toBe('false'));
  expect(selector.querySelector('.agent-toolbar-agent-list')).toBe(bar);
  fireEvent.click(resident);
  expect(nextSelect).toHaveBeenCalledWith('a');
  expect(onSelect).not.toHaveBeenCalled();
  contexts[1].setEntitySelector(null);
  await waitFor(() => expect(selector.childElementCount).toBe(0));
  view.unmount();
  expect(selector.childElementCount).toBe(0);
  navigation.remove();
  overflow.remove();
  selector.remove();
});

it.each(['mod', 'url', 'resource', 'declarative', 'failure'])(
  'clears a retained selector on %s changes',
  async (change) => {
    const contexts: any[] = [];
    mountSettings.mockImplementation((ctx) => {
      contexts.push(ctx);
    });
    const navigation = document.createElement('div');
    document.body.append(navigation);
    const props = {
      modId: 'fixture',
      settingsUrl: './ModSettingsHostFixture',
      agents: [],
      onAgentsChanged: async () => {},
      navigationTarget: navigation,
      overflowTarget: null,
    };
    const makeUi = (overrides = {}) => (
      <ConfirmProvider>
        <ModSettingsHost {...props} {...overrides} />
      </ConfirmProvider>
    );
    const view = render(makeUi());
    await waitFor(() => expect(contexts).toHaveLength(1));
    contexts[0].setEntitySelector({
      label: 'Residents',
      items: [{ id: 'a', label: 'Gerald' }],
      selectedId: '',
      onSelect: vi.fn(),
    });
    await screen.findByRole('button', { name: 'Gerald' });
    if (change === 'mod') view.rerender(makeUi({ modId: 'other' }));
    if (change === 'url') view.rerender(makeUi({ settingsUrl: './ModSettingsImperativeFixture' }));
    if (change === 'resource') view.rerender(makeUi({ selectedAgentId: 'other' }));
    if (change === 'declarative') {
      createSettingsContribution.mockResolvedValue({
        sections: [
          {
            id: 'main',
            label: 'Main',
            layout: 'form',
            fields: [{ id: 'name', label: 'Name', value: 'Example' }],
          },
        ],
      });
      view.rerender(makeUi({ modId: 'other' }));
      await screen.findByLabelText('Name');
    }
    if (change === 'failure') {
      mountSettings.mockRejectedValueOnce(new Error('Synthetic mount failure'));
      fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
      await screen.findByRole('alert');
    }
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Gerald' })).toBeNull());
    view.unmount();
    navigation.remove();
  },
);
