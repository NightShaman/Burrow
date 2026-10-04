export function resourceBytes(value, fallback) {
 const n=Number(value ?? fallback);if(!Number.isSafeInteger(n)||n<1) throw new Error('invalid_resource_budget');return n;
}
export function importBudgets(env=process.env) {return {compressed:resourceBytes(env.BURROW_IMPORT_MAX_COMPRESSED_BYTES,64*1024*1024),expanded:resourceBytes(env.BURROW_IMPORT_MAX_DECOMPRESSED_BYTES,256*1024*1024)};}
// Bounds are technical allocation/traversal ceilings, not admission-rate policy.
export function jsonBudgets(env=process.env) { return {maxDepth:resourceBytes(env.BURROW_JSON_MAX_DEPTH,128),maxItems:resourceBytes(env.BURROW_JSON_MAX_ITEMS,1000000)}; }
export function boundJson(value,{maxDepth=jsonBudgets().maxDepth,maxItems=jsonBudgets().maxItems}={}) {
 maxDepth=resourceBytes(maxDepth);maxItems=resourceBytes(maxItems);
 const stack=[[value,1]];let items=0;
 while(stack.length){const [node,depth]=stack.pop();if(++items>maxItems||depth>maxDepth)throw Object.assign(new Error('json_structure_too_large'),{statusCode:413});
 if(node&&typeof node==='object')for(const key of Object.keys(node))stack.push([node[key],depth+1]);}
 return value;
}
export async function readJsonBody(req,{maxBytes=resourceBytes(process.env.BURROW_REQUEST_MAX_BYTES,96*1024*1024),timeoutMs=resourceBytes(process.env.BURROW_REQUEST_TIMEOUT_MS,30000),signal,...structure}={}) {
 maxBytes=resourceBytes(maxBytes);timeoutMs=resourceBytes(timeoutMs);const chunks=[];let size=0;
 const abort=()=>req.destroy?.(Object.assign(new Error('request_body_aborted'),{statusCode:408}));
 signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>req.destroy?.(Object.assign(new Error('request_body_timeout'),{statusCode:408})),timeoutMs);
 try {
 const fail=()=>{req.destroy?.();throw Object.assign(new Error('request_body_too_large'),{statusCode:413});};
 if(Number(req.headers?.['content-length'])>maxBytes) fail();
 for await(const chunk of req) {size+=Buffer.byteLength(chunk);if(size>maxBytes)fail();chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));}
 const text=Buffer.concat(chunks,size).toString('utf8');if(!text)return {};
 let value;try{value=JSON.parse(text);}catch{throw Object.assign(new Error('invalid_json'),{statusCode:400});}
 return boundJson(value,structure);
 } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
