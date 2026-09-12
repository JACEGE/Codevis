const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const hookRunner = require('./helpers/hook-runner.cjs');
const tick = async () => {for(let i=0;i<8;i++) await Promise.resolve();};
function setup(name) {
    const requests=[], errors=[];
    const props={db:'project_db', tasks:[{taskId:'A',status:'backlog'}], onError:e=>errors.push(e),
        reloadEpics:async()=>{},requestTasks:()=>{}};
    props.setTasks=fn=>{props.tasks=fn(props.tasks);};
    const run=hookRunner(path.resolve(__dirname, `../frontend/src/hooks/${name}.js`), {
        '../bridgeUrl':'', '../api/http':{requestJson:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}))},
    }, {localStorage:{getItem:()=>null,setItem(){}}});
    const render=()=>run(props);render();
    return {props,requests,errors,render,unmount:run.unmount};
}

for (const name of ['useBulkTaskMove', 'useKanbanDragDrop']) {
    for (const order of [[0, 1], [1, 0]]) {
        test(`${name} restores original status after overlapping failures (${order})`, async () => {
            const h = setup(name);
            const event = { preventDefault() {}, dataTransfer: { setData() {} } };
            const move = status => {
                if (name === 'useBulkTaskMove') {
                    h.render().setBulkTargetStatus(status);
                    return h.render().moveSelectedTasks();
                }
                h.render().handleDragStart(event, h.props.tasks[0]);
                return h.render().handleDrop(event, status);
            };
            if (name === 'useBulkTaskMove') h.render().toggleColumnSelection(['A']);
            const pending = [move('todo'), move('done')];
            for (const index of order) {
                h.requests[index].reject(new Error('offline'));
                await pending[index];
            }
            assert.equal(h.props.tasks[0].status, 'backlog');
        });
    }
}

test('failed epic status moves roll back even when refresh is unavailable', async () => {
    const h = setup('useKanbanDragDrop');
    h.props.tasks = [{ taskId: 'A', status: 'backlog', epicId: 'E' }, { taskId: 'B', status: 'todo', epicId: 'E' }];
    const moving = h.render().moveEpicToStatus('E', 'done');
    h.requests[0].resolve({}); h.requests[1].reject(new Error('offline'));
    await moving;
    assert.equal(h.props.tasks[0].status, 'done');
    assert.equal(h.props.tasks[1].status, 'todo');
});

test('failed epic assignment restores membership and does not change status', async () => {
    const h = setup('useKanbanDragDrop');
    const moving = h.render().dropTaskOnEpic('E', 'A', 'done');
    h.requests[0].reject(new Error('offline')); await moving;
    assert.equal(h.props.tasks[0].epicId, undefined);
    assert.equal(h.props.tasks[0].status, 'backlog');
    assert.equal(h.requests.length, 1);
});

test('failed epic removal restores membership before any status move', async () => {
    const h = setup('useKanbanDragDrop');
    h.props.tasks = [{ taskId: 'A', status: 'backlog', epicId: 'E', epicTitle: 'Epic', seqIndex: 2 }];
    const event = { preventDefault() {}, dataTransfer: { setData() {} } };
    h.render().handleDragStart(event, h.props.tasks[0]);
    const moving = h.render().handleDrop(event, 'backlog');
    h.requests[0].reject(new Error('offline')); await moving;
    assert.equal(h.props.tasks[0].epicId, 'E');
    assert.equal(h.props.tasks[0].seqIndex, 2);
});

