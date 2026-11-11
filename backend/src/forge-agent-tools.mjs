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
  'forge_delivery_failed', 'forge_wait_interrupted', 'generation_interrupted',
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
 { type:'function', function:{ name:'forge_catalog', description:'Discover Forge models/defaults, per-model agentReferenceImage capability, all registered agents with saved portraits in agentReferenceImages, your own portrait in agentReferenceImage, and the operator photo in operatorReferenceImage. Each portrait attachmentId can be reopened via attachment_view. Per-model imageOptions describes supported outputFormats, sizes and GIF controls. Arbitrary source attachments, video, and arbitrary provider tuning remain unsupported.', parameters:{type:'object',additionalProperties:false,properties:{reason:{type:'string'}}} } },
 { type:'function', function:{ name:'forge_create_job', description:'Explicitly request a potentially paid Forge generation; this call waits for completion and automatically sends succeeded artifacts as your messages in the current chat. Never use this without the operator asking for generation. Set mode and leave both connectionId and modelId null to use its configured default; supply both nonempty IDs to choose a model explicitly. For supported image models, imageOptions selects png/jpeg/webp or animated gif as advertised by forge_catalog; GIF defaults to 9 frames at 200 ms and auto size. Frame controls are GIF-only. For a supported image model, useAgentReferenceImage true includes your own saved portrait from Settings > Agent > Agent Details; referenceAgentIds can select other registered agents with saved portraits from forge_catalog. useOperatorReferenceImage true appends the operator photo from Settings > Operator Profile after selected agent portraits. Combining the agent selectors deduplicates self; order of first selection determines image order. False/null/omitted flags and empty/null referenceAgentIds use text-only generation. Missing portraits or unsupported models fail without dispatch or fallback; never supply image bytes or paths. Missing defaults or invalid selections fail; no automatic model fallback. On success the returned attachments are already delivered; do not attach them again. Failures return an error, not a promise of a later model follow-up.', parameters:{type:'object',additionalProperties:false,properties:{mode:{type:'string',enum:['image','music','speech','video']},connectionId:{type:['string','null']},modelId:{type:['string','null']},prompt:{type:'string'},idempotencyKey:{type:'string'},useAgentReferenceImage:{type:['boolean','null'],description:'Include the current agent saved portrait. Image jobs and supported models only.'},useOperatorReferenceImage:{type:['boolean','null'],description:'Include the operator saved photo after selected agent portraits. Supported image models only; missing photos fail without dispatch.'},referenceAgentIds:{type:['array','null'],items:{type:'string',minLength:1},description:'Ordered registered agent IDs whose saved portraits should be included. May include your own ID; duplicate IDs are ignored. Null/empty array means no additional references.'},imageOptions:{type:['object','null'],additionalProperties:false,description:'Image-only generation settings supported by the selected model in forge_catalog. Null/omitted preserves provider defaults. GIF is limited to models advertising gif.',properties:{outputFormat:{type:'string',enum:['png','jpeg','webp','gif']},frameCount:{type:'integer',minimum:2,maximum:16},frameDurationMs:{type:'integer',minimum:20,maximum:2000,description:'Milliseconds per GIF frame; rounded to the nearest 10 ms.'},size:{type:'string',description:'auto or supported WIDTHxHEIGHT. GIF dimensions must be multiples of 16 and fit provider size limits.'}},required:['outputFormat']},reason:{type:'string'}},required:['prompt','idempotencyKey']} } },
 { type:'function', function:{ name:'forge_list_jobs', description:'List durable Forge jobs owned by the current operator, newest first.', parameters:{type:'object',additionalProperties:false,properties:{reason:{type:'string'}}} } },
 { type:'function', function:{ name:'forge_inspect_job', description:'Inspect one durable Forge job and its current status/artifacts. This is asynchronous and does not wait for generation.', parameters:{type:'object',additionalProperties:false,properties:{jobId:{type:'string'},reason:{type:'string'}},required:['jobId']} } },
 { type:'function', function:{ name:'forge_attach_artifact', description:'Send a succeeded Forge artifact as an assistant message to the current conversation. Destination agent and session are trusted runtime context, never model-selected. Repeated calls within the same turn are idempotent; a new turn can resend the existing artifact without regeneration.', parameters:{type:'object',additionalProperties:false,properties:{jobId:{type:'string'},artifactId:{type:'string'},reason:{type:'string'}},required:['jobId','artifactId']} } },
];
export async function executeForgeTool(name, args, context = {}) {
 try {
  const store=requireStore();
  if(name==='forge_catalog') return store.catalog({agentId:context.agentId});
  if(name==='forge_create_job') return {ok:true,...await store.createAndDeliver({mode:args.mode,connectionId:args.connectionId ?? undefined,modelId:args.modelId ?? undefined,prompt:args.prompt,idempotencyKey:args.idempotencyKey,useAgentReferenceImage:args.useAgentReferenceImage,useOperatorReferenceImage:args.useOperatorReferenceImage,referenceAgentIds:args.referenceAgentIds,imageOptions:args.imageOptions},{agentId:context.agentId,sessionId:context.sessionId,runId:context.runId || null,signal:context.signal})};
  if(name==='forge_list_jobs') return {ok:true,jobs:await store.list()};
  if(name==='forge_inspect_job') return {ok:true,job:store.public(await store.get(args.jobId))};
  if(name==='forge_attach_artifact') {
    const agentId=context.agentId, sessionId=context.sessionId;
    if(typeof agentId!=='string'||!agentId||typeof sessionId!=='string'||!sessionId) throw new Error('forge_context_unavailable');
    return {ok:true,attachment:await store.attach(args.jobId,{agentId,sessionId,artifactId:args.artifactId},{role:'assistant',runId:context.runId || null})};
  }
  throw new Error('forge_tool_unsupported');
 } catch (error) { return forgeFailure(error); }
}
