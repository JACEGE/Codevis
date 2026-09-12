const test = require('node:test');
const assert = require('node:assert/strict');

test('Kanban columns remain readable and cards do not shrink inside scrolling lists', async () => {
    const { default: styles } = await import('../frontend/src/kanban/styles.js');
    assert.equal(styles.board.overflow, 'auto');
    const tracks = /^repeat\(12, minmax\((\d+)px, 1fr\)\)$/.exec(styles.board.gridTemplateColumns);
    assert.ok(tracks, 'the board keeps twelve flexible tracks with a minimum width');
    assert.ok(Number(tracks[1]) >= 48, 'tracks must not collapse below the readable minimum');
    assert.equal(styles.card.flexShrink, 0);
});
