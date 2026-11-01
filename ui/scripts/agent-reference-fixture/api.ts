const photos = new Map<string, { metadata: object; content: string }>();
let revision = 0;
export async function api(path: string, init: RequestInit = {}) {
  const id = decodeURIComponent(path.split('/')[3] || '');
  if (path.endsWith('/reference-image')) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (init.method && document.querySelector<HTMLInputElement>('#fail-writes')?.checked)
      throw new Error('Fixture upload unavailable. Retry when ready.');
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body as string);
      const key = `revision-${++revision}`;
      photos.set(id, {
        content: body.content,
        metadata: {
          id: key,
          attachmentId: key,
          contentUrl: `${path}/content?id=${key}`,
          mimeType: body.content.split(';')[0].slice(5),
          fileName: body.fileName,
          sizeBytes: atob(body.content.split(',')[1]).length,
          updatedAt: new Date().toISOString(),
        },
      });
    } else if (init.method === 'DELETE') photos.delete(id);
    return { ok: true, agentId: id, referenceImage: photos.get(id)?.metadata ?? null };
  }
  if (path.endsWith('/minion-model-selection')) return { ok: true, agentId: id, selection: null };
  if (path.endsWith('/minion-settings')) return { ok: true, agentId: id, maxDepth: 1 };
  throw new Error(`Fixture does not implement ${path}`);
}
export async function fetchApi(path: string, init: RequestInit) {
  const id = decodeURIComponent(path.split('/')[3]);
  const photo = photos.get(id);
  if (!photo) throw new Error('No fixture photo');
  if (init.signal?.aborted) throw new Error('Aborted');
  const bytes = Uint8Array.from(atob(photo.content.split(',')[1]), (c) => c.charCodeAt(0));
  return new Response(new Blob([bytes], { type: photo.content.split(';')[0].slice(5) }));
}
export const apiLocal = api;
export const jsonMutation = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
