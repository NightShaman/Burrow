import { createModelAdapter } from './model-adapter.mjs';
import { preferenceConversationContext, preferenceRuleReviewIdentity, preferenceRuleReviewPrompt, preferenceBaselineAsync, preferenceOperatorBaselineAt, recoverablePreferenceSignalIds, applyPreferenceUpdateAsync, parsePreferenceAdjudication, preferenceAdjudicationPrompt, preferenceLearningStateAsync, preferenceSignalsAsync, validatePreferenceAdjudication } from './preference-learning.mjs';

function text(value) { return String(value ?? '').trim(); }

// Keep the runner's shared prompt budget and model-completion policies injectable.
export function createPreferenceAdjudicator({ fitsPrompt, completeTextResult }) {
  return async function adjudicatePreferencesAsync({ agentId, profileStore, metadataStore, generatedAt, modelAdapter = null, modelConfig = null, traceLogger = null, onProgress = null, cycleStore = null, sourceMessages = [] } = {}) {
  if (!profileStore?.atomicPreferenceUpdate) throw new Error('dream_profile_store_required');
  let signals = [];
  try {
    const state = await preferenceLearningStateAsync({ agentId, metadataStore });
    const retained = await preferenceSignalsAsync({ agentId, metadataStore, limit: null });
    const legacyBlocked = state.version < 2 && state.reviewedDisposition === 'operator_baseline_newer';
    const receipts = legacyBlocked && cycleStore?.listArchiveDreamCycleReceipts ? await cycleStore.listArchiveDreamCycleReceipts({ agentId }) : [];
    const recoveredSignalIds = recoverablePreferenceSignalIds({ state, receipts, signals: retained });
    const reviewed = new Set(state.reviewedSignalIds || []);
    signals = retained.filter(item => !reviewed.has(item.id) || recoveredSignalIds.includes(item.id));
    const baseline = await preferenceBaselineAsync({ agentId, profileStore });
    const rules = typeof profileStore.preferenceRulesSnapshot === 'function' ? await profileStore.preferenceRulesSnapshot(agentId) : null;
    const maintenanceDue = /^# (?:PREFERENCES|Operator Preferences)\s*$/imu.test(baseline?.markdown || '') &&
      baseline.markdown.split('\n').some(line => line.trim() && !/^\s*#/u.test(line)) &&
      (!state.lastMaintenanceAt || Date.parse(generatedAt) - Date.parse(state.lastMaintenanceAt) >= 86400_000);
    if (!signals.length && !maintenanceDue) return { disposition: 'no_new_signals', signalCount: 0 };
    const operatorAt = preferenceOperatorBaselineAt(baseline, state);
    const sources = new Map(sourceMessages.filter(item => item.role === 'user' && item.operatorInput !== false).map(item => [item.sourceRef, item]));
    signals = signals.map(item => {
      // Legacy extraction timestamps are NOT source dates. Recover chronology
      // only from the original eligible operator messages, when all are retained.
      const originals = (item.sourceRefs || []).map(ref => sources.get(ref));
      if (!originals.length || originals.some(source => !source)) return item;
      const dates = originals.map(source => Object.hasOwn(source, 'preferenceAt') ? source.preferenceAt : source.at);
      const dated = dates.every(value => Number.isFinite(Date.parse(value))) ? dates.sort() : [];
      return { ...item, sourceAt: dated[0] || null, sourceEndAt: dated.at(-1) || null, evidence: originals.map(source => ({ sourceRef: source.sourceRef, at: Object.hasOwn(source, 'preferenceAt') ? source.preferenceAt : source.at, content: source.content })), context: item.context?.length ? item.context : preferenceConversationContext(sourceMessages, item.sourceRefs) };
    });
    const pendingCount = signals.length;
    const eligible = signals.filter(item => item.sourceRefs?.length && item.evidence?.length === item.sourceRefs.length && (!operatorAt || (item.sourceAt && Date.parse(item.sourceAt) > Date.parse(operatorAt))));
    const deferredSignalCount = pendingCount - eligible.length;
    const maintenance = !eligible.length && maintenanceDue;
    if (!eligible.length && !maintenance) return { disposition: 'deferred', signalCount: pendingCount, deferredSignalCount, reason: 'source_predates_operator_baseline_or_unknown' };
    const audit = await metadataStore.get(`preference-audit:${agentId}`);
    const priorGuidance = (audit?.entries || []).filter(entry => entry.disposition === 'updated').flatMap(entry => entry.guidance || []);
    const reviewSignals = maintenance ? retained.filter(item => item.context?.length) : [];
    const reviewContext = reviewSignals.map(({ guidance, context }) => ({ guidance, context }));
    const promptFor = items => preferenceAdjudicationPrompt({ preferences: baseline?.markdown ?? '', signals: items, priorGuidance, rules, maintenance, reviewContext });
    // Process oldest evidence first; backlog size must not exceed the configured model budget.
    signals = [];
    for (const item of eligible.sort((a, b) => String(a.sourceAt || a.observedAt).localeCompare(String(b.sourceAt || b.observedAt)))) {
      const trial = [...signals, item];
      if (!fitsPrompt(promptFor(trial), modelConfig)) {
        if (!signals.length) return { disposition: 'deferred', pending: true, signalCount: pendingCount, reason: 'preference_evidence_exceeds_model_budget' };
        break;
      }
      signals = trial;
    }
    if (!fitsPrompt(promptFor(signals), modelConfig)) return { disposition: 'deferred', pending: true, signalCount: pendingCount, reason: 'preference_evidence_exceeds_model_budget' };
    let adapter = modelAdapter;
    if (!adapter && modelConfig?.model) adapter = createModelAdapter({ config: { ...modelConfig, temperature: 0, reasoningEffort: 'off' } });
    if (!adapter) return { disposition: 'model_unavailable', signalCount: pendingCount };
    const result = await completeTextResult({ content: promptFor(signals), modelAdapter: adapter, modelConfig, traceLogger, onProgress });
    const proposal = parsePreferenceAdjudication(result.text);
    let validation = validatePreferenceAdjudication({ proposal, signals, preferences: baseline?.markdown ?? '', rules, maintenance });
    if (validation.reason === 'rule_intent_review_required') {
      const review = await completeTextResult({ content: preferenceRuleReviewPrompt({ proposal, signals, rules }), modelAdapter: adapter, modelConfig, traceLogger, onProgress });
      let authorization;
      try { authorization = JSON.parse(review.text); } catch { authorization = null; }
      if (authorization?.approved !== true) return { disposition: 'review', pending: true, signalCount: pendingCount, reason: 'rule_intent_review_required', reviewReason: text(authorization?.reason) || 'RULES change needs clear standing intent and ownership.' };
      validation = validatePreferenceAdjudication({ proposal, signals, preferences: baseline?.markdown ?? '', rules, maintenance,
        ruleAuthorization: { approved: true, identity: preferenceRuleReviewIdentity({ proposal, signals, rules }) } });
    }
    if (validation.reason === 'preference_review_required') return { disposition: 'review', pending: true, signalCount: pendingCount, reason: validation.reason, reviewReason: proposal.reviewReason };
    if (!validation.ok) return { disposition: 'rejected', signalCount: pendingCount, pending: true, reason: validation.reason || null };
    const update = await applyPreferenceUpdateAsync({ agentId, markdown: validation.disposition === 'noop' ? null : proposal.markdown, sourceSignals: validation.signals,
      baseline, recoveredSignalIds, legacyReviewedAt: state.lastReviewedAt, profileStore, maintenance, reviewSignals, rulesBaseline: rules, ruleAmendments: validation.ruleAmendments, at: generatedAt });
    return { disposition: update.applied ? 'updated' : update.reason, signalCount: pendingCount, deferredSignalCount,
      maintenance, ...(proposal.reviewReason ? { reviewReason: proposal.reviewReason } : {}), rulesChanged: update.rulesChanged === true, pending: !update.reviewed || pendingCount > validation.signals.length, signalIds: validation.signals.map(item => item.id), reason: proposal.reason };
  } catch (error) { return { disposition: 'failed', pending: true, signalCount: signals.length, reason: String(error?.message || error) }; }
}

}
