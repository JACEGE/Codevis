import useTheme from '../hooks/useTheme';

export default function AppTabBar({ activeTab, extractors, onSelect, tabs, align = 'left' }) {
    const [theme, setTheme] = useTheme();
    const availableTabs = tabs.filter((tab) => !tab.requiresExtractor || extractors?.[tab.requiresExtractor]);
    const groups = [...new Set(availableTabs.map((tab) => tab.group || 'Views'))];
    return (
        <nav className={`app-nav app-nav--${align}`} aria-label="Dashboard views">
            {groups.map((group) => (
                <div className="app-nav-group" data-group={group.toLowerCase()} key={group}>
                    <span className="app-nav-group-label">{group}</span>
                    <div className="app-nav-items">
                        {availableTabs.filter((tab) => (tab.group || 'Views') === group).map((tab) => {
                            const active = activeTab === tab.key;
                            return (
                                <button
                                    className={`app-nav-item${active ? ' active' : ''}`}
                                    key={tab.key}
                                    aria-current={active ? 'page' : undefined}
                                    onClick={() => onSelect(tab.key)}
                                >
                                    {tab.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            ))}
            <button
                className="theme-toggle"
                type="button"
                aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                title={`Use ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
                <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
                {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
        </nav>
    );
}
