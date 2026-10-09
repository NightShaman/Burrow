export async function executeBrainTool({tool,arguments:args={},agentId,store}={}) {
 if (!agentId || !store) return {tool,ok:false,error:'brain_scope_unavailable'};
 if (args.agentId && args.agentId !== agentId) return {tool,ok:false,error:'brain_agent_mismatch'};
 try {
  const input={...args,agentId};
  if (input.limit == null) delete input.limit;
  let result;
  if (tool==='brain_search') result=await store.list(input);
  else if (tool==='brain_read') result=await store.get(input);
  else if (tool==='brain_save') result=await store.create(input);
  else if (tool==='brain_update') result=await store.update(input);
  else if (tool==='brain_remove') result=await store.remove(input);
  else throw new Error('brain_unknown_tool');
  return {tool,ok:true,agentId,result,error:null};
 } catch(error) { return {tool,ok:false,error:error.message}; }
}
