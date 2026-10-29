// Native provider pooling owns only routing state, never provider credentials.
import { randomUUID } from 'node:crypto';

export const AFFINITY_CACHE_TTL_MS = 1_800_000;
export const USAGE_STALE_MS = 120_000;
// Percentage-point hysteresis: normal imbalance needs 25 points; low allowance
// needs a real 10-point improvement. Never compare raw tier-weighted capacity.
export const STICKY_REMAINING_FLOOR = 20;
export const STICKY_IMBALANCE_GAP = 25;
export const STICKY_MIN_IMPROVEMENT = 10;
const CAPACITIES = { openai: [1, 5, 10, 25], anthropic: [1, 5, 20, 1.25, 6.25] };
const time = (value) => typeof value === 'number' ? value : Date.parse(value);

export function poolThreadKey(options = {}) {
  const value = options.threadKey || options.threadId || options.conversationId || options.sessionId
    || options.session?.id || options.session?.sessionId || options.traceLogger?.conversationId || options.traceLogger?.sessionId;
  // Requests without a session must not accidentally share native state.
  return String(value || `request:${randomUUID()}`);
}

export function evaluatePoolUsage(result, { family, model = '', now = Date.now(), staleMs = USAGE_STALE_MS } = {}) {
  if (!result?.ok || !result.usage) return { eligible: false, reason: 'usage_missing' };
  const fetched = time(result.fetchedAt);
  if (!Number.isFinite(fetched) || now - fetched > staleMs || fetched > now + 60_000) return { eligible: false, reason: 'usage_stale' };
  const usage = result.usage;
  const metadata = usage.tierMetadata;
  const capacity = Number(metadata?.capacity ?? metadata?.capacityMultiplier ?? metadata?.weight ?? metadata?.multiplier);
  if (!metadata || metadata.known === false || metadata.supported === false || !CAPACITIES[family]?.includes(capacity)) {
    return { eligible: false, reason: 'tier_unknown', tier: metadata?.tier || metadata?.planType || usage.planType || null };
  }
  const windows = (usage.windows || []).filter((window) => {
    if (family !== 'anthropic') return !window.scope || window.scope === model;
    if (window.key === 'seven_day_sonnet') return /sonnet/i.test(model);
    if (window.key === 'seven_day_opus') return /opus/i.test(model);
    return window.key === 'five_hour' || window.key === 'seven_day' || window.key === 'seven_day_oauth_apps';
  });
  if (!windows.length || windows.some((window) => window.usedPercent == null || !Number.isFinite(Number(window.usedPercent)))) return { eligible: false, reason: 'usage_missing' };
  // Pressure and independent exhaustion are intentionally separate predicates.
  const exhausted = Boolean(usage.blocked) || windows.some((window) => Number(window.usedPercent) >= 100);
  const pressureThreshold = window => window.key === 'five_hour' || (family === 'openai' && (Number(window.windowSeconds) > 0 ? Number(window.windowSeconds) < 86_400 : window.key === 'primary')) ? 95 : 100;
  const pressure = windows.some(window => Number(window.usedPercent) > pressureThreshold(window));
  const used = Math.max(...windows.map((window) => Number(window.usedPercent)));
  const resets = windows.map((window) => time(window.resetAt)).filter((reset) => Number.isFinite(reset) && reset > now);
  const blockingResets = windows.filter(window => Number(window.usedPercent) >= 100 || Number(window.usedPercent) > pressureThreshold(window)).map(window => time(window.resetAt)).filter(reset => Number.isFinite(reset) && reset > now);
  return { eligible: !exhausted && !pressure, reason: exhausted ? 'quota_exhausted' : pressure ? 'quota_pressure' : null,
    exhausted, pressure, capacity, remainingPercent: Math.max(0, 100 - used), weight: capacity * Math.max(0, 1 - used / 100), resetAt: resets.length ? Math.min(...resets) : null, blockedUntil: blockingResets.length ? Math.max(...blockingResets) : null };
}

export class ProviderPoolEngine {
  constructor({ store, connection, usageService, clock = Date.now, random = Math.random, refreshConnection = null } = {}) {
    if (!store?.pool?.connect) throw new Error('provider_pool_postgres_required');
    if (!connection?.id) throw new Error('provider_pool_connection_required');
    this.refreshConnection = refreshConnection;
    this.db = store.pool;
    this.connection = connection;
    this.usageService = usageService;
    this.clock = clock;
    this.random = random;
    this.affinityCache = new Map(); // Advisory cache only: never bypass durable ownership reads.
  }

