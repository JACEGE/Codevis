const test=require('node:test');const assert=require('node:assert/strict');
test('search finds collapsed source and opaque IDs, limits results and ignores blank queries',async()=>{
  const {searchFlowNodes}=await import('../frontend/src/changes/navigation.js');
  const nodes=Array.from({length:40},(_,i)=>({id:'Function||file=src/auth.js||name=f'+i,key:'TC-'+i,title:'Reject token reuse',label:'TestCase',file:'src/auth.js'}));
  assert.equal(searchFlowNodes(nodes,'').total,0);
  assert.equal(searchFlowNodes(nodes,'auth.js token').total,40);
  assert.equal(searchFlowNodes(nodes,'auth.js token').matches.length,12);
  assert.equal(searchFlowNodes(nodes,'TC-39').matches[0].id,nodes[39].id);
  assert.equal(searchFlowNodes(nodes,'no-match').total,0);
});
test('revealing a hidden node opens only a shortest branch and terminates on provenance cycles',async()=>{
  const {revealAncestors}=await import('../frontend/src/changes/navigation.js');
  const model={allNodes:[{id:'flow',label:'Flow'},{id:'phase',label:'Phase'}],children:{flow:['idea'],idea:['flow'],phase:['req','unrelated'],req:['ac'],ac:['tc'],tc:['source'],source:[]}};
  assert.deepEqual(revealAncestors(model,'source'),['phase','req','ac','tc']);
  assert.deepEqual(revealAncestors(model,'phase'),[]);
  assert.equal(revealAncestors(model,'absent'),null);
});
test('large focused layers wrap without overlapping ranks or dropping nodes',async()=>{
  const {focusPositions}=await import('../frontend/src/changes/navigation.js');
  const layers=new Map([[3,Array.from({length:100},(_,i)=>({id:'source-'+i}))],[0,[{id:'req'}]],[2,[{id:'tc'}]]]);
  const positions=focusPositions(layers);
  assert.equal(positions.size,102);
  assert.equal(new Set([...positions.values()].map(p=>p.x+':'+p.y)).size,102);
  assert.ok(Math.max(...[...positions.values()].map(p=>p.x))-Math.min(...[...positions.values()].map(p=>p.x))<=620);
  assert.ok(positions.get('source-0').y>positions.get('tc').y);
  assert.ok(positions.get('tc').y>positions.get('req').y);
});
test('read navigation recovers legible zoom from overview without shrinking an enlarged card',async()=>{
  const {readableNodeCenter}=await import('../frontend/src/changes/navigation.js');
  const node={position:{x:930,y:2300}};
  assert.equal(readableNodeCenter(node,0.15).zoom,0.9);
  assert.equal(readableNodeCenter(node,1.8).zoom,1.8);
  assert.deepEqual(readableNodeCenter(node,1),{x:1052.5,y:2390,zoom:1});
});

test('overview bounds include every row and negative focused positions',async()=>{const {flowBounds}=await import('../frontend/src/changes/navigation.js');assert.equal(flowBounds([]),null);assert.deepEqual(flowBounds([{position:{x:-310,y:0}},{position:{x:310,y:460}}]),{x:-310,y:0,width:865,height:690});});
