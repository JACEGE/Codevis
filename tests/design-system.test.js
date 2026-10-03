const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = () => import('../frontend/src/theme/tokens.js');
function luminance(hex) {
    const rgb = hex.slice(1).match(/../g).slice(0, 3).map(v => parseInt(v, 16) / 255)
        .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(a, b) {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
test('graphite and light themes expose the same semantic roles and readable text', async () => {
    const { THEMES } = await load();
    assert.deepEqual(Object.keys(THEMES.dark), Object.keys(THEMES.light));
    for (const [name, t] of Object.entries(THEMES)) {
        for (const role of ['text', 'muted', 'accent', 'danger', 'success', 'warning']) {
            for (const surface of ['bg', 'surface', 'surface-raised'])
                assert.ok(contrast(t[role], t[surface]) >= 4.5, `${name}: ${role} on ${surface}`);
        }
        assert.ok(contrast(t['on-accent'], t['accent-strong']) >= 4.5, name + ': primary action');
        assert.ok(contrast(t['on-accent'], t['accent-hover']) >= 4.5, name + ': primary hover');
        assert.ok(contrast(t.accent, t['accent-soft']) >= 4.5, name + ': selected control');
        assert.ok(contrast(t.danger, t['danger-soft']) >= 4.5, name + ': destructive action');
        assert.ok(contrast(t['on-danger'], t['danger-strong']) >= 4.5, name + ': recording action');
        assert.equal(t['graph-bg'], t.bg);
    }
});

let puppeteer;
try { puppeteer = require('puppeteer'); } catch { /* optional browser checks */ }

test('rendered controls share geometry, readable interaction states and explicit compact sizes', {
    skip: process.env.SKIP_BROWSER_TESTS === '1' || !puppeteer,
}, async () => {
    const { THEMES } = await load();
    const layout = fs.readFileSync(path.join(__dirname, '../frontend/src/demo-theme.css'), 'utf8');
    const controls = fs.readFileSync(path.join(__dirname, '../frontend/src/theme/controls.css'), 'utf8');
    const browser = await puppeteer.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        for (const [name, tokens] of Object.entries(THEMES)) {
            const vars = Object.entries(tokens).map(([key, value]) => `--${key}:${value}`).join(';');
            await page.setContent(`<html data-theme="${name}" style="${vars}"><head><style>${layout}\n${controls}</style></head><body>
                <button id="plain">Cancel</button>
                <button id="primary" class="ui-button ui-button--primary">Save</button>
                <button id="danger" class="ui-button ui-button--danger">Delete</button>
                <button class="inspector-action-btn">Inspect</button>
                <button class="apply-btn">Apply</button>
                <button class="debug-btn">Step</button>
                <button class="debug-mode-btn active">Mode</button>
                <button id="disabled" disabled>Unavailable</button>
                <button id="small" class="ui-button ui-button--small">Compact</button>
                <button id="icon" class="ui-button ui-button--small ui-button--icon">+</button>
                <div class="ui-segmented"><button id="selected" class="ui-button" aria-pressed="true">2D</button></div>
            </body></html>`);
            const geometry = await page.$$eval('button', buttons => buttons.map(b => {
                const s = getComputedStyle(b);
                return { id: b.id, height: b.getBoundingClientRect().height, width: b.getBoundingClientRect().width,
                    radius: s.borderRadius, padding: s.padding, opacity: s.opacity, cursor: s.cursor };
            }));
            for (const button of geometry) {
                assert.equal(button.radius, '6px', `${name}: ${button.id} radius`);
                const compact = ['small', 'icon', 'selected'].includes(button.id);
                assert.equal(button.height, compact ? 28 : 32, `${name}: ${button.id} height`);
                if (!compact) assert.equal(button.padding, '6px 10px', `${name}: shared padding`);
            }
            assert.equal(geometry.find(b => b.id === 'icon').width, 28);
            assert.equal(geometry.find(b => b.id === 'disabled').cursor, 'not-allowed');
            assert.equal(geometry.find(b => b.id === 'disabled').opacity, '0.5');
            const readColours = id => page.$eval(id, b => {
                const s = getComputedStyle(b);
                const hex = rgb => '#' + rgb.match(/\d+/g).slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('');
                return { text: hex(s.color), background: hex(s.backgroundColor) };
            });
            for (const id of ['#primary', '#danger', '#selected']) {
                let colours = await readColours(id);
                assert.ok(contrast(colours.text, colours.background) >= 4.5, `${name}: ${id} contrast`);
                await page.hover(id);
                colours = await readColours(id);
                assert.ok(contrast(colours.text, colours.background) >= 4.5, `${name}: ${id} hover contrast`);
            }
            await page.focus('#plain');
            await page.keyboard.press('Tab');
            const focus = await page.$eval('#primary', b => ({ focused: b.matches(':focus-visible'), outline: getComputedStyle(b).outlineWidth }));
            assert.equal(focus.focused, true);
            assert.equal(focus.outline, '2px');
        }
    } finally {
        await browser.close();
    }
});
test('theme changes replace all CSS roles and keep canvas and terminal in agreement', async () => {
    const { applyTheme, themeTokens, terminalTheme } = await load();
    const properties = new Map();
    const root = { dataset: {}, style: { setProperty: (key, value) => properties.set(key, value) } };
    for (const name of ['dark', 'light', 'dark']) {
        applyTheme(name, root);
        assert.equal(root.dataset.theme, name);
        assert.equal(root.style.colorScheme, name);
        for (const [role, colour] of Object.entries(themeTokens(name))) assert.equal(properties.get('--' + role), colour);
        assert.equal(terminalTheme(name).background, properties.get('--terminal-bg'));
        assert.equal(terminalTheme(name).foreground, properties.get('--text'));
    }
    applyTheme('unknown', root);
    assert.equal(root.dataset.theme, 'dark');
});
test('inline action variants use the common CSS geometry and states', async () => {
    const { buttonStyle, controlStyle } = await load();
    for (const style of [buttonStyle(), buttonStyle('primary'), buttonStyle('danger'), buttonStyle('default', true)]) {
        assert.ok(Object.keys(style).every(key => key.startsWith('--button-')));
    }
    assert.equal(controlStyle.borderRadius, 'var(--radius-control)');
    assert.equal(controlStyle.minHeight, 'var(--control-height)');
    const css = fs.readFileSync(path.join(__dirname, '../frontend/src/theme/controls.css'), 'utf8');
    assert.match(css, /button:focus-visible/);
    assert.match(css, /button:disabled/);
    assert.match(css, /hover:not\(:disabled\)/);
    assert.match(css, /prefers-reduced-motion/);
    assert.doesNotMatch(css, /!important/);
});
