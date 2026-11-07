// Complements Chromium geometry: validate synthetic API shapes against real forms.
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Root } from 'react-dom/client';
let mountedRoot: Root | undefined;
afterEach(async () => {
  await act(async () => {
    mountedRoot?.unmount();
  });
  vi.unstubAllGlobals();
});

it('loads every built-in subsection against isolated realistic fixture data', async () => {
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL() {
        return 'blob:synthetic-reference';
      }
      static revokeObjectURL() {}
    },
  );
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    mountedRoot = (await import('./fixture')).fixtureRoot;
  });
  const click = async (label: string, selector: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(selector)].find(
      (e) => e.textContent?.trim() === label,
    );
    expect(button, `Missing ${label}`).toBeTruthy();
    await act(async () => {
      fireEvent.click(button!);
    });
  };
  await waitFor(() => expect(document.querySelector('.settings-blank-slate')).toBeTruthy());
  await click('Agents', '.settings-prototype-menu button');
  const setAgentCount = (window as unknown as { fixtureSetAgentCount: (count: number) => void })
    .fixtureSetAgentCount;
  for (const count of [1, 8, 9, 17]) {
    await act(async () => setAgentCount(count));
    const toolbar = document.querySelector('.agent-toolbar')!;
    expect(toolbar.querySelector('select'), `${count} agents must stay buttons`).toBeNull();
    expect(toolbar.querySelectorAll('[data-agent-id]')).toHaveLength(count);
    expect(within(toolbar as HTMLElement).getByRole('button', { name: 'New Agent' })).toBeTruthy();
    expect(within(toolbar as HTMLElement).getByRole('button', { name: 'Global' })).toBeTruthy();
  }
  expect(() => setAgentCount(0)).toThrow('Synthetic agent count');
  expect(() => setAgentCount(18)).toThrow('Synthetic agent count');
  const matrix: Record<string, string[]> = {
    General: ['Personalization', 'Trace retention', 'Continuity', 'Export', 'Rail panels'],
    Agents: [
      'Agent details',
      'Profile documents',
      'MCP tools',
      'Cron jobs',
      'Workflow events',
      'Dreams',
      'Skills',
    ],
    Skills: ['Installed skills', 'Import from repository', 'New text skill'],
    Connections: [
      'Authentication',
      'OpenTelemetry',
      'Models',
      'Load Balancing',
      'MCP servers',
      'API tokens',
    ],
    Mods: ['Installed mods', 'Mod sources', 'Automatic source checks'],
  };
  for (const [category, sections] of Object.entries(matrix)) {
    await click(category, '.settings-prototype-menu button');
    if (category === 'Connections')
      expect(
        [...document.querySelectorAll('.settings-prototype-section-items button')].some(
          (e) => e.textContent?.trim() === 'Browser origin',
        ),
      ).toBe(false);
    for (const section of sections) {
      await click(section, '.settings-prototype-section-items button');
      expect(
        [...document.querySelectorAll('.settings-request-error')]
          .map((e) => e.textContent)
          .filter(Boolean),
        `${category}/${section}`,
      ).toEqual([]);
      const singles = [
        'General/Trace retention',
        'Connections/Authentication',
        'Skills/Import from repository',
        'Skills/New text skill',
        'Agents/Skills',
        'Mods/Automatic source checks',
      ];
      if (singles.includes(category + '/' + section)) {
        const w = document.querySelector('.settings-content-normalized[data-composition="single"]');
        expect(w, category + '/' + section).toBeTruthy();
        expect(w?.querySelectorAll(':scope > .settings-blank-column')).toHaveLength(1);
        expect(w?.firstElementChild?.classList.contains('settings-prototype-configuration')).toBe(
          true,
        );
      }
      if (
        category === 'General' &&
        ['Personalization', 'Continuity', 'Export', 'Rail panels'].includes(section)
      )
        expect(
          document
            .querySelector('.settings-content-normalized[data-composition="paired"]')
            ?.querySelectorAll(':scope > .settings-blank-column'),
        ).toHaveLength(2);
      if (section === 'Export') expect(document.querySelectorAll('.export-option')).toHaveLength(8);
      if (section === 'Installed skills')
        expect(
          document.querySelectorAll('.memory-connection-list .memory-connection'),
        ).toHaveLength(8);
      if (section === 'Cron jobs' || section === 'Workflow events')
        expect(document.querySelectorAll('.schedule-card')).toHaveLength(12);
      if (section === 'OpenTelemetry')
        expect(document.querySelectorAll('.telemetry-inventory-item')).toHaveLength(3);
      if (section === 'Models') {
        await act(async () => {
          fireEvent.click(
            document.querySelector('.models-provider-inventory .provider-card-select')!,
          );
        });
        expect(document.querySelectorAll('.model-option')).toHaveLength(10);
        expect(
          document.querySelectorAll('.models-provider-inventory .provider-card-select'),
        ).toHaveLength(3);
        const editor = within(document.querySelector('.model-capability-editor') as HTMLElement);
        for (const name of ['Context window', 'Input', 'Output']) {
          const group = editor.getByRole('group', { name });
          expect(group.querySelector('legend')).toBeNull();
          expect(group.querySelector('.model-capability-title')?.textContent).toBe(name);
        }
        expect(editor.getByLabelText('Output token limit')).toBeTruthy();
      }
      if (section === 'Load Balancing')
        expect(document.querySelectorAll('.provider-card-select')).toHaveLength(6);
      if (section === 'API tokens')
        expect(document.querySelectorAll('.api-token-row')).toHaveLength(8);
      if (section === 'Installed mods')
        expect(
          document.querySelectorAll('.memory-connection-list .memory-connection'),
        ).toHaveLength(6);
      if (section === 'Mod sources') {
        expect(
          document.querySelectorAll('.memory-connection-list .memory-connection'),
        ).toHaveLength(4);
        const source = within(document.body).getByRole('button', { name: 'Edit Fixture Mod' });
        expect(source.textContent).not.toContain('https://');
        await act(async () => {
          fireEvent.click(source);
        });
        expect(source.getAttribute('aria-pressed')).toBe('true');
        expect(
          (within(document.body).getByLabelText('Git repository URL') as HTMLInputElement).value,
        ).toBe('https://example.invalid/synthetic-team/mod-source-1.git');
        await waitFor(() =>
          expect(document.querySelector('[aria-label="Browse stored credentials"]')).toBeTruthy(),
        );
        await act(async () => {
          fireEvent.click(document.querySelector('[aria-label="Browse stored credentials"]')!);
        });
        expect(document.querySelectorAll('#mod-source-credentials [role=option]')).toHaveLength(3);
        await act(async () => {
          fireEvent.click(document.querySelector('[aria-label="Browse stored credentials"]')!);
        });
      }
      if (section === 'Import from repository') {
        for (const [label, value] of [
          ['Repository', 'https://repository.invalid/synthetic.git'],
          ['Skill path', 'skills/review'],
        ]) {
          const input = [...document.querySelectorAll('label.field')]
            .find((e) => e.textContent?.trim() === label)
            ?.querySelector('input');
          expect(input).toBeTruthy();
          await act(async () => {
            fireEvent.change(input!, { target: { value } });
          });
        }
        await click('Preview skill', 'button.settings-action');
        await waitFor(() =>
          expect(
            document.querySelector('.skill-repository-preview button.settings-action')?.textContent,
          ).toBe('Install skill'),
        );
        await click('Installed skills', '.settings-prototype-section-items button');
        await waitFor(() =>
          expect(document.querySelector('[data-unsaved-changes-modal]')).toBeTruthy(),
        );
        await click('Discard', '[data-unsaved-changes-modal] button');
        await click('Import from repository', '.settings-prototype-section-items button');
      }
      if (section === 'Continuity') {
        await act(async () => {
          fireEvent.click(document.querySelector('input[name="curator-mode"]:not(:checked)')!);
        });
        expect(
          document.querySelector('input[placeholder="models/LFM2.5-2.6B-Q4_K_M.gguf"]'),
        ).toBeTruthy();
        expect(document.querySelector('.curator-card input[type=range]')).toBeTruthy();
        await act(async () => {
          fireEvent.click(document.querySelector('input[name="curator-mode"]:not(:checked)')!);
        });
        expect(document.querySelector('.curator-model-row input[type=range]')).toBeTruthy();
      }
      if (section === 'Authentication') {
        const mode = document.querySelector('.settings-prototype-configuration select')!;
        for (const value of ['trusted-proxy', 'oidc']) {
          await act(async () => {
            fireEvent.change(mode, { target: { value } });
          });
          expect(document.querySelector('.auth-mode-fields textarea')).toBeTruthy();
        }
        await act(async () => {
          fireEvent.change(mode, { target: { value: 'none' } });
        });
      }
    }
  }
  await click('General', '.settings-prototype-menu button');
  await click('Personalization', '.settings-prototype-section-items button');
  await waitFor(() =>
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Reference photo file"]')?.value,
    ).toBe('synthetic-operator-reference.png'),
  );
  await waitFor(() => expect(document.querySelector('.agent-reference-preview img')).toBeTruthy());
  const referenceUpload = document.querySelector<HTMLInputElement>(
    'input[aria-label="Upload reference photo"]',
  )!;
  await act(async () => {
    fireEvent.change(referenceUpload, {
      target: {
        files: [
          new File(['synthetic-photo'], 'operator-reference-updated.png', { type: 'image/png' }),
        ],
      },
    });
  });
  await waitFor(() => expect(document.body.textContent).toContain('Reference photo saved.'));
  await click('Trace retention', '.settings-prototype-section-items button');
  await click('Personalization', '.settings-prototype-section-items button');
  await waitFor(() =>
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Reference photo file"]')?.value,
    ).toBe('operator-reference-updated.png'),
  );
  await click('Remove reference photo', 'button');
  await waitFor(() => expect(document.body.textContent).toContain('Reference photo removed.'));
  expect(document.querySelector('.agent-reference-preview img')).toBeNull();

  expect(
    [...document.querySelectorAll('.settings-prototype-section-items button')].some((e) =>
      ['Operator profile', 'Appearance'].includes(e.textContent?.trim() ?? ''),
    ),
  ).toBe(false);
  expect(
    document.querySelector('.settings-personalization-profile input[value="Goblin King"]'),
  ).toBeTruthy();
  expect(document.querySelector('.settings-personalization-appearance .theme-picker')).toBeTruthy();
  expect(document.querySelectorAll('input[placeholder="Dev, Test, or Prod"]')).toHaveLength(1);
  expect(
    document.querySelector(
      '.settings-personalization-appearance input[placeholder="Dev, Test, or Prod"]',
    ),
  ).toBeTruthy();
  const suffix = document.querySelector<HTMLInputElement>(
    'input[placeholder="Dev, Test, or Prod"]',
  )!;
  await waitFor(() => expect(suffix.value).toBe('Dev'));
  await act(async () => {
    fireEvent.change(suffix, { target: { value: 'Fixture contract' } });
  });
  expect(
    suffix.closest('.setting-section')?.querySelector('.settings-help strong')?.textContent,
  ).toBe('Burrow — Fixture contract');
  await act(async () => {
    fireEvent.blur(suffix);
  });
  await waitFor(() => expect(document.body.textContent).toContain('Browser tab suffix saved.'));
  await click('Trace retention', '.settings-prototype-section-items button');
  expect(document.querySelector('input[placeholder="Dev, Test, or Prod"]')).toBeNull();
  await click('Personalization', '.settings-prototype-section-items button');
  await waitFor(() =>
    expect(
      document.querySelector<HTMLInputElement>('input[placeholder="Dev, Test, or Prod"]')?.value,
    ).toBe('Fixture contract'),
  );
  await act(async () => {
    fireEvent.change(document.querySelector('input[placeholder="Dev, Test, or Prod"]')!, {
      target: { value: 'Unsaved personalization' },
    });
  });
  await click('Trace retention', '.settings-prototype-section-items button');
  await waitFor(() => expect(document.querySelector('[data-unsaved-changes-modal]')).toBeTruthy());
  await click('Stay', '[data-unsaved-changes-modal] button');
  expect(
    document.querySelector<HTMLInputElement>('input[placeholder="Dev, Test, or Prod"]')?.value,
  ).toBe('Unsaved personalization');
  await click('Trace retention', '.settings-prototype-section-items button');
  await waitFor(() => expect(document.querySelector('[data-unsaved-changes-modal]')).toBeTruthy());
  await click('Discard', '[data-unsaved-changes-modal] button');
  await click('Personalization', '.settings-prototype-section-items button');
  await waitFor(() =>
    expect(
      document.querySelector<HTMLInputElement>('input[placeholder="Dev, Test, or Prod"]')?.value,
    ).toBe('Fixture contract'),
  );
  await click('Connections', '.settings-prototype-menu button');
  await click('Models', '.settings-prototype-section-items button');
  await click('Add provider', '.models-workspace-header button');
  const setField = async (label: string, value: string) => {
    const input = [...document.querySelectorAll('label.field')]
      .find((e) => e.textContent?.trim().startsWith(label))
      ?.querySelector('input');
    expect(input).toBeTruthy();
    await act(async () => {
      fireEvent.change(input!, { target: { value } });
    });
  };
  await setField('Provider', 'Synthetic contract discovery');
  await setField('URL', 'https://contract.invalid/v1');
  await click('Connect', '.models-connection-editor .model-actions button');
  expect(document.querySelectorAll('.model-option')).toHaveLength(10);
  expect(document.querySelectorAll('.model-option-select small')).toHaveLength(10);
  expect(document.querySelectorAll('.model-option-summary')).toHaveLength(0);
  expect(document.querySelectorAll('.model-option-check:checked')).toHaveLength(0);
  await act(async () => {
    fireEvent.click(document.querySelector('.model-option:nth-child(2) .model-option-select')!);
  });
  expect(document.querySelectorAll('.model-option-check:checked')).toHaveLength(0);
  await act(async () => {
    fireEvent.click(document.querySelector('.model-option:nth-child(2) .model-option-check')!);
  });
  await click('Save', '.models-connection-editor .model-actions button');
  await click(
    'Synthetic contract discovery',
    '.models-provider-inventory .provider-card-select strong',
  );
  expect(document.querySelectorAll('.model-option')).toHaveLength(10);
  expect(document.querySelectorAll('.model-option-check:checked')).toHaveLength(1);
  const controls = window as unknown as {
    fixtureQueueDiscovery: (outcomes: string[]) => void;
    fixtureReleaseDiscovery: (outcome: string) => void;
    fixtureFailNextModelSave: () => void;
  };
  await click('Synthetic OpenAI', '.models-provider-inventory .provider-card-select strong');
  const disclosure = () =>
    document.querySelector<HTMLButtonElement>('[aria-controls="models-connection-fields"]')!;
  const fields = () => document.querySelector<HTMLElement>('#models-connection-fields')!;
  expect(fields().hidden).toBe(true);
  controls.fixtureFailNextModelSave();
  await click('Save', '.models-connection-editor .model-actions button');
  await waitFor(() => expect(document.body.textContent).toContain('Synthetic save unavailable'));
  expect(fields().hidden).toBe(true);
  controls.fixtureQueueDiscovery(['fail']);
  await click('Connect', '.models-connection-editor .model-actions button');
  await waitFor(() =>
    expect(document.body.textContent).toContain('Synthetic upstream unavailable'),
  );
  expect(fields().hidden).toBe(false);
  expect(disclosure().disabled).toBe(true);
  expect(disclosure().getAttribute('aria-expanded')).toBe('true');
  await setField('URL', 'https://recovery-contract.invalid/v1');
  const selectedBefore = document.querySelectorAll('.model-option-check:checked').length;
  controls.fixtureQueueDiscovery(['pending']);
  await click('Connect', '.models-connection-editor .model-actions button');
  expect(fields().hidden).toBe(false);
  await act(async () => {
    controls.fixtureReleaseDiscovery('fail');
  });
  await waitFor(() =>
    expect(document.body.textContent).toContain('Synthetic upstream unavailable'),
  );
  expect(fields().hidden).toBe(false);
  expect(
    document.querySelector('input[value="https://recovery-contract.invalid/v1"]'),
  ).toBeTruthy();
  expect(document.querySelectorAll('.model-option-check:checked')).toHaveLength(selectedBefore);
  controls.fixtureQueueDiscovery(['success-current']);
  await click('Connect', '.models-connection-editor .model-actions button');
  await waitFor(() => expect(fields().hidden).toBe(true));
  expect(disclosure().disabled).toBe(false);
  expect(disclosure().getAttribute('aria-expanded')).toBe('false');
  expect(
    (window as unknown as { fixtureEvidence: { errors: string[] } }).fixtureEvidence.errors,
  ).toEqual([]);
  expect(
    (
      window as unknown as { fixtureEvidence: { requests: { path: string }[] } }
    ).fixtureEvidence.requests.filter((r) => r.path === '/api/settings/browser-origin'),
  ).toEqual([]);
}, 30000);
