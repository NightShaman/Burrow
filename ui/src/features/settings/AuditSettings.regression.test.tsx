import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { DeclarativeSection } from './ModSettingsHost';
import { useModelConnectionEditor } from './useModelConnectionEditor';
import { api } from '../../app/api';
import { FirstRunSetup } from './FirstRunSetup';
import { ModelConnections } from './ModelConnections';
import { modelConnectionsApi } from './modelConnectionsApi';

vi.mock('../../app/api', async (original) => ({
  ...(await original<typeof import('../../app/api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);
const contribution = {
  sections: [
    {
      id: 'main',
      label: 'Main',
      layout: 'form' as const,
      fields: [{ id: 'name', label: 'Name', value: 'Original' }],
      actions: [{ id: 'save', label: 'Save', tone: 'primary' as const }],
    },
  ],
};
function Form() {
  const navigate = useUnsavedNavigation();
  return (
    <>
      <DeclarativeSection
        contribution={contribution}
        section={{ id: 'main', label: 'Main' }}
        module={{ handleSettingsAction: saveAction }}
        overflowTarget={null}
      />
      <button onClick={() => navigate(() => navigation())}>Leave</button>
    </>
  );
}
const navigation = vi.fn();
const saveAction = vi.fn();
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function renderForm() {
  return render(
    <ConfirmProvider>
      <UnsavedChangesProvider>
        <Form />
      </UnsavedChangesProvider>
    </ConfirmProvider>,
  );
}

it('SET01 protects edited declarative forms across navigation and unload; discard discards', async () => {
  renderForm();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Draft' } });
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByText('Leave'));
  expect(navigation).not.toHaveBeenCalled();
  expect(await screen.findByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByText('Stay'));
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Draft');
  fireEvent.click(screen.getByText('Leave'));
  fireEvent.click(screen.getByText('Discard'));
  expect(navigation).toHaveBeenCalledOnce();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Original');
});

it('SET01 waits for a declarative action and blocks busy navigation/unload', async () => {
  let complete!: () => void;
  saveAction.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  renderForm();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(saveAction).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText('Leave'));
  expect(navigation).not.toHaveBeenCalled();
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await act(async () => complete());
  expect(navigation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Leave'));
  expect(navigation).toHaveBeenCalledOnce();
});

function editor() {
  return renderHook(() => useModelConnectionEditor({ onModelConnectionsChanged: async () => {} }), {
    wrapper: ({ children }) => (
      <ConfirmProvider>
        <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
      </ConfirmProvider>
    ),
  });
}
function ready(result: ReturnType<typeof editor>['result']) {
  act(() => {
    result.current.setProvider('Example');
    result.current.setUrl('https://example.invalid');
    result.current.setApiKey('submitted-key');
    result.current.setManualModel('example-model');
  });
  act(() => result.current.addManualModel());
}
it.each(['success', 'error'])(
  'SET02 does not strand a write when API type changes during pending %s',
  async (outcome) => {
    let settle!: (value?: unknown) => void;
    apiMock.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          settle = outcome === 'success' ? resolve : reject;
        }) as ReturnType<typeof api>,
    );
    apiMock.mockResolvedValue({});
    const { result } = editor();
    ready(result);
    let first!: Promise<void>;
    act(() => {
      first = result.current.saveProvider();
    });
    act(() => result.current.setApiType('anthropic-messages'));
    expect(result.current.requestState).toBe('saving');
    expect(result.current.apiType).toBe('openai-chat-completions');
    await act(async () => {
      settle(outcome === 'success' ? {} : new Error('network failed'));
      await first;
    });
    if (outcome === 'success') ready(result);
    await act(() => result.current.saveProvider());
    expect(apiMock).toHaveBeenCalledTimes(2);
  },
);

it.each(['apiKey', 'oauthIdToken', 'oauthAccessToken', 'oauthRefreshToken'] as const)(
  'SET03 preserves a newer %s typed during a save',
  async (field) => {
    let settle!: () => void;
    apiMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({});
        }) as ReturnType<typeof api>,
    );
    const { result } = editor();
    ready(result);
    if (field !== 'apiKey')
      act(() =>
        result.current[
          (
            {
              apiKey: 'setApiKey',
              oauthIdToken: 'setOauthIdToken',
              oauthAccessToken: 'setOauthAccessToken',
              oauthRefreshToken: 'setOauthRefreshToken',
            } as const
          )[field]
        ]('submitted-token'),
      );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.saveProvider();
    });
    act(() =>
      result.current[
        (
          {
            apiKey: 'setApiKey',
            oauthIdToken: 'setOauthIdToken',
            oauthAccessToken: 'setOauthAccessToken',
            oauthRefreshToken: 'setOauthRefreshToken',
          } as const
        )[field]
      ]('newer-token'),
    );
    await act(async () => {
      settle();
      await pending;
    });
    expect(result.current[field]).toBe('newer-token');
    expect(result.current.provider).toBe('Example');
    expect(
      JSON.parse(apiMock.mock.calls[0][1]!.body as string)[
        field === 'apiKey' ? 'apiKey' : 'oauthTokens'
      ][
        field === 'apiKey'
          ? 'length'
          : field === 'oauthIdToken'
            ? 'id_token'
            : field === 'oauthAccessToken'
              ? 'access_token'
              : 'refresh_token'
      ],
    ).toBe(field === 'apiKey' ? 'submitted-key'.length : 'submitted-token');
  },
);

