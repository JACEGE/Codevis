import { useMemo } from 'react';
import DebugStepper from './DebugStepper';
import ExploreTab from './ExploreTab';
import InspectorSidebar from './InspectorSidebar';
import KanbanBoard from './KanbanBoard';
import ContextPanel from './KnowledgePanel';
import SettingsPanel from './SettingsPanel';
import { summarizeVisibleRelations } from '../pathfinder/relationshipSummary';

export default function DashboardSidePanel({
    activeDb,
    activeTab,
    callStack,
    connected,
    dbTotal,
    debugSequence,
    debugStep,
    detailLevel,
    extractors,
    exploreGraphData,
    freezeLayout,
    graphData,
    graphLoadable,
    growthMode,
    growthSpeed,
    max3dNodes,
    nodeBudget,
    onCardHover,
    onConfigChange,
    onExpandAst,
    onFindRoute,
    onInspectContextNode,
    onInspectSearchResult,
    onSearch,
    onRefresh,
    onResetPathfinder,
    onResultGraph,
    onSelectGraphNode,
    onSelectInspectorRelationship,
    onSelectTab,
    onSequentialChange,
    onTraceDirectionChange,
    onShowContext,
    onStepChange,
    pending,
    scopeError,
    onRetryScope,
    selectedNode,
    sequentialMode,
    routeResult,
    traceDirection,
    tabs,
    typeCounts,
    socket,
}) {
    const pathfinderRelations = useMemo(
        () => selectedNode == null ? null : summarizeVisibleRelations(exploreGraphData || graphData, selectedNode),
        [exploreGraphData, graphData, selectedNode],
    );
    return (
        <div
            id="right-panel-container"
            style={{
                gridArea: 'kanban', display: 'flex', flexDirection: 'column',
                overflow: 'hidden', background: 'var(--surface, #ffffff)',
            }}
        >
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
                {activeTab === 'kanban' && <KanbanBoard onCardHover={onCardHover} db={activeDb} socket={socket} onShowNode={onShowContext} />}
                {activeTab === 'settings' && (
                    <SettingsPanel
                        activeDb={activeDb}
                        connected={connected}
                        growthMode={growthMode}
                        growthSpeed={growthSpeed}
                        maxVisibleNodes={nodeBudget > 0 ? nodeBudget : Infinity}
                        max3dNodes={max3dNodes}
                        totalNodes={graphLoadable || graphData.nodes.length}
                        dbTotal={dbTotal}
                        typeCounts={typeCounts}
                        detailLevel={detailLevel}
                        pending={pending}
                        scopeError={scopeError}
                        onRetryScope={onRetryScope}
                        freezeLayout={freezeLayout}
                        onConfigChange={onConfigChange}
                        onRefresh={onRefresh}
                    />
                )}
                {activeTab === 'context' && (
                    <ContextPanel onSelectTab={onSelectTab} db={activeDb} onShowNode={onShowContext} onInspectNode={onInspectContextNode} />
                )}
                {activeTab === 'explore' && (
                    <ExploreTab onInspectNode={onInspectSearchResult} db={activeDb} graphData={exploreGraphData || graphData} onShowNode={onShowContext} onResultGraph={onResultGraph} />
                )}
                {activeTab === 'inspector' && (
                    <InspectorSidebar
                        onSearch={onSearch}
                        debugNode={selectedNode}
                        callStack={callStack}
                        graphData={graphData}
                        onExpandAst={onExpandAst}
                        db={activeDb}
                        onSelectNode={onSelectGraphNode}
                        onSelectRelationship={onSelectInspectorRelationship}
                        onFindRoute={() => onSelectTab('pathfinder')}
                    />
                )}
                {activeTab === 'pathfinder' && (
                    selectedNode != null ? (
                        <DebugStepper
                            debugNode={selectedNode}
                            callStack={callStack}
                            debugSequence={debugSequence}
                            debugStep={debugStep}
                            sequentialMode={sequentialMode}
                            traceDirection={traceDirection}
                            relationshipSummary={pathfinderRelations}
                            graphNodes={graphData.nodes}
                            db={activeDb}
                            routeResult={routeResult}
                            onFindRoute={onFindRoute}
                            onStepChange={onStepChange}
                            onSequentialChange={onSequentialChange}
                            onTraceDirectionChange={onTraceDirectionChange}
                            onReset={onResetPathfinder}
                            onInspect={() => onSelectTab('inspector')}
                        />
                    ) : (
                        <div style={{ padding: 16, color: 'var(--muted, #888)', fontSize: 13, lineHeight: 1.6 }}>
                            <strong style={{ color: 'var(--text, #1a1a1a)' }}>Pathfinder</strong> — click a node in the graph to walk its CALLS/RENDERS tree and step along it.
                            <br /><button className="ui-button" onClick={onSearch}>Find a starting node</button><br />
                            Difference: <em>Inspector</em> shows the static details of one node (code, props, AST); <em>Pathfinder</em> follows where that node leads and highlights the route in the graph.
                        </div>
                    )
                )}
            </div>
        </div>
    );
}
