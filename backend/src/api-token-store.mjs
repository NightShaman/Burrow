export const API_TOKEN_SCOPES = Object.freeze(['diagnostics:read']);

// Compatibility export only; persistence requires the PostgreSQL store.
export class ApiTokenStore {
  constructor() { throw new Error('postgres_required'); }
}
