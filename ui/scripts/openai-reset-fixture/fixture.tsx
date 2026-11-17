import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountStatus } from '../../src/features/panels/AccountStatus';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import '../../src/app.css';
const providers = [
  'Anthropic Personal',
  'OpenAI Personal',
  'Anthropic Studio',
  'OpenAI Research',
  'OpenAI Development',
  'OpenAI Operations',
  'OpenAI Testing',
  'OpenAI Spare',
  'OpenAI Studio',
].map((provider, index) => ({
  id: `fixture-${index}`,
  provider,
  url: '',
  apiKey: '',
  models: [],
  oauthConfigured: true,
}));
const expiry = () => new Date(Date.now() + 3 * 86400_000).toISOString();
let scenario = 'Normal';
const json = (data: unknown, init: ResponseInit = {}) =>
  Response.json(data, { ...init, headers: { Date: new Date().toUTCString() } });
window.fetch = async (input, init) => {
  const url = String(input);
  const connection = url.match(/connectionId=([^&]+)/)?.[1] || 'fixture-0';
  if (init?.method === 'POST') {
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (scenario === 'Ambiguous')
      return json(
        { ok: false, error: 'reset_credit_outcome_unknown', ambiguous: true },
        { status: 502 },
      );
    return json({
      ok: true,
      code: 'reset',
      usageRefresh: { ok: true },
      creditsRefresh: creditData(connection),
    });
  }
  if (url.includes('reset-credits')) {
    if (scenario === 'Unavailable')
      return json({ ok: false, error: 'unavailable' }, { status: 502 });
    return json(creditData(connection));
  }
  const index = Number(connection.slice(-1));
  const anthropic = providers[index].provider.startsWith('Anthropic');
  return json({
    usage: {
      ...(anthropic
        ? {
            fullResets: { availableCount: index === 2 ? 0 : 2, nearestExpiresAt: expiry() },
            fullResetsFreshness: {
              fetchedAt: new Date().toISOString(),
              sampleAgeMs: 0,
              stale: false,
            },
          }
        : {}),
      accountStatus: {
        status: index <= 1 ? 'available' : index === 4 ? 'rate_limited' : 'limit_exceeded',
        label: index <= 1 ? 'Available' : index === 4 ? 'Rate Limited' : 'Limit Exceeded',
        reason: 'usage_window',
        scope: 'account',
        checkedAt: new Date().toISOString(),
        resetAt: expiry(),
      },
      windows: [
        {
          key: anthropic ? 'five_hour' : 'primary',
          label: '5 hours',
          usedPercent: index === 0 || index === 1 ? 28 : 100,
          resetAt: expiry(),
        },
        {
          key: anthropic ? 'seven_day' : 'secondary',
          label: '7 days',
          usedPercent: index === 2 ? 100 : 54,
          resetAt: expiry(),
        },
      ],
    },
  });
};
function creditData(connection: string) {
  const zero = connection.endsWith('2');
  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    credits: {
      availableCount: zero ? 0 : 2,
      nearestExpiresAt: zero ? null : expiry(),
      available: zero ? [] : [{ id: 'first', expiresAt: expiry() }],
    },
  };
}
function Fixture() {
  const [geometry, setGeometry] = useState('');
  useEffect(() => {
    const timer = window.setInterval(() => {
      const panel = document.querySelector('.account-status') as HTMLElement | null;
      const cards = [...document.querySelectorAll<HTMLElement>('.account-card')];
      if (panel && cards.length)
        setGeometry(
          JSON.stringify({
            client: panel.clientHeight,
            scroll: panel.scrollHeight,
            heights: cards.map((card) => Number(card.getBoundingClientRect().height.toFixed(2))),
            clipped: cards.filter((card) => card.scrollHeight > card.clientHeight + 1).length,
          }),
        );
    }, 250);
    return () => window.clearInterval(timer);
  }, []);
  const [compressed, setCompressed] = useState(true);
  const [version, setVersion] = useState(0);
  return (
    <ConfirmProvider>
      <main style={{ padding: 24 }}>
        <header style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
          <button onClick={() => setCompressed(!compressed)}>Toggle compressed rail</button>
          <select
            aria-label="Scenario"
            onChange={(e) => {
              scenario = e.target.value;
              setVersion((v) => v + 1);
            }}
          >
            {['Normal', 'Unavailable', 'Ambiguous'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </header>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(300px,1fr) 330px',
            gap: 16,
            maxWidth: 1250,
            margin: 'auto',
          }}
        >
          <section
            className="rail-panel"
            style={{ height: compressed ? 'calc(100vh - 118px)' : 850, padding: 24 }}
          >
            <h2>Chat</h2>
            <output aria-label="Layout measurements" style={{ overflowWrap: 'anywhere' }}>
              {geometry}
            </output>
          </section>
          <aside
            className="rail-panel"
            style={{ height: compressed ? 'calc(100vh - 118px)' : 850 }}
          >
            <header className="rail-head">Account status</header>
            <AccountStatus key={version} providers={providers} />
          </aside>
        </div>
      </main>
    </ConfirmProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
