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

export function clearBasicCredentials() {
  basicCredentials = null;
}
