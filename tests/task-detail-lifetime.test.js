const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const hookRunner=require('./helpers/hook-runner.cjs');

function setup() {
    const requests=[], errors=[];
    const run=hookRunner(path.join(__dirname,'../frontend/src/hooks/useTaskDetails.js'),{
        '../bridgeUrl':'http://test.invalid',
        '../api/http':{requestJson:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}))},
    });
    const state={db:'project_db',tasks:[{taskId:'A',title:'A'},{taskId:'B',title:'B'}]};
    const setTasks=fn=>{state.tasks=fn(state.tasks);};
    const onError=error=>errors.push(error);
    const render=()=>run({db:state.db,setTasks,onError});
    render();
    return {state,render,requests,errors};
}

for(const outcome of ['success','error']) test(`late save ${outcome} cannot replace another task or clear its draft`,async()=>{
    const {render,requests,state}=setup();
    let hook=render(); hook.setTaskDetail({taskId:'A',title:'Task A'});
    hook=render(); hook.startTaskEdit(); hook=render();
    const saving=hook.saveTaskEdit(); const pending=requests.shift();
    hook.closeDetail(); hook=render();
    const opening=hook.openTaskDetail({taskId:'B'});
    requests.shift().resolve({taskId:'B',title:'Task B'}); await opening;
    hook=render(); hook.startTaskEdit(); hook=render();
    hook.setTaskForm(form=>({...form,title:'Unsaved B'}));
    if(outcome==='success') pending.resolve({taskId:'A',title:'Saved A'});
    else pending.reject(new Error('Old save failed'));
    await saving; hook=render();
    assert.equal(hook.selectedTask,'B'); assert.equal(hook.taskDetail.taskId,'B');
    assert.equal(hook.taskForm.title,'Unsaved B'); assert.equal(hook.editingTask,true);
    assert.equal(hook.taskSaveError,null); assert.equal(hook.taskSaving,false);
    assert.equal(state.tasks[0].title,outcome==='success'?'Saved A':'A');
});

test('save response from a previous workspace cannot update same-id task in new workspace',async()=>{
    const {render,requests,state}=setup();
    let hook=render(); hook.setTaskDetail({taskId:'A',title:'Old workspace'});
    hook=render(); hook.startTaskEdit(); hook=render();
    const saving=hook.saveTaskEdit();
    state.db='codevis_db'; render(); state.tasks=[{taskId:'A',title:'New workspace'}];
    requests.shift().resolve({taskId:'A',title:'Saved in old workspace'}); await saving;
    hook=render(); assert.equal(state.tasks[0].title,'New workspace'); assert.equal(hook.taskDetail,null);
});

test('current save still updates details and exits edit mode',async()=>{
    const {render,requests}=setup();
    let hook=render(); hook.setTaskDetail({taskId:'A',title:'Task A'});
    hook=render(); hook.startTaskEdit(); hook=render();
    const saving=hook.saveTaskEdit(); requests.shift().resolve({taskId:'A',title:'Saved A'}); await saving;
    hook=render(); assert.equal(hook.taskDetail.title,'Saved A'); assert.equal(hook.editingTask,false); assert.equal(hook.taskSaving,false);
});

for (const change of ['other comment', 'continued typing', 'cancel and reopen']) {
    test(`late comment save preserves draft after ${change}`, async () => {
        const {render,requests}=setup();
        let hook=render(); hook.setTaskDetail({taskId:'A'}); hook.setEditingId('first'); hook.setEditingText('Submitted');
        hook=render(); const saving=hook.saveComment('first');
        if(change==='other comment') hook.setEditingId('second');
        if(change==='cancel and reopen') {hook.setEditingId(null);render();hook.setEditingId('first');}
        hook.setEditingText('New unsaved text'); render();
        requests.shift().resolve({ok:true}); await saving; hook=render();
        assert.equal(hook.editingId,change==='other comment'?'second':'first');
        assert.equal(hook.editingText,'New unsaved text');
    });
}

test('current comment save still closes its unchanged editor', async () => {
    const {render,requests}=setup();
    let hook=render(); hook.setTaskDetail({taskId:'A'});hook.setEditingId('first');hook.setEditingText('Submitted');
    hook=render();const saving=hook.saveComment('first');requests.shift().resolve({ok:true});await saving;
    hook=render();assert.equal(hook.editingId,null);assert.equal(hook.editingText,'');
});

test('typing into a task during save preserves the newer form',async()=>{
    const {render,requests}=setup();let hook=render();hook.setTaskDetail({taskId:'A',title:'Original'});
    hook=render();hook.startTaskEdit();hook=render();const saving=hook.saveTaskEdit();
    hook.setTaskForm(form=>({...form,title:'Typed later'}));render();
    requests.shift().resolve({taskId:'A',title:'Original'});await saving;hook=render();
    assert.equal(hook.taskForm.title,'Typed later');assert.equal(hook.editingTask,true);assert.equal(hook.taskSaving,false);
});

for (const outcome of ['success', 'error']) for (const next of ['B', 'A']) {
    test(`old delete ${outcome} preserves reopened confirmation for ${next}`, async () => {
        const { render, requests, state } = setup();
        render().setPendingDelete({ taskId: 'A' });
        const deleting = render().deleteTask();
        render().setPendingDelete(null); render().setPendingDelete({ taskId: next });
        if (outcome === 'success') requests[0].resolve({});
        else requests[0].reject(new Error('Old delete failed'));
        await deleting;
        assert.equal(render().pendingDelete.taskId, next); assert.equal(render().deleteError, null);
        assert.equal(state.tasks.length, outcome === 'success' ? 1 : 2);
    });
}
