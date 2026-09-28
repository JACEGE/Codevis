const test=require('node:test');
const assert=require('node:assert/strict');
const {LABELS,RELATIONS}=require('../lib/workflow/model.cjs');
const {levelLabels,levelEdgeTypes}=require('../server/graph-levels.cjs');

test('workflow traceability stays loadable at every graph detail level',()=>{
  for(const level of [1,2,3]) {
    for(const label of LABELS)assert.ok(levelLabels(level).includes(label),label+' missing at '+level);
    for(const type of RELATIONS)assert.ok(levelEdgeTypes(level).includes(type),type+' missing at '+level);
    for(const type of ['AFFECTS','DEPENDS_ON','APPLIES_TO'])assert.ok(levelEdgeTypes(level).includes(type));
    assert.equal(new Set(levelLabels(level)).size,levelLabels(level).length);
    assert.equal(new Set(levelEdgeTypes(level)).size,levelEdgeTypes(level).length);
  }
  assert.ok(!levelLabels(1).includes('ASTNode'));
  assert.ok(levelLabels(3).includes('ASTNode'));
});
test('workflow types share palette, legend names and distinct 2D glyphs',async()=>{
  const {WORKFLOW_STYLES,workflowOutline,paintWorkflowNode,workflowType}=await import('../frontend/src/graph/workflowShapes.js');
  const {colorForNode,displayNameForLabel}=await import('../frontend/src/nodePalette.js');
  const outlines=new Set();
  for(const label of LABELS){
    assert.equal(workflowType(['CodeNode',label]),label);
    assert.equal(colorForNode({labels:[label]}),WORKFLOW_STYLES[label].color);
    assert.equal(displayNameForLabel(label),WORKFLOW_STYLES[label].name);
    outlines.add(JSON.stringify(workflowOutline(label)));
    const calls=[];const ctx=new Proxy({},{get:(_,key)=>(...args)=>calls.push([key,...args])});
    assert.equal(paintWorkflowNode(ctx,label,10,20,5),true);
    assert.ok(calls.some(c=>c[0]==='fill'&&c[1]==='evenodd'));
    assert.ok(calls.flat().filter(x=>typeof x==='number').every(Number.isFinite));
    if(label==='Phase')assert.equal(calls.filter(c=>c[0]==='arc').length,2);
  }
  assert.equal(outlines.size,LABELS.length);
  assert.equal(paintWorkflowNode({},'Function',0,0,1),false);
});
test('3D workflow geometries are finite and distinct from source spheres',async()=>{
  const {createWorkflowGeometries}=await import('../frontend/src/graph/workflowShapes.js');
  const {createRequire}=require('node:module');
  const THREE=createRequire(require('node:path').resolve(__dirname,'../frontend/package.json'))('three');
  const geometries=createWorkflowGeometries(THREE,5);
  try{
    assert.deepEqual(new Set(Object.keys(geometries)),new Set(LABELS));
    for(const geometry of Object.values(geometries)) {
      assert.notEqual(geometry.type,'SphereGeometry');
      assert.ok([...geometry.attributes.position.array].every(Number.isFinite));
    }
    assert.equal(geometries.Phase.type,'TorusGeometry');
    assert.equal(geometries.TestCase.parameters.radialSegments,3);
    assert.ok(geometries.Requirement.parameters.depth<geometries.Requirement.parameters.height);
  }finally{for(const geometry of Object.values(geometries))geometry.dispose();}
});