  async select({ threadKey, model, exclude = [], requiredMemberId = null } = {}) {
    const refreshed = await this.refreshConnection?.();
    if (refreshed) this.connection = refreshed.connection;
    const connection = this.connection;
    const flags = connection.pool || {};
    if (!flags.enabled) throw new Error('provider_pool_disabled');
    if (refreshed && !requiredMemberId && !connection.models?.some(item => item.id === model && item.selected !== false)) throw new Error('model_not_enabled_for_connection');
    const ids = [...new Set(flags.memberConnectionIds || [])];
    const family = connection.apiType === 'anthropic-lb' ? 'anthropic' : 'openai';
    const now = this.clock();
    const diagnostics = await Promise.all(ids.map(async (id) => {
      try {
        if (refreshed && !refreshed.members.find(member => member.id === id)?.models?.some(item => item.id === model)) return { id, eligible: false, reason: 'model_unavailable' };
        const method = family === 'anthropic' ? 'anthropicOauthUsage' : 'openaiOauthUsage';
        const usage = await this.usageService?.[method]?.({ connectionId: id });
        return { id, ...evaluatePoolUsage(usage, { family, model, now }) };
      } catch { return { id, eligible: false, reason: 'usage_missing' }; }
    }));
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // Transaction-scoped PostgreSQL lock also covers the initially absent row.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['provider-pool', connection.id, threadKey])]);
      const affinity = (await client.query('SELECT * FROM provider_pool_affinity WHERE pool_id=$1 AND thread_key=$2 FOR UPDATE', [connection.id, threadKey])).rows[0];
      const health = (await client.query('SELECT * FROM provider_pool_health WHERE pool_id=$1', [connection.id])).rows;
      for (const candidate of diagnostics) {
        if (exclude.includes(candidate.id)) { candidate.eligible = false; candidate.reason = 'attempt_failed'; }
        const state = health.find((row) => row.member_id === candidate.id);
        if (state && time(state.cooldown_until) > now) { candidate.eligible = false; candidate.reason = state.last_reason || 'cooldown'; }
      }
      // A continuation is not new work: usage and health are advisory, not
      // permission to strand an already executed tool result or signed turn.
      // Explicit pool disable, removal and failed member resolution remain hard.
      if (requiredMemberId) {
        const candidate = diagnostics.find(row => row.id === requiredMemberId);
        if (!candidate) throw Object.assign(new Error('provider_pool_continuation_owner_unavailable'), {
          diagnostics: [{ id: requiredMemberId, eligible: false, reason: 'member_removed' }, ...diagnostics],
          rejection: { memberId: requiredMemberId, reason: 'member_removed', hard: true },
        });
        if (refreshed && !refreshed.members.find(member => member.id === requiredMemberId)) throw Object.assign(new Error('provider_pool_continuation_owner_unavailable'), {
          diagnostics, rejection: { memberId: requiredMemberId, reason: 'member_removed', hard: true },
        });
        if (exclude.includes(requiredMemberId)) throw Object.assign(new Error('provider_pool_continuation_owner_unavailable'), {
          diagnostics, rejection: { memberId: requiredMemberId, reason: 'attempt_failed', hard: true },
        });
        candidate.continuationOverride = candidate.eligible ? [] : [candidate.reason];
        candidate.eligible = true;
        candidate.reason = null;
      }
      const available = diagnostics.filter((candidate) => candidate.eligible);
      const eligible = (id) => available.find((candidate) => candidate.id === id);
      let selected;
      let rebalanceReason = null;
      let owner = affinity?.owner_id;
      let substitute = null;
      let substituteUntil = null;
      if (requiredMemberId) {
        // Native IDs and signed blocks may only return to the account that made them.
        selected = eligible(requiredMemberId);
        if (!selected) throw Object.assign(new Error('provider_pool_continuation_owner_unavailable'), { diagnostics, rejection: { memberId: requiredMemberId, reason: diagnostics.find(row => row.id === requiredMemberId)?.reason || 'member_unavailable', hard: true } });
      } else if (flags.sticky !== false && owner && ids.includes(owner)) {
        if (affinity.substitute_id && time(affinity.substitute_until) > now) selected = eligible(affinity.substitute_id);
        if (!selected) selected = eligible(owner);
      }
      // Only unpinned requests may rebalance. Keep durable ownership until the
      // alternate actually succeeds; the adapter promotes with compare-and-swap.
      if (!requiredMemberId && flags.sticky !== false && selected) {
        const best = [...available].sort((a, b) => b.remainingPercent - a.remainingPercent)[0];
        const improvement = best.remainingPercent - selected.remainingPercent;
        if (best.id !== selected.id && (improvement >= STICKY_IMBALANCE_GAP ||
          selected.remainingPercent <= STICKY_REMAINING_FLOOR && improvement >= STICKY_MIN_IMPROVEMENT)) {
          rebalanceReason = improvement >= STICKY_IMBALANCE_GAP ? 'sticky_imbalance' : 'sticky_allowance_floor';
          selected = best;
        }
      }
      if (!selected && available.length) {
        if (flags.preferEarlierReset === true) selected = [...available].sort((a, b) => (a.resetAt ?? Infinity) - (b.resetAt ?? Infinity))[0];
        else {
          const total = available.reduce((sum, candidate) => sum + candidate.weight, 0);
          let cursor = this.random() * total;
          selected = available.find((candidate) => (cursor -= candidate.weight) < 0) || available.at(-1);
        }
      }
      if (!selected) throw Object.assign(new Error('provider_pool_no_eligible_members'), { diagnostics });
      // A temporarily unavailable owner retains ownership indefinitely. Removal is permanent.
      if (!owner || !ids.includes(owner) || flags.sticky === false) owner = selected.id;
      if (owner !== selected.id) {
        substitute = selected.id;
        const ownerState = health.find((row) => row.member_id === owner);
        const quotaReset = diagnostics.find((candidate) => candidate.id === owner)?.blockedUntil;
        substituteUntil = affinity?.substitute_id === selected.id && time(affinity.substitute_until) > now
          ? new Date(affinity.substitute_until)
          : new Date(Math.max(now + 60_000, time(ownerState?.cooldown_until) || 0, quotaReset || 0));
      }
      await client.query(`INSERT INTO provider_pool_affinity(pool_id,thread_key,owner_id,substitute_id,substitute_until,updated_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(pool_id,thread_key) DO UPDATE SET
        owner_id=EXCLUDED.owner_id,substitute_id=EXCLUDED.substitute_id,substitute_until=EXCLUDED.substitute_until,updated_at=EXCLUDED.updated_at`,
      [connection.id, threadKey, owner, substitute, substituteUntil, new Date(now)]);
      await client.query('COMMIT');
      for (const [key, cached] of this.affinityCache) if (cached.expiresAt <= now) this.affinityCache.delete(key);
      if (this.affinityCache.size >= 1000) this.affinityCache.delete(this.affinityCache.keys().next().value);
      this.affinityCache.set(threadKey, { ownerId: owner, expiresAt: now + AFFINITY_CACHE_TTL_MS });
      return { memberId: selected.id, ownerId: owner, logicalConnectionId: connection.id, diagnostics, substitute: owner !== selected.id, rebalanceReason };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  // Promote only after the alternate has successfully replayed the complete
  // request. The lock and compare-and-swap prevent a concurrent reroute from
  // being silently overwritten by a late replay response.
  async promote({ threadKey, memberId, previousOwnerId = null }) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['provider-pool', this.connection.id, threadKey])]);
      const result = await client.query(`UPDATE provider_pool_affinity
        SET owner_id=$3, substitute_id=NULL, substitute_until=NULL, updated_at=$4
        WHERE pool_id=$1 AND thread_key=$2 AND substitute_id=$3
        AND ($5::text IS NULL OR owner_id=$5)`,
      [this.connection.id, threadKey, memberId, new Date(this.clock()), previousOwnerId]);
      await client.query('COMMIT');
      if (result.rowCount) this.affinityCache.set(threadKey,
        { ownerId: memberId, expiresAt: this.clock() + AFFINITY_CACHE_TTL_MS });
      return result.rowCount === 1;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async cooldown(memberId, reason, durationMs = 60_000) {
    const now = this.clock();
    const result = await this.db.query(`INSERT INTO provider_pool_health(pool_id,member_id,cooldown_until,last_reason,updated_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(pool_id,member_id) DO UPDATE SET
      cooldown_until=GREATEST(provider_pool_health.cooldown_until,EXCLUDED.cooldown_until),last_reason=EXCLUDED.last_reason,updated_at=EXCLUDED.updated_at
      RETURNING cooldown_until,last_reason,updated_at`,
    [this.connection.id, memberId, new Date(now + durationMs), reason, new Date(now)]);
    return result.rows[0] || null;
  }
}
