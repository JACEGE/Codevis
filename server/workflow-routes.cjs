'use strict';
const { normalizeWorkspaceName,publicWorkspaceName }=require('../lib/workspace-names.cjs');
function registerWorkflowRoutes(app,{getDriver,isConfigured=()=>true,onChange=()=>{}}) {
 const execute=async(req,res,options)=>{
  let session;
  try{
   const db=normalizeWorkspaceName(req.body?.db||req.query.db,'project_db');
   if(!isConfigured(db))return res.status(400).json({error:'Workspace is not configured'});
   session=getDriver(db).session();const result=await session.changeOperation(options);
   if(!['read','list','related','idea_context','trace','test_result'].includes(options.operation))onChange(publicWorkspaceName(db));
   res.json(result);
  }catch(e){res.status(/ENOENT/.test(e.message)?404:/CONFLICT/.test(e.message)?409:400).json({error:e.message});}
  finally{await session?.close();}
 };
 app.get(['/api/changes','/api/flows'], (req,res)=>execute(req,res,{operation:'list'}));
 app.post(['/api/changes','/api/flows'], (req,res)=>execute(req,res,{...req.body,operation:'create',agent:'user'}));
 app.get(['/api/changes/related/:nodeId','/api/flows/related/:nodeId'],(req,res)=>execute(req,res,{operation:'related',nodeId:req.params.nodeId}));
 app.get('/api/flows/test-results/:nodeId',(req,res)=>execute(req,res,{operation:'test_result',nodeId:req.params.nodeId}));
 app.get('/api/flows/trace/:nodeId',(req,res)=>execute(req,res,{operation:'trace',nodeId:req.params.nodeId,slug:req.query.slug}));
 app.get('/api/flows/idea-context/:ideaId',(req,res)=>execute(req,res,{operation:'idea_context',ideaId:req.params.ideaId}));
 app.post('/api/ideas/:ideaId/codeflow',(req,res)=>execute(req,res,{...req.body,operation:'promote_idea',ideaId:req.params.ideaId,agent:'user'}));
 app.get(['/api/changes/:slug','/api/flows/:slug'],(req,res)=>execute(req,res,{operation:'read',slug:req.params.slug,view:req.query.view,path:req.query.path,taskId:req.query.taskId}));
 app.post(['/api/changes/:slug/actions','/api/flows/:slug/actions'],(req,res)=>{
  if(!['submit','complete','resume','reopen'].includes(req.body?.operation))return res.status(400).json({error:'Unsupported workflow action'});
  return execute(req,res,{...req.body,slug:req.params.slug,agent:req.body.agent||'user'});
 });
}
module.exports={registerWorkflowRoutes};
