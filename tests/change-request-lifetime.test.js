const test=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const hookRunner=require('./helpers/hook-runner.cjs');
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function setup(){
 const requests=[];
 const run=hookRunner(path.resolve(__dirname,'../frontend/src/hooks/useChanges.js'),{'../bridgeUrl':'','../api/http':{requestJson:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}))}},{setInterval:()=>1,clearInterval:()=>{}});
 let db='project_db';const render=()=>run(db);render();
 return{requests,render,switchDb:()=>{db=db==='project_db'?'codevis_db':'project_db';render();},unmount:run.unmount};
}
test('Change lists ignore previous workspace and A-B-A responses',async()=>{
 const h=setup();h.switchDb();h.switchDb();h.requests[2].resolve({changes:[{slug:'current'}]});await tick();h.requests[0].resolve({changes:[{slug:'old'}]});h.requests[1].resolve({changes:[{slug:'foreign'}]});await tick();assert.equal(h.render().changes[0].slug,'current');h.unmount();
});
test('selecting another Change invalidates a pending mutation and clears busy state',async()=>{
 const h=setup();h.requests.shift().resolve({changes:[]});await tick();h.render().setSlug('one');h.render();
 h.requests.shift().resolve({state:{slug:'one',revision:1}});await tick();
 const saving=h.render().act('complete');h.render().setSlug('two');h.render();assert.equal(h.render().busy,false);
 const mutation=h.requests.shift(),read=h.requests.shift();read.resolve({state:{slug:'two',revision:2}});await tick();mutation.resolve({status:'GATE_BLOCKED',state:{slug:'one',revision:2}});await saving;
 assert.equal(h.render().detail.state.slug,'two');assert.equal(h.render().error,'');h.unmount();
});
test('a pending mutation blocks background detail refresh but resolves with its own gate result',async()=>{
 const h=setup();h.requests.shift().resolve({changes:[]});await tick();h.render().setSlug('one');h.render();h.requests.shift().resolve({state:{slug:'one',revision:1}});await tick();
 const saving=h.render().act('complete');const count=h.requests.length;await h.render().refresh();assert.equal(h.requests.length,count);
 h.requests.shift().resolve({status:'GATE_BLOCKED',state:{slug:'one',revision:2}});await tick();h.requests.shift().resolve({changes:[]});await saving;
 assert.equal(h.render().busy,false);assert.match(h.render().error,/Phase remains open/);h.unmount();
});

async function selectedFlow(){
 const h=setup();h.requests.shift().resolve({changes:[]});await tick();h.render().setSlug('one');h.render();
 h.requests.shift().resolve({state:{slug:'one',revision:1}});await tick();return h;
}
test('Refresh replaces opened quality evidence even when the Flow revision is unchanged',async()=>{
 const h=await selectedFlow();const opening=h.render().getQuality();
 h.requests.shift().resolve({testResults:{counts:{pass:3,stale:0}}});await opening;
 assert.equal(h.render().quality.testResults.counts.pass,3);
 const refreshing=h.render().refresh();assert.equal(h.render().quality,null);
 assert.equal(h.requests.length,2);assert.match(h.requests[1].url,/view=quality/);
 h.requests.shift().resolve({state:{slug:'one',revision:1}});
 h.requests.shift().resolve({testResults:{counts:{pass:0,stale:3}}});await refreshing;
 assert.equal(h.render().quality.testResults.counts.stale,3);h.unmount();
});
test('late quality responses cannot overwrite a newer request or a refreshed source snapshot',async()=>{
 const h=await selectedFlow();const old=h.render().getQuality(),current=h.render().getQuality();
 h.requests[1].resolve({passed:false});await current;h.requests[0].resolve({passed:true});await old;
 assert.equal(h.render().quality.passed,false);h.requests.splice(0);
 const pending=h.render().getQuality();const stale=h.requests.shift();const refreshing=h.render().refresh();
 h.requests.shift().resolve({state:{slug:'one',revision:1}});h.requests.shift().resolve({passed:false});await refreshing;
 stale.resolve({passed:true});await pending;assert.equal(h.render().quality.passed,false);h.unmount();
});
test('a failed quality reload keeps current Flow detail and clears the old passing report',async()=>{
 const h=await selectedFlow();const opening=h.render().getQuality();h.requests.shift().resolve({passed:true});await opening;
 const refreshing=h.render().refresh();h.requests.shift().resolve({state:{slug:'one',revision:2}});
 h.requests.shift().reject(new Error('Quality evidence unavailable'));await refreshing;
 assert.equal(h.render().detail.state.revision,2);assert.equal(h.render().quality,null);
 assert.equal(h.render().error,'Quality evidence unavailable');h.unmount();
});
