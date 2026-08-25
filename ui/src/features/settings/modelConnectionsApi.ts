import { api, type RuntimeModel } from '../../app/api';

export type ClaudeCodeLogin = {
  id: string;
  status: string;
  verificationUrl?: string | null;
  prompt?: string | null;
  expiresAt?: string | null;
  error?: string | null;
  connection?: OpenAiOAuthConnection | null;
};

export type OpenAiOAuthConnection = {
  id: string;
  provider?: string;
  apiType?: string;
  baseUrl?: string;
  models?: Array<string | RuntimeModel>;
  apiKeyConfigured?: boolean;
  authConfigured?: boolean;
};

export type OpenAiOAuthLogin = {
  id: string;
  status: string;
  authorizationUrl?: string | null;
  redirectUri?: string | null;
  expiresAt?: string | null;
  error?: string | null;
  connection?: OpenAiOAuthConnection | null;
};

const jsonPost = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const modelConnectionsApi = {
  discover: (connection: { id?: string; provider: string; apiType: string; baseUrl: string; apiKey: string; models: RuntimeModel[] }) =>
    api<{ models: RuntimeModel[]; discovery?: { status?: string; error?: string } }>('/api/settings/model-connections/discover', jsonPost(connection)),

  startOpenAiOAuth: () =>
    api<{ connection: OpenAiOAuthConnection; login: OpenAiOAuthLogin }>('/api/settings/model-connections/openai-oauth/start', jsonPost({})),
  getOpenAiOAuthLogin: (loginId: string) =>
    api<{ login: OpenAiOAuthLogin }>(`/api/settings/model-connections/openai-oauth/${encodeURIComponent(loginId)}`),
  submitOpenAiOAuthCode: (loginId: string, input: string) =>
    api<{ login: OpenAiOAuthLogin }>(`/api/settings/model-connections/openai-oauth/${encodeURIComponent(loginId)}/submit-code`, jsonPost({ input })),
  cancelOpenAiOAuth: (loginId: string) =>
    api<{ login: OpenAiOAuthLogin }>(`/api/settings/model-connections/openai-oauth/${encodeURIComponent(loginId)}/cancel`, { method: 'POST' }),

  startClaudeCodeLogin: (connectionId?: string) =>
    api<{ connection?: OpenAiOAuthConnection | null; login: ClaudeCodeLogin }>('/api/settings/model-connections/claude-code-login/start', jsonPost(connectionId ? { connectionId } : {})),
  getClaudeCodeLogin: (loginId: string) =>
    api<{ login: ClaudeCodeLogin }>(`/api/settings/model-connections/claude-code-login/${encodeURIComponent(loginId)}`),
  submitClaudeCode: (loginId: string, code: string) =>
    api<{ login: ClaudeCodeLogin }>(`/api/settings/model-connections/claude-code-login/${encodeURIComponent(loginId)}/submit-code`, jsonPost({ code })),
  cancelClaudeCodeLogin: (loginId: string) =>
    api<{ login: ClaudeCodeLogin }>(`/api/settings/model-connections/claude-code-login/${encodeURIComponent(loginId)}/cancel`, { method: 'POST' }),
  importClaudeCodeLogin: (loginId: string, connectionId?: string) =>
    api<{ login: ClaudeCodeLogin }>(`/api/settings/model-connections/claude-code-login/${encodeURIComponent(loginId)}/import`, jsonPost(connectionId ? { connectionId } : {})),
};
