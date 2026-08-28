import { useEffect, useMemo, useState } from 'react';
import { api, type RuntimeHealth, type RuntimeMetrics } from '../../app/api';

type DetailedRuntimeHealth = RuntimeHealth & {
  runtime?: string;
  ui?: { authEnabled?: boolean; authMode?: string; authSource?: string };
  memory?: { configured?: boolean; owner?: string };
  model?: {
    configured?: boolean;
    providerName?: string;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    contextWindow?: number;
    temperature?: number;
  };
  policy?: { packs?: number; enabledHardBlockCount?: number; hardBlockCount?: number };
  traces?: RuntimeHealth['traces'] & {
    rateLastHour?: { runs?: number; allocatedBytes?: number };
    retention?: { retention?: { traceMaxAgeDays?: number; traceMaxBytes?: number } };
  };
};

function formatBytes(bytes?: number | null) {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return 'Unavailable';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatUptime(seconds?: number | null) {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds)) return 'Unavailable';
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function percent(used?: number | null, total?: number | null) {
  return used != null && total != null && total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : null;
}

function Meter({ value, tone = 'accent' }: { value: number | null; tone?: 'accent' | 'warning' }) {
  return <span className={`system-rail-meter ${tone}`} aria-hidden="true"><i style={{ width: `${value ?? 0}%` }} /></span>;
}

function Stat({ label, value, detail, meter, warning = false }: { label: string; value: string; detail?: string; meter?: number | null; warning?: boolean }) {
  return <div className="system-rail-stat"><div><span>{label}</span><b>{value}</b></div>{detail && <small>{detail}</small>}{meter !== undefined && <Meter value={meter} tone={warning ? 'warning' : 'accent'} />}</div>;
}

export function SystemStatsRail({ active }: { active: boolean }) {
  const [health, setHealth] = useState<DetailedRuntimeHealth | null>(null);
  const [metrics, setMetrics] = useState<RuntimeMetrics | null>(null);
  const [error, setError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const load = () => {
      void Promise.all([api<DetailedRuntimeHealth>('/api/health'), api<RuntimeMetrics>('/api/metrics')])
        .then(([nextHealth, nextMetrics]) => {
          if (!alive) return;
          setHealth(nextHealth);
          setMetrics(nextMetrics);
          setError(false);
          setUpdatedAt(new Date());
        })
        .catch(() => { if (alive) setError(true); });
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [active]);

  const diskUsed = percent(metrics?.filesystem.usedBytes, metrics?.filesystem.totalBytes);
  const heapUsed = percent(metrics?.process.heapUsedBytes, metrics?.process.heapTotalBytes);
  const model = health?.model;
  const traceRate = health?.traces?.rateLastHour;
  const status = error ? 'Unavailable' : health?.ok && metrics?.ok ? 'Healthy' : 'Loading';
  const updated = useMemo(() => updatedAt?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) ?? 'Waiting for data', [updatedAt]);

  return <div className="system-rail-content">
    <section className="system-rail-summary">
      <div><span className={`system-rail-status ${error ? 'error' : health?.ok ? 'healthy' : 'loading'}`}><i />{status}</span><small>Updated {updated}</small></div>
      <strong>{health?.runtime ?? 'Burrow'} <span>{health?.version ?? '—'}</span></strong>
    </section>

    <section className="system-rail-group">
      <h3>Host</h3>
      <Stat label="CPU" value={metrics?.process.cpu.percent == null ? '—' : `${metrics.process.cpu.percent.toFixed(1)}%`} detail={metrics ? `Load ${metrics.load.oneMinute?.toFixed(2) ?? '—'} · ${metrics.load.fiveMinutes?.toFixed(2) ?? '—'} · ${metrics.load.fifteenMinutes?.toFixed(2) ?? '—'}` : undefined} />
      <Stat label="Disk" value={diskUsed == null ? '—' : `${diskUsed.toFixed(1)}%`} detail={metrics ? `${formatBytes(metrics.filesystem.usedBytes)} used · ${formatBytes(metrics.filesystem.availableBytes)} free` : undefined} meter={diskUsed} warning={(diskUsed ?? 0) >= 85} />
      <Stat label="Uptime" value={formatUptime(metrics?.process.uptimeSeconds)} />
    </section>

    <section className="system-rail-group">
      <h3>Process</h3>
      <Stat label="Resident memory" value={formatBytes(metrics?.process.rssBytes)} />
      <Stat label="JavaScript heap" value={heapUsed == null ? '—' : `${heapUsed.toFixed(1)}%`} detail={metrics ? `${formatBytes(metrics.process.heapUsedBytes)} / ${formatBytes(metrics.process.heapTotalBytes)}` : undefined} meter={heapUsed} warning={(heapUsed ?? 0) >= 85} />
      <Stat label="External memory" value={formatBytes(metrics?.process.externalBytes)} />
    </section>

    <section className="system-rail-group">
      <h3>Storage</h3>
      <Stat label="Settings database" value={formatBytes(metrics?.settingsDatabase.totalBytes)} detail={metrics ? `DB ${formatBytes(metrics.settingsDatabase.databaseBytes)} · WAL ${formatBytes(metrics.settingsDatabase.walBytes)}` : undefined} />
      <Stat label="Trace storage" value={formatBytes(health?.traces?.logicalBytes)} detail={`${health?.traces?.count ?? '—'} runs`} />
      <Stat label="Last hour" value={`${traceRate?.runs ?? '—'} runs`} detail={traceRate ? `${formatBytes(traceRate.allocatedBytes)} allocated` : undefined} />
    </section>

    <section className="system-rail-group">
      <h3>Runtime</h3>
      <Stat label="Model provider" value={model?.providerName ?? model?.provider ?? 'Unavailable'} detail={model?.model} />
      <Stat label="Model defaults" value={model?.reasoningEffort ?? '—'} detail={model?.contextWindow ? `${model.contextWindow.toLocaleString()} context · temp ${model.temperature ?? '—'}` : undefined} />
      <Stat label="Authentication" value={health?.ui?.authEnabled ? health.ui.authMode ?? 'Enabled' : 'Disabled'} detail={health?.ui?.authSource ? `Source: ${health.ui.authSource}` : undefined} />
      <Stat label="Memory" value={health?.memory?.configured ? 'Configured' : 'Not configured'} detail={health?.memory?.owner} />
      <Stat label="Policy" value={`${health?.policy?.enabledHardBlockCount ?? 0} hard blocks`} detail={`${health?.policy?.packs ?? 0} packs loaded`} />
    </section>
  </div>;
}
