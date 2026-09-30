import { useCallback, useEffect, useState } from 'react';
import { AppSections, AppViewTabs, ThemeToggle, useTabGroups } from './AppTabBar';
import NavigationHistory from './NavigationHistory';

const COLLAPSED_KEY = 'codevis.header.collapsed';
const readCollapsed = () => { try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; } };
const writeCollapsed = value => { try { localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0'); } catch { /* private window: per session only */ } };

/**
 * Two rows instead of three: sections sit in the top row, their subtitles and
 * each view's description are tooltips. Collapsed, the header is one slim row
 * with a breadcrumb (Ctrl+. toggles, remembered per browser). In Full view it
 * hides entirely and slides back in when the pointer reaches the top edge.
 */
export default function WorkspaceHeader({ activeDb, activeTab, extractors, tabs, onSelectTab, layout = 'panel', onLayoutChange, navigation, projectRoot, workspaceReady = true, onSearch, terminalOpen, onToggleTerminal }) {
    const projectName = projectRoot?.split(/[\\/]/).filter(Boolean).pop();
    const nav = useTabGroups({ activeTab, extractors, onSelect: onSelectTab, tabs });
    const [collapsed, setCollapsedState] = useState(readCollapsed);
    const [revealed, setRevealed] = useState(false);
    const setCollapsed = useCallback(value => { setCollapsedState(value); writeCollapsed(value); }, []);
    const autoHide = layout === 'panel' && Boolean(onLayoutChange);

    useEffect(() => {
        const onKey = event => {
            if ((event.ctrlKey || event.metaKey) && event.key === '.') {
                event.preventDefault();
                setCollapsedState(value => { writeCollapsed(!value); return !value; });
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    useEffect(() => { if (!autoHide) setRevealed(false); }, [autoHide]);

    const dbLabel = !workspaceReady ? 'Connecting…' : activeDb === 'codevis_db' ? 'CodeVis' : projectName || 'Project';
    const layoutButtons = (
        <div className="workspace-layout" role="group" aria-label="Workspace layout">
            {['graph', 'split', 'panel'].map(value => (
                <button key={value} type="button" className="ui-button"
                    aria-pressed={layout === value} disabled={!onLayoutChange}
                    onClick={() => onLayoutChange?.(value)}
                    title={value === 'panel' ? 'Expand work panel (the header hides; move to the top edge to show it)' : value === 'graph' ? 'Expand graph' : 'Show graph and work panel'}>
                    {value === 'graph' ? 'Code graph' : value === 'split' ? 'Split view' : 'Full view'}
                </button>
            ))}
        </div>
    );
    const collapseButton = (
        <button type="button" className="ui-button workspace-collapse" aria-expanded={!collapsed}
            title={(collapsed ? 'Expand' : 'Collapse') + ' the header (Ctrl+.)'} aria-label={(collapsed ? 'Expand' : 'Collapse') + ' the header'}
            onClick={() => setCollapsed(!collapsed)}>
            <span aria-hidden="true">{collapsed ? '▼' : '▲'}</span>
        </button>
    );

    const className = 'workspace-header'
        + (collapsed ? ' workspace-header--collapsed' : '')
        + (autoHide ? ' workspace-header--autohide' : '')
        + (autoHide && revealed ? ' workspace-header--revealed' : '');
    return (
        <header className={className} onMouseEnter={() => autoHide && setRevealed(true)} onMouseLeave={() => setRevealed(false)}>
            <div className="workspace-header-inner">
                {collapsed ? (
                    <div className="workspace-heading workspace-heading--collapsed">
                        <button type="button" className="workspace-breadcrumb" onClick={() => setCollapsed(false)} title="Expand the header (Ctrl+.)">
                            <strong className="workspace-brand">CodeVis</strong>
                            <span className="workspace-crumb">{dbLabel}</span>
                            <span className="workspace-crumb-sep" aria-hidden="true">›</span>
                            <span className="workspace-crumb">{nav.activeGroup}</span>
                            <span className="workspace-crumb-sep" aria-hidden="true">›</span>
                            <span className="workspace-crumb workspace-crumb--current">{nav.current?.label}</span>
                        </button>
                        {layoutButtons}
                        {collapseButton}
                    </div>
                ) : (
                    <>
                        <div className="workspace-heading">
                            <strong className="workspace-brand">CodeVis</strong>
                            <NavigationHistory {...navigation} />
                            <button className="workspace-db" disabled={!workspaceReady} onClick={() => onSelectTab('settings')} title={workspaceReady ? `${projectRoot || 'Workspace'} · ${activeDb} — open Settings` : 'Waiting for the dashboard workspace'}>
                                <strong>{dbLabel}</strong>
                                {workspaceReady && <span>{activeDb === 'codevis_db' ? 'Self-graph' : 'Project graph'}</span>}
                            </button>
                            <button className="ui-button workspace-search" disabled={!workspaceReady} onClick={onSearch}>Search code &amp; work</button>
                            {onToggleTerminal && <button className="ui-button" aria-pressed={terminalOpen} onClick={onToggleTerminal}>Terminal</button>}
                            <AppSections nav={nav} compact />
                            {layoutButtons}
                            <ThemeToggle />
                            {collapseButton}
                        </div>
                        <nav className="app-nav app-nav--left" aria-label="Dashboard views">
                            <AppViewTabs nav={nav} activeTab={activeTab} onSelect={onSelectTab} compact />
                        </nav>
                    </>
                )}
            </div>
        </header>
    );
}
