import { describe, expect, it } from 'vitest';
import { createMcpDiagnosticRequest, serializeEnvironmentVariables } from './McpConnections';

describe('serializeEnvironmentVariables', () => {
  it('sends a newly entered MCP secret', () => {
    expect(serializeEnvironmentVariables([{ name: 'BW_SESSION', value: 'opaque-session-token', configured: false }])).toEqual([
      { name: 'BW_SESSION', value: 'opaque-session-token' },
    ]);
  });

  it('omits blank new rows while retaining configured rows without their secret', () => {
    expect(serializeEnvironmentVariables([
      { name: '', value: '', configured: false },
      { name: 'NEW_SECRET', value: '', configured: false },
      { name: 'EXISTING_SECRET', value: '', configured: true },
    ])).toEqual([{ name: 'EXISTING_SECRET' }]);
  });
});


describe('createMcpDiagnosticRequest', () => {
  it('limits operator diagnostics to a connection-level check without tool arguments', () => {
    expect(createMcpDiagnosticRequest('bitwarden')).toEqual({ connectionId: 'bitwarden' });
  });
});