for (const order of [[0, 1], [1, 0]]) for (let mask = 0; mask < 4; mask++) {
    test(`bulk and drag moves share rollback history (${order}, success mask ${mask})`, async () => {
        const bulk = setup('useBulkTaskMove');
        const drag = setup('useKanbanDragDrop');
        bulk.props.optimisticUpdates = drag.props.optimisticUpdates = new WeakMap();
        drag.props.setTasks = bulk.props.setTasks;
        Object.defineProperty(drag.props, 'tasks', { get: () => bulk.props.tasks });
        bulk.render().toggleColumnSelection(['A']); bulk.render().setBulkTargetStatus('todo');
        const first = bulk.render().moveSelectedTasks();
        const event = { preventDefault() {}, dataTransfer: { setData() {} } };
        drag.render().handleDragStart(event, drag.props.tasks[0]);
        const second = drag.render().handleDrop(event, 'done');
        const requests = [bulk.requests[0], drag.requests[0]];
        const pending = [first, second];
        for (const index of order) {
            if (mask & (1 << index)) requests[index].resolve({});
            else requests[index].reject(new Error('offline'));
            await pending[index];
        }
        assert.equal(bulk.props.tasks[0].status, mask & 2 ? 'done' : mask & 1 ? 'todo' : 'backlog');
    });
}

test('older bulk results cannot replace the outcome of a newer move', async () => {
    const h = setup('useBulkTaskMove');
    h.render().toggleColumnSelection(['A']); h.render().setBulkTargetStatus('todo');
    const first = h.render().moveSelectedTasks();
    h.render().setBulkTargetStatus('done'); const second = h.render().moveSelectedTasks();
    h.requests[1].reject(new Error('offline')); await second;
    const result = h.render().moveResult;
    h.requests[0].resolve({}); await first;
    assert.equal(h.render().moveResult, result);
    assert.deepEqual([...h.render().selectedTasks], ['A']);
});

test('epic assignment success survives a failed follow-up status update', async () => {
    const h = setup('useKanbanDragDrop');
    const moving = h.render().dropTaskOnEpic('E', 'A', 'done');
    h.requests[0].resolve({}); await tick();
    h.requests[1].reject(new Error('offline')); await moving;
    assert.equal(h.props.tasks[0].epicId, 'E');
    assert.equal(h.props.tasks[0].status, 'backlog');
});

test('switching workspaces during epic assignment prevents a follow-up write', async () => {
    const h = setup('useKanbanDragDrop');
    const moving = h.render().dropTaskOnEpic('E', 'A', 'done');
    h.props.db = 'codevis_db'; h.render();
    h.props.tasks = [{ taskId: 'A', status: 'review' }];
    h.requests[0].resolve({}); await moving;
    assert.equal(h.requests.length, 1);
    assert.equal(h.props.tasks[0].status, 'review');
});

test('a live task replacement remains authoritative after failed moves', async () => {
    const h = setup('useBulkTaskMove');
    h.render().toggleColumnSelection(['A']); h.render().setBulkTargetStatus('done');
    const moving = h.render().moveSelectedTasks();
    h.props.tasks = [{ taskId: 'A', status: 'review', title: 'Remote update' }];
    h.requests[0].reject(new Error('offline')); await moving;
    assert.equal(h.props.tasks[0].status, 'review');
    assert.equal(h.props.tasks[0].title, 'Remote update');
});

