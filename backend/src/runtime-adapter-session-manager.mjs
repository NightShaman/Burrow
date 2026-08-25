import {
  assertRuntimeAdapter,
  createAdapterDescriptor,
  createRuntimeEvent,
  createRuntimeRunRef,
  createRuntimeSessionRef,
  isTerminalRunState,
} from './runtime-adapter-contract.mjs';

/**
 * Coordinates a provider-neutral adapter with durable binding state. This is
 * intentionally not wired into ordinary chat yet: it is the tested ownership
 * seam for the forthcoming Codex harness.
 */
export class RuntimeAdapterSessionManager {
  constructor({ adapter, descriptor, bindings, activityWriter = null, clock = () => new Date().toISOString() } = {}) {
    this.adapter = assertRuntimeAdapter(adapter);
    this.descriptor = createAdapterDescriptor(descriptor || { id: adapter.id, generation: adapter.generation, capabilities: adapter.capabilities });
    if (!bindings) throw new Error('runtime_bindings_required');
    this.bindings = bindings;
    this.activityWriter = activityWriter;
    this.clock = clock;
  }

  async createSession({ agentId, sessionId, metadata = {} } = {}) {
    const existing = this.bindings.getSessionBinding({ adapterId: this.descriptor.id, agentId, sessionId, adapterGeneration: this.descriptor.generation });
    if (existing?.nativeThreadId && existing.state === 'active') return existing;
    const result = await this.adapter.startSession({ adapter: this.descriptor, agentId, sessionId, metadata, binding: existing });
    const session = createRuntimeSessionRef({
      adapterId: this.descriptor.id,
      agentId,
      sessionId,
      adapterGeneration: this.descriptor.generation,
      nativeThreadId: result?.nativeThreadId,
      state: result?.state || 'active',
    });
    if (!session.nativeThreadId) throw new Error('runtime_adapter_native_thread_required');
    return this.bindings.upsertSessionBinding(session);
  }

  async resumeSession({ agentId, sessionId, metadata = {} } = {}) {
    const binding = this.bindings.getSessionBinding({ adapterId: this.descriptor.id, agentId, sessionId, adapterGeneration: this.descriptor.generation });
    if (!binding?.nativeThreadId) throw new Error('runtime_session_binding_not_found');
    const result = await this.adapter.resumeSession({ adapter: this.descriptor, binding, metadata });
    return this.bindings.upsertSessionBinding({
      ...binding,
      nativeThreadId: result?.nativeThreadId || binding.nativeThreadId,
      state: result?.state || 'active',
    });
  }

  async startRun({ agentId, sessionId, runId, input = {} } = {}) {
    const binding = this.bindings.getSessionBinding({ adapterId: this.descriptor.id, agentId, sessionId, adapterGeneration: this.descriptor.generation });
    if (!binding?.nativeThreadId) throw new Error('runtime_session_binding_not_found');
    const existing = this.bindings.getRunBinding({ runId });
    if (existing) return existing;
    const provisional = this.bindings.startRunBinding({ runId, sessionBindingId: binding.id, state: 'starting' });
    try {
      const result = await this.adapter.startRun({ adapter: this.descriptor, session: binding, run: provisional, input });
      const run = createRuntimeRunRef({ adapterId: this.descriptor.id, agentId, sessionId, runId, nativeTurnId: result?.nativeTurnId, state: result?.state || 'active' });
      if (!run.nativeTurnId) throw new Error('runtime_adapter_native_turn_required');
      const stored = this.bindings.updateRunBinding({ runId, nativeTurnId: run.nativeTurnId, state: run.state });
      this.bindings.setActiveTurn({ sessionBindingId: binding.id, runId, nativeTurnId: run.nativeTurnId, state: run.state });
      return stored;
    } catch (error) {
      this.bindings.terminalRunBinding({ runId, state: 'failed' });
      throw error;
    }
  }

  async cancelRun({ runId, reason = null } = {}) {
    const run = this.bindings.getRunBinding({ runId });
    if (!run) throw new Error('runtime_run_binding_not_found');
    if (isTerminalRunState(run.state)) return run;
    this.bindings.updateRunBinding({ runId, state: 'cancelling' });
    await this.adapter.cancelRun({ adapter: this.descriptor, run, reason });
    return this.bindings.terminalRunBinding({ runId, state: 'cancelled' });
  }

  async acceptEvent(event = {}) {
    const normalized = createRuntimeEvent({ ...event, adapterId: this.descriptor.id, timestamp: event.timestamp || this.clock() });
    const run = this.bindings.getRunBinding({ runId: normalized.runId });
    if (!run) return { ok: false, reason: 'run_binding_not_found', event: normalized };
    const sequence = this.bindings.updateRunSequence({ runId: normalized.runId, sequence: normalized.sequence });
    if (!sequence.ok) return { ok: false, reason: sequence.reason, event: normalized, run: sequence.record };
    if (normalized.type === 'activity' || normalized.type === 'context_status') {
      // Activity is durable chat-visible history but excluded from context.
      // The writer receives only normalized bounded projection data.
      await this.activityWriter?.(normalized);
    }
    if (normalized.type === 'completed' || normalized.type === 'cancelled' || normalized.type === 'failed') {
      this.bindings.terminalRunBinding({ runId: normalized.runId, state: normalized.type });
    }
    return { ok: true, event: normalized, run: this.bindings.getRunBinding({ runId: normalized.runId }) };
  }

  /** Map an adapter notification only after resolving the active native turn binding. */
  async acceptAdapterNotification({ agentId, sessionId, runId, sequence, timestamp = this.clock(), notification } = {}) {
    if (typeof this.adapter.mapEvent !== 'function') return { ok: false, reason: 'adapter_event_mapping_unsupported' };
    const binding = this.bindings.getSessionBinding({ adapterId: this.descriptor.id, agentId, sessionId, adapterGeneration: this.descriptor.generation });
    const run = this.bindings.getRunBinding({ runId });
    if (!binding || !run || run.sessionBindingId !== binding.id || !run.nativeTurnId) return { ok: false, reason: 'run_binding_not_found' };
    const event = this.adapter.mapEvent({ sessionId, runId, nativeTurnId: run.nativeTurnId, sequence, timestamp, notification });
    return event ? this.acceptEvent(event) : { ok: false, reason: 'notification_ignored' };
  }

  async closeSession({ agentId, sessionId, detach = true } = {}) {
    const binding = this.bindings.getSessionBinding({ adapterId: this.descriptor.id, agentId, sessionId, adapterGeneration: this.descriptor.generation });
    if (!binding) return null;
    await this.adapter.closeSession({ adapter: this.descriptor, binding, detach });
    return detach ? this.bindings.detachSessionBinding({ sessionBindingId: binding.id }) : this.bindings.closeSessionBinding({ sessionBindingId: binding.id });
  }
}
