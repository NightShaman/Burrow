import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderRequestHistory } from './ProviderRequestHistory';
import { createArchiveRepository, type ProviderRequest } from './archiveRepository';

const run = { runId: 'run-1', agentId: 'fixture', sessionId: 'a & b' };
const endpoint = '/api/traces/run-1/provider-requests?agentId=fixture&sessionId=a+%26+b';
const providerRequest = (
  requestId: string,
  extra: Partial<ProviderRequest> = {},
): ProviderRequest => ({
  requestId,
  ts: '2026-11-18T10:00:00Z',
  provider: 'openai',
  model: 'fixture-model',
  api: 'responses',
  modelCall: 1,
  continuation: false,
  state: 'available',
  ...extra,
});
const before = providerRequest('req-first');
const after = providerRequest('req-second', { continuation: true });
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const history = (requests: ProviderRequest[]) =>
  json({ ok: true, runId: run.runId, retentionDays: 3, requests });
const body = (request: ProviderRequest, value?: unknown) =>
  json({ ok: true, runId: run.runId, request: { ...request, body: value } });

function setup(implementation: typeof fetch) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal('fetch', fetchMock);
  const view = render(<ProviderRequestHistory run={run} repository={createArchiveRepository()} />);
  const expand = () => fireEvent.click(screen.getByText('Redacted provider requests'));
  return { fetchMock, expand, ...view };
}

function select(label: string, value: string) {
  fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('loads metadata lazily and compares independently selected physical requests with the same model-call number', async () => {
  const { fetchMock, expand } = setup(async (input) => {
    const id = new URL(String(input), 'http://localhost').searchParams.get('requestId');
    return id === before.requestId
      ? body(before, { input: 'before [REDACTED]' })
      : id === after.requestId
        ? body(after, { input: 'after [REDACTED]' })
        : history([before, after]);
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expand();
  const picker = await screen.findByRole('combobox', { name: 'Request' });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([endpoint]);
  expect(
    within(picker)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value),
  ).toEqual(['', 'req-first', 'req-second']);
  expect(within(picker).getByRole('option', { name: /continuation.*req-second/ })).toBeTruthy();
  select('Request', before.requestId);
  expect((await screen.findByLabelText('Request redacted body')).textContent).toContain(
    'before [REDACTED]',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Compare requests' }));
  expect(screen.getByLabelText('Before tool call redacted body').textContent).toContain(
    'before [REDACTED]',
  );
  select('After tool call', after.requestId);
  expect((await screen.findByLabelText('After tool call redacted body')).textContent).toContain(
    'after [REDACTED]',
  );
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    endpoint,
    `${endpoint}&requestId=req-first`,
    `${endpoint}&requestId=req-second`,
  ]);
});

it('ignores a stale body that finishes after a different selection', async () => {
  let resolveFirst!: (value: Response) => void;
  const first = new Promise<Response>((resolve) => {
    resolveFirst = resolve;
  });
  const { expand, fetchMock } = setup(async (input) =>
    String(input).endsWith('req-first')
      ? first
      : String(input).endsWith('req-second')
        ? body(after, 'new selection')
        : history([before, after]),
  );
  expand();
  await screen.findByRole('combobox', { name: 'Request' });
  select('Request', before.requestId);
  expect(screen.getByRole('status').textContent).toMatch(/Loading redacted body/);
  select('Request', after.requestId);
  expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
  await screen.findByText('new selection');
  await act(async () => resolveFirst(body(before, 'stale selection')));
  expect(screen.queryByText('stale selection')).toBeNull();
  expect(screen.getByText('new selection')).toBeTruthy();
});

it('distinguishes expired, not captured and unavailable states; honors expiry between listing and selection', async () => {
  const expired = providerRequest('expired', { state: 'expired' });
  const uncaptured = providerRequest('never', { state: 'not_captured' });
  const unavailable = providerRequest('unavailable', { state: 'unavailable' });
  const { fetchMock, expand } = setup(async (input) =>
    String(input).endsWith('req-first')
      ? body({ ...before, state: 'expired' }, 'must not render')
      : history([before, expired, uncaptured, unavailable]),
  );
  expand();
  await screen.findByRole('combobox', { name: 'Request' });
  for (const [id, text] of [
    ['expired', 'This capture has expired.'],
    ['never', 'No body was captured for this request.'],
    ['unavailable', 'The request body is unavailable.'],
  ]) {
    select('Request', id);
    expect(screen.getByRole('status').textContent).toBe(text);
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
  select('Request', before.requestId);
  await screen.findByText('This capture has expired.');
  expect(screen.queryByText('must not render')).toBeNull();
});

it.each(['legacy trace', '404', 'empty'])(
  'displays an appropriate no-history state for %s',
  async (mode) => {
    const { expand } = setup(async () =>
      mode === 'legacy trace'
        ? json({ ok: true, trace: null })
        : mode === '404'
          ? json({ ok: false, error: 'not_found' }, 404)
          : history([]),
    );
    expand();
    await screen.findByText(
      mode === 'empty'
        ? 'No provider requests were recorded for this run.'
        : 'Provider request history is not available for this trace on the connected Core.',
    );
    expect(screen.queryByRole('combobox')).toBeNull();
  },
);

it('retries failed history and detail, and refuses a response for the wrong physical request ID', async () => {
  let attempts = 0;
  const { expand } = setup(async () => {
    attempts += 1;
    if (attempts === 1) return json({ ok: false, error: 'temporarily_unavailable' }, 503);
    if (attempts === 2) return history([before]);
    if (attempts === 3) return body(after, 'wrong request');
    return body(before, 'correct request');
  });
  expand();
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
  await screen.findByRole('combobox');
  select('Request', before.requestId);
  await screen.findByRole('alert');
  expect(screen.queryByText('wrong request')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry body' }));
  expect(await screen.findByText('correct request')).toBeTruthy();
});
