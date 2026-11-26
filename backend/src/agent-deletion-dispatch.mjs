// Durable at-least-once delivery for identity deletion receipts. A single
// dispatcher owns retries across all active hosts; the database is the queue.
import { boundaryDiagnostic } from './diagnostic-boundary.mjs';
export function createAgentDeletionDispatch({ agents, getHosts = () => [], logger = console, intervalMs = 2000 } = {}) {
  let closed = false;
  let running = null;
  const drain = async () => {
    if (closed || running) return running;
    running = (async () => {
      for (const artifact of await agents.pendingIdentityDeletionArtifacts?.(25) || []) {
        try { await agents.cleanupIdentityDeletionArtifact(artifact.eventId); }
        catch (error) {
          const code=boundaryDiagnostic(error,'agent_reference_image_cleanup','agent_reference_image_cleanup_failed').errorCode;
          await agents.failIdentityDeletionArtifact?.(artifact.eventId,code);
          logger.warn?.('Agent reference image cleanup failed',{eventId:artifact.eventId,errorCode:code});
        }
      }
      for (const host of getHosts()) {
        const mod = host?.host ? host : null;
        const runtime = mod?.host || host;
        if (!runtime?.hasAgentDeletedHandler || !runtime.isAvailable()) continue;
        const modId = mod?.id || host.modId;
        if (!modId) continue;
        for (const event of await agents.pendingIdentityDeletions(modId, 25)) {
          try {
            const result = await runtime.invoke('agent-deleted', event);
            if (result?.ok === false) throw Object.assign(new Error('mod_identity_cleanup_failed'), { diagnostic: { errorCode: /^[a-z0-9_]{1,80}$/.test(String(result.errorCode || '')) ? result.errorCode : 'mod_identity_cleanup_failed' } });
            await agents.acknowledgeIdentityDeletion(event.eventId, modId);
          }
          catch (error) {
            const diagnostic = error?.diagnostic || error;
            const code = /^[a-z0-9_]{1,80}$/.test(String(diagnostic?.errorCode || diagnostic?.code || '')) ? String(diagnostic.errorCode || diagnostic.code) : 'mod_identity_cleanup_failed';
            await agents.failIdentityDeletion(event.eventId, modId, code);
            logger.warn?.('Mod identity cleanup failed', { modId, eventId: event.eventId, errorCode: code });
          }
        }
      }
    })().finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(() => { void drain().catch(() => logger.warn?.('Identity deletion queue unavailable')); }, intervalMs);
  timer.unref?.();
  agents.setIdentityDeletionWake?.(drain);
  void drain().catch(() => logger.warn?.('Identity deletion queue unavailable'));
  return { wake: drain, async close() { closed = true; clearInterval(timer); agents.setIdentityDeletionWake?.(null); await running; } };
}
