import { resolveModelConfig } from './config.mjs';
import { forgeConnectionModels, forgeMediaContract, forgeModelConfig } from './model-adapters/forge-media-contract.mjs';
import { XAI_SPEECH_SELECTOR } from './model-adapters/xai-media-contract.mjs';

/** Forge-only resolver. Never put the connection-level TTS selector in the chat
 * model catalog, save invented models, or borrow credentials from another model. */
export async function resolveForgeConfig({ stores, connectionId, modelId, fetchImpl, signal } = {}) {
  const connection = await stores.models.get(connectionId);
  if (!connection) throw new Error('model_connection_not_found');
  const model = forgeConnectionModels(connection).find(item => item.id === modelId && item.selected !== false);
  if (!model) throw new Error('model_not_enabled_for_connection');
  const declared = forgeModelConfig(connection, model);
  const contract = forgeMediaContract(declared);
  if (!contract) throw new Error('provider_contract_unavailable');
  if (contract.id === 'xai-speech' && modelId === XAI_SPEECH_SELECTOR) {
    const auth = await stores.models.resolveAuth(connectionId, { fetchImpl, signal });
    const token = auth?.token ?? auth?.apiKey ?? auth?.accessToken;
    return { ...declared, api: connection.apiType, apiKey: token, auth: { ...auth, token }, connectionId };
  }
  const resolved = await resolveModelConfig({ stores, modelConnectionId: connectionId, model: modelId, fetchImpl, abortSignal: signal });
  // Use identical override/discovery/input precedence on both sides of Forge.
  return { ...resolved, acceptedInput: declared.acceptedInput, acceptedOutput: declared.acceptedOutput,
    capabilities: declared.capabilities, supportedGenerationMethods: declared.supportedGenerationMethods };
}
