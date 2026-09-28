// Presentation helpers only. Source IDs and workflow relationships stay unchanged.
export function revealAncestors(model, target) {
  const roots=model.allNodes.filter(n=>['Flow','Change','Phase'].includes(n.label)).map(n=>n.id);
  const queue=roots.map(id=>({id,path:[]})),visited=new Set();
  for(let i=0;i<queue.length;i++){
    const {id,path}=queue[i];
    if(id===target)return path;
    if(visited.has(id))continue;
    visited.add(id);
    for(const child of model.children[id]||[])if(!visited.has(child))queue.push({id:child,path:[...path,id]});
  }
  return null;
}
export function searchFlowNodes(nodes, query, limit=12) {
  const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if(!terms.length)return {matches:[],total:0};
  const matches=nodes.filter(n=>terms.every(term=>[n.key,n.title,n.name,n.label,n.file,n.path].filter(Boolean).join(' ').toLocaleLowerCase().includes(term)));
  matches.sort((a,b)=>(a.key||a.title||a.id).localeCompare(b.key||b.title||b.id));
  return {matches:matches.slice(0,limit),total:matches.length};
}
export function readableNodeCenter(node, currentZoom=1) {
  return {x:node.position.x+122.5,y:node.position.y+90,zoom:Math.max(0.9,Math.min(1.8,currentZoom))};
}
export function focusPositions(layers) {
  const positions=new Map();let y=0;
  for(const [,nodes] of [...layers].sort(([a],[b])=>a-b)){
    const columns=Math.min(3,nodes.length);
    nodes.forEach((n,i)=>positions.set(n.id,{x:(i%columns-(columns-1)/2)*310,y:y+Math.floor(i/columns)*230}));
    y+=Math.ceil(nodes.length/3)*230;
  }
  return positions;
}

export function flowBounds(nodes){
  if(!nodes.length)return null;
  const x=Math.min(...nodes.map(n=>n.position.x)),y=Math.min(...nodes.map(n=>n.position.y));
  return {x,y,width:Math.max(...nodes.map(n=>n.position.x+245))-x,height:Math.max(...nodes.map(n=>n.position.y+230))-y};
}
