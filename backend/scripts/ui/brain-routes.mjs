/** Mounted only behind the existing UI authentication and browser-origin policy. */
export function createBrainRoutes({store,embeddings,readJsonBody,sendJson}) {
 return async ({req,res,url}) => {
  if (url.pathname.startsWith('/api/settings/brain-embeddings')) {
   const action=url.pathname.slice('/api/settings/brain-embeddings'.length);
   try {
    let result;
    if(req.method==='GET' && action==='') result=await embeddings.status();
    else if(req.method==='PUT' && action==='') result=await embeddings.configure(await readJsonBody(req));
    else if(req.method==='GET' && action==='/models') result=await embeddings.provider.discover(url.searchParams.get('connectionId'));
    else if(req.method==='POST' && action==='/test') result=await embeddings.test(await readJsonBody(req));
    else if(req.method==='POST' && action==='/reindex') result=await embeddings.reindex();
    else return false;
    sendJson(res,200,result);
   } catch { sendJson(res,400,{error:'brain_embedding_request_failed'}); }
   return true;
  }
  const match=/^\/api\/brains(?:\/([^/]+))?$/.exec(url.pathname); if (!match) return false;
  const agentId=url.searchParams.get('agentId');
  try {
   const id=match[1] ? decodeURIComponent(match[1]) : null;
   let result;
   if (req.method==='GET') result=id ? await store.get({agentId,id}) : await store.list({agentId,query:url.searchParams.get('query') || '',limit:Number(url.searchParams.get('limit') ?? 50),cursor:url.searchParams.get('cursor')});
   else if (req.method==='POST' && !id) result=await store.create({...await readJsonBody(req),agentId},{operator:true});
   else if (req.method==='PUT' && id) result=await store.update({...await readJsonBody(req),agentId,id},{operator:true});
   else if (req.method==='DELETE' && id) result=await store.remove({...await readJsonBody(req),agentId,id},{operator:true});
   else return false;
   sendJson(res,result===null?404:200,result===null?{error:'brain_not_found'}:result);
  } catch(error) { if (!error.message.startsWith('brain_')) throw error; sendJson(res,error.message.includes('conflict')?409:400,{error:error.message}); }
  return true;
 };
}
