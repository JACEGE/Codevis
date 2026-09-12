import GraphFilter from './GraphFilter';
import { useRef, useState } from 'react';
import GraphLegend from './GraphLegend';
import GraphScene from './GraphScene';
import ViewModeToggle from './ViewModeToggle';
import GraphEmptyState from './GraphEmptyState';
import GraphScopeError from './GraphScopeError';
import useElementSize from '../hooks/useElementSize';

function NodeActionMenu({ menu, onClose, onInspect, onShowContext, pending }) {
    if (!menu) return null;
    return (
        <div style={{
            position: 'absolute',
            left: 12, right: 12, top: 12,
            zIndex: 110, display: 'flex', flexWrap: 'wrap', gap: 6, padding: 7, borderRadius: 8,
            background: 'var(--surface,#fff)', border: '1px solid var(--border,#ddd)',
            boxShadow: '0 4px 18px rgba(0,0,0,.2)',
        }}>
            <button className="ui-button ui-button--primary" onClick={onInspect}>Inspect</button>
            <button className="ui-button" disabled={pending} onClick={() => onShowContext(menu.nodeId, 1)}>Direct connections</button>
            <button className="ui-button" disabled={pending} onClick={() => onShowContext(menu.nodeId, 2)}>Surrounding context</button>
            <button aria-label="Close node actions" onClick={onClose} style={{ padding: '6px 8px', cursor: 'pointer' }}>×</button>
        </div>
    );
}

