import { readResponseBytesBounded } from './adapter-primitives.mjs';
const positive = (value, fallback) => { const n=Number(value ?? fallback); if(!Number.isSafeInteger(n)||n<1) throw new Error('invalid_generated_media_budget'); return n; };
export function mediaBudgets(config={}) {
 const total=positive(config.maxDecodedBytes,256*1024*1024);
 return { total, asset:positive(config.maxAssetBytes,config.maxResponseBytes ?? total), metadata:positive(config.maxResponseBytes,Math.ceil(total/3)*4+1024*1024), count:positive(config.maxArtifactCount,16) };
}
export async function mediaBytes(response,limit) {
 const result=await readResponseBytesBounded(response,limit);
 if(!result.ok) throw new Error(result.error);
 return result.data;
}
export function decodeMedia(encoded,remaining) {
 const padding=encoded.endsWith('==')?2:encoded.endsWith('=')?1:0;
 const size=Math.floor(encoded.length*3/4)-padding;
 if(size>remaining) throw new Error('generated_media_decoded_too_large');
 return Buffer.from(encoded,'base64');
}
