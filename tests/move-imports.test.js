const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ts = require('typescript');
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const { rewriteMovedImports } = require('../tools/lib/move-imports.ts');

for (const [sourceExt, runtimeExt] of [['.js', '.js'], ['.ts', '.js'], ['.tsx', '.js'], ['.mts', '.mjs'], ['.cts', '.cjs'], ['.ts', '']]) {
    test(`move resolves a symbolic ${sourceExt} source imported with ${runtimeExt || 'no extension'}`, t => {
        const fs = require('node:fs');
        const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codevis-import-link-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const source = path.join(root, 'physical-source' + sourceExt), target = path.join(root, 'physical-target' + sourceExt);
        fs.writeFileSync(source, 'export function work() {}');
        fs.writeFileSync(target, '');
        fs.symlinkSync(source, path.join(root, 'source' + sourceExt), 'file');
        const output = rewriteMovedImports(`import { work } from './source${runtimeExt}'; work();`, path.join(root, 'app.ts'), source, target, 'work');
        assert.equal(imports(output)[0].module, './physical-target' + runtimeExt);
    });
}
function imports(text) {
    return ts.createSourceFile('a.ts', text, ts.ScriptTarget.Latest, true).statements
        .filter(ts.isImportDeclaration).map(s => ({ module: s.moduleSpecifier.text,
            names: s.importClause.namedBindings?.elements?.map(e => e.getText()) || [],
            default: s.importClause.name?.text }));
}
for (const [platform, paths, root] of [['Windows', path.win32, 'C:\\repo'], ['POSIX', path.posix, '/repo']]) {
    for (const ext of ['', '.js', '.ts', '.mjs']) {
        test(`${platform} move preserves mixed imports, aliases and ${ext || 'extensionless'} paths`, () => {
            const input = `// keep\nimport main, { work as renamed, helper } from './source${ext}';\nrenamed(); helper();`;
            const output = rewriteMovedImports(input, paths.join(root, 'app.ts'), paths.join(root, 'source' + (ext || '.ts')),
                paths.join(root, 'lib/target' + (ext || '.ts')), 'work', paths);
            const result = imports(output);
            assert.equal(result[0].module, './source' + ext);
            assert.deepEqual(result[0].names, ['helper']);
            assert.equal(result[0].default, 'main');
            assert.equal(result[1].module, './lib/target' + ext);
            assert.deepEqual(result[1].names, ['work as renamed']);
            assert.match(output, /^\/\/ keep/);
            assert.match(output, /renamed\(\); helper\(\);$/);
        });
    }
    test(`${platform} nested caller gets a relative path to its sibling`, () => {
        const output = rewriteMovedImports("import { work } from '../source.js';", paths.join(root, 'views/app.js'),
            paths.join(root, 'source.js'), paths.join(root, 'lib/target.js'), 'work', paths);
        assert.equal(imports(output)[0].module, '../lib/target.js');
    });
}
test('move handles runtime .js imports of a TypeScript source and type-only bindings', () => {
    const output = rewriteMovedImports("import type { Work, Other } from './source.js';", '/repo/a.ts', '/repo/source.ts', '/repo/target.ts', 'Work', path.posix);
    assert.equal(imports(output)[1].module, './target.js');
    assert.match(output, /import type \{ Work \}/);
});
test('unrelated paths with the same basename and strings/comments are unchanged', () => {
    const input = `import { work } from './other/source.js';\n// import { work } from './source.js';\nconst note = "from './source.js'";`;
    assert.equal(rewriteMovedImports(input, '/repo/a.js', '/repo/source.js', '/repo/target.js', 'work', path.posix), input);
});
test('unsupported namespace and self-import moves fail before any edits', () => {
    assert.throws(() => rewriteMovedImports("import * as api from './source.js';", '/repo/a.js', '/repo/source.js', '/repo/target.js', 'work', path.posix), /Namespace/);
    assert.throws(() => rewriteMovedImports("import { work } from './source.js';", '/repo/target.js', '/repo/source.js', '/repo/target.js', 'work', path.posix), /Destination imports/);
});

test('a dot-prefixed destination still gets a relative module specifier', () => {
    const output = rewriteMovedImports('import { work } from "./source.js";', '/repo/a.js', '/repo/source.js', '/repo/.hidden.js', 'work', path.posix);
    assert.equal(imports(output)[0].module, './.hidden.js');
});
