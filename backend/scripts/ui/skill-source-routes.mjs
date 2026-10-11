import { promises as fs } from 'node:fs';
import path from 'node:path';
import { skillSourceError } from '../../src/postgres-skill-sources.mjs';

/** Operator management API; uses existing HTTP auth/origin/JSON boundaries. */
export function createSkillSourceRoutes({sources,skills,sync,pool,readJsonBody,sendJson}={}) {
 return async ({req,res,url})=>{
  if(['/api/settings/skills/git/preview','/api/settings/skills/git/import'].includes(url.pathname)) {
   try {
    if(req.method!=='POST')throw skillSourceError('method_not_allowed',405);
    const importing=url.pathname.endsWith('/import');
    const result=await sync[importing?'import':'preview'](await readJsonBody(req));
    sendJson(res,importing?201:200,result);
   } catch(e){sendJson(res,e.statusCode||500,{ok:false,error:e.statusCode?e.message:'skill_source_failed'});}
   return true;
  }
  const match=/^\/api\/settings\/skills\/([^/]+)\/(source|sync|history|files)(?:\/(.+))?$/.exec(url.pathname);
  if(!match)return false;
  const id=decodeURIComponent(match[1]), action=match[2];
  try {
   const skill=await skills.get(id);if(!skill)throw skillSourceError('skill_not_found',404);
   let result;
   if(action==='source'&&!match[3]) {
    if(req.method==='GET')result={ok:true,source:await sources.get(id)};
    if(req.method==='PUT')result={ok:true,source:await sources.save(id,await readJsonBody(req))};
    if(req.method==='DELETE')result={ok:await sources.remove(id)};
   } else if(action==='sync'&&req.method==='POST'&&!match[3]) {
    result=await sync.sync(id);
   } else if(action==='history'&&req.method==='GET'&&!match[3]) {
    result={ok:true,...await sources.history(id,{before:url.searchParams.get('before'),limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):50})};
   } else if(action==='files'&&req.method==='GET') {
    if(!match[3]) {const {rows}=await pool.query('SELECT file_path,bytes,executable FROM skill_package_files WHERE skill_id=$1 ORDER BY file_path',[id]);result={ok:true,files:rows.map(r=>({path:r.file_path,bytes:Number(r.bytes),executable:r.executable}))};}
    else {
     const relative=decodeURIComponent(match[3]);
     if(relative.split('/').some(p=>!p||p==='.'||p==='..')||relative.includes('\\')||relative.includes('\0'))throw skillSourceError('skill_file_path_invalid');
     const known=(await pool.query('SELECT 1 FROM skill_package_files WHERE skill_id=$1 AND file_path=$2',[id,relative])).rowCount;
     if(skill.storage!=='filesystem'||!known)throw skillSourceError('skill_file_not_found',404);
     // Reject local symlink tampering, including parent directories.
     let target=skill.installedPath;if((await fs.lstat(target)).isSymbolicLink())throw skillSourceError('skill_local_changes',409);
     for(const part of relative.split('/')){target=path.join(target,part);if((await fs.lstat(target)).isSymbolicLink())throw skillSourceError('skill_local_changes',409);}
     const bytes=await fs.readFile(target);
     // Download only: never execute repo-provided HTML/scripts in the application origin.
     res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(path.basename(relative)),'x-content-type-options':'nosniff','content-length':bytes.length});res.end(bytes);return true;
    }
   }
   if(!result)throw skillSourceError('method_not_allowed',405);
   sendJson(res,result.ok?200:409,result);
  } catch(e){sendJson(res,e.statusCode||500,{ok:false,error:e.statusCode?e.message:'skill_source_failed'});}
  return true;
 };
}
