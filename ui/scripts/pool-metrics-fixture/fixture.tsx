import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppStatusBar } from '../../src/app/AppChrome';
import '../../src/app.css';
const day = { requests: 12345, successes: 12200, failures: 45, cancellations: 100, attempts: 13000, retries: 655, inputTokens: 12345678, outputTokens: 987654, cachedTokens: 8765432, cachePercent: 71.2, errorPercent: 0.36, durationMs: 150000, coverage: { inputAttempts: 13000, outputAttempts: 13000, cachedAttempts: 12000, cacheAttempts: 12000, cacheInputTokens: 12311000 } };
const requests: string[] = [];
window.fetch = (async (path: string) => { requests.push(path); if (path !== '/api/metrics/provider-pools') throw Error('Unexpected request'); return Response.json({ ok: true, windows: { '24h': day, '7d': { ...day, requests: 999999, inputTokens: null, outputTokens: null, cachePercent: null, errorPercent: 0 } } }); }) as typeof fetch;
Object.assign(window, { fixtureEvidence: { requests } });
createRoot(document.getElementById('root')!).render(<main className="cockpit"><header className="app-header">Isolated footer acceptance — actual AppStatusBar</header><aside className="left-rail">Existing rail placeholder</aside><section className="workspace">No account cards or application layout changed.</section><aside className="right-rail">Existing rail placeholder</aside><AppStatusBar anthropicUsage={{ windows: [{ key: 'five_hour', usedPercent: 20 }, { key: 'seven_day', usedPercent: 40 }] }} openAiUsage={{ windows: [{ key: 'primary', label: '5hr', usedPercent: 30 }] }} runtimeVersion="2026.10.24.10" /></main>);
