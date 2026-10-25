import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { api, type AnthropicUsage, type OpenAiUsage, type OpenAiAccountStatus } from '../../app/api';
import { readAccountOrder, writeAccountOrder } from '../../app/accountOrderStorage';
import type { SavedProvider } from '../../app/types';
import { AccountCard } from './AccountCard';
import { OpenAiResets } from './OpenAiResets';

export type AccountVendor = 'Anthropic' | 'OpenAI';
export type UsageBar = { key: string; label: string; remainingPercent: number | null; resetAt: string | null };
export type AccountUsageCard = { id: string; name: string; vendor: AccountVendor; plan: string | null; state: 'loading' | 'ready' | 'error'; bars: UsageBar[]; accountStatus?: OpenAiAccountStatus; error?: string };

const oauthConfigured = (provider: SavedProvider) =>
  provider.auth?.type === 'oauth' ||
  provider.auth?.source === 'oauth' ||
  provider.auth?.source === 'openai-oauth' ||
  provider.auth?.source === 'anthropic-oauth' ||
  provider.auth?.source === 'claude-code' ||
  provider.authSource === 'oauth' ||
  provider.authSource === 'openai-oauth' ||
  provider.authSource === 'anthropic-oauth' ||
  provider.oauthConfigured === true;

export function accountVendor(provider: SavedProvider): AccountVendor | null {
  const name = (provider.provider ?? '').toLowerCase();
  const apiType = (provider.apiType ?? '').toLowerCase();
  const url = (provider.url ?? '').toLowerCase();
  if (apiType === 'anthropic-messages' || name.includes('anthropic') || name.includes('claude') || url.includes('anthropic.com')) return 'Anthropic';
  if (name.includes('openai') || name.includes('chatgpt') || url.includes('chatgpt.com') || url.includes('openai.com')) return 'OpenAI';
  return null;
}

export function oauthAccounts(providers: SavedProvider[]) {
  return providers
    .map((provider) => ({ provider, vendor: accountVendor(provider) }))
    .filter((entry): entry is { provider: SavedProvider; vendor: AccountVendor } => entry.vendor !== null && oauthConfigured(entry.provider));
}

const titleCase = (value: string) => value.split(/[\s_-]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');

export function formatResetIn(resetAt: string | null | undefined, nowMs: number = Date.now()) {
  if (!resetAt) return null;
  const target = new Date(resetAt).getTime();
  if (!Number.isFinite(target)) return null;
  const deltaMs = target - nowMs;
  if (deltaMs <= 0) return 'now';
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

const remainingFrom = (usedPercent: number | null | undefined) =>
  typeof usedPercent === 'number' && Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, 100 - usedPercent)) : null;

export function anthropicBars(usage: AnthropicUsage | null): UsageBar[] {
  if (!usage?.windows?.length) return [];
  const byKey = new Map(usage.windows.map((window) => [window.key, window]));
  const ordered = [byKey.get('five_hour'), byKey.get('seven_day'), ...usage.windows].filter(Boolean) as AnthropicUsage['windows'];
  const seen = new Set<string>();
  return ordered
    .filter((window) => (seen.has(window.key) ? false : (seen.add(window.key), true)))
    .slice(0, 2)
    .map((window) => ({ key: window.key, label: titleCase(window.key), remainingPercent: remainingFrom(window.usedPercent), resetAt: window.resetAt ?? null }));
}

export function openAiBars(usage: OpenAiUsage | null): UsageBar[] {
  if (!usage?.windows?.length) return [];
  const byKey = new Map(usage.windows.map((window) => [window.key, window]));
  const ordered = [byKey.get('primary'), byKey.get('secondary'), ...usage.windows].filter(Boolean) as OpenAiUsage['windows'];
  const seen = new Set<string>();
  return ordered
    .filter((window) => (seen.has(window.key) ? false : (seen.add(window.key), true)))
    .slice(0, 2)
    .map((window) => ({ key: window.key, label: window.label || titleCase(window.key), remainingPercent: remainingFrom(window.usedPercent), resetAt: window.resetAt ?? null }));
}

