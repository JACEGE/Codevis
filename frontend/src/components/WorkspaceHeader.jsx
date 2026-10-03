import { AppSectionMenus, ThemeToggle, useTabGroups } from './AppTabBar';
import NavigationHistory from './NavigationHistory';

/**
 * One row that is always there: brand, history, project, search and the four
 * sections. The active section shows the current view ("Work › Task board");
 * hovering or focusing a section opens its views underneath. An earlier
 * version hid the whole header in Full view and behind a collapse toggle,
 * which made the navigation hard to find.
 */
export default function WorkspaceHeader({ activeDb, activeTab, extractors, tabs, onSelectTab, layout = 'panel', onLayoutChange, navigation, projectRoot, workspaceReady = true, onSearch, terminalOpen, onToggleTerminal }) {
    const projectName = projectRoot?.split(/[\\/]/).filter(Boolean).pop();
    const nav = useTabGroups({ activeTab, extractors, onSelect: onSelectTab, tabs });
    const dbLabel = !workspaceReady ? 'Connecting…' : activeDb === 'codevis_db' ? 'CodeVis' : projectName || 'Project';
    return (
        <header className="workspace-header">
            <div className="workspace-heading">
                <strong className="workspace-brand">CodeVis</strong>
                <NavigationHistory {...navigation} />
                <button className="workspace-db" disabled={!workspaceReady} onClick={() => onSelectTab('settings')} title={workspaceReady ? `${projectRoot || 'Workspace'} · ${activeDb} — open Settings` : 'Waiting for the dashboard workspace'}>
                    <strong>{dbLabel}</strong>
                    {workspaceReady && <span>{activeDb === 'codevis_db' ? 'Self-graph' : 'Project graph'}</span>}
                </button>
                <button className="ui-button workspace-search" disabled={!workspaceReady} onClick={onSearch}>Search code &amp; work</button>
                {onToggleTerminal && <button className="ui-button" aria-pressed={terminalOpen} onClick={onToggleTerminal}>Terminal</button>}
                <nav className="app-nav app-nav--inline" aria-label="Dashboard views">
                    <AppSectionMenus nav={nav} activeTab={activeTab} />
                </nav>
                <div className="workspace-layout" role="group" aria-label="Workspace layout">
                    {['graph', 'split', 'panel'].map(value => (
                        <button key={value} type="button" className="ui-button"
                            aria-pressed={layout === value} disabled={!onLayoutChange}
                            onClick={() => onLayoutChange?.(value)}
                            title={value === 'panel' ? 'Expand work panel' : value === 'graph' ? 'Expand graph' : 'Show graph and work panel'}>
                            {value === 'graph' ? 'Code graph' : value === 'split' ? 'Split view' : 'Full view'}
                        </button>
                    ))}
                </div>
                <ThemeToggle />
            </div>
        </header>
    );
}