test('late idea creation cannot erase text typed while saving', async()=>{
    const h=setup('useIdeas');h.render().setNewIdeaText('Submitted');
    const saving=h.render().createIdea();h.render().setNewIdeaText('Next idea');h.render();
    h.requests.shift().resolve({});await saving;
    assert.equal(h.render().newIdeaText,'Next idea');
});
test('late idea edit cannot close a newer editor',async()=>{
    const h=setup('useIdeas');h.render().startIdeaEdit({ideaId:'A',content:'A'});
    const saving=h.render().saveIdeaEdit('A');h.render().startIdeaEdit({ideaId:'B',content:'B draft'});h.render();
    h.requests.shift().resolve({});await saving;
    assert.equal(h.render().editingIdeaId,'B');assert.equal(h.render().editingIdeaText,'B draft');
});
test('idea rollback cannot replace a newer workspace item or emit an old error',async()=>{
    const h=setup('useIdeas');h.render().setIdeas([{ideaId:'A',content:'Old'}]);
    const saving=h.render().patchIdea('A',{content:'Optimistic'});
    h.props.db='codevis_db';h.render();h.render().setIdeas([{ideaId:'A',content:'Other workspace'}]);h.render();
    h.requests.shift().reject(new Error('old failure'));await saving;
    assert.equal(h.render().ideas[0].content,'Other workspace');assert.deepEqual(h.errors,[]);
});
test('failed optimistic idea update cannot roll back a newer live update',async()=>{
    const h=setup('useIdeas');h.render().setIdeas([{ideaId:'A',content:'Old'}]);
    const saving=h.render().patchIdea('A',{priority:'high'});
    h.render().setIdeas([{ideaId:'A',content:'New realtime content',priority:'low'}]);h.render();
    h.requests.shift().reject(new Error('failure'));await saving;
    assert.equal(h.render().ideas[0].content,'New realtime content');
});
test('epic lists from previous workspace cannot overwrite current list',async()=>{
    const h=setup('useEpics');h.props.db='codevis_db';h.render();
    h.requests[1].resolve([{epicId:'new'}]);await tick();
    h.requests[0].resolve([{epicId:'old'}]);await tick();
    assert.equal(h.render().epics[0].epicId,'new');
});
test('closing an epic while loading does not reopen it on late response',async()=>{
    const h=setup('useEpics');const opening=h.render().openEpicDetail('A');
    h.render().setEpicDetail(null);h.render();h.requests[1].resolve({epicId:'A'});await opening;
    assert.equal(h.render().epicDetail,null);
});
test('workspace switch closes an epic editor before it could save into the new workspace',()=>{
    const h=setup('useEpics');h.render().setEpicDetail({epicId:'A',title:'Old'});h.render().startEpicEdit();h.render();
    h.props.db='codevis_db';h.render();
    assert.equal(h.render().epicDetail,null);assert.equal(h.render().epicForm,null);
});
test('late bulk failure cannot roll back same-id task in a different workspace',async()=>{
    const h=setup('useBulkTaskMove');h.render().toggleColumnSelection(['A']);h.render().setBulkTargetStatus('done');
    const moving=h.render().moveSelectedTasks();h.props.db='codevis_db';h.render();h.props.tasks=[{taskId:'A',status:'review'}];
    h.requests.shift().reject(new Error('old failure'));await moving;
    assert.equal(h.props.tasks[0].status,'review');assert.equal(h.render().moveResult,null);
});
test('late drag failure cannot roll back another workspace or clear its drag',async()=>{
    const h=setup('useKanbanDragDrop');
    const event={preventDefault(){},dataTransfer:{setData(){}}};
    h.render().handleDragStart(event,h.props.tasks[0]);const moving=h.render().handleDrop(event,'done');
    h.props.db='codevis_db';h.render();h.props.tasks=[{taskId:'A',status:'review'}];
    h.render().handleDragStart(event,h.props.tasks[0]);h.render();
    h.requests.shift().reject(new Error('old failure'));await moving;
    assert.equal(h.props.tasks[0].status,'review');assert.equal(h.render().draggedTask.status,'review');assert.deepEqual(h.errors,[]);
});

test('current idea creation and edit still clear their submitted drafts',async()=>{
    const h=setup('useIdeas');h.render().setNewIdeaText('Submitted');
    const creating=h.render().createIdea();h.requests.shift().resolve({});await creating;
    assert.equal(h.render().newIdeaText,'');
    h.render().startIdeaEdit({ideaId:'A',content:'Edit'});
    const saving=h.render().saveIdeaEdit('A');h.requests.shift().resolve({});await saving;
    assert.equal(h.render().editingIdeaId,null);
});
test('current optimistic failures still restore the original idea and task status',async()=>{
    const h=setup('useIdeas');h.render().setIdeas([{ideaId:'A',content:'Original'}]);
    const editing=h.render().patchIdea('A',{content:'Optimistic'});h.requests.shift().reject(new Error('failure'));await editing;
    assert.equal(h.render().ideas[0].content,'Original');
    const b=setup('useBulkTaskMove');b.render().toggleColumnSelection(['A']);b.render().setBulkTargetStatus('done');
    const moving=b.render().moveSelectedTasks();b.requests.shift().reject(new Error('failure'));await moving;
    assert.equal(b.props.tasks[0].status,'backlog');assert.equal(b.render().moveResult.moved,0);
});