// Session-only last successful values keep remounts from flashing empty cards.
const usageCardCache = new Map<string, AccountUsageCard>();
const accountCacheKey = (id: string, vendor: AccountVendor) => `${vendor}:${id}`;

export function useAccountUsage(providers: SavedProvider[], refreshMs = 300_000, revision = 0) {
  const accounts = useMemo(() => oauthAccounts(providers), [providers]);
  const signature = accounts.map((entry) => `${entry.provider.id}:${entry.vendor}`).join('|');
  const [cards, setCards] = useState<AccountUsageCard[]>([]);

  useEffect(() => {
    if (!accounts.length) { setCards([]); return; }
    let cancelled = false;
    setCards(accounts.map(({ provider, vendor }) => ({ ...(usageCardCache.get(accountCacheKey(provider.id, vendor)) ?? { plan: null, state: 'loading' as const, bars: [] }), id: provider.id, name: provider.provider || vendor, vendor })));

    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      await Promise.all(accounts.map(async ({ provider, vendor }) => {
        const key = accountCacheKey(provider.id, vendor);
        let next: AccountUsageCard;
        const base = { id: provider.id, name: provider.provider || vendor, vendor, plan: null as string | null };
        try {
          if (vendor === 'Anthropic') {
            const result = await api<{ usage?: AnthropicUsage | null }>(`/api/anthropic/oauth/usage?connectionId=${encodeURIComponent(provider.id)}`);
            next = { ...base, state: 'ready', bars: anthropicBars(result.usage ?? null) };
          } else {
            const result = await api<{ usage?: OpenAiUsage | null }>(`/api/openai/oauth/usage?connectionId=${encodeURIComponent(provider.id)}`);
            next = { ...base, accountStatus: result.usage?.accountStatus, plan: result.usage?.planType ? titleCase(result.usage.planType) : null, state: 'ready', bars: openAiBars(result.usage ?? null) };
          }
        } catch (error) {
          next = { ...base, plan: usageCardCache.get(key)?.plan ?? null, state: 'error', bars: usageCardCache.get(key)?.bars ?? [], error: error instanceof Error ? error.message : 'Usage unavailable' };
        }
        if (cancelled) return;
        if (next.state === 'ready') usageCardCache.set(key, next);
        setCards(current => current.map(card => card.id === provider.id && card.vendor === vendor ? next : card));
      }));
      loading = false;
    };

    void load();
    const interval = window.setInterval(() => void load(), refreshMs);
    return () => { cancelled = true; window.clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, refreshMs, revision]);

  return cards;
}

export function accountUsageStatus(card: AccountUsageCard, now = Date.now()): { label: string; tone: 'active' | 'paused' | 'quota-exceeded'; detail?: string } {
  if (card.state === 'loading') return { label: 'Checking', tone: 'paused' };
  if (card.state === 'error') return { label: 'Usage unavailable', tone: 'paused' };
  if (card.vendor !== 'OpenAI') {
    const known = card.bars.filter(bar => bar.remainingPercent !== null);
    if (!known.length) return { label: 'Unknown', tone: 'paused' };
    return known.some(bar => bar.remainingPercent === 0)
      ? { label: 'Limit Exceeded', tone: 'quota-exceeded' }
      : { label: 'Available', tone: 'active' };
  }
  const status = card.accountStatus;
  if (!status || !Number.isFinite(Date.parse(status.checkedAt))) return { label: 'Unknown', tone: 'paused' };
  const detail = `${status.reason} · ${status.scope}${status.resetAt ? ` · resets ${new Date(status.resetAt).toLocaleString()}` : ''} · checked ${new Date(status.checkedAt).toLocaleString()}`;
  if (now - Date.parse(status.checkedAt) > 600_000 || (status.resetAt && Date.parse(status.resetAt) <= now)) return { label: 'Stale', tone: 'paused', detail };
  return { label: status.status === 'available' ? 'Available' : status.label, tone: status.status === 'available' ? 'active' : status.status === 'unknown' ? 'paused' : 'quota-exceeded', detail };
}

