const test=require('node:test');const assert=require('node:assert/strict');const express=require('express');
const {registerWorkflowRoutes}=require('../server/workflow-routes.cjs');
test('Change routes validate workspaces, preserve opaque IDs and restrict mutations',async()=>{
 const app=express();app.use(express.json());let operations=[],closed=0;
 registerWorkflowRoutes(app,{getDriver:()=>({session:()=>({changeOperation:async o=>{operations.push(o);return {status:'OK'};},close:async()=>closed++})}),isConfigured:db=>db==='target'});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/api/changes?db=codevis_db')).status,400);
  const id='Function:path#rotate';assert.equal((await fetch(base+'/api/changes/related/'+encodeURIComponent(id))).status,200);assert.equal(operations[0].nodeId,id);
  assert.equal((await fetch(base+'/api/changes/rotation/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'record_quality'})})).status,400);
  assert.equal((await fetch(base+'/api/changes/rotation/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'complete',expectedRevision:3})})).status,200);
  assert.equal(operations[1].expectedRevision,3);assert.equal(closed,2);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
