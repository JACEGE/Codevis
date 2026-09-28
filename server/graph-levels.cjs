'use strict';
const {LABELS:WORKFLOW_LABELS,RELATIONS:WORKFLOW_RELATIONS}=require('../lib/workflow/model.cjs');
const SPEC_LABELS = [
    'SpecClassDiagram', 'SpecClass', 'SpecMethod', 'SpecField', 'SpecRelation',
    'SpecSequence', 'SpecParticipant', 'SpecMessage',
    'SpecUseCaseDiagram', 'SpecUseCase', 'SpecActor', 'SpecAssoc',
    'SpecActivityDiagram', 'SpecProcess', 'SpecAction',
];
function levelLabels(level) {
    const labels = [
        'Function', 'Component', 'Class', 'State',
        'Module', 'Endpoint', 'File', 'Task', 'Epic', 'Knowledge', 'Annotation',
        'Effect', 'DOMElement', 'Topic', 'Service', 'Action',
        'BraindumpSession',
        ...WORKFLOW_LABELS, 'Change',
        // Ideen gehören zur Planungsebene wie Task, Epic und Knowledge — sie
        // fehlten hier als einzige, obwohl die Palette im Frontend längst eine
        // Farbe und einen Filtereintrag für sie hat. Im Graphen kamen sie
        // damit überhaupt nicht vor.
        'Idea',
        // Imported diagrams. Without these the spec layer exists in the DB but
        // never reaches the main graph, so DERIVES/REALIZED_BY edges have no
        // endpoints and drop out — spec and code look like separate worlds.
        // The frontend hides the layer by default (GraphFilter 'Spec').
        ...SPEC_LABELS,
    ];
    if (level >= 2) {
        // Level 2 — meaningful atomic nodes.
        // Intentionally EXCLUDES raw ASTNode (~21k): force layout collapses
        // them into a clump. See memory: "Render-Kollision".
        labels.push(
            'Variable', 'ReturnValue', 'ControlFlow', 'ReturnStatement',
            'ContinueStatement', 'BreakStatement', 'ThrowStatement'
        );
    }
    // Level 3 — full AST parse (noise tier; use with caution).
    if (level >= 3) labels.push('ASTNode');
    return labels;
}

function levelEdgeTypes(level) {
    const edgeTypes = [
        'CALLS', 'RENDERS', 'IMPORTS', 'HANDLES', 'FETCHES', 'CONTAINS',
        'READS_STATE', 'WRITES_STATE', 'RETURNS', 'AFFECTS', 'APPLIES_TO', 'ANNOTATES', 'REFERENCES',
        'AWAITS', 'HAS_EFFECT', 'DATA_FLOWS_TO', 'CALLS_CONDITIONALLY',
        'BELONGS_TO', 'USES_TOPIC', 'PUBLISHES_TOPIC', 'SUBSCRIBES_TOPIC',
        'PROVIDES_SERVICE', 'CALLS_SERVICE', 'PROVIDES_ACTION', 'USES_ACTION',
        'WATCHES', 'ON_EVENT', 'PASSES_CALLBACK',
        'DECLARES', 'CONTAINS_FLOW', 'CONTAINS_STMT', 'DERIVES', 'INSTANTIATES',
        // Diagram structure, and the one edge that ties a diagram to the code
        // that implements it.
        'INHERITS', 'SPEC_RELATES', 'REALIZED_BY',
        // Epic → Task. Without it an Epic loads as a node nothing points at,
        // which is the one thing an Epic never is.
        'FULFILLED_BY', 'DEPENDS_ON', ...WORKFLOW_RELATIONS,
    ];
    if (level >= 3) edgeTypes.push('CONTAINS_AST');
    return [...new Set(edgeTypes)];
}

module.exports = { SPEC_LABELS, levelLabels, levelEdgeTypes };
