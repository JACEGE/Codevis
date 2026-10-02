'use strict';
const fs=require('node:fs'); const path=require('node:path'); const {execFileSync}=require('node:child_process');
const {digest,artifactRoot}=require('./artifacts.cjs');
const {inspectGraphFreshness}=require('../../scripts/impact/graph_freshness.cjs');
function git(root,args) { return execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024}); }
// Never source, whatever the project's .gitignore says. Without these a
// project lacking a .gitignore had its live database files read (EBUSY on
// Windows while the daemon holds them) and all of node_modules hashed.
const NEVER_SOURCE=new Set(['.codevis','node_modules','.git']);
function sourceSnapshot(context) {
  // Share the storage path resolver: equivalent ./ and ../ paths must exclude
  // the same files. Only generated changes are excluded, not their parent,
  // which may also contain source (or be the project root itself).
  const changesDir=path.dirname(artifactRoot(context.projectRoot,context.config,'project_db'));
  const normalizeCase=value=>process.platform==='win32'?value.toLowerCase():value;
  const artifactDir=normalizeCase(path.relative(context.projectRoot,changesDir).replace(/\\/g,'/')+'/');
  let listing;
  try { listing=git(context.projectRoot,['ls-files','-z','--cached','--others','--exclude-standard']); }
  catch { throw new Error('Change baselines require a Git repository. Initialize Git before completing Source Analysis.'); }
  const files=[...new Set(listing.split('\0').filter(Boolean))].sort();
  const hashes={},contents=new Map();
  for(const file of files) {
    if(normalizeCase(file).startsWith(artifactDir)||file.split('/').some(part=>NEVER_SOURCE.has(part)))continue;
    const absolute=path.resolve(context.projectRoot,file);
    if(!fs.existsSync(absolute))continue;
    const stat=fs.lstatSync(absolute),linked=stat.isSymbolicLink();
    if(!(linked?fs.statSync(absolute):stat).isFile())continue;
    const bytes=fs.readFileSync(absolute);
    // Test execution follows file symlinks. Hash both their destination and
    // content, including targets that Git does not enumerate separately.
    hashes[file]=digest(linked?Buffer.concat([Buffer.from('symlink\0'+fs.readlinkSync(absolute)+'\0'),bytes]):bytes);
    contents.set(file,bytes.toString('utf8'));
  }
  let head=null;try{head=git(context.projectRoot,['rev-parse','--verify','HEAD']).trim();}catch{}
  return {hashes,contents,head,fingerprint:digest(JSON.stringify(hashes))};
}
async function captureSnapshot(session,context) {
  const disk=sourceSnapshot(context);
  const symbols=[];
  const rows=await session.run("MATCH (n) WHERE n.label IN ['File','Function','Class','Component'] RETURN elementId(n) AS id,n.label AS label,n.name AS name,n.file AS file,n.path AS path,n.owner AS owner,n.signature AS signature,n.startLine AS startLine,n.endLine AS endLine");
  for(const r of rows.records) {
    const label=r.get('label'),file=r.get('file')||r.get('path'),text=disk.contents.get(file);
    if(text==null)continue;
    const start=Number(r.get('startLine')),end=Number(r.get('endLine'));
    const body=label==='File'?text: start>0&&end>=start?text.split(/\r?\n/).slice(start-1,end).join('\n'):null;
    const key=JSON.stringify([label,file,r.get('owner')||'',r.get('name')||'',r.get('signature')||'']);
    symbols.push({id:String(r.get('id')),key,label,file,name:r.get('name')||file,owner:r.get('owner'),hash:body===null?null:digest(body),lines:body===null?null:body.split(/\r?\n/).length});
  }
  const metrics=[];
  for(const s of symbols)if(s.lines!=null)metrics.push({key:(s.label==='File'?'fileLOC:':'symbolLOC:')+s.key,metric:s.label==='File'?'fileLOC':'functionLOC',value:s.lines,nodeId:s.id,file:s.file});
  const complexities=await session.run('MATCH (f:Function) OPTIONAL MATCH (f)-[:CONTAINS_FLOW]->(flow:ControlFlow) RETURN elementId(f) AS id,1+count(flow) AS value');
  for(const r of complexities.records){const s=symbols.find(s=>s.id===r.get('id'));if(s)metrics.push({key:'complexity:'+s.key,metric:'complexity',value:Number(r.get('value')),nodeId:s.id,file:s.file});}
  const imports=await session.run('MATCH (f:File)-[:IMPORTS]->(target) RETURN elementId(f) AS id,count(target) AS value');
  for(const r of imports.records){const s=symbols.find(s=>s.id===r.get('id'));if(s)metrics.push({key:'dependencies:'+s.key,metric:'dependencies',value:Number(r.get('value')),nodeId:s.id,file:s.file});}
  const cycleRows=await session.run('MATCH (f:File)-[:IMPORTS*2..6]->(f) RETURN DISTINCT f.path AS file');
  // The existing query uses bounded traversal. Report observations, not proof that no longer cycles exist.
  const cycles=cycleRows.records.map(r=>r.get('file')).filter(Boolean).sort();
  const parse=await session.run("MATCH (f:File) WHERE f.parseStatus='parse_error' RETURN f.path AS file");
  return {at:Date.now(),head:disk.head,fingerprint:disk.fingerprint,files:disk.hashes,symbols,metrics,cycles,
    parseErrors:parse.records.map(r=>r.get('file')),freshness:await inspectGraphFreshness(session,context)};
}
module.exports={git,sourceSnapshot,captureSnapshot};
