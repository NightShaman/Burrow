import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { UnsavedChangesProvider } from '../../app/UnsavedChanges';
import type { Agent } from '../../app/types';
import { ModSettingsHost } from './ModSettingsHost';

const targets: HTMLElement[] = [];
afterEach(() => {
  cleanup();
  targets.splice(0).forEach((node) => node.remove());
  vi.unstubAllGlobals();
});
const initial = {
  grants: ['mod-management-v1', 'future-capability'],
  diagnosticAgentIds: ['agent-1'],
  modManagementAgentIds: ['agent-2'],
  coreApiAgentIds: ['agent-3'],
  declaredCapabilities: ['mod-management-v1', 'core-api-v1'],
  restartRequired: false,
};
const response = (body = initial, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
function mountHost(fetcher = vi.fn(async () => response())) {
  vi.stubGlobal('fetch', fetcher);
  const navigation = document.createElement('nav');
  const overflow = document.createElement('section');
  document.body.append(navigation, overflow);
  targets.push(navigation, overflow);
  const view = render(
    <ConfirmProvider>
      <UnsavedChangesProvider>
        <ModSettingsHost
          modId="burrow-backdoor"
          settingsUrl="../../../scripts/backdoor-settings-fixture/settings.js"
          agents={
            Array.from({ length: 17 }, (_, i) => ({
              id: `agent-${i + 1}`,
              name: `Agent ${i + 1}`,
            })) as Agent[]
          }
          onAgentsChanged={async () => {}}
          navigationTarget={navigation}
          overflowTarget={overflow}
        />
      </UnsavedChangesProvider>
    </ConfirmProvider>,
  );
  return { ...view, navigation, overflow, fetcher };
}

it('loads actual Backdoor through the host and keeps imperative form metadata and targets', async () => {
  const { container, navigation, overflow } = mountHost();
  await screen.findByRole('checkbox', { name: 'Agent 17' });
  const host = container.querySelector('.mod-settings-mount');
  expect(host?.getAttribute('data-settings-layout')).toBe('form');
  expect(host?.querySelector('.mod-settings-surface > form.setting-section')).not.toBeNull();
  expect(overflow.querySelector('.mod-settings-surface')).not.toBeNull();
  expect(overflow.textContent).toBe('');
  expect(screen.getAllByRole('checkbox')).toHaveLength(17);
  expect(screen.queryByRole('combobox')).toBeNull();
  for (const section of ['Admin Access', 'Core API Access', 'Global Access', 'Admin Access']) {
    fireEvent.click(within(navigation).getByRole('button', { name: section }));
    await screen.findByRole('button', {
      name:
        section === 'Admin Access'
          ? 'Save admin access'
          : section === 'Core API Access'
            ? 'Save Core API access'
            : 'Save global access',
    });
    await screen.findAllByRole('checkbox', { name: 'Agent 17' });
    expect(container.querySelector('.mod-settings-mount')).toBe(host);
    expect(host?.getAttribute('data-settings-layout')).toBe('form');
    expect(overflow.isConnected).toBe(true);
  }
});

it('guards actual Backdoor subsection changes with Stay, failed Save, and Discard', async () => {
  const fetcher = vi.fn(async (_url?: unknown, init?: RequestInit) =>
    init?.method === 'PUT' ? response(initial, 503) : response(),
  );
  mountHost(fetcher);
  const checkbox = await screen.findByRole('checkbox', { name: 'Agent 17' });
  fireEvent.click(checkbox);
  click('Admin Access');
  click('Stay');
  expect(checkbox).toHaveProperty('checked', true);
  click('Admin Access');
  click('Save');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(screen.getByRole('alert').textContent).toContain('Could not save agent access');
  expect(checkbox).toHaveProperty('checked', true);
  expect(screen.getByRole('button', { name: 'Save global access' })).toBeTruthy();
  click('Admin Access');
  click('Discard');
  await screen.findByRole('button', { name: 'Save admin access' });
  click('Global Access');
  expect(await screen.findByRole('checkbox', { name: 'Agent 17' })).toHaveProperty(
    'checked',
    false,
  );
});

it('blocks navigation while actual Backdoor saves and ignores completion after unmount', async () => {
  let resolve!: (value: Response) => void;
  let signal: AbortSignal | null | undefined;
  const fetcher = vi.fn(async (_url?: unknown, init?: RequestInit) => {
    if (init?.method !== 'PUT') return response();
    signal = init.signal;
    return new Promise<Response>((done) => {
      resolve = done;
    });
  });
  const { unmount, overflow } = mountHost(fetcher);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Agent 17' }));
  click('Save global access');
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  click('Admin Access');
  expect(screen.queryByRole('button', { name: 'Save admin access' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true);
  const before = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(before);
  expect(before.defaultPrevented).toBe(true);
  unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(response()));
  expect(overflow.childElementCount).toBe(0);
  expect(screen.queryByRole('checkbox')).toBeNull();
  const after = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});

it('commits actual Backdoor through guard Save before navigating and preserves other access scopes', async () => {
  let accepted = structuredClone(initial);
  const fetcher = vi.fn(async (_url?: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') accepted = { ...accepted, ...JSON.parse(String(init.body)) };
    return response(accepted);
  });
  mountHost(fetcher);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Agent 17' }));
  click('Admin Access');
  click('Save');
  await screen.findByRole('button', { name: 'Save admin access' });
  expect(accepted.diagnosticAgentIds).toEqual(['agent-1', 'agent-17']);
  expect(accepted.modManagementAgentIds).toEqual(initial.modManagementAgentIds);
  expect(accepted.coreApiAgentIds).toEqual(initial.coreApiAgentIds);
  expect(accepted.grants).toEqual(initial.grants);
  expect(
    fetcher.mock.calls.every(([url]) => url === '/api/operator/mods/burrow-backdoor/access'),
  ).toBe(true);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('guards separate Admin and Core API sections and saves the exact four-array contract', async () => {
  let accepted = structuredClone(initial);
  const payloads: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (_url?: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const payload = JSON.parse(String(init.body));
      payloads.push(payload);
      accepted = { ...accepted, ...payload };
    }
    return response(accepted);
  });
  mountHost(fetcher);
  await screen.findByRole('checkbox', { name: 'Agent 17' });
  click('Admin Access');
  const management = await screen.findByRole('group', {
    name: 'Agents with mod management access',
  });
  fireEvent.click(within(management).getByRole('checkbox', { name: 'Agent 17' }));
  click('Global Access');
  click('Stay');
  expect(within(management).getByRole('checkbox', { name: 'Agent 17' })).toHaveProperty(
    'checked',
    true,
  );
  click('Save admin access');
  await waitFor(() => expect(payloads).toHaveLength(1));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save admin access' })).toHaveProperty(
      'disabled',
      true,
    ),
  );
  expect(accepted.modManagementAgentIds).toEqual(['agent-2', 'agent-17']);
  expect(accepted.coreApiAgentIds).toEqual(['agent-3']);
  click('Core API Access');
  await screen.findByRole('group', { name: 'Agents with Core API access' });
  expect(screen.queryByRole('group', { name: 'Agents with mod management access' })).toBeNull();
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Agents with Core API access' })).getByRole(
      'checkbox',
      { name: 'Agent 17' },
    ),
  );
  click('Global Access');
  click('Save');
  await screen.findByRole('button', { name: 'Save global access' });
  expect(accepted.coreApiAgentIds).toEqual(['agent-3', 'agent-17']);
  expect(accepted.modManagementAgentIds).toEqual(['agent-2', 'agent-17']);
  expect(accepted.diagnosticAgentIds).toEqual(initial.diagnosticAgentIds);
  expect(accepted.grants).toEqual(initial.grants);
  for (const payload of payloads) {
    expect(Object.keys(payload).sort()).toEqual([
      'coreApiAgentIds',
      'diagnosticAgentIds',
      'grants',
      'modManagementAgentIds',
    ]);
  }
});

