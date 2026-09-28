export const EXECUTION_LABELS = {pass:'PASS',fail:'FAIL',skipped:'Skipped',todo:'TODO',unknown:'Not recorded / unresolved',stale:'Stale — rerun checks'};
export default function TestExecutionDetails({execution,onOpenArtifact}) {
  const status=execution?.status||'unknown';
  return <section className="test-execution" aria-label="Test execution evidence" data-result={status}>
    <h3>Execution: {EXECUTION_LABELS[status]||status}</h3>
    {execution?.reason&&<p>{execution.reason}</p>}
    {execution?.at&&<p>Last run: <time dateTime={new Date(execution.at).toISOString()}>{new Date(execution.at).toLocaleString()}</time></p>}
    {status==='stale'&&execution?.recordedStatus&&<p>Previous observation: {EXECUTION_LABELS[execution.recordedStatus]}</p>}
    {execution?.observations?.map((test,i)=><details key={i}><summary>{EXECUTION_LABELS[test.status]} · {test.name}</summary><p>{test.check} · {test.file}{test.line?':'+test.line:''}{test.durationMs!=null?' · '+test.durationMs.toFixed(1)+' ms':''}</p>{test.message&&<pre>{test.message}</pre>}</details>)}
    {execution?.artifact&&onOpenArtifact&&<button className="ui-button" onClick={()=>onOpenArtifact(execution.artifact.path)}>Open execution evidence</button>}
    <small>Recorded execution validates the linked intent only as well as its assertions. It is not a coverage measurement.</small>
  </section>;
}
