import { useEffect, useRef } from 'react';
import useTheme from '../hooks/useTheme';

const groupDescriptions = { Work: 'Plan and deliver changes', Analyze: 'Understand the code', Model: 'Inspect system structure', System: 'Guides and configuration' };
export default function AppTabBar({ activeTab, extractors, onSelect, tabs, align = 'left' }) {
    const [theme, setTheme] = useTheme();
    const remembered = useRef({});
    const availableTabs = tabs.filter(tab => !tab.requiresExtractor || extractors?.[tab.requiresExtractor]);
    const groups = [...new Set(availableTabs.map(tab => tab.group || 'Views'))];
    const current = availableTabs.find(tab => tab.key === activeTab);
    const activeGroup = current?.group || groups[0];
    useEffect(() => { if (current) remembered.current[activeGroup] = current.key; }, [activeGroup, current?.key]);
    const selectGroup = group => {
        const candidates = availableTabs.filter(tab => (tab.group || 'Views') === group);
        onSelect(candidates.find(tab => tab.key === remembered.current[group])?.key || candidates[0].key);
    };
    return (
        <nav className={'app-nav app-nav--' + align} aria-label="Dashboard views">
            <div className="app-nav-sections" role="group" aria-label="Dashboard sections">
                {groups.map(group => <button type="button" key={group} className="app-nav-section"
                    data-group={group.toLowerCase()} aria-pressed={activeGroup === group}
                    title={groupDescriptions[group]} onClick={() => selectGroup(group)}>
                    <span className="app-nav-group-label">{group}</span>
                    <small>{groupDescriptions[group]}</small>
                </button>)}
                <button className="theme-toggle" type="button"
                    aria-label={'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode'}
                    onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                    <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
                    {theme === 'dark' ? 'Light' : 'Dark'}
                </button>
            </div>
            <div className="app-nav-view-row">
                <div className="app-nav-items" role="group" aria-label={activeGroup + ' views'}>
                    {availableTabs.filter(tab => (tab.group || 'Views') === activeGroup).map(tab => {
                        const active = activeTab === tab.key;
                        return <button type="button" className={'app-nav-item' + (active ? ' active' : '')}
                            key={tab.key} aria-current={active ? 'page' : undefined}
                            title={tab.description} onClick={() => onSelect(tab.key)}>{tab.label}</button>;
                    })}
                </div>
                <p className="app-nav-description">{current?.description}</p>
            </div>
        </nav>
    );
}