function UsageMeter({ bar, tone }: { bar: UsageBar; tone: 'primary' | 'secondary' }) {
  const remaining = bar.remainingPercent;
  const level = remaining === null ? 'unknown' : remaining <= 15 ? 'low' : remaining <= 50 ? 'medium' : 'high';
  return <div className={`account-meter ${tone}`}>
    <div className="usage"><i style={{ width: `${remaining ?? 0}%` }} /></div>
    <small className={`usage-percent ${level}`}>{remaining === null ? '—' : `${remaining}%`}</small>
    <small className="account-reset-time" aria-hidden={!bar.resetAt}>{bar.resetAt ? formatResetIn(bar.resetAt) : '\u00a0'}</small>
  </div>;
}

export const accountStatusOrderKey = 'hc.accountStatusOrder';

export function orderAccountStatusCards(cards: AccountUsageCard[], order: string[]) {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...cards].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

export function AccountStatus({ providers }: { providers: SavedProvider[] }) {
  const [revision, setRevision] = useState(0);
  const cards = useAccountUsage(providers, 300_000, revision);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  const [order, setOrder] = useState(() => readAccountOrder(accountStatusOrderKey));
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const orderedCards = useMemo(() => orderAccountStatusCards(cards, order), [cards, order]);

  useEffect(() => {
    setOrder((current) => {
      const next = [...current, ...cards.map((card) => card.id).filter((id) => !current.includes(id))];
      if (next.length === current.length && next.every((id, index) => id === current[index])) return current;
      writeAccountOrder(accountStatusOrderKey, next);
      return next;
    });
  }, [cards]);

  const clearDrag = () => { setDraggedId(null); setDropTargetId(null); };
  const reorder = (dragged: string, target: string) => setOrder((current) => {
    const next = [...current];
    const sourceIndex = next.indexOf(dragged);
    const targetIndex = next.indexOf(target);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return current;
    next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, dragged);
    writeAccountOrder(accountStatusOrderKey, next);
    return next;
  });
  const handleDrop = (event: DragEvent<HTMLElement>, targetId: string) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData('text/plain') || draggedId;
    if (sourceId && sourceId !== targetId) reorder(sourceId, targetId);
    clearDrag();
  };

  if (!cards.length) return <div className="panel-body"><p className="hint">No Anthropic or OpenAI OAuth connections yet.</p></div>;
  return <section className="codex-content account-status">
    {orderedCards.map((card) => {
      const isDragging = draggedId === card.id;
      const isDropTarget = dropTargetId === card.id && !isDragging;
      const status = accountUsageStatus(card, now);
      return <AccountCard key={card.id} name={card.name} subtitle={card.vendor} status={<span title={status.detail}>{status.label}</span>} statusTone={status.tone} className={`${isDragging ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''}`} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', card.id); setDraggedId(card.id); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTargetId(card.id); }} onDragLeave={() => setDropTargetId((current) => current === card.id ? null : current)} onDrop={(event) => handleDrop(event, card.id)} onDragEnd={clearDrag}>
        {card.state === 'loading' && <small className="hint">Loading usage</small>}
        {card.state === 'error' && <small className="hint">{card.error ?? 'Usage unavailable'}</small>}
        {card.state === 'ready' && !card.bars.length && <small className="hint">No usage windows reported.</small>}
        {card.bars.length > 0 && <div className={`account-meters ${card.bars.length === 2 ? 'two-up' : ''}`}>
          {card.bars.map((bar, index) => <UsageMeter key={bar.key} bar={bar} tone={index === 0 ? 'primary' : 'secondary'} />)}
        </div>}
        {card.vendor === 'OpenAI' && <OpenAiResets connectionId={card.id} name={card.name} onUsageRefresh={() => setRevision(value => value + 1)} />}
      </AccountCard>;
    })}
  </section>;
}
