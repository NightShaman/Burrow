import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountStatus } from '../../src/features/panels/AccountStatus';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import '../../src/app.css';

let used = 20;
let failed = false;
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
  if (failed) return Response.json({ error: 'Usage unavailable' }, { status: 503, headers });
  return Response.json(
    {
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
    },
    { headers },
  );
};
function Fixture() {
  const [scenario, setScenario] = useState('Initial');
  return (
    <ConfirmProvider>
      <main style={{ padding: 16, maxWidth: 640, margin: 'auto' }}>
        <h2>Account refresh acceptance</h2>
        <p>
          Synthetic responses only. Changes below take effect on the next real 30-second poll,
          without remounting cards.
        </p>
        <select
          aria-label="Next poll response"
          value={scenario}
          onChange={(event) => {
            const value = event.target.value;
            used = value === 'Initial' ? 20 : 35;
            failed = value === 'Failed';
            setScenario(value);
          }}
        >
          <option>Initial</option>
          <option>Updated</option>
          <option>Failed</option>
        </select>
        <pre id="request-counts" aria-label="Usage request counts" />
        <aside className="rail-panel" style={{ width: '100%', maxWidth: 330, height: 600 }}>
          <header className="rail-head">Account status</header>
          <AccountStatus providers={providers} />
        </aside>
      </main>
    </ConfirmProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
