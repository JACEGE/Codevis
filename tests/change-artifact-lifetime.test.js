const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const hookRunner=require('./helpers/hook-runner.cjs');
function fixture() {
  const requests=[];
  const run=hookRunner(path.resolve(__dirname,'../frontend/src/changes/useFlowArtifact.js'),{});
  const getArtifact=path=>new Promise((resolve,reject)=>requests.push({path,resolve,reject}));
  let scope='node|flow|1';
  const render=()=>run({scope,getArtifact});
  render();
  return {requests,render,revision:value=>{scope=value;return render();},unmount:run.unmount};
}
test('an inspected artifact disappears on revision change and an old response cannot restore it',async()=>{
  const h=fixture();
  const loaded=h.render().open('requirements-r1.md');
  h.requests.shift().resolve({content:'old requirements'});await loaded;
  assert.equal(h.render().artifact.content,'old requirements');
  const pending=h.render().open('requirements-r1.md');
  assert.equal(h.revision('node|flow|2').artifact,null);
  h.requests.shift().resolve({content:'late old requirements'});await pending;
  assert.equal(h.render().artifact,null);
  const current=h.render().open('requirements-r2.md');
  h.requests.shift().resolve({content:'reviewed requirements'});await current;
  assert.equal(h.render().artifact.content,'reviewed requirements');h.unmount();
});
test('only the last requested artifact can update the inspector',async()=>{
  const h=fixture();const first=h.render().open('first.md'),second=h.render().open('second.md');
  h.requests[1].resolve({content:'second'});await second;
  h.requests[0].reject(new Error('obsolete failure'));await first;
  assert.equal(h.render().artifact.content,'second');assert.equal(h.render().error,undefined);h.unmount();
});
test('switching away and back invalidates old artifact errors',async()=>{
  const h=fixture();const pending=h.render().open('old.md');
  h.revision('other|flow|1');h.revision('node|flow|1');
  h.requests[0].reject(new Error('late error'));await pending;
  assert.equal(h.render().error,null);h.unmount();
});