export default function GraphPanel({
    contextRequest,
    active = true,
    detailLevel,
    onDetailLevelChange,
    onFreezeChange,
    activeLinks,
    bridgeUrl,
    connected,
    debugBranches,
    debugPath,
    effectiveViewMode,
    exploreGraphActive,
    filteredOutResult,
    filterLabels,
    focusNodeId,
    freezeLayout,
    graphPanelRef,
    graphScope,
    graphLoadedEmpty,
    highlightedNodes,
    includeIsolated,
    nodeActionMenu,
    nodeBudget,
    onBudgetChange,
    onClearFocus,
    onClearQuery,
    onCloseNodeActions,
    onIncludeIsolatedChange,
    onInspectNode,
    onNodeClick,
    onShowContext,
    onTypeVisibilityChange,
    onViewModeChange,
    palette,
    scopePending,
    scopeError,
    onRetryScope,
    selectedNode,
    sequentialMode,
    sourceGraphEmpty,
    typeCounts,
    typeVisibility,
    viewMode,
    visibleGraphData,
}) {
    const canvasRef = useRef(null);
    const size = useElementSize(canvasRef);
    const [fitRequest, setFitRequest] = useState(0);
    const filteredEmpty = sourceGraphEmpty
        && Number(graphScope?.total || 0) > 0
        && (graphScope?.hiddenTypes?.length || 0) > 0;

    return (
        <div ref={graphPanelRef} className="graph-panel" style={{
            gridArea: 'graph', position: 'relative', overflow: 'hidden',
            background: 'var(--graph-bg)', borderRight: '1px solid var(--border)',
        }}>
            <div className="graph-toolbar" role="toolbar" aria-label="Graph controls">
                <ViewModeToggle viewMode={effectiveViewMode} onChange={onViewModeChange} />
                <GraphFilter embedded
                    visible={typeVisibility} onVisibleChange={onTypeVisibilityChange}
                    typeCounts={typeCounts} palette={palette} levelLabels={filterLabels}
                    budget={nodeBudget} onBudgetChange={onBudgetChange}
                    loadable={graphScope?.loadable || 0} dbTotal={graphScope?.total || 0}
                    isolatedCount={graphScope?.isolated || 0} includeIsolated={includeIsolated}
                    onIncludeIsolatedChange={onIncludeIsolatedChange} pending={scopePending}
                />
                <select aria-label="Graph detail" value={detailLevel} onChange={event => onDetailLevelChange(Number(event.target.value))}>
                    <option value={1}>Architecture</option><option value={2}>Code detail</option><option value={3}>Syntax tree</option>
                </select>
                <button className="ui-button" aria-pressed={freezeLayout} onClick={onFreezeChange}>Freeze layout</button>
                <button className="ui-button" onClick={() => setFitRequest(value => value + 1)} disabled={!visibleGraphData.nodes.length}>Fit graph</button>
                {viewMode !== effectiveViewMode && <span className="graph-mode-note">2D for this graph size</span>}
            </div>
            <div className="graph-viewport" ref={canvasRef}>
            <GraphScene
                active={active}
                fitRequest={fitRequest}
                width={size.width} height={size.height}
                graphData={visibleGraphData} palette={palette} activeLinks={activeLinks}
                debugNode={selectedNode} debugPath={debugPath}
                debugBranches={sequentialMode ? [] : debugBranches}
                debugEdges={Array.from(activeLinks)} freezeLayout={freezeLayout}
                onNodeClick={onNodeClick} highlightedNodes={highlightedNodes}
                viewMode={effectiveViewMode} focusNodeId={focusNodeId}
            />
            <NodeActionMenu
                pending={contextRequest?.pending}
                menu={nodeActionMenu} onClose={onCloseNodeActions}
                onInspect={onInspectNode} onShowContext={onShowContext}
            />
            {sourceGraphEmpty && !exploreGraphActive && (
                <GraphEmptyState
                    bridgeUrl={bridgeUrl}
                    connected={connected}
                    loadedEmpty={graphLoadedEmpty && !scopePending}
                    filteredEmpty={filteredEmpty}
                    onResetFilters={() => onTypeVisibilityChange?.({})}
                />
            )}
            <GraphLegend nodes={visibleGraphData.nodes} palette={palette} />
            {contextRequest && <div style={{ position: 'absolute', bottom: 16, left: 16, right: 16, zIndex: 180 }}>
                {contextRequest.pending
                    ? <div role="status" style={{ padding: '8px 12px', background: 'var(--surface)', color: 'var(--text)', borderRadius: 6 }}>
                        Loading {contextRequest.hops === 1 ? 'direct connections' : 'surrounding context'}…
                    </div>
                    : <GraphScopeError error={contextRequest.error} onRetry={() => onShowContext(contextRequest.nodeId, contextRequest.hops)} />}
            </div>}
            {exploreGraphActive && !visibleGraphData.nodes.length && (
                <div style={{ position: 'absolute', inset: '25% 12% auto', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                    No graph nodes in this result. Check the results table or adjust the graph filters.
                </div>
            )}
            {scopeError && <div style={{ position: 'absolute', bottom: 16, left: 16, right: 16, zIndex: 180 }}>
                <GraphScopeError error={scopeError} onRetry={onRetryScope} />
            </div>}
            <div className="graph-state">
                {focusNodeId != null && (
                    <button onClick={onClearFocus} title="Show the full graph again" style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                        fontSize: 12.5, fontWeight: 600, color: '#ffffff', background: '#6366f1',
                        border: 'none', borderRadius: 6, cursor: 'pointer',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.2)', fontFamily: 'inherit',
                    }}>× Clear focus</button>
                )}
                {exploreGraphActive && (
                    <button onClick={onClearQuery} title="Return to the full dashboard graph" style={{
                        padding: '6px 12px', fontSize: 12.5, fontWeight: 600,
                        color: '#ffffff', background: '#0f766e', border: 'none',
                        borderRadius: 6, cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                        fontFamily: 'inherit',
                    }}>× Clear query graph</button>
                )}
                {filteredOutResult && (
                    <div title="Switch these types on in the Filter panel (top right) to see them" style={{
                        maxWidth: 260, padding: '6px 10px', fontSize: 11.5, lineHeight: 1.45,
                        color: 'var(--text, #1a1a1a)', background: 'var(--surface, #fff)',
                        border: '1px solid #f59e0b', borderRadius: 6,
                        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                    }}>
                        The filter hides {filteredOutResult.hidden} of {filteredOutResult.total} result nodes: {filteredOutResult.types.join(', ')}
                    </div>
                )}
            </div>
            </div>
        </div>
    );
}
