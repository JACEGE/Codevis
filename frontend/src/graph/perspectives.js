const workflow=['Flow','Change','Phase','Requirement','AcceptanceCriterion','SourceAnalysis','ArchitectureDecision','TestCase'];
const source=['File','Function','Class','Component','Module','Endpoint','State','Effect','Variable','ControlFlow','ASTNode'];
const proof=['HAS_REQUIREMENT','HAS_CRITERION','VALIDATED_BY','VALIDATES','IMPLEMENTED_BY','IMPLEMENTS','AFFECTS'];
const processEdges=[...proof,'HAS_PHASE','IMPACTS','DERIVES','REFERENCES','PROMOTED_TO','DEPENDS_ON','APPLIES_TO'];
export const GRAPH_PRESETS={
    all:{title:'All',labels:null,edges:null},
    code:{title:'Code',labels:source,edges:['CALLS','CALLS_CONDITIONALLY','IMPORTS','IMPORTS_SYMBOL','RENDERS','INHERITS','CONTAINS','READS_STATE','WRITES_STATE','HAS_EFFECT','PASSES_CALLBACK','DATA_FLOWS_TO']},
    codeflow:{title:'CodeFlow',labels:[...workflow,...source,'Idea','Task','Epic','Knowledge'],edges:processEdges},
    testing:{title:'Testing',labels:['Requirement','AcceptanceCriterion','TestCase',...source],edges:proof.filter(e=>!['IMPLEMENTS','AFFECTS'].includes(e))},
    architecture:{title:'Architecture',labels:['Flow','Phase','SourceAnalysis','ArchitectureDecision','Knowledge','Spec','SpecClass','SpecParticipant','Class','Component','Module','File'],edges:['HAS_PHASE','DERIVES','REFERENCES','APPLIES_TO','IMPACTS','IMPORTS','INHERITS','REALIZED_BY']},
    quality:{title:'Quality',labels:[...workflow,...source,'Task'],edges:[...proof,'IMPACTS','DERIVES']},
};
export function perspectiveGraph(graph,preset='all',hiddenEdges=null,showTestSource=true) {
    const rule=GRAPH_PRESETS[preset]||GRAPH_PRESETS.all;
    const candidates=graph.nodes.filter(n=>(!rule.labels||n.labels?.some(l=>rule.labels.includes(l)))&&(showTestSource||!n.isTest));
    let ids=new Set(candidates.map(n=>n.id));
    const links=graph.links.filter(l=>(hiddenEdges?!hiddenEdges.has(l.relType):!rule.edges||rule.edges.includes(l.relType))&&ids.has(l.source?.id??l.source)&&ids.has(l.target?.id??l.target));
    // Proof views keep missing TestCases/requirements visible while omitting unrelated code.
    if(['testing','quality'].includes(preset)){
        const linked=new Set(links.flatMap(l=>[l.source?.id??l.source,l.target?.id??l.target]));
        ids=new Set(candidates.filter(n=>linked.has(n.id)||n.labels?.some(l=>workflow.includes(l)||l==='Task')).map(n=>n.id));
    }
    return {nodes:candidates.filter(n=>ids.has(n.id)),links};
}
