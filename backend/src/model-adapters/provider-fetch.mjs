import { wireFingerprint } from './wire-fingerprint.mjs';
// This receipt is local invocation evidence only, never provider acceptance.
// Attach both promises immediately so a rejected fetch cannot go unobserved
// while durable diagnostics are being written.
export async function invokeProviderFetch(fetchImpl, url, options, { traceLogger, requestId, provider, api, model, clock = () => new Date().toISOString() } = {}) {
  const invokedAt = clock();
  let response;
  try { response = fetchImpl(url, options); }
  catch (error) { response = Promise.reject(error); }
  const receipt = Promise.resolve().then(async () => {
    const wire = traceLogger?.artifact ? wireFingerprint(options?.body) : null;
    const wireFingerprintArtifact = wire ? await traceLogger.artifact(`provider-wire-${requestId}.json`, JSON.stringify({ requestId, provider, api, model, invokedAt, ...wire })) : null;
    return traceLogger?.event?.('provider-fetch-invoked', {
      requestId, provider, api, model, invokedAt,
      boundary: 'local-fetch-invocation', providerAcceptance: 'unknown', wireFingerprintArtifact,
    });
  });
  const [result] = await Promise.all([response, receipt]);
  return result;
}
