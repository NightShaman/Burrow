let basicCredentials: { username: string; password: string } | null = null;

export function getBasicAuthHeader() {
  if (!basicCredentials) return undefined;
  return `Basic ${btoa(`${basicCredentials.username}:${basicCredentials.password}`)}`;
}

export function setBasicCredentials(username: string, password: string) {
  basicCredentials = { username, password };
}

export function clearBasicCredentials() {
  basicCredentials = null;
}
