import { googleNativeBase, discoverGoogleModels } from './model-adapters/google-native-catalog.mjs';
export function embeddingTimeout(value=process.env.BURROW_BRAIN_EMBEDDING_TIMEOUT_MS) {
 const n=Number(value ?? 30000);
 if(!Number.isSafeInteger(n) || n<1 || n>300000) throw new Error('brain_embedding_timeout_invalid');
 return n;
}
export function embeddingFailure(error) {
 const codes=['brain_embedding_provider_http_failed','brain_embedding_provider_request_failed',
  'brain_embedding_invalid_vector','brain_embedding_input_invalid','brain_embedding_connection_missing',
  'brain_embedding_provider_unsupported','brain_embedding_api_key_required','brain_embedding_invalid_response'];
 const code=codes.includes(error?.message) ? error.message : 'brain_embedding_provider_request_failed';
 return {code,retryable:error?.retryable ?? code==='brain_embedding_provider_request_failed'};
}
function providerFailure(code,retryable) { return Object.assign(new Error(code),{retryable}); }
// Embedding-only boundary: credentials stay in headers, never in URLs or errors.
export function embeddingKind(connection) {
 if (connection?.apiType === 'ollama' || /ollama/i.test(connection?.provider || '')) return 'ollama';
 if (/google|gemini/i.test(connection?.apiType || '') || /^(google|google-ai|google-gemini)$/i.test(connection?.provider || '') || new URL(connection?.baseUrl || 'http://invalid').hostname==='generativelanguage.googleapis.com') return 'google';
 throw new Error('brain_embedding_provider_unsupported');
}
export function embeddingVector(value) {
 if (!Array.isArray(value) || !value.length || value.some(x => typeof x !== 'number' || !Number.isFinite(x)) || !value.some(x => x !== 0)) throw new Error('brain_embedding_invalid_vector');
 return value;
}
export class BrainEmbeddingProvider {
 constructor({models,fetchImpl=fetch,timeoutMs=embeddingTimeout()}) { this.models=models; this.fetch=fetchImpl; this.timeoutMs=embeddingTimeout(timeoutMs); }
 async context(connectionId) {
  const connection=await this.models.get(connectionId);
  if (!connection) throw new Error('brain_embedding_connection_missing');
  const kind=embeddingKind(connection);
  const auth=kind==='google' ? await this.models.auth(connectionId) : null;
  if(kind==='google' && (auth?.type!=='api_key' || !auth.apiKey)) throw new Error('brain_embedding_api_key_required');
  let base=connection.baseUrl.replace(/\/$/,'').replace(kind==='ollama' ? /\/(?:api|v1)$/ : /\/(?:models|openai)$/,'');
  if(kind==='google') base=googleNativeBase(connection);
  return {connection,kind,base,headers:kind==='google'?{'x-goog-api-key':auth.apiKey}:{}};
 }
 async request(url,options,signal) {
  try {
   const response=await this.fetch(url,{...options,signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)});
   if (!response.ok) throw providerFailure('brain_embedding_provider_http_failed',response.status===408 || response.status===429 || response.status>=500);
   try { return await response.json(); }
   catch(error) {
    if(error instanceof SyntaxError) throw providerFailure('brain_embedding_invalid_response',false);
    throw error;
   }
  } catch(error) {
   if(['brain_embedding_provider_http_failed','brain_embedding_invalid_response'].includes(error?.message)) throw error;
   throw providerFailure('brain_embedding_provider_request_failed',true);
  }
 }
 async embed({connectionId,model,text,query=false,signal}) {
  if(typeof text!=='string' || !text.trim() || typeof model!=='string' || !model.trim()) throw new Error('brain_embedding_input_invalid');
  signal?.throwIfAborted();
  const c=await this.context(connectionId);
  signal?.throwIfAborted();
  const body=c.kind==='ollama' ? {model,input:text,truncate:false} : {model:`models/${model.replace(/^models\//,'')}`,content:{parts:[{text}]},taskType:query?'RETRIEVAL_QUERY':'RETRIEVAL_DOCUMENT'};
  const url=c.kind==='ollama' ? `${c.base}/api/embed` : `${c.base}/models/${encodeURIComponent(model.replace(/^models\//,''))}:embedContent`;
  const data=await this.request(url,{method:'POST',headers:{...c.headers,'content-type':'application/json'},body:JSON.stringify(body)},signal);
  return embeddingVector(c.kind==='ollama'?data.embeddings?.[0]:data.embedding?.values);
 }
 async discover(connectionId) {
  const c=await this.context(connectionId),models=[];
  if(c.kind==='google') {
   const discovered = await discoverGoogleModels({ baseUrl:c.base, apiKey:c.headers['x-goog-api-key'] }, { fetchImpl:(url,options) => this.fetch(url,{...options,signal:AbortSignal.timeout(this.timeoutMs)}) }).catch(() => { throw providerFailure('brain_embedding_provider_request_failed',true); });
   for (const m of discovered) if (m.supportedGenerationMethods.includes('embedContent')) models.push({id:m.id.replace(/^models\//,''),name:m.displayName || m.id});
  } else {
   const data=await this.request(`${c.base}/api/tags`,{headers:c.headers});
   for(const m of data.models || []) {
    const show=await this.request(`${c.base}/api/show`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:m.name})});
    if(show.capabilities?.includes('embedding')) models.push({id:m.name,name:m.name});
   }
  }
  return {connectionId,provider:c.kind,models,capabilityDisclosure:c.kind==='ollama'?'Only installed models explicitly advertising embedding via /api/show are listed. Older Ollama versions may not advertise capabilities; manual model selection requires a successful embedding test.':'Only models advertising embedContent are listed; chat model catalogs are not used.'};
 }
}
