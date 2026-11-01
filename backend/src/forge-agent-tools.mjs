// Native Forge tools share the operator-owned ForgeStore used by HTTP routes.
let sharedStore = null;
let sharedStoreFactory = null;
export function configureForgeStore(store) { sharedStore = store; sharedStoreFactory = null; return store; }
export function configureForgeStoreFactory(factory) { sharedStoreFactory = factory; sharedStore = null; return factory; }
export function forgeStore() { if (!sharedStore && sharedStoreFactory) sharedStore = sharedStoreFactory(); return sharedStore; }
function requireStore() { const store = forgeStore(); if (!store) throw new Error('forge_unavailable'); return store; }

const SAFE_FORGE_ERRORS = new Set([
  'forge_unavailable', 'forge_not_found', 'forge_job_not_found', 'forge_artifact_not_found',
  'forge_conflict', 'idempotency_conflict', 'forge_request_invalid', 'forge_model_unavailable',
  'forge_job_not_succeeded', 'forge_context_unavailable', 'session_not_found',
  'source_attachments_unsupported', 'generation_options_unsupported', 'generation_failed', 'forge_selection_missing',
  'reference_images_too_large', 'agent_reference_image_missing', 'agent_reference_image_invalid', 'agent_reference_image_unsupported', 'agent_reference_image_image_only',
]);
function safeForgeError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const safe = SAFE_FORGE_ERRORS.has(message) ? message : null;
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : null;
  return { message: safe || (statusCode === 404 ? 'forge_not_found' : statusCode === 409 ? 'forge_conflict' : 'forge_operation_failed'), statusCode };
}
export function forgeFailure(error) {
  const safe = safeForgeError(error);
  return { ok: false, error: safe.message, ...(safe.statusCode ? { statusCode: safe.statusCode } : {}) };
}
export const forgeToolSchemas = [
 { type:'function', function:{ name:'forge_catalog', description:'Discover Forge models/defaults, per-model agentReferenceImage capability, all registered agents with saved portraits in agentReferenceImages, and your own portrait in agentReferenceImage. Each portrait attachmentId can be reopened via attachment_view. Arbitrary source attachments, video, and provider tuning remain unsupported.', parameters:{type:'object',additionalProperties:false,properties:{reason:{type:'string'}}} } },
 { type:'function', function:{ name:'forge_create_job', description:'Explicitly request a potentially paid asynchronous Forge generation. Never use this without the operator asking for generation. Set mode and leave both connectionId and modelId null to use its configured default; supply both nonempty IDs to choose a model explicitly. For a supported image model, useAgentReferenceImage true includes your own saved portrait from Settings > Agent > Agent Details; referenceAgentIds can select other registered agents with saved portraits from forge_catalog. Combining both deduplicates self; order of first selection determines image order. False, null, or omission of the flag and empty/null referenceAgentIds uses text-only generation. Missing portraits or unsupported models fail without dispatch or fallback; never supply image bytes or paths. Missing defaults or invalid selections fail; no automatic model fallback. Poll forge_inspect_job until the job reaches a terminal status; then attach a succeeded artifact.', parameters:{type:'object',additionalProperties:false,properties:{mode:{type:'string',enum:['image','music','speech','video']},connectionId:{type:['string','null']},modelId:{type:['string','null']},prompt:{type:'string'},idempotencyKey:{type:'string'},useAgentReferenceImage:{type:['boolean','null'],description:'Include the current agent saved portrait. Image jobs and supported models only.'},referenceAgentIds:{type:['array','null'],items:{type:'string',minLength:1},description:'Ordered registered agent IDs whose saved portraits should be included. May include your own ID; duplicate IDs are ignored. Null/empty array means no additional references.'},reason:{type:'string'}},required:['prompt','idempotencyKey']} } },
 { type:'function', function:{ name:'forge_list_jobs', description:'List durable Forge jobs owned by the current operator, newest first.', parameters:{type:'object',additionalProperties:false,properties:{reason:{type:'string'}}} } },
 { type:'function', function:{ name:'forge_inspect_job', description:'Inspect one durable Forge job and its current status/artifacts. This is asynchronous and does not wait for generation.', parameters:{type:'object',additionalProperties:false,properties:{jobId:{type:'string'},reason:{type:'string'}},required:['jobId']} } },
 { type:'function', function:{ name:'forge_attach_artifact', description:'Attach a succeeded Forge artifact to the current conversation. Destination agent and session are trusted runtime context, never model-selected. Repeating the call is idempotent.', parameters:{type:'object',additionalProperties:false,properties:{jobId:{type:'string'},artifactId:{type:'string'},reason:{type:'string'}},required:['jobId','artifactId']} } },
];
export async function executeForgeTool(name, args, context = {}) {
 try {
  const store=requireStore();
  if(name==='forge_catalog') return store.catalog({agentId:context.agentId});
  if(name==='forge_create_job') return {ok:true,...await store.create({mode:args.mode,connectionId:args.connectionId ?? undefined,modelId:args.modelId ?? undefined,prompt:args.prompt,idempotencyKey:args.idempotencyKey,useAgentReferenceImage:args.useAgentReferenceImage,referenceAgentIds:args.referenceAgentIds},{agentId:context.agentId})};
  if(name==='forge_list_jobs') return {ok:true,jobs:await store.list()};
  if(name==='forge_inspect_job') return {ok:true,job:store.public(await store.get(args.jobId))};
  if(name==='forge_attach_artifact') {
    const agentId=context.agentId, sessionId=context.sessionId;
    if(typeof agentId!=='string'||!agentId||typeof sessionId!=='string'||!sessionId) throw new Error('forge_context_unavailable');
    return {ok:true,attachment:await store.attach(args.jobId,{agentId,sessionId,artifactId:args.artifactId})};
  }
  throw new Error('forge_tool_unsupported');
 } catch (error) { return forgeFailure(error); }
}
