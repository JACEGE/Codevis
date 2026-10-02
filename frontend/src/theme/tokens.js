// The single colour source for CSS, canvas/Three.js, diagrams and xterm.
// Semantic graph-type colours remain in nodePalette: they describe data, not UI chrome.
export const THEMES = Object.freeze({
    dark: Object.freeze({
        bg: '#18181b', surface: '#222226', 'surface-raised': '#2b2b30', 'surface-hover': '#333339',
        border: '#3f3f46', 'border-strong': '#66666f', text: '#e7e7ea', muted: '#aaaab3',
        accent: '#91b2d6', 'accent-strong': '#789bc4', 'accent-hover': '#91b2d6', 'on-accent': '#121921',
        'accent-soft': '#293645', 'accent-border': '#577799',
        success: '#89b69a', 'success-soft': '#25372d', warning: '#d6b176', 'warning-soft': '#3b3225',
        danger: '#e49a9a', 'danger-soft': '#432b30', 'danger-strong': '#ae3c49', 'on-danger': '#ffffff',
        info: '#91b2d6', 'info-soft': '#293645', violet: '#baa9d1', 'violet-soft': '#342e40',
        'graph-bg': '#18181b', 'graph-outline': '#77777f', 'graph-label-bg': '#222226ed',
        'terminal-bg': '#18181b', 'terminal-text': '#e7e7ea', 'selection-bg': '#57779966',
        shadow: '#00000040', backdrop: '#00000088',
    }),
    light: Object.freeze({
        bg: '#f3f4f6', surface: '#ffffff', 'surface-raised': '#f8f9fa', 'surface-hover': '#e8ebef',
        border: '#d4d7dd', 'border-strong': '#9097a2', text: '#25272c', muted: '#606671',
        accent: '#42658e', 'accent-strong': '#42658e', 'accent-hover': '#345273', 'on-accent': '#ffffff',
        'accent-soft': '#e4edf6', 'accent-border': '#839ebc',
        success: '#346c49', 'success-soft': '#e7f1e9', warning: '#855a20', 'warning-soft': '#f5eddf',
        danger: '#a32f3c', 'danger-soft': '#f9e8ea', 'danger-strong': '#ae3c49', 'on-danger': '#ffffff',
        info: '#42658e', 'info-soft': '#e4edf6', violet: '#6c5187', 'violet-soft': '#eee8f4',
        'graph-bg': '#f3f4f6', 'graph-outline': '#747b85', 'graph-label-bg': '#ffffffed',
        'terminal-bg': '#ffffff', 'terminal-text': '#25272c', 'selection-bg': '#839ebc55',
        shadow: '#20232a18', backdrop: '#20232a66',
    }),
});

export function themeTokens(theme) { return THEMES[theme] || THEMES.dark; }

export function applyTheme(theme, root = document.documentElement) {
    const name = theme === 'light' ? 'light' : 'dark';
    root.dataset.theme = name;
    root.style.colorScheme = name;
    for (const [key, value] of Object.entries(themeTokens(name))) root.style.setProperty(`--${key}`, value);
}

export function terminalTheme(theme) {
    const t = themeTokens(theme);
    return {
        background: t['terminal-bg'], foreground: t['terminal-text'], cursor: t.accent, cursorAccent: t.bg,
        selectionBackground: t['selection-bg'], black: theme === 'light' ? t.text : t.bg, brightBlack: t.muted,
        red: t.danger, green: t.success, yellow: t.warning, blue: t.accent, magenta: t.violet, cyan: t.info,
        white: t.text, brightWhite: t.text,
    };
}

export const controlStyle = Object.freeze({
    minHeight: 'var(--control-height)', padding: 'var(--control-padding)',
    borderRadius: 'var(--radius-control)', fontSize: 'var(--control-font-size)',
    fontFamily: 'var(--font-family)',
});

// Inline consumers set variables, not competing background/shape declarations.
// The shared CSS still owns hover, focus, disabled, size and geometry.
export function buttonStyle(variant = 'default', active = false) {
    if (variant === 'primary') return {
        '--button-bg': 'var(--accent-strong)', '--button-text': 'var(--on-accent)',
        '--button-border': 'var(--accent-strong)', '--button-hover': 'var(--accent-hover)',
    };
    if (variant === 'danger') return {
        '--button-bg': 'var(--danger-soft)', '--button-text': 'var(--danger)',
        '--button-border': 'var(--danger)', '--button-hover': 'var(--danger-soft)',
    };
    if (active) return {
        '--button-bg': 'var(--accent-soft)', '--button-text': 'var(--accent)',
        '--button-border': 'var(--accent-border)',
    };
    return {};
}
