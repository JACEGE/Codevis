import AppTabBar from './AppTabBar';
import NavigationHistory from './NavigationHistory';

export default function WorkspaceHeader({ activeDb, activeTab, extractors, tabs, onSelectTab, layout = 'panel', onLayoutChange, navigation, projectRoot, workspaceReady = true, onSearch, terminalOpen, onToggleTerminal }) {
    const projectName = projectRoot?.split(/[\\/]/).filter(Boolean).pop();
    return (
        <header className="workspace-header">
            <div className="workspace-heading">
                <strong className="workspace-brand">CodeVis</strong>
                <NavigationHistory {...navigation} />
                <button className="workspace-db" disabled={!workspaceReady} onClick={() => onSelectTab('settings')} title={workspaceReady ? `${projectRoot || 'Workspace'} · ${activeDb} — open Settings` : 'Waiting for the dashboard workspace'}>
                    <strong>{!workspaceReady ? 'Connecting…' : activeDb === 'codevis_db' ? 'CodeVis' : projectName || 'Project'}</strong>
                    {workspaceReady && <span>{activeDb === 'codevis_db' ? 'Self-graph' : 'Project graph'}</span>}
                </button>
                <button className="ui-button workspace-search" disabled={!workspaceReady} onClick={onSearch}>Search code &amp; work</button>
                {onToggleTerminal && <button className="ui-button" aria-pressed={terminalOpen} onClick={onToggleTerminal}>Terminal</button>}
                <div className="workspace-layout" role="group" aria-label="Workspace layout">
                    {['graph', 'split', 'panel'].map(value => (
                        <button key={value} type="button" className="ui-button"
                            aria-pressed={layout === value} disabled={!onLayoutChange}
                            onClick={() => onLayoutChange?.(value)}
                            title={value === 'panel' ? 'Expand work panel' : value === 'graph' ? 'Expand graph' : 'Show graph and work panel'}>
                            {value === 'graph' ? 'Graph' : value === 'split' ? 'Split' : 'Panel'}
                        </button>
                    ))}
                </div>
            </div>
            <AppTabBar activeTab={activeTab} extractors={extractors} onSelect={onSelectTab} tabs={tabs} />
        </header>
    );
}
