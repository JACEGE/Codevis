import type { ToolModule } from '../lib/graph.js';
import { mcpOk, mcpErr, pickDbDriver } from '../lib/graph.js';
const shared = { db: { type: 'string' }, slug: { type: 'string' } };
export const changeTools: ToolModule = {
  definitions: [
    { name: 'change_read', description: 'Read persistent Changes, current phase instructions/context, task context, artifacts or reverse source traceability. Call get_workspace_identity first. trace follows obligations and proof around an exact nodeId; idea_context previews explicit Idea links. Only current-phase instructions are returned.',
      inputSchema: { type:'object', properties:{ ...shared,
        operation:{type:'string',enum:['list','read','related','idea_context','trace','test_result'],default:'read'}, view:{type:'string',enum:['graph','context','artifact','quality','tests']},
        ideaId:{type:'string'}, taskId:{type:'string'}, nodeId:{type:'string'}, path:{type:'string'}, includeImpact:{type:'boolean'} } } },
    { name: 'change_write', description: 'Lead workflow control. create starts Requirements; promote_idea preserves the Idea and its explicit context without creating Tasks; submit saves Markdown and typed graph evidence; complete executes the current gate and returns the next instructions only on success. resume repairs projection; reopen invalidates downstream approval. Read before mutations and supply expectedRevision.',
      inputSchema: { type:'object', required:['operation'], properties:{ ...shared,
        operation:{type:'string',enum:['create','promote_idea','submit','complete','resume','reopen']}, expectedRevision:{type:'integer'},
        ideaId:{type:'string'},kind:{type:'string',enum:['feature','bug','refactor','research','architecture','tech-debt']},template:{type:'string'},title:{type:'string'},description:{type:'string'},agent:{type:'string'},phase:{type:'string'},reason:{type:'string'},
        markdown:{type:'string'},data:{type:'object'},judgment:{type:'object'},
        entities:{type:'array',items:{type:'object',required:['id','label','title','content'],properties:{id:{type:'string'},label:{type:'string',enum:['Requirement','AcceptanceCriterion','TestCase','ArchitectureDecision']},title:{type:'string'},content:{type:'string'},reason:{type:'string'}}}},
        testBindings:{type:'array',description:'Development only. Replaces all execution selectors. Needs existing IMPLEMENTED_BY links and a check with testReport: codevis-json.',items:{type:'object',required:['testCaseId','check','file','name','implementation'],properties:{testCaseId:{type:'string'},check:{type:'string'},file:{type:'string'},name:{type:'string'},line:{type:'integer'},implementation:{type:'object',required:['nodeId'],properties:{nodeId:{type:'string'}}}}}},
        links:{type:'array',items:{type:'object',required:['from','to','type'],properties:{from:{oneOf:[{type:'string'},{type:'object',properties:{nodeId:{type:'string'}},required:['nodeId']}]},to:{oneOf:[{type:'string'},{type:'object',properties:{nodeId:{type:'string'}},required:['nodeId']}]},type:{type:'string',enum:['HAS_REQUIREMENT','HAS_CRITERION','VALIDATED_BY','VALIDATES','IMPLEMENTED_BY','IMPLEMENTS','IMPACTS','REFERENCES'],description:'Which types each phase accepts, with endpoint labels: allowedLinks in the phase instructions (change_read view context).'}}},description:'from/to: a local workflow ID, or {nodeId} = elementId or a Task taskId / Epic epicId.'}
      } } },
  ],
  handlers: {
    change_read: async(args,ctx) => {
      const operation=args.operation||'read';
      if (!['list','read','related','idea_context','trace','test_result'].includes(operation)) return mcpErr('Unsupported read operation');
      const session=pickDbDriver(ctx,args).session();
      try { return mcpOk(await session.changeOperation({...args,operation,view:args.view||'context'})); }
      catch(e:any) { return mcpErr(e.message); } finally { await session.close(); }
    },
    change_write: async(args,ctx) => {
      if (!['create','promote_idea','submit','complete','resume','reopen'].includes(args.operation)) return mcpErr('Unsupported workflow operation');
      const session=pickDbDriver(ctx,args).session();
      try {
        const result=await session.changeOperation({...args,agent:args.agent||ctx.defaultAgentId||'Lead'});
        if (!result.state) return mcpOk(result);
        const {state,instructions,status}=result;
        const gate=state.phases.map((p:any)=>p.gate).filter(Boolean).sort((a:any,b:any)=>b.checkedAt-a.checkedAt)[0]||null;
        return mcpOk({status,state:{slug:state.slug,changeId:state.changeId,revision:state.revision,currentPhase:state.currentPhase,status:state.status},
          instructions,gate,artifacts:state.artifacts.map((a:any)=>({path:a.path,phase:a.phase,revision:a.revision})),
          unresolved:result.graph?.unresolved||[],next:'Use change_read(view: context) for current-phase or task-specific context; view: graph explicitly requests the full Change.'});
      }
      catch(e:any) { return mcpErr(e.message); } finally { await session.close(); }
    },
  },
};

// Preserve the original MCP names while publishing the product terminology.
changeTools.definitions.push(...changeTools.definitions.map(tool=>({...tool,name:tool.name.replace('change_','flow_'),description:tool.description.replace(/Changes/g,'Flows').replace(/Change/g,'Flow')})));
changeTools.handlers.flow_read = changeTools.handlers.change_read;
changeTools.handlers.flow_write = changeTools.handlers.change_write;
