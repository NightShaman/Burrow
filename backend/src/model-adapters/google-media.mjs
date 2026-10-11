import { randomUUID } from 'node:crypto';
import { googleNativeBase, googleNativeHeaders, googleMediaKind, googleModelId } from './google-native-catalog.mjs';
import { createGoogleLyriaAdapter } from './google-lyria.mjs';
import { mediaBudgets, mediaBytes, decodeMedia } from './generated-media-budgets.mjs';
import { readProviderError } from '../forge-diagnostics.mjs';
export function createGoogleMediaAdapter({ config = {}, fetchImpl = fetch, idFactory = randomUUID } = {}) {
  const kind = googleMediaKind(config);
  if (kind === 'audio') return createGoogleLyriaAdapter({ config, fetchImpl, idFactory });
  if (kind !== 'image') throw new Error('google_media_contract_unsupported');
  if (config.supportedGenerationMethods && !config.supportedGenerationMethods.includes('generateContent')) throw new Error('google_media_method_unsupported');
  const base = googleNativeBase(config), headers = googleNativeHeaders(config), model = googleModelId(config.model), budgets = mediaBudgets(config);
  return { provider:'google', api:'google-generative-language', model, outputKind:kind,
    async complete({ prompt, signal } = {}) {
      const requestId=idFactory();
      const response=await fetchImpl(`${base}/models/${encodeURIComponent(model)}:generateContent`, { method:'POST', headers, body:JSON.stringify({ contents:[{ role:'user', parts:[{ text:String(prompt || '') }] }], generationConfig:{ responseModalities:['TEXT','IMAGE'] } }), ...(signal ? {signal} : {}) });
      if (!response.ok) { const details=await readProviderError(response,[config.apiKey,config.auth?.token].filter(Boolean)); return {ok:false,status:response.status,error:details.message,errorDetails:details,outputArtifacts:[]}; }
      const data=JSON.parse((await mediaBytes(response,budgets.metadata)).toString('utf8'));
      const outputArtifacts=[]; let total=0;
      for (const part of data.candidates?.[0]?.content?.parts || []) {
        if (!part.inlineData) continue;
        const {mimeType,data:encoded}=part.inlineData;
        const extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mimeType];
        if (!extension || typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('google_image_payload_unsupported');
        if (outputArtifacts.length >= budgets.count) throw new Error('generated_media_artifact_count_exceeded');
        const bytes=decodeMedia(encoded,Math.min(budgets.asset,budgets.total-total)); total+=bytes.length;
        outputArtifacts.push({kind:'image',name:`google-${requestId}-${outputArtifacts.length}.${extension}`,mimeType,sizeBytes:bytes.length,source:{bytes}});
      }
      return {ok:outputArtifacts.length>0,requestId,provider:'google',api:'google-generative-language',model,status:response.status,outputArtifacts,error:outputArtifacts.length ? null : 'google_returned_no_image'};
    } };
}
