import WorkspaceHeader from './WorkspaceHeader';

export const FULL_SCREEN_TABS = new Set([
    'brain', 'spec', 'classes', 'ros', 'diagrams', 'documentation',
]);

export function FullScreenTabShell({
    activeDb,
    activeTab,
    bridgeUrl,
    children,
    connected,
    extractors,
    onSelectTab,
    onLayoutChange,
    navigation,
    tabs,
    projectRoot,
    workspaceReady,
    onSearch,
}) {
    return (
        <div style={{
            height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column',
            background: 'var(--bg)', color: 'var(--text)', overflow: 'hidden',
        }}>
            {connected === false && (
                <div style={{ padding: '8px 16px', background: '#ef4444', color: '#fff', fontSize: 13, fontWeight: 600, textAlign: 'center', flexShrink: 0 }}>
                    No connection to the bridge ({bridgeUrl})
                </div>
            )}
            <WorkspaceHeader workspaceReady={workspaceReady} projectRoot={projectRoot} onSearch={onSearch} activeDb={activeDb} activeTab={activeTab} extractors={extractors} onSelectTab={onSelectTab} tabs={tabs} onLayoutChange={onLayoutChange} navigation={navigation} />
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                {children}
            </div>
        </div>
    );
}
