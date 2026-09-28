const test=require('node:test');const assert=require('node:assert/strict');
const express=require('express');const path=require('node:path');
const {registerDocumentationRoutes}=require('../server/documentation-routes.cjs');
test('dashboard serves packaged guides and rejects arbitrary file selection',async()=>{
  const app=express();registerDocumentationRoutes(app,path.resolve(__dirname,'..'));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base='http://127.0.0.1:'+server.address().port+'/api/docs';
  try {
    const overview=await fetch(base);assert.equal(overview.status,200);assert.match(await overview.text(),/^# CodeVis/);
    const guide=await fetch(base+'?guide=changes');assert.ok(guide.headers.get('content-type').startsWith('text/markdown'));assert.match(await guide.text(),/## Where to start/);
    for (const [file, heading] of [['docs/NAVIGATION.md', '# Dashboard navigation'], ['docs/CHANGES_GUIDE.md', '# CodeFlow'], ['docs/CHANGE_INTELLIGENCE.md', '#']]) {
      const response = await fetch(base + '?file=' + encodeURIComponent(file));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-codevis-document'), file);
      assert.ok((await response.text()).startsWith(heading));
    }
    for (const file of ['../package.json', 'package.json', '__proto__']) {
      assert.equal((await fetch(base + '?file=' + encodeURIComponent(file))).status, 404);
    }
    assert.equal((await fetch(base + '?file=README.md&file=AGENTS.md')).status, 404);
    assert.equal((await fetch(base + '?file=README.md&guide=changes')).status, 400);
    for(const name of ['../package.json','constructor','__proto__','unknown'])assert.equal((await fetch(base+'?guide='+encodeURIComponent(name))).status,404);
    assert.equal((await fetch(base+'?guide=changes&guide=overview')).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
