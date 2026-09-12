const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const crypto = require('node:crypto');
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const parser = require('../tools/lib/treesitter.ts');
const { planSemanticRename } = require('../tools/lib/semantic-rename.ts');
const source = ts.createSourceFile('edit-tools.ts', fs.readFileSync(path.resolve(__dirname, '../tools/handlers/edit-tools.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const transaction = ts.createSourceFile('edit-transaction.ts', fs.readFileSync(path.resolve(__dirname, '../tools/lib/edit-transaction.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const helpers = source.statements.filter(n => ts.isFunctionDeclaration(n) && ['collectRenameOffsets', 'applyRenameOffsets'].includes(n.name.text)).map(n => n.getText(source));
helpers.push(transaction.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'commitFileSnapshots').getText(transaction).replace(/^export /, ''));
let handler;
function visit(n) {
    if (ts.isPropertyAssignment(n) && n.name.getText(source) === 'rename_function') handler = n.initializer.getText(source);
    ts.forEachChild(n, visit);
}
visit(source);

function harness(t, fault) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codevis-rename-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const src = path.join(root, 'source.js'), caller = path.join(root, 'app.js');
    const original = 'export function work() { return 42; }\n';
    const callerOriginal = fault === 'parse' ? 'function {' : "import { work } from './source.js';\nconsole.log(work());\n";
    fs.writeFileSync(src, original); fs.writeFileSync(caller, callerOriginal);
    let graphWrites = 0, holding = false, locks;
    const mod = { exports: {} };
    const session = {
        run: async q => {
            if (q.includes('RETURN n.locked')) return { records: [{ get: k => k === 'startLine' ? 1 : null }] };
            if (q.includes('count(n) AS c')) return { records: [{ get: () => ({ toNumber: () => 0 }) }] };
            if (q.includes('RETURN caller.file')) return { records: [{ get: k => k === 'callerFile' ? 'app.js' : 'main' }] };
            if (q.includes('SET n.name')) graphWrites++;
            return { records: [] };
        }, close: async () => {},
    };
    vm.runInNewContext(ts.transpile(helpers.join('\n') + '\nmodule.exports = ' + handler, { target: ts.ScriptTarget.ES2022 }), require('./helpers/file-publication.cjs')({
        module: mod, process, ...path, ...fs, ...crypto, ...parser, planSemanticRename, PROJECT_ROOT: root,
        pickDbDriver: () => ({ session: () => session }), isPathAllowed: () => true, graphInt: Number,
        assertFileScope: async () => {},
        withFileLock: async (_, fn) => fn(),
        withFileLocks: async (paths, fn) => {
            locks = paths; holding = true;
            if (fault === 'caller-conflict') fs.appendFileSync(caller, '// NEW USER EDIT\n');
            if (fault === 'source-conflict') fs.appendFileSync(src, '// NEW USER EDIT\n');
            try { return await fn(); } finally { holding = false; }
        },
        createEditBackup: (file, _, content) => {
            const backupToken = crypto.randomUUID();
            fs.writeFileSync(path.join(root, backupToken + '.bak'), content);
            return { backupToken };
        },
        writeFileSync: (file, ...args) => {
            if (fault === 'stage' && file.startsWith(caller + '.')) throw new Error('ENOSPC');
            fs.writeFileSync(file, ...args);
        },
        renameSync: (a, b) => {
            assert.equal(holding, true);
            if (fault === 'commit' && b === caller) throw new Error('EACCES');
            fs.renameSync(a, b);
        },
        syncFileToGraph: async () => {}, recordEditTouch: async () => {}, logger: { info: () => {} },
    }));
    return { root, src, caller, original, callerOriginal, get locks() { return locks; }, get graphWrites() { return graphWrites; },
        run: async () => {
            const result = await mod.exports({ agentId: 'audit', file: 'source.js', oldName: 'work', newName: 'renamed' }, { lockingEnabled: false });
            return { ...result, body: JSON.parse(result.content[0].text) };
        } };
}

test('rename preserves source and caller symlinks and the resulting modules execute', async t => {
    const h = harness(t);
    for (const file of [h.src, h.caller]) {
        const target = path.join(h.root, 'physical-' + path.basename(file));
        fs.renameSync(file, target); fs.symlinkSync(target, file, 'file');
    }
    const result = await h.run();
    assert.equal(result.body.status, 'OK', JSON.stringify(result));
    assert.equal(fs.lstatSync(h.src).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(h.caller).isSymbolicLink(), true);
    fs.writeFileSync(path.join(h.root, 'package.json'), '{"type":"module"}');
    const output = require('node:child_process').execFileSync(process.execPath, [h.caller], { encoding: 'utf8', timeout: 10000 });
    assert.equal(output.trim(), '42');
});

for (const fault of ['caller-conflict', 'source-conflict', 'stage', 'commit', 'parse']) {
    test(`rename_function leaves the complete source/caller set intact after ${fault}`, async t => {
        const h = harness(t, fault);
        const result = await h.run();
        assert.equal(result.isError, true);
        assert.equal(fs.readFileSync(h.src, 'utf8'), h.original + (fault === 'source-conflict' ? '// NEW USER EDIT\n' : ''));
        assert.equal(fs.readFileSync(h.caller, 'utf8'), h.callerOriginal + (fault === 'caller-conflict' ? '// NEW USER EDIT\n' : ''));
        assert.equal(h.graphWrites, 0);
        if (fault.endsWith('conflict')) assert.equal(result.body.status, 'CONFLICT');
        if (fault === 'commit') assert.equal(result.body.rolledBack, true);
        assert.ok(!fs.readdirSync(h.root).some(f => f.includes('_tmp')));
    });
}
test('rename_function backs up and commits declaration and caller under the whole lock set', async t => {
    const h = harness(t);
    const result = await h.run();
    assert.equal(result.body.status, 'OK', JSON.stringify(result));
    assert.deepEqual([...h.locks].sort(), [h.src, h.caller].sort());
    assert.equal(result.body.callersUpdated, 1);
    assert.ok(result.body.backupToken);
    assert.equal(result.body.callerBackupTokens.length, 1);
    assert.match(fs.readFileSync(h.src, 'utf8'), /function renamed/);
    assert.match(fs.readFileSync(h.caller, 'utf8'), /renamed\(\)/);
    fs.writeFileSync(path.join(h.root, 'package.json'), '{"type":"module"}');
    const run = require('node:child_process').spawnSync(process.execPath, [h.caller], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), '42');
});
