const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
require('../lib/tsx-userinfo-preload.cjs');
require('tsx/cjs/api').register();
const { planSemanticRename } = require('../tools/lib/semantic-rename.ts');

function run(files) {
    const cache = new Map();
    const load = file => {
        if (cache.has(file)) return cache.get(file).exports;
        const module = { exports: {} }; cache.set(file, module);
        const code = ts.transpileModule(files[file], { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
        vm.runInNewContext(code, { module, exports: module.exports, require: spec => load(path.basename(spec)) });
        return module.exports;
    };
    return load('app.js').result;
}
const scenarios = [
    ['template expression', 'export function work(){return 42;}', 'import { work } from "./source.js"; export const result = `${work()}`;', '42'],
    ['shorthand property', 'export function work(){return 42;}', 'import { work } from "./source.js"; const api={work}; export const result=api.work();', 42],
    ['same-file caller', 'export function work(){return 42;} export function main(){return work();}', 'import { main } from "./source.js"; export const result=main();', 42],
    ['aliased caller', 'export function work(){return 42;}', 'import { work as local } from "./source.js"; export const result=local();', 42],
    ['shadowed local', 'export function work(){return 40;}', 'import { work } from "./source.js"; function other(work){return {work}.work;} export const result=work()+other(2);', 42],
    ['destructuring shadow', 'export function work(){return 40;}', 'import { work } from "./source.js"; function other({work}){return work;} export const result=work()+other({work:2});', 42],
    ['unrelated same name', 'export function work(){return 40;}', 'import { work } from "./source.js"; const api={work:()=>2}; export const result=work()+api.work();', 42],
    ['literal string', 'export function work(){return 42;}', 'import { work } from "./source.js"; export const result=work()+" work";', '42 work'],
];
for (const [name, source, caller, expected] of scenarios) {
    test(`semantic rename preserves runtime behavior: ${name}`, () => {
        const root = path.resolve('semantic-fixture');
        const originals = { 'source.js': source, 'app.js': caller };
        const inputs = Object.entries(originals).map(([file, original]) => ({ file, path: path.join(root, file), original }));
        assert.equal(run(originals), expected);
        const edited = planSemanticRename(inputs, path.join(root, 'source.js'), 'work', 'renamed', 1);
        const after = Object.fromEntries(edited.map(file => [file.file, file.content]));
        assert.equal(run(after), expected, JSON.stringify(after));
        assert.match(after['source.js'], /function renamed/);
        if (name === 'shadowed local') assert.match(after['app.js'], /other\(work\)/);
    });
}

test('semantic rename rejects a conflicting caller binding without preparing any writes', () => {
    const root = path.resolve('semantic-fixture');
    const files = [
        { file: 'source.js', path: path.join(root, 'source.js'), original: 'export function work(){return 40;}' },
        { file: 'app.js', path: path.join(root, 'app.js'), original: 'import {work} from "./source.js"; const renamed=2; export const result=work()+renamed;' },
    ];
    assert.throws(() => planSemanticRename(files, files[0].path, 'work', 'renamed', 1), /NAME_CONFLICT/);
});
