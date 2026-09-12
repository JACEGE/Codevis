// Deterministic callback-level hook runner. Does not claim to test React's
// renderer; it exercises the production callback bodies and request lifetimes.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('esbuild');

module.exports = function hookRunner(filename, dependencies, globals = {}) {
    const slots=[]; let cursor=0, effects=[];
    const equal=(a,b)=>a && b && a.length===b.length && a.every((v,i)=>Object.is(v,b[i]));
    const react={
        useState(initial) { const i=cursor++; if(!(i in slots)) slots[i]=typeof initial==='function'?initial():initial; return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v;}]; },
        useRef(initial) { const i=cursor++; return slots[i] ||= {current:initial}; },
        useCallback(fn,deps) { const i=cursor++; if(!equal(slots[i]?.deps,deps)) slots[i]={fn,deps}; return slots[i].fn; },
        useMemo(fn,deps) { const i=cursor++; if(!equal(slots[i]?.deps,deps)) slots[i]={value:fn(),deps}; return slots[i].value; },
        useEffect(fn,deps) {
            const i=cursor++;
            if(!equal(slots[i]?.deps,deps)) effects.push(()=>{slots[i]?.cleanup?.(); slots[i]={deps,cleanup:fn()};});
        },
    };
    function load(source) {
      const mod={exports:{}};
      vm.runInNewContext(transformSync(fs.readFileSync(source,'utf8'),{format:'cjs'}).code, {
        ...globals,
        module:mod,exports:mod.exports,require:name=>{
            if(name==='react') return react;
            if(name in dependencies) return dependencies[name];
            if(name.startsWith('.')) return load(path.resolve(path.dirname(source), `${name}.js`));
            throw new Error(`Unexpected hook dependency: ${name}`);
        },
      });
      return mod.exports;
    }
    const mod = load(filename);
    const render = props=>{
        cursor=0;
        const hook=mod.default(props);
        const pending=effects; effects=[]; pending.forEach(fn=>fn());
        return hook;
    };
    render.unmount = () => slots.forEach(slot => slot?.cleanup?.());
    return render;
};
