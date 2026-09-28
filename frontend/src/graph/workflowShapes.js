// Semantic types shared by the main graph, its legend and the Change cards.
export const WORKFLOW_STYLES = Object.freeze({
    Flow: {color:'#f59e0b',name:'Flows',shape:'Hexagon / prism'},
    Phase: {color:'#a78bfa',name:'Phases',shape:'Ring / torus'},
    Requirement: {color:'#38bdf8',name:'Requirements',shape:'Document / slab'},
    AcceptanceCriterion: {color:'#2dd4bf',name:'Acceptance criteria',shape:'Small document / slab'},
    SourceAnalysis: {color:'#22d3ee',name:'Source analysis',shape:'Flat hexagon / plate'},
    ArchitectureDecision: {color:'#fb923c',name:'Architecture decisions',shape:'Pentagon / square pyramid'},
    TestCase: {color:'#f472b6',name:'Test cases',shape:'Triangle / triangular prism'},
});
export function workflowType(labels = []) { return labels.find(label => Object.hasOwn(WORKFLOW_STYLES,label)); }
export function workflowOutline(label) {
    if(label==='SourceAnalysis')return Array.from({length:6},(_,i)=>[Math.cos(i*Math.PI/3),Math.sin(i*Math.PI/3)*.55]);
    if(label==='ArchitectureDecision')return [[0,-1],[1,.5],[.5,1],[-.5,1],[-1,.5]];
    if(label==='Flow')return Array.from({length:6},(_,i)=>[Math.cos(i*Math.PI/3),Math.sin(i*Math.PI/3)]);
    if(label==='Phase')return null;
    if(label==='Requirement')return [[-.72,-1],[.25,-1],[.72,-.5],[.72,1],[-.72,1]];
    if(label==='AcceptanceCriterion')return [[-.55,-.75],[.2,-.75],[.55,-.38],[.55,.75],[-.55,.75]];
    if(label==='TestCase')return [[0,-1],[.95,.8],[-.95,.8]];
    return null;
}
export function paintWorkflowNode(ctx,label,x,y,r) {
    if(!WORKFLOW_STYLES[label])return false;
    ctx.beginPath();
    if(label==='Phase'){
        ctx.arc(x,y,r,0,Math.PI*2);ctx.moveTo(x+r*.55,y);ctx.arc(x,y,r*.55,0,Math.PI*2,true);
    }else{
        const points=workflowOutline(label);
        points.forEach(([px,py],i)=>ctx[i?'lineTo':'moveTo'](x+px*r,y+py*r));ctx.closePath();
    }
    ctx.fill('evenodd');ctx.stroke();return true;
}
export function createWorkflowGeometries(THREE,size) {
    return {
        Flow:new THREE.CylinderGeometry(size,size,size*.8,6),
        Phase:new THREE.TorusGeometry(size*.72,size*.25,8,20),
        Requirement:new THREE.BoxGeometry(size*1.25,size*1.8,size*.35),
        AcceptanceCriterion:new THREE.BoxGeometry(size*.9,size*1.3,size*.25),
        SourceAnalysis:new THREE.CylinderGeometry(size,size,size*.2,6),
        ArchitectureDecision:new THREE.ConeGeometry(size,size*1.5,4),
        TestCase:new THREE.CylinderGeometry(size,size,size*.85,3),
    };
}
