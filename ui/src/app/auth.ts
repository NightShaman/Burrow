let basicCredentials: { username: string; password: string } | null = null;

/** Encode Basic credentials as UTF-8 bytes, as required by the auth contract. */
function encodeBasicCredentials(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

export function getBasicAuthHeader() {
  if (!basicCredentials) return undefined;
  return `Basic ${encodeBasicCredentials(`${basicCredentials.username}:${basicCredentials.password}`)}`;
}

export function setBasicCredentials(username: string, password: string) {
  basicCredentials = { username, password };
}

export function hasBasicCredentials() {
  return basicCredentials !== null;
}

export function clearBasicCredentials() {
  basicCredentials = null;
}

export type AuthDiscovery = { mode: 'none' | 'basic' };

/** Discover effective runtime auth before mounting the application. */
export async function discoverAuthMode(signal?: AbortSignal): Promise<AuthDiscovery> {
  const response = await fetch('/api/auth/discovery', { headers: { accept: 'application/json' }, signal });
  const body = await response.json().catch(() => ({})) as Partial<AuthDiscovery>;
  if (!response.ok || (body.mode !== 'none' && body.mode !== 'basic')) throw new Error('auth_discovery_failed');
  return { mode: body.mode };
}

/** Validate credentials against the runtime without committing them to session state. */
export async function validateBasicCredentials(username: string, password: string, signal?: AbortSignal): Promise<void> {
  const encoded = encodeBasicCredentials(`${username}:${password}`);
  const response = await fetch('/api/auth/validate', {
    headers: { accept: 'application/json', authorization: `Basic ${encoded}` }, signal,
  });
  if (!response.ok) throw new Error('invalid_credentials');
}