it.each([false, true])(
  'SET02 disables the API type selector during a %s pool save',
  async (loadBalancing) => {
    let finishSave!: () => void;
    apiMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = () => resolve({});
        }) as ReturnType<typeof api>,
    );
    const account = {
      id: 'account',
      provider: 'Account',
      apiType: 'openai-responses',
      url: 'https://example.invalid',
      apiKey: '',
      models: ['example-model'],
      connectionModels: [{ id: 'example-model', selected: true, acceptedInput: ['text' as const] }],
      auth: { type: 'oauth', provider: 'OpenAI' },
    };
    const { container } = render(
      <ConfirmProvider>
        <UnsavedChangesProvider>
          <ModelConnections
            loadBalancing={loadBalancing}
            savedProviders={[account]}
            onModelConnectionsChanged={async () => {}}
            mcpConnections={null}
          />
        </UnsavedChangesProvider>
      </ConfirmProvider>,
    );
    if (loadBalancing) {
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pool' } });
      fireEvent.click(screen.getByLabelText('Account'));
    } else {
      fireEvent.click(screen.getByRole('button', { name: /Account.*1 model/ }));
      fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'secret' } });
    }
    const selector = screen.getByLabelText(
      loadBalancing ? 'Adapter' : 'API type',
    ) as HTMLSelectElement;
    expect(selector.disabled).toBe(false);
    fireEvent.click(container.querySelector('button.primary')!);
    await waitFor(() => expect(apiMock).toHaveBeenCalledOnce());
    expect(selector.disabled).toBe(true);
    await act(async () => finishSave());
    expect(selector.disabled).toBe(false);
  },
);

const secretSetters = {
  apiKey: 'setApiKey',
  oauthIdToken: 'setOauthIdToken',
  oauthAccessToken: 'setOauthAccessToken',
  oauthRefreshToken: 'setOauthRefreshToken',
} as const;
const secretFields = Object.keys(secretSetters) as Array<keyof typeof secretSetters>;

it('SET03 completes a normal save after the inventory refresh renders cleared secrets', async () => {
  let finishRefresh!: () => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishRefresh = resolve;
      }),
  );
  apiMock.mockResolvedValue({});
  const { result } = renderHook(
    () => useModelConnectionEditor({ onModelConnectionsChanged: refresh }),
    {
      wrapper: ({ children }) => (
        <ConfirmProvider>
          <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
        </ConfirmProvider>
      ),
    },
  );
  ready(result);
  act(() => {
    for (const field of secretFields) result.current[secretSetters[field]](`submitted-${field}`);
  });
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.saveProvider();
  });
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  // Wait for a real render of the immediate post-write secret clearing before refresh resolves.
  await waitFor(() => {
    for (const field of secretFields) expect(result.current[field]).toBe('');
  });
  expect(result.current.requestState).toBe('saving');
  await act(async () => {
    finishRefresh();
    await pending;
  });
  expect(apiMock).toHaveBeenCalledOnce();
  expect(result.current.requestState).toBe('idle');
  expect(result.current.provider).toBe('');
  expect(result.current.savedProvidersOpen).toBe(true);
});

