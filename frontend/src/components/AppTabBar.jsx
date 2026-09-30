import { useEffect, useRef } from 'react';
import useTheme from '../hooks/useTheme';

export const groupDescriptions = { Work: 'Plan and deliver changes', Analyze: 'Understand the code', Model: 'Inspect system structure', System: 'Guides and configuration' };

/** Groups, the active group and view, and group selection that returns to the view last used in it. */
export function useTabGroups({ activeTab, extractors, onSelect, tabs }) {
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
    const groupTabs = availableTabs.filter(tab => (tab.group || 'Views') === activeGroup);
    return { groups, current, activeGroup, selectGroup, groupTabs };
}

export function ThemeToggle() {
    const [theme, setTheme] = useTheme();
    return (
        <button className="theme-toggle" type="button"
            aria-label={'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
            {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
    );
}

/** Work / Analyze / Model / System. `compact` drops the subtitles to a tooltip. */
export function AppSections({ nav, compact = false }) {
    return (
        <div className={'app-nav-sections' + (compact ? ' app-nav-sections--compact' : '')} role="group" aria-label="Dashboard sections">
            {nav.groups.map(group => <button type="button" key={group} className="app-nav-section"
                data-group={group.toLowerCase()} aria-pressed={nav.activeGroup === group}
                title={groupDescriptions[group]} onClick={() => nav.selectGroup(group)}>
                <span className="app-nav-group-label">{group}</span>
                {!compact && <small>{groupDescriptions[group]}</small>}
            </button>)}
        </div>
    );
}

/** The views of the active group. `compact` moves the description into the tooltip. */
export function AppViewTabs({ nav, activeTab, onSelect, compact = false }) {
    return (
        <div className="app-nav-view-row">
            <div className="app-nav-items" role="group" aria-label={nav.activeGroup + ' views'}>
                {nav.groupTabs.map(tab => {
                    const active = activeTab === tab.key;
                    return <button type="button" className={'app-nav-item' + (active ? ' active' : '')}
                        key={tab.key} aria-current={active ? 'page' : undefined}
                        title={tab.description} onClick={() => onSelect(tab.key)}>{tab.label}</button>;
                })}
            </div>
            {!compact && <p className="app-nav-description">{nav.current?.description}</p>}
        </div>
    );
}

export default function AppTabBar({ activeTab, extractors, onSelect, tabs, align = 'left' }) {
    const nav = useTabGroups({ activeTab, extractors, onSelect, tabs });
    return (
        <nav className={'app-nav app-nav--' + align} aria-label="Dashboard views">
            <div className="app-nav-sections-row">
                <AppSections nav={nav} />
                <ThemeToggle />
            </div>
            <AppViewTabs nav={nav} activeTab={activeTab} onSelect={onSelect} />
        </nav>
    );
}
