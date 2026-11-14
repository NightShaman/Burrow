import { sanitizeProviderMessage, providerErrorSecrets } from './model-failure.mjs';
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
 const message=sanitizeProviderMessage(error?.diagnosticMessage || (error?.message!==code ? error?.message : undefined));
 return {code,retryable:error?.retryable ?? code==='brain_embedding_provider_request_failed',...(message?{message}:{})};
}
function providerFailure(code,retryable,error,protectedValues=[]) {
 const diagnosticMessage=sanitizeProviderMessage(error?.diagnosticMessage || error?.message || (typeof error==='string'?error:undefined),protectedValues);
 return Object.assign(new Error(code),{retryable,...(diagnosticMessage?{diagnosticMessage}:{})});
}
// Consume only a bounded error response and select the reason, never stringify payloads.
async function responseReason(response) {
 if (!response.body?.getReader) return response.statusText || `HTTP ${response.status}`;
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 try {
  while(true) { const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>16384)break;chunks.push(Buffer.from(value)); }
 } catch {} finally { await reader.cancel().catch(()=>{}); }
 if(bytes<=16384) {
  const text=Buffer.concat(chunks).toString('utf8');
  try { const data=JSON.parse(text);const message=data?.error?.message || data?.message || (typeof data?.error==='string'?data.error:undefined);if(typeof message==='string')return message; } catch {
   if (/^text\/plain\b/i.test(response.headers?.get('content-type') || '')) return text;
  }
 }
 return response.statusText || `HTTP ${response.status}`;
}
function parsedBase(value) {
 try {
  const u=new URL(value);
  // Never send embedded credentials or arbitrary query parameters to providers.
  if(!['http:','https:'].includes(u.protocol) || u.username || u.password || u.hash || [...u.searchParams.keys()].some(k=>k!=='api-version') || u.searchParams.getAll('api-version').length>1) throw new Error();
  return u;
 } catch { throw new Error('brain_embedding_provider_unsupported'); }
}
function azureHost(u) { return u.hostname.endsWith('.openai.azure.com') || u.hostname.endsWith('.services.ai.azure.com'); }
// Embedding-only boundary: credentials stay in headers, never in URLs or errors.
export function embeddingKind(connection) {
 const u=parsedBase(connection?.baseUrl);
 if (connection?.apiType === 'ollama' || /ollama/i.test(connection?.provider || '')) return 'ollama';
 if (/google|gemini/i.test(connection?.apiType || '') || /^(google|google-ai|google-gemini)$/i.test(connection?.provider || '') || u.hostname==='generativelanguage.googleapis.com') return 'google';
 if (azureHost(u)) return 'azure';
 if (/^openai(?:-chat-completions|-completions|-responses)?$/i.test(connection?.apiType || '')) return 'openai';
 throw new Error('brain_embedding_provider_unsupported');
}
export function embeddingVector(value) {
 if (!Array.isArray(value) || !value.length || value.some(x => typeof x !== 'number' || !Number.isFinite(x)) || !value.some(x => x !== 0)) throw new Error('brain_embedding_invalid_vector');
 return value;
}
export class BrainEmbeddingProvider {
 constructor({models,fetchImpl=fetch,timeoutMs=embeddingTimeout()}) { this.models=models; this.fetch=fetchImpl; this.timeoutMs=embeddingTimeout(timeoutMs); }
 async context(connectionId,signal) {
  let connection;
  try { connection=await this.models.get(connectionId); } catch(error) { throw providerFailure('brain_embedding_provider_request_failed',true,error); }
  if (!connection) throw new Error('brain_embedding_connection_missing');
  const kind=embeddingKind(connection), u=parsedBase(connection.baseUrl);
  if (kind!=='azure' && u.search) throw new Error('brain_embedding_provider_unsupported');
  // ChatGPT/Codex subscription endpoints are not the embeddings API.
  if (u.hostname==='chatgpt.com' && u.pathname.startsWith('/backend-api')) throw new Error('brain_embedding_provider_unsupported');
  let auth=null;
  const authSecrets=[];
  if(kind!=='ollama' && this.models.auth) {
   try {
    auth=await this.models.auth(connectionId);
    authSecrets.push(...providerErrorSecrets({...connection,auth}));
    if(auth?.type==='oauth' && kind!=='google' && this.models.resolveAuth) {
     const resolved=await this.models.resolveAuth(connectionId,{fetchImpl:this.fetch,signal});
     auth={...auth,accessToken:resolved?.token};
    }
   } catch(error) { throw providerFailure('brain_embedding_provider_request_failed',true,error,[...authSecrets,...providerErrorSecrets({...connection,auth})]); }
  }
  if(kind==='google' && (auth?.type!=='api_key' || !auth.apiKey)) throw new Error('brain_embedding_api_key_required');
  let headers={};
  if(kind==='google') headers={'x-goog-api-key':auth.apiKey};
  else if(kind!=='ollama' && auth) {
   const token=auth.type==='api_key'?auth.apiKey:['oauth','token','bearer_token'].includes(auth.type)?(auth.accessToken || auth.token):null;
   if(!token) throw new Error('brain_embedding_api_key_required');
   headers=kind==='azure' && auth.type==='api_key'?{'api-key':token}:{authorization:`Bearer ${token}`};
  }
  let base=u.origin+u.pathname.replace(/\/+$/,'');
  let version=u.searchParams.get('api-version');
  if(version && !/^\d{4}-\d{2}-\d{2}(?:-preview)?$/.test(version)) throw new Error('brain_embedding_provider_unsupported');
  if(kind==='google') base=googleNativeBase(connection);
  if(kind==='ollama') base=base.replace(/\/(?:api|v1)$/,'');
  if(kind==='azure') {
   // A version query or /openai[/deployments/...] selects Azure's legacy deployment API.
   const legacy=Boolean(version) || /\/openai(?:\/deployments\/[^/]+)?$/.test(base);
   if(legacy) {
    base=base.replace(/\/openai(?:\/v1|\/deployments\/[^/]+)?$/,'');
    version=version || '2024-10-21';
   } else if(!base.endsWith('/openai/v1')) base+='/openai/v1';
  } else if(kind==='openai' && !base.endsWith('/v1')) base+='/v1';
  return {connection,kind,base,headers,version,protectedValues:[...authSecrets,...providerErrorSecrets({...connection,auth},headers)]};
 }
 async request(url,options,signal,protectedValues=providerErrorSecrets({},options.headers)) {
  try {
   const response=await this.fetch(url,{...options,redirect:'error',signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)});
   if (!response.ok) throw providerFailure('brain_embedding_provider_http_failed',response.status===408 || response.status===429 || response.status>=500,await responseReason(response),protectedValues);
   try { return await response.json(); }
   catch(error) {
    if(error instanceof SyntaxError) throw providerFailure('brain_embedding_invalid_response',false,'Provider returned invalid JSON',protectedValues);
    throw error;
   }
  } catch(error) {
   if(['brain_embedding_provider_http_failed','brain_embedding_invalid_response'].includes(error?.message)) throw error;
   throw providerFailure('brain_embedding_provider_request_failed',true,error,protectedValues);
  }
 }
 async embed({connectionId,model,text,query=false,signal}) {
  if(typeof text!=='string' || !text.trim() || typeof model!=='string' || !model.trim()) throw new Error('brain_embedding_input_invalid');
  signal?.throwIfAborted();
  const c=await this.context(connectionId,signal);
  signal?.throwIfAborted();
  let body,url;
  if(c.kind==='ollama') { body={model,input:text,truncate:false}; url=`${c.base}/api/embed`; }
  else if(c.kind==='google') { body={model:`models/${model.replace(/^models\//,'')}`,content:{parts:[{text}]},taskType:query?'RETRIEVAL_QUERY':'RETRIEVAL_DOCUMENT'}; url=`${c.base}/models/${encodeURIComponent(model.replace(/^models\//,''))}:embedContent`; }
  else {
   body={model,input:text};
   if(c.kind==='azure' && c.version) {
    if(model==='.' || model==='..') throw new Error('brain_embedding_input_invalid');
    url=`${c.base}/openai/deployments/${encodeURIComponent(model)}/embeddings?api-version=${c.version}`;
   } else url=`${c.base}/embeddings`;
  }
  const data=await this.request(url,{method:'POST',headers:{...c.headers,'content-type':'application/json'},body:JSON.stringify(body)},signal,c.protectedValues);
  if(c.kind==='openai' || c.kind==='azure') {
   if(!data || data.error || !Array.isArray(data.data) || data.data.length!==1 || !data.data[0] || (data.data[0].index!=null && data.data[0].index!==0)) throw providerFailure('brain_embedding_invalid_response',false,data?.error?.message,c.protectedValues);
   return embeddingVector(data.data[0].embedding);
  }
  return embeddingVector(c.kind==='ollama'?data?.embeddings?.[0]:data?.embedding?.values);
 }
 async discover(connectionId,{signal}={}) {
  signal?.throwIfAborted();
  const c=await this.context(connectionId,signal),models=[];
  signal?.throwIfAborted();
  if(c.kind==='google') {
   const discovered = await discoverGoogleModels({ baseUrl:c.base, apiKey:c.headers['x-goog-api-key'] }, { signal, fetchImpl:(url,options) => this.fetch(url,{...options,redirect:'error',signal:options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)}) }).catch(error => { throw providerFailure('brain_embedding_provider_request_failed',true,error,c.protectedValues); });
   for (const m of discovered) if (m.supportedGenerationMethods.includes('embedContent')) models.push({id:m.id.replace(/^models\//,''),name:m.displayName || m.id});
  } else if(c.kind==='ollama') {
   const data=await this.request(`${c.base}/api/tags`,{headers:c.headers},signal,c.protectedValues);
   for(const m of data.models || []) {
    const show=await this.request(`${c.base}/api/show`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:m.name})},signal,c.protectedValues);
    if(show.capabilities?.includes('embedding')) models.push({id:m.name,name:m.name});
   }
  }
  // OpenAI-compatible model catalogs do not reliably disclose embedding support;
  // Azure deployment lists often require management permissions. Never claim chat
  // models are embedding-capable. The operator can enter and test a model/deployment.
  const capabilityDisclosure=c.kind==='ollama'?'Only installed models explicitly advertising embedding via /api/show are listed. Older Ollama versions may not advertise capabilities; manual model selection requires a successful embedding test.':c.kind==='google'?'Only models advertising embedContent are listed; chat model catalogs are not used.':'Embedding capability cannot be established from this provider\'s model catalog. Enter a model or deployment manually and test it.';
  return {connectionId,provider:c.kind,models,capabilityDisclosure};
 }
}