for (const order of [[0, 1], [1, 0]]) {
    test(`overlapping failed idea patches restore the actual original (${order})`, async () => {
        const h = setup('useIdeas');
        h.render().setIdeas([{ ideaId: 'A', content: 'Original', priority: 'low' }]);
        const first = h.render().patchIdea('A', { priority: 'high' });
        const second = h.render().patchIdea('A', { content: 'Changed' });
        const pending = [first, second];
        for (const index of order) {
            h.requests[index].reject(new Error('failed'));
            await pending[index];
        }
        assert.deepEqual(h.render().ideas, [{ ideaId: 'A', content: 'Original', priority: 'low' }]);
    });
}

test('a failed earlier idea patch does not undo a later successful field change', async () => {
    const h = setup('useIdeas');
    h.render().setIdeas([{ ideaId: 'A', content: 'Original', priority: 'low' }]);
    const first = h.render().patchIdea('A', { priority: 'high' });
    const second = h.render().patchIdea('A', { content: 'Saved' });
    h.requests[1].resolve({}); await second;
    h.requests[0].reject(new Error('failed')); await first;
    assert.equal(h.render().ideas[0].content, 'Saved');
    assert.equal(h.render().ideas[0].priority, 'low');
});
test('a completed bulk move preserves a selection made during the request',async()=>{
    const h=setup('useBulkTaskMove');h.render().toggleColumnSelection(['A']);h.render().setBulkTargetStatus('done');
    const moving=h.render().moveSelectedTasks();h.render().clearSelection();h.render().toggleColumnSelection(['B']);h.render();
    h.requests.shift().resolve({});await moving;
    assert.deepEqual([...h.render().selectedTasks],['B']);
});
test('an old epic save cannot replace another epic or close its editor',async()=>{
    const h=setup('useEpics');h.requests.shift().resolve([]);await tick();
    h.render().setEpicDetail({epicId:'A',title:'A'});h.render().startEpicEdit();
    const saving=h.render().saveEpicEdit();const save=h.requests.shift();
    h.render().setEpicDetail({epicId:'B',title:'B'});h.render().startEpicEdit();h.render();
    save.resolve({});await tick();h.requests.shift().resolve([]);await saving;
    assert.equal(h.render().epicDetail.epicId,'B');assert.equal(h.render().epicForm.title,'B');assert.equal(h.render().epicEditing,true);
});
test('current epic save succeeds but preserves typing after submission',async()=>{
    const h=setup('useEpics');h.requests.shift().resolve([]);await tick();
    h.render().setEpicDetail({epicId:'A',title:'Original'});h.render().startEpicEdit();
    const saving=h.render().saveEpicEdit();const save=h.requests.shift();
    h.render().setEpicForm(form=>({...form,title:'Typed later'}));h.render();
    save.resolve({});await tick();h.requests.shift().resolve([{epicId:'A'}]);await saving;
    assert.equal(h.render().epicForm.title,'Typed later');assert.equal(h.render().epicEditing,true);assert.equal(h.render().epicSaving,false);
});
test('idea callbacks after unmount cannot publish stale errors',async()=>{
    const h=setup('useIdeas');const deleting=h.render().deleteIdea('A');h.unmount();
    h.requests.shift().reject(new Error('failure'));await deleting;assert.deepEqual(h.errors,[]);
});
