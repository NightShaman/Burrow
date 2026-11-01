import { artifactResponseHeaders } from '../../src/artifact-response-policy.mjs';
import { REFERENCE_IMAGE_MAX_BYTES } from '../../src/model-adapters/reference-image-capability.mjs';

export function createAgentReferenceImageRoutes({ store, readJsonBody, sendJson }) {
  return async ({ req, res, url }) => {
    const match = /^\/api\/agents\/([^/]+)\/reference-image(\/content)?$/.exec(url.pathname);
    if (!match) return false;
    try {
      const agentId = decodeURIComponent(match[1]);
      const images = store();
      if (match[2] && req.method === 'GET') {
        const { image, bytes } = await images.read(agentId, url.searchParams.get('id'));
        res.writeHead(200, { 'content-type': image.mimeType, 'content-length': bytes.length,
          ...artifactResponseHeaders({ name: image.fileName, mimeType: image.mimeType }) });
        res.end(bytes);
      } else if (!match[2] && ['GET', 'PUT', 'DELETE'].includes(req.method)) {
        const referenceImage = req.method === 'GET' ? await images.get(agentId)
          : req.method === 'DELETE' ? await images.remove(agentId)
          : await images.put(agentId, await readJsonBody(req, { maxBytes: Math.ceil(REFERENCE_IMAGE_MAX_BYTES / 3) * 4 + 2048 }));
        sendJson(res, 200, { ok: true, agentId, referenceImage });
      } else sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    } catch (error) {
      const badId = error instanceof URIError;
      sendJson(res, badId ? 400 : error.statusCode || 500, { ok: false, error: badId ? 'agent_reference_image_invalid' : error.statusCode ? error.message : 'agent_reference_image_unavailable' });
    }
    return true;
  };
}