for (const [section, group, saveLabel] of [
  ['Admin Access', 'Agents with mod management access', 'Save admin access'],
  ['Core API Access', 'Agents with Core API access', 'Save Core API access'],
]) {
  it(`retains failed ${section} drafts and discards without writing other scopes`, async () => {
    const fetcher = vi.fn(async (_url?: unknown, init?: RequestInit) =>
      init?.method === 'PUT' ? response(initial, 503) : response(),
    );
    mountHost(fetcher);
    await screen.findByRole('checkbox', { name: 'Agent 17' });
    click(section);
    const agents = await screen.findByRole('group', { name: group });
    fireEvent.click(within(agents).getByRole('checkbox', { name: 'Agent 17' }));
    click('Global Access');
    click('Save');
    await screen.findByRole('alert');
    expect(within(agents).getByRole('checkbox', { name: 'Agent 17' })).toHaveProperty(
      'checked',
      true,
    );
    click('Global Access');
    click('Discard');
    await screen.findByRole('button', { name: 'Save global access' });
    click(section);
    const reset = await screen.findByRole('group', { name: group });
    expect(within(reset).getByRole('checkbox', { name: 'Agent 17' })).toHaveProperty(
      'checked',
      false,
    );
    expect(screen.getByRole('button', { name: saveLabel })).toHaveProperty('disabled', true);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });
}

it('uses the unchanged Global single-form layout for separate Admin and Core API sections', async () => {
  const { container, navigation } = mountHost();
  await screen.findByRole('checkbox', { name: 'Agent 17' });
  expect(
    within(navigation)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['Global Access', 'Admin Access', 'Core API Access']);
  for (const [section, ownGroup, absentGroup, save] of [
    [
      'Admin Access',
      'Agents with mod management access',
      'Agents with Core API access',
      'Save admin access',
    ],
    [
      'Core API Access',
      'Agents with Core API access',
      'Agents with mod management access',
      'Save Core API access',
    ],
  ]) {
    click(section);
    await screen.findByRole('group', { name: ownGroup });
    expect(screen.queryByRole('group', { name: absentGroup })).toBeNull();
    expect(container.querySelector('.settings-section-pair')).toBeNull();
    expect(
      container.querySelector('.mod-settings-mount')?.getAttribute('data-settings-layout'),
    ).toBe('form');
    expect(container.querySelectorAll('form')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: save })).toHaveLength(1);
  }
});
