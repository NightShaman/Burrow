import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountStatus } from '../../src/features/panels/AccountStatus';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import '../../src/app.css';

let scenario = new URLSearchParams(location.search).get('state') ?? 'limited';
const requests = new Map<string, number>();
const providers = ['Anthropic', 'OpenAI'].map((name) => ({
  id: `refresh-${name}`,
  provider: name,
  apiType: name === 'Anthropic' ? 'anthropic-messages' : 'openai-responses',
  url: '',
  apiKey: '',
  models: [],
  oauthConfigured: true,
}));
window.fetch = async (input) => {
  const path = String(input);
  const now = Date.now();
  const headers = { Date: new Date(now).toUTCString() };
  if (path.includes('reset-credits')) return Response.json({ ok: false }, { headers });
  const vendor = path.includes('/anthropic/') ? 'Anthropic' : 'OpenAI';
  requests.set(vendor, (requests.get(vendor) ?? 0) + 1);
  const counter = document.getElementById('request-counts');
  if (counter) counter.textContent = JSON.stringify(Object.fromEntries(requests));
  if (scenario === 'offline') throw new Error('Network unavailable');
  const used = scenario === 'fresh' ? 35 : 20;
  const body = {
    usage: {
      accountStatus: {
        status: 'available',
        label: 'Active',
        reason: 'usage_available',
        scope: 'account',
        checkedAt: new Date(now).toISOString(),
        resetAt: null,
      },
      windows: [
        {
          key: vendor === 'Anthropic' ? 'five_hour' : 'primary',
          usedPercent: used,
          resetAt: new Date(now + 3_600_000).toISOString(),
        },
        {
          key: vendor === 'Anthropic' ? 'seven_day' : 'secondary',
          usedPercent: used + 10,
          resetAt: new Date(now + 86_400_000).toISOString(),
        },
      ],
    },
  };
  if (vendor === 'OpenAI') return Response.json(body, { headers });
  const age = scenario === 'stale' ? 180_000 : scenario === 'limited' ? 240_000 : 0;
  const fetchedAt = new Date(now - age).toISOString();
  const limited = scenario === 'limited' || scenario === 'empty';
  return Response.json(
    {
      ok: !limited,
      usage: limited ? null : body.usage,
      fetchedAt: scenario === 'empty' ? null : fetchedAt,
      serverTime: new Date(now).toISOString(),
      sampleAgeMs: scenario === 'empty' ? null : age,
      lastSuccess: scenario === 'empty' ? null : { fetchedAt, usage: body.usage },
      error: limited ? 'anthropic_oauth_usage_failed:429' : null,
      lastError: limited
        ? {
            status: 429,
            error: 'anthropic_oauth_usage_failed:429',
            at: new Date(now).toISOString(),
          }
        : null,
      retryAfterMs: limited ? 60_000 : 0,
      retryAt: limited ? new Date(now + 60_000).toISOString() : null,
    },
    { status: limited ? 429 : 200, headers },
  );
};
function Fixture() {
  const [selected, setSelected] = useState(scenario);
  return (
    <ConfirmProvider>
      <main style={{ padding: 16, maxWidth: 640, margin: 'auto' }}>
        <h2>Account freshness acceptance</h2>
        <p>Synthetic responses only; no provider requests. State: {selected}.</p>
        <select
          aria-label="Next poll response"
          value={selected}
          onChange={(event) => {
            scenario = event.target.value;
            setSelected(scenario);
          }}
        >
          <option value="limited">Rate limited, retained sample</option>
          <option value="empty">Rate limited, no sample</option>
          <option value="stale">Stale sample</option>
          <option value="fresh">Fresh / recovered</option>
          <option value="offline">Network error</option>
        </select>
        <pre id="request-counts" aria-label="Usage request counts" />
        <aside className="rail-panel" style={{ width: '100%', maxWidth: 330, height: 360 }}>
          <header className="rail-head">Account status</header>
          <AccountStatus providers={providers} />
        </aside>
      </main>
    </ConfirmProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
