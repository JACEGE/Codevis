const test=require('node:test');const assert=require('node:assert/strict');
const phases=['requirements','analysis','architecture','planning','development','quality','review'];
function detail(){return {state:{phases:phases.map(id=>({id,status:'pending',submissions:[]}))},graph:{nodes:[{id:'change',label:'Change',title:'Rotation'},...phases.map(id=>({id,key:id,label:'Phase',title:id,status:'pending'})),{id:'r',key:'REQ-1',label:'Requirement',title:'Reject token reuse'},{id:'ac',label:'AcceptanceCriterion',title:'Old token fails'},{id:'tc',label:'TestCase',title:'Reuse fails'},{id:'source',label:'Function',title:'rotate',source:true,external:true},{id:'test',label:'Function',title:'testReuse',source:true,external:true},{id:'task',label:'Task',title:'Implement rotation',external:true}],links:[{from:'r',to:'ac',type:'HAS_CRITERION'},{from:'ac',to:'tc',type:'VALIDATED_BY'},{from:'tc',to:'source',type:'VALIDATES'},{from:'tc',to:'test',type:'IMPLEMENTED_BY'},{from:'task',to:'r',type:'IMPLEMENTS'}]}};}
test('default Change graph stays small; branches expand by explicit relationships',async()=>{
 const {changeGraphModel}=await import('../frontend/src/changes/graphModel.js');
 const d=detail();assert.equal(changeGraphModel(d).nodes.length,8);
 const branch=changeGraphModel(d,{expanded:new Set(['requirements','r','ac','tc'])});
 assert.ok(branch.nodes.some(n=>n.id==='tc'));assert.ok(!branch.nodes.some(n=>n.id==='source'));
 const code=changeGraphModel(d,{expanded:new Set(['requirements','r','ac','tc']),showSource:true});
 assert.ok(code.edges.some(e=>e.source==='tc'&&e.target==='test'));assert.equal(code.nodes.filter(n=>n.id==='source').length,1);
 assert.deepEqual(code.nodes.find(n=>n.id==='tc').data.testSummary,{implementations:1,execution:'unknown'});
 assert.equal(code.nodes.find(n=>n.id==='task').data.taskSummary.requirements,1);
 assert.equal(new Set(code.nodes.map(n=>n.position.x+':'+n.position.y)).size,code.nodes.length);
});
test('requirement focus includes criteria, intention, Tasks and source without other phase branches',async()=>{
 const {changeGraphModel}=await import('../frontend/src/changes/graphModel.js');
 const focused=changeGraphModel(detail(),{focus:'r',showSource:true});
 assert.deepEqual(new Set(focused.nodes.map(n=>n.id)),new Set(['r','ac','tc','source','test','task']));
 assert.ok(focused.edges.every(e=>focused.nodes.some(n=>n.id===e.source)&&focused.nodes.some(n=>n.id===e.target)));
});
test('quality expansion contains actual evidence categories and inspectable findings',async()=>{
 const {changeGraphModel}=await import('../frontend/src/changes/graphModel.js');
 const quality={checks:[{name:'unit',exitCode:1,durationMs:20}],traceability:{requirements:{covered:0,total:1}},impact:{counts:{predicted:1,actual:2,unexpected:1},unexpected:[]},findings:[{code:'failed-check',message:'Unit tests failed.',level:'error'}],passed:false};
 const graph=changeGraphModel(detail(),{expanded:new Set(['quality','quality:evidence:checks','quality:evidence:issues']),quality});
 assert.ok(graph.nodes.some(n=>n.data.title==='unit'&&n.data.status==='error'));assert.ok(graph.nodes.some(n=>n.data.content==='Unit tests failed.'));
});
test('whole flow lays every phase out side by side with its content, Tasks under Development', async()=>{
 const {changeGraphModel}=await import('../frontend/src/changes/graphModel.js');
 const whole=changeGraphModel(detail(),{whole:true});
 const at=id=>whole.nodes.find(n=>n.id===id)?.position;
 // Phases form one row, left to right in workflow order, chained by NEXT.
 const xs=phases.map(id=>at(id).x);assert.deepEqual(xs,[...xs].sort((a,b)=>a-b));assert.ok(phases.every(id=>at(id).y===0));
 assert.ok(whole.edges.some(e=>e.source==='requirements'&&e.target==='analysis'));
 // Content sits in its phase's column, below it, without expanding anything.
 assert.equal(at('r').x,at('requirements').x);assert.ok(at('r').y>0);
 assert.equal(at('task').x,at('development').x,'a Task is shown where it is built');
 assert.equal(whole.nodes.filter(n=>n.id==='task').length,1);
 assert.ok(!whole.nodes.some(n=>n.id==='ac'),'nested criteria stay one click away');
 assert.equal(new Set(whole.nodes.map(n=>n.position.x+':'+n.position.y)).size,whole.nodes.length);
});
test('whole flow wraps a long phase into sub-columns and moves the next phase right of them', async()=>{
 const {changeGraphModel}=await import('../frontend/src/changes/graphModel.js');
 const d=detail();
 for(let i=2;i<=9;i++)d.graph.nodes.push({id:'r'+i,key:'REQ-'+i,label:'Requirement',title:'Requirement '+i});
 const whole=changeGraphModel(d,{whole:true});
 const at=id=>whole.nodes.find(n=>n.id===id).position;
 const reqs=whole.nodes.filter(n=>n.data.label==='Requirement');
 assert.equal(reqs.length,9);assert.ok(Math.max(...reqs.map(n=>n.position.y))<=6*200,'at most six rows');
 assert.equal(new Set(reqs.map(n=>n.position.x)).size,2,'two sub-columns');
 assert.ok(at('analysis').x>Math.max(...reqs.map(n=>n.position.x)),'next phase starts after the wrapped column');
 assert.equal(new Set(whole.nodes.map(n=>n.position.x+':'+n.position.y)).size,whole.nodes.length);
});
test('whole flow draws the phase chain and item links, not phase-to-item containment', async()=>{
 const {changeGraphModel}=await import('../frontend/src/changes/graphModel.js');
 const d=detail();d.graph.links.push({from:'requirements',to:'r',type:'HAS_REQUIREMENT'});
 const whole=changeGraphModel(d,{whole:true});
 assert.ok(!whole.edges.some(e=>e.source==='requirements'&&e.target==='r'));
 assert.ok(whole.edges.some(e=>e.source==='task'&&e.target==='r'),'a Task still points at its requirement');
 assert.ok(whole.edges.every(e=>e.label===''));
});
