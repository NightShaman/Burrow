import React from 'react';
import { createRoot } from 'react-dom/client';
import { AccountStatus } from '../../src/features/panels/AccountStatus';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import '../../src/app.css';
const state = new URLSearchParams(location.search).get('state');
window.fetch = async (input, options) => {
  const path = String(input),
    now = Date.now(),
    fetchedAt = new Date(now).toISOString();
  const headers = { Date: new Date(now).toUTCString() };
  if (path.includes('reset-activation')) {
    document.getElementById('writes')!.textContent = 'Mock POST only';
    return Response.json({ code: 'unavailable', ambiguous: state === 'ambiguous' }, { headers });
  }
  const fullResets = {
    availableCount: 2,
    nearestExpiresAt: new Date(now + 86400000).toISOString(),
  };
  if (path.includes('reset-inventory'))
    return Response.json({ ok: true, fullResets, fetchedAt }, { headers });
  if (path.includes('/anthropic/oauth/usage'))
    return Response.json(
      {
        ok: true,
        serverTime: fetchedAt,
        sampleAgeMs: 0,
        usage: {
          windows: [
            { key: 'five_hour', usedPercent: 100, resetAt: new Date(now + 3600000).toISOString() },
            { key: 'seven_day', usedPercent: 75, resetAt: new Date(now + 86400000).toISOString() },
          ],
          fullResets,
          fullResetsFreshness: {
            fetchedAt,
            sampleAgeMs: state === 'stale' ? 180000 : 0,
            stale: state === 'stale',
          },
        },
      },
      { headers },
    );
  throw new Error('Fixture blocks unexpected ' + path);
};
const providers = [
  {
    id: 'fixture',
    provider: 'Anthropic Max',
    apiType: 'anthropic-messages',
    url: '',
    apiKey: '',
    models: [],
    oauthConfigured: true,
  },
];
createRoot(document.getElementById('root')!).render(
  <ConfirmProvider>
    <main style={{ width: 'min(100%, 410px)', padding: 16 }}>
      <AccountStatus providers={providers} />
      <small id="writes">Mock API — no live reset requests</small>
    </main>
  </ConfirmProvider>,
);
