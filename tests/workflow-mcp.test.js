'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const fs=require('node:fs'); const path=require('node:path'); const os=require('node:os'); const net=require('node:net');
const {requirements}=require('./helpers/workflow.cjs');
test('MCP persists Changes across clients and workers cannot mutate workflow', {timeout:60000}, async()=>{
 const root=path.resolve(__dirname,'..'); const temp=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-mcp-'));
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
 fs.writeFileSync(path.join(temp,'codevis.config.cjs'), "module.exports={workMode:'planning',workspaces:{project_db:{sourceDir:[],dbUri:'bolt://localhost:7687',auth:{user:'x',pass:'x'}}}};");
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const clients=[];
 const connect=async role=>{
  const c=new Client({name:'workflow-test',version:'1'},{capabilities:{}});clients.push(c);
  await c.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'lib/tsx-launcher.cjs'),path.join(root,'tools/mcp_server.ts')],cwd:temp,
    env:{...process.env,CODEVIS_PROJECT_DIR:temp,CODEVIS_DATA_DIR:path.join(temp,'.codevis'),LADYBUG_DAEMON_PORT:String(port),CODEVIS_ROLE:role,CODEVIS_LOCK_SWEEP_MS:'0'}}));
  return c;
 };
 const call=async(c,name,args)=>{const r=await c.callTool({name,arguments:args});assert.ok(!r.isError,r.content?.[0]?.text);return JSON.parse(r.content[0].text);};
 try{
  const lead=await connect('lead');
  const identity=await call(lead,'get_workspace_identity',{});assert.equal(path.resolve(identity.projectRoot),path.resolve(temp));
  const created=await call(lead,'flow_write',{operation:'create',title:'Refresh token rotation',description:'Reject previously used tokens after rotation.',slug:'rotation'});
  const submitted=await call(lead,'change_write',{operation:'submit',slug:'rotation',expectedRevision:created.state.revision,...requirements});
  const completed=await call(lead,'change_write',{operation:'complete',slug:'rotation',expectedRevision:submitted.state.revision});assert.equal(completed.state.currentPhase,'analysis');
  await lead.close();
  const worker=await connect('worker');const names=(await worker.listTools()).tools.map(t=>t.name);assert.ok(names.includes('change_read'));assert.ok(names.includes('flow_read'));assert.ok(!names.includes('flow_write'));assert.ok(!names.includes('change_write'));
  await assert.rejects(worker.callTool({name:'change_write',arguments:{operation:'create'}}),/Tool not found/);
  await assert.rejects(worker.callTool({name:'flow_write',arguments:{operation:'create'}}),/Tool not found/);
  const r=await call(worker,'change_read',{operation:'read',slug:'rotation',view:'context'});assert.equal(r.instructions.phase,'analysis');
  const misused=await worker.callTool({name:'change_read',arguments:{operation:'complete',slug:'rotation'}});assert.equal(misused.isError,true);
  const resumed=await connect('lead');const read=await call(resumed,'change_write',{operation:'resume',slug:'rotation'});assert.equal(read.state.changeId,created.state.changeId);
 }finally{
  for(const c of clients)await c.close().catch(()=>{});
  await fetch('http://127.0.0.1:'+port+'/shutdown',{method:'POST',headers:{Connection:'close'},signal:AbortSignal.timeout(5000)}).catch(()=>{});
  await fs.promises.rm(temp,{recursive:true,force:true,maxRetries:20,retryDelay:100});
 }
});
