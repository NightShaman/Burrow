import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountStatus } from '../../src/features/panels/AccountStatus';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import '../../src/app.css';

const realNow = Date.now.bind(Date);
let skew = 3_600_000;
let scenario = 'Fresh';
Date.now = () => realNow() + skew;
const providers = [
  'Rob Pro',
  'Wife Plus',
  'Business 1',
  'Business 2',
  'Business 3',
  'Business 4',
  'Business 5',
  'Ant-Goblin',
  'Ant-Rob',
].map((name, i) => ({
  id: `clock-${i}`,
  provider: name,
  apiType: i < 7 ? 'openai-responses' : 'anthropic-messages',
  url: i < 7 ? 'https://openai.com' : 'https://anthropic.com',
  apiKey: '',
  models: [],
  oauthConfigured: true,
}));
window.fetch = async (input) => {
  const path = String(input);
  const now = realNow();
  const headers = { Date: new Date(now).toUTCString() };
  if (path.includes('reset-credits'))
    return Response.json(
      {
        ok: true,
        fetchedAt: new Date(now).toISOString(),
        credits: {
          availableCount: 2,
          nearestExpiresAt: new Date(now + 2 * 86400_000).toISOString(),
          available: [],
        },
      },
      { headers },
    );
  if (scenario === 'Failed')
    return Response.json({ error: 'Usage service unavailable' }, { status: 503, headers });
  const i = Number(path.match(/clock-(\d+)/)?.[1] ?? 0);
  const limited = scenario === 'Limited' || scenario === 'Reset passed';
  return Response.json(
    {
      usage: {
        accountStatus: {
          status: limited ? 'rate_limited' : 'available',
          label: limited ? 'Rate Limited' : 'Active',
          reason: limited ? 'short_window_exhausted' : 'usage_available',
          scope: 'account',
          checkedAt: new Date(now - (scenario === 'Old' ? 660_000 : 0)).toISOString(),
          resetAt: limited
            ? new Date(now + (scenario === 'Reset passed' ? -60_000 : 1_800_000)).toISOString()
            : null,
        },
        windows: [
          {
            key: i < 7 ? 'primary' : 'five_hour',
            label: '5 hours',
            usedPercent: limited ? 100 : 20 + i * 3,
            resetAt: new Date(now + 3_600_000).toISOString(),
          },
          {
            key: i < 7 ? 'secondary' : 'seven_day',
            label: '7 days',
            usedPercent: 30,
            resetAt: new Date(now + 3 * 86400_000).toISOString(),
          },
        ],
      },
    },
    { headers: scenario === 'No server clock' ? {} : headers },
  );
};
function Fixture() {
  const [version, setVersion] = useState(0);
  const [offset, setOffset] = useState(skew);
  return (
    <ConfirmProvider>
      <main style={{ padding: 24 }}>
        <header style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
          <label>
            Browser clock{' '}
            <select
              aria-label="Browser clock"
              value={offset}
              onChange={(e) => {
                skew = Number(e.target.value);
                setOffset(skew);
              }}
            >
              <option value={3_600_000}>Ahead 1 hour</option>
              <option value={0}>Correct</option>
              <option value={-3_600_000}>Behind 1 hour</option>
            </select>
          </label>
          <label>
            Data{' '}
            <select
              aria-label="Data scenario"
              onChange={(e) => {
                scenario = e.target.value;
                setVersion((v) => v + 1);
              }}
            >
              {['Fresh', 'Limited', 'Old', 'Reset passed', 'Failed', 'No server clock'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </header>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1fr) minmax(260px,320px)',
            gap: 16,
          }}
        >
          <section className="rail-panel" style={{ padding: 24 }}>
            <h2>Account clock acceptance</h2>
            <p>Real account cards with isolated synthetic responses. No live API calls.</p>
            <p>Change the browser clock without reloading; account health must not change.</p>
          </section>
          <aside className="rail-panel" style={{ height: 'calc(100vh - 120px)' }}>
            <header className="rail-head">Account status</header>
            <AccountStatus key={version} providers={providers} />
          </aside>
        </div>
      </main>
    </ConfirmProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
