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
