import { resolveRuntimeStateConfig } from '../../src/config.mjs';
import { agentRuntimeContext } from '../../src/agent-registry.mjs';
import { archiveReadCheckpoint } from '../../src/archive-read-scope.mjs';

// Archive needs identity and filesystem provenance, not model selection, auth,
// or bootstrap writes. Read the registry under the same request owner and map
// paths from service environment with the established synchronous resolver.
export function createArchiveAgentContext({ agentsStore, rootDir } = {}) {
  const registry = {
    list: options => {
      const store = agentsStore();
      return store.listArchiveAgents(options);
    },
    get: (id, options) => agentsStore().resolveArchiveAgent(id, options),
    resolve: (id, options) => agentsStore().resolveArchiveAgent(id, options),
  };
  const runtimeConfig = () => ({ runtimeState: resolveRuntimeStateConfig({ rootDir }) });
  return {
    agentsStore: () => registry,
    runtimeConfig,
    async resolveAgentRuntime(reference, options = {}) {
      archiveReadCheckpoint(options);
      const state = runtimeConfig().runtimeState;
      const agent = await registry.resolve(String(reference || state.agentId), options);
      archiveReadCheckpoint(options);
      if (!agent) throw Object.assign(new Error('agent_not_found'), { statusCode: 404 });
      if (!agent.enabled) throw Object.assign(new Error('agent_disabled'), { statusCode: 409 });
      return agentRuntimeContext({ runtimeState: state, agent });
    },
  };
}