it.each(secretFields)(
  'SET03 retains a newer %s entered during inventory refresh',
  async (field) => {
    let finishRefresh!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    apiMock.mockResolvedValue({});
    const { result } = renderHook(
      () => useModelConnectionEditor({ onModelConnectionsChanged: refresh }),
      {
        wrapper: ({ children }) => (
          <ConfirmProvider>
            <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
          </ConfirmProvider>
        ),
      },
    );
    ready(result);
    act(() => result.current[secretSetters[field]]('submitted-secret'));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.saveProvider();
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current[field]).toBe(''));
    act(() => result.current[secretSetters[field]]('newer-secret'));
    await act(async () => {
      finishRefresh();
      await pending;
    });
    expect(result.current[field]).toBe('newer-secret');
    expect(result.current.provider).toBe('Example');
    expect(result.current.requestState).toBe('idle');
    expect(apiMock).toHaveBeenCalledOnce();
  },
);

it.each(secretFields)('SET03 keeps a cleared-and-retyped %s during refresh', async (field) => {
  let finishRefresh!: () => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishRefresh = resolve;
      }),
  );
  apiMock.mockResolvedValue({});
  const { result } = renderHook(
    () => useModelConnectionEditor({ onModelConnectionsChanged: refresh }),
    {
      wrapper: ({ children }) => (
        <ConfirmProvider>
          <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
        </ConfirmProvider>
      ),
    },
  );
  ready(result);
  act(() => result.current[secretSetters[field]]('submitted-secret'));
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.saveProvider();
  });
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await waitFor(() => expect(result.current[field]).toBe(''));
  act(() => result.current[secretSetters[field]]('submitted-secret'));
  await act(async () => {
    finishRefresh();
    await pending;
  });
  expect(result.current[field]).toBe('submitted-secret');
  expect(result.current.provider).toBe('Example');
  expect(apiMock).toHaveBeenCalledOnce();
});

it('CLEAN03 Escape and backdrop dismiss only nested OAuth, not mandatory onboarding', async () => {
  apiMock.mockResolvedValue({ connections: [] });
  vi.spyOn(modelConnectionsApi, 'startOpenAiOAuth').mockRejectedValue(new Error('offline fixture'));
  render(
    <FirstRunSetup
      onSelect={() => {}}
      onAgentsChanged={async () => {}}
      onModelConnectionsChanged={async () => {}}
      onOperatorProfileChanged={async () => {}}
      agents={[]}
      selectedId=""
    />,
  );
  await screen.findByRole('heading', { name: 'Bring your kingdom with you' });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('heading', { name: 'Bring your kingdom with you' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.change(
    screen
      .getByRole('dialog', { name: 'Identify your first agent' })
      .querySelector('input[placeholder="Luna"]')!,
    { target: { value: 'Example' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: /OpenAI.*Sign in with ChatGPT/i }));
  expect(screen.getByRole('heading', { name: 'OpenAI OAuth' })).toBeTruthy();
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Close OAuth dialog' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('heading', { name: 'OpenAI OAuth' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /OpenAI.*Sign in with ChatGPT/i }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('offline fixture'));
  fireEvent.click(document.querySelectorAll('.accessible-modal-backdrop')[1]);
  expect(screen.queryByRole('heading', { name: 'OpenAI OAuth' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /OpenAI.*Sign in with ChatGPT/i }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('offline fixture'));
  fireEvent.click(screen.getByRole('button', { name: 'Close OAuth dialog' }));
  expect(screen.queryByRole('heading', { name: 'OpenAI OAuth' })).toBeNull();
});
