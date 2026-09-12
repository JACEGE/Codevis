import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import useSessionDraft from '../hooks/useSessionDraft';
import ForceGraph2D from 'react-force-graph-2d';

import BRIDGE_URL from '../bridgeUrl';
import useRequestLifetime from '../hooks/useRequestLifetime';

// Colour by spec node label + binding status.
const SPEC_COLORS = {
  SpecSequence: '#6366f1', SpecClassDiagram: '#6366f1',
  SpecParticipant: '#0ea5e9', SpecClass: '#0ea5e9',
  SpecMessage: '#a855f7', SpecMethod: '#a855f7', SpecRelation: '#f59e0b',
  default: '#94a3b8',
};
function pickColor(node) {
  if (node.status === 'unbound' || node.status === 'ambiguous') return '#ef4444';
  for (const l of node.labels || []) if (SPEC_COLORS[l]) return SPEC_COLORS[l];
  return SPEC_COLORS.default;
}

function SpecSubgraph({ nodes, edges }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 400, h: 300 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const graphData = useMemo(() => ({
    nodes: nodes.map((n) => ({ ...n })),
    links: (edges || []).map((e) => ({ source: e.source, target: e.target, relType: e.relType })),
  }), [nodes, edges]);
  const paintNode = useCallback((node, ctx, scale) => {
    const color = pickColor(node);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, 5, 0, 2 * Math.PI);
    ctx.fill();
    const label = String(node.name || node.id);
    const short = label.length > 24 ? label.slice(0, 23) + '…' : label;
    const fontSize = Math.max(3, 10 / scale);
    ctx.font = `500 ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(228,228,231,0.85)';
    ctx.fillText(short, node.x, node.y + 7 / scale);
  }, []);
  return (
    <div ref={wrapRef} style={{ flex: '1 1 auto', minHeight: 200, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border, #2a2f37)', background: '#0b0e1a' }}>
      <ForceGraph2D
        width={size.w} height={size.h} graphData={graphData}
        nodeCanvasObject={paintNode}
        linkColor={() => 'rgba(148,163,184,0.4)'} linkWidth={1.1}
        linkLabel={(l) => l.relType}
        linkDirectionalArrowLength={4} linkDirectionalArrowRelPos={1}
        cooldownTicks={100} d3VelocityDecay={0.35} backgroundColor="#0b0e1a"
      />
    </div>
  );
}

const STATUS = {
  idle: { label: 'Ready', color: '#94a3b8' },
  deleting: { label: 'Deleting...', color: '#0ea5e9' },
  sending: { label: 'Importing & overlaying…', color: '#0ea5e9' },
  waiting: { label: 'Claude is building…', color: '#a855f7' },
  done: { label: 'Done', color: '#22c55e' },
  error: { label: 'Error', color: '#ef4444' },
};
function StatusPill({ status }) {
  const cfg = STATUS[status] || STATUS.idle;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 999, background: 'rgba(255,255,255,0.04)', border: `1px solid ${cfg.color}55`, color: cfg.color, fontFamily: 'var(--font-mono, monospace)', fontSize: 12, fontWeight: 500 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: cfg.color, boxShadow: `0 0 6px ${cfg.color}` }} />
      {cfg.label}
    </div>
  );
}

// Flatten the kind-specific region shape into {conforms, missing, extra} string lists.
function flattenRegions(reconciled) {
  if (!reconciled || !reconciled.regions) return { conforms: [], missing: [], extra: [] };
  const r = reconciled.regions;
  if (reconciled.kind === 'usecase') {
    return {
      conforms: [
        ...(r.implemented || []).map((u) => `${u.name} ✓ implemented`),
        ...(r.relationConforms || []).map((x) => `${x.from} ${x.type} ${x.to}`),
      ],
      missing: [
        ...(r.unimplemented || []).map((u) => `${u.name} (not implemented)`),
        ...(r.relationMissing || []).map((x) => `${x.from} ${x.type} ${x.to}`),
      ],
      extra: [],
    };
  }
  if (reconciled.kind === 'activity') {
    return {
      conforms: (r.conforms || []).map((c) => `${c.action} → ${c.callee}()`),
      missing: (r.missing || []).map((m) => `${m.action}`),
      extra: (r.extra || []).map((e) => `${e.callee}() (uncovered)`),
    };
  }
  if (reconciled.kind === 'class') {
    return {
      conforms: [
        ...(r.methodConforms || []).map((m) => `${m.class}.${m.method}`),
        ...(r.inheritsConforms || []).map((i) => `${i.child} ▸ ${i.parent}`),
      ],
      missing: [
        ...(r.methodMissing || []).map((m) => `${m.class}.${m.method}`),
        ...(r.inheritsMissing || []).map((i) => `${i.child} ▸ ${i.parent}`),
      ],
      extra: (r.methodExtra || []).map((m) => `${m.class}.${m.method}`),
    };
  }
  return {
    conforms: (r.conforms || []).map((c) => `${c.message.from} → ${c.message.to}.${c.message.method}`),
    missing: (r.missing || []).map((c) => `${c.message.from} → ${c.message.to}.${c.message.method}  (${c.reason})`),
    extra: (r.extra || []).map((e) => `${e.fromAlias} → ${e.toAlias}.${e.calleeName}`),
  };
}

function RegionList({ title, items, color }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color, marginBottom: 4 }}>
        {title} <span style={{ opacity: 0.7 }}>· {items.length}</span>
      </div>
      {items.length === 0
        ? <div style={{ fontSize: 12, color: 'var(--muted, #94a3b8)', fontStyle: 'italic' }}>—</div>
        : items.map((t, i) => (
          <div key={i} style={{ fontSize: 12, fontFamily: 'monospace', padding: '2px 8px', borderRadius: 6, background: `${color}14`, border: `1px solid ${color}33`, marginBottom: 3, overflowWrap: 'anywhere' }}>{t}</div>
        ))}
    </div>
  );
}

const SAMPLE = `@startuml
title Checkout Flow
actor User
participant Checkout
participant PaymentService

User -> Checkout : submitOrder()
Checkout -> PaymentService : charge(amount)
PaymentService --> Checkout : Receipt
@enduml`;

/**
 * SpecTab — paste a PlantUML/.wsd diagram + optional architect instructions,
 * import it into the graph and overlay it against the code (conforms/missing/
 * extra). Optionally emit backlog Tasks for the missing region. Mirrors the
 * BrainTab layout.
 */
export default function SpecTab({ socket, db, pendingSpecId, onPendingConsumed }) {
  const lifetime = useRequestLifetime(db);
  const editorRequest = useRef(0);
  const libraryRequest = useRef(0);
  const workerId = useRef(null);
  const draftRevision = useRef(0);
  const [diagram, setDraftDiagram] = useSessionDraft(`codevis.draft.spec.${db}.diagram`, '');
  const setDiagram = useCallback(value => {
    draftRevision.current++;
    setDraftDiagram(value);
  }, [setDraftDiagram]);
  const [instructions, setInstructions] = useSessionDraft(`codevis.draft.spec.${db}.instructions`, '');
  const [kind, setKind] = useSessionDraft(`codevis.draft.spec.${db}.kind`, 'auto');
  const [emitTasks, setEmitTasks] = useSessionDraft(`codevis.draft.spec.${db}.emitTasks`, false);
  const [status, setStatus] = useState('idle');
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  // Diagram library: every previously imported diagram, reopenable without
  // re-running the importer/Claude (the raw PlantUML is stored on the node).
  const [specs, setSpecs] = useState([]);
  const [openingId, setOpeningId] = useState(null);
  // Welches gespeicherte Diagramm gerade im Editor liegt. Nur dann sind Sync
  // und Löschen überhaupt möglich — ein frisch eingefügter Text gehört noch
  // keinem Diagramm, und "Import & overlay" legt dafür ein neues an.
  const [openedSpec, setOpenedSpec] = useSessionDraft(`codevis.draft.spec.${db}.opened`, null);
  const [syncNote, setSyncNote] = useState(null);
  // Löschen ist zweistufig. Kein window.confirm: das lässt sich vom Code
  // auslösen und sieht in jedem Browser anders aus.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dbQuery = db ? `?db=${encodeURIComponent(db)}` : '';

  const loadLibrary = useCallback(async () => {
    const token = lifetime.current, request = ++libraryRequest.current;
    try {
      const res = await fetch(`${BRIDGE_URL}/api/spec/list${dbQuery}`);
      if (!res.ok) return;
      const data = await res.json();
      if (lifetime.current !== token || libraryRequest.current !== request) return;
      setSpecs(Array.isArray(data.specs) ? data.specs : []);
    } catch { /* library is best-effort */ }
  }, [dbQuery]);

  // Load the library on mount and whenever the active DB changes.
  useEffect(() => { loadLibrary(); }, [loadLibrary]);

  // Live updates if another client triggers an import; refresh the library too.
  useEffect(() => {
    if (!socket) return;
    const handler = (data) => {
      if (data.db !== db) return;
      loadLibrary();
      if (data.specId !== workerId.current) return;
      workerId.current = null;
      setResult(data); setStatus(data.ok ? 'done' : 'error');
      if (!data.ok) setErrorMsg(data.error || 'Diagram build failed');
    };
    socket.on('spec:result', handler);
    return () => socket.off('spec:result', handler);
  }, [socket, loadLibrary, db]);

  // Reopen a stored diagram: pull its raw text + overlay back into the view.
  const openSpec = useCallback(async (specId) => {
    const token = lifetime.current, request = ++editorRequest.current;
    const revision = draftRevision.current;
    workerId.current = null;
    setOpeningId(specId);
    setErrorMsg(null);
    try {
      const res = await fetch(`${BRIDGE_URL}/api/spec/get?specId=${encodeURIComponent(specId)}${db ? `&db=${encodeURIComponent(db)}` : ''}`);
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
      const data = await res.json();
      if (lifetime.current !== token || editorRequest.current !== request) return;
      if (draftRevision.current !== revision) {
        setSyncNote('Newer draft kept. Open the diagram again to replace it.');
        return;
      }
      setDiagram(data.source || '');
      setResult(data);
      setStatus('done');
      setOpenedSpec({ db, specId, title: data.title || specId, sourceFile: data.sourceFile || null });
      setConfirmDelete(false);
      setSyncNote(null);
    } catch (e) {
      if (lifetime.current !== token || editorRequest.current !== request) return;
      setErrorMsg(e.message || 'Could not load diagram');
    } finally {
      if (lifetime.current === token && editorRequest.current === request) setOpeningId(null);
    }
  }, [db]);

  // Den bearbeiteten Text zurückspielen: gleiche specId, also ersetzt der
  // Import seine eigenen Knoten statt ein zweites Diagramm anzulegen. Steht
  // eine Datei dahinter, schreibt die Bridge sie mit — sonst hätte der nächste
  // Import aus der Datei die Änderung stillschweigend zurückgedreht.
  const syncSpec = useCallback(async () => {
    if (!openedSpec || openedSpec.db !== db || !diagram.trim()) return;
    const token = lifetime.current, request = ++editorRequest.current;
    setStatus('sending');
    setErrorMsg(null);
    setSyncNote(null);
    try {
      const res = await fetch(`${BRIDGE_URL}/api/spec/${encodeURIComponent(openedSpec.specId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram, db }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (lifetime.current !== token || editorRequest.current !== request) return;
      setResult(data);
      setStatus('done');
      setSyncNote(data.warning || (data.fileWritten
        ? `Graph updated · ${data.sourceFile} saved to disk`
        : `Graph updated${data.sourceFile ? ` · File ${data.sourceFile} not found; only the graph was updated` : ''}`));
      loadLibrary();
    } catch (e) {
      if (lifetime.current !== token || editorRequest.current !== request) return;
      setErrorMsg(e.message || 'Sync failed');
      setStatus('error');
    }
  }, [openedSpec, diagram, db, loadLibrary]);

  // Löschen. Bewusst nur von hier aus: es gibt dafür kein MCP-Tool, und die
  // Bridge verlangt die specId als Bestätigung — ein Agent, der die Route
  // zufällig trifft, kommt damit nicht durch.
  const deleteSpec = useCallback(async () => {
    if (!openedSpec || openedSpec.db !== db) return;
    const token = lifetime.current, request = ++editorRequest.current;
    const revision = draftRevision.current;
    setStatus('deleting');
    setErrorMsg(null);
    try {
      const res = await fetch(`${BRIDGE_URL}/api/spec/${encodeURIComponent(openedSpec.specId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: openedSpec.specId, db }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (lifetime.current !== token || editorRequest.current !== request) return;
      setSyncNote(`"${openedSpec.title}" deleted — ${data.removed} nodes removed from the graph. The source file is kept.`);
      setOpenedSpec(null);
      setConfirmDelete(false);
      setResult(null);
      if (draftRevision.current === revision) setDiagram('');
      setStatus('idle');
      loadLibrary();
    } catch (e) {
      if (lifetime.current !== token || editorRequest.current !== request) return;
      setErrorMsg(e.message || 'Delete failed');
      setStatus('error');
    }
  }, [openedSpec, db, loadLibrary]);

  // Opened from the Diagrams tab: load that spec, then clear the request so the
  // same diagram can be re-opened later (App resets pendingSpecId to null).
  useEffect(() => {
    if (!pendingSpecId) return;
    openSpec(pendingSpecId);
    if (onPendingConsumed) onPendingConsumed();
  }, [pendingSpecId, openSpec, onPendingConsumed]);

  const submit = useCallback(async () => {
    if (!diagram.trim()) return;
    const token = lifetime.current, request = ++editorRequest.current;
    workerId.current = null;
    setStatus('sending');
    setErrorMsg(null);
    try {
      const res = await fetch(`${BRIDGE_URL}/api/spec/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          diagram, instructions,
          kind: kind === 'auto' ? undefined : kind,
          emitTasks, db,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (lifetime.current !== token || editorRequest.current !== request) return;
      setResult(data);
      setStatus('done');
      // Ein Import legt IMMER ein neues Diagramm an (eigene specId). Der
      // Editor gehört ab jetzt diesem neuen — sonst zeigte die Leiste weiter
      // auf das vorher geöffnete und ein Sync hätte das falsche überschrieben.
      setOpenedSpec({ db, specId: data.specId, title: (data.imported && data.imported.title) || data.specId, sourceFile: null });
      setSyncNote(null);
      setConfirmDelete(false);
      loadLibrary();
    } catch (e) {
      if (lifetime.current !== token || editorRequest.current !== request) return;
      setErrorMsg(e.message || 'Unknown error');
      setStatus('error');
    }
  }, [diagram, instructions, kind, emitTasks, db, loadLibrary]);

  // Hybrid: hand the diagram + instructions to a Claude worker that binds with
  // judgment, interprets relations, and plans Tasks/Knowledge. Result arrives
  // via the 'spec:result' socket event.
  const buildWithClaude = useCallback(async () => {
    if (!diagram.trim()) return;
    const token = lifetime.current, request = ++editorRequest.current;
    const specId = `spec-ui-${crypto.randomUUID()}`;
    workerId.current = specId;
    setStatus('waiting');
    setErrorMsg(null);
    try {
      const res = await fetch(`${BRIDGE_URL}/api/spec/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram, instructions, db, specId }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      // 202 accepted — wait for the socket event.
    } catch (e) {
      if (lifetime.current !== token || editorRequest.current !== request) return;
      workerId.current = null;
      setErrorMsg(e.message || 'Unknown error');
      setStatus('error');
    }
  }, [diagram, instructions, db]);

  const reset = useCallback(() => {
    editorRequest.current++;
    workerId.current = null;
    setDiagram(''); setInstructions(''); setResult(null); setStatus('idle'); setErrorMsg(null);
    setOpenedSpec(null); setConfirmDelete(false); setSyncNote(null);
  }, []);

  const isBusy = status === 'sending' || status === 'waiting' || status === 'deleting';
  const regions = flattenRegions(result && result.reconciled);
  const unbound = (result && result.reconciled && result.reconciled.unbound) || [];
  const emitted = (result && result.reconciled && result.reconciled.emitted) || [];

  const panel = {
    display: 'flex', flexDirection: 'column', gap: 12, padding: 16,
    background: 'var(--surface, #14171c)', border: '1px solid var(--border, #2a2f37)',
    borderRadius: 12, minHeight: 0, minWidth: 0, overflow: 'auto',
  };
  const ta = {
    resize: 'vertical', padding: 12, fontSize: 13, lineHeight: 1.5,
    fontFamily: 'monospace', background: 'var(--bg, #0b0d10)', color: 'var(--text, #e4e4e7)',
    border: '1px solid var(--border, #2a2f37)', borderRadius: 8, boxSizing: 'border-box', width: '100%',
  };

  return (
    <div className="editor-workspace" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, padding: 16, height: '100%', boxSizing: 'border-box', background: 'var(--bg, #0b0d10)', color: 'var(--text, #e4e4e7)', overflow: 'hidden' }}>
      {/* ── Left: input ── */}
      <div style={panel}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>📐 Spec import</h2>
          <StatusPill status={status} />
        </div>

        <div style={{ fontSize: 12, color: 'var(--muted, #94a3b8)' }}>
          Paste a PlantUML / WebSequenceDiagrams (.wsd) diagram — sequence or class. It gets imported and overlaid against the code graph.
        </div>

        {specs.length > 0 && (
          <div style={{ border: '1px solid var(--border,#2a2f37)', borderRadius: 8, background: 'rgba(255,255,255,0.02)' }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted,#94a3b8)', padding: '8px 10px', display: 'flex', justifyContent: 'space-between' }}>
              <span>📚 Saved diagrams</span><span style={{ opacity: 0.6 }}>{specs.length}</span>
            </div>
            <div style={{ maxHeight: 160, overflow: 'auto' }}>
              {specs.map((s) => {
                const active = result && result.specId === s.specId;
                return (
                  <button key={s.specId} type="button" onClick={() => openSpec(s.specId)} disabled={isBusy || openingId === s.specId}
                    title="Reopen this diagram + its overlay (no Claude run)"
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', border: 'none', borderTop: '1px solid var(--border,#23272f)', background: active ? 'rgba(99,102,241,0.12)' : 'transparent', cursor: openingId === s.specId ? 'wait' : 'pointer', textAlign: 'left', color: 'var(--text,#e4e4e7)', fontFamily: 'inherit', fontSize: 12.5 }}>
                    <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, color: '#a5b4fc', background: 'rgba(99,102,241,0.15)', padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase' }}>{s.kind || s.label}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                    <span style={{ flexShrink: 0, fontSize: 10, opacity: 0.6 }}>{openingId === s.specId ? '…' : `${s.children} nodes`}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Leiste für das geöffnete Diagramm: bearbeiten heißt hier einfach im
            Textfeld tippen und dann synchronisieren. Löschen liegt daneben,
            zweistufig — und beides gibt es NUR hier, nicht als MCP-Tool. */}
        {openedSpec && (
          <div style={{ border: '1px solid rgba(14,165,233,0.35)', background: 'rgba(14,165,233,0.08)', borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>✏️ {openedSpec.title}</span>
              <span style={{ fontSize: 11, opacity: 0.65 }}>{openedSpec.specId}</span>
              {openedSpec.sourceFile && (
                <span style={{ fontSize: 11, opacity: 0.65, fontFamily: 'ui-monospace, monospace' }}>· {openedSpec.sourceFile}</span>
              )}
              <span style={{ flex: 1 }} />
              <button type="button" onClick={syncSpec} disabled={isBusy || !diagram.trim()}
                title="Update this diagram in the graph and its source file, if available"
                style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: isBusy || !diagram.trim() ? '#4b5563' : 'linear-gradient(135deg, #0ea5e9, #0369a1)', border: 'none', borderRadius: 6, padding: '5px 12px', cursor: isBusy || !diagram.trim() ? 'not-allowed' : 'pointer' }}>
                💾 Sync changes
              </button>
              {!confirmDelete && (
                <button type="button" onClick={() => setConfirmDelete(true)} disabled={isBusy}
                  title="Remove this diagram from the graph"
                  style={{ fontSize: 12, fontWeight: 600, color: '#fca5a5', background: 'transparent', border: '1px solid rgba(239,68,68,0.45)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer' }}>
                  🗑 Delete
                </button>
              )}
            </div>
            {confirmDelete && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderTop: '1px solid rgba(239,68,68,0.25)', paddingTop: 6 }}>
                <span style={{ fontSize: 12, color: '#fca5a5' }}>
                  Delete "{openedSpec.title}"? This removes the diagram and its nodes from the graph
                  {openedSpec.sourceFile ? ` — the file ${openedSpec.sourceFile} is kept.` : '.'}
                </span>
                <span style={{ flex: 1 }} />
                <button type="button" onClick={deleteSpec} disabled={isBusy}
                  style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: '#dc2626', border: 'none', borderRadius: 6, padding: '5px 12px', cursor: 'pointer' }}>
                  {status === 'deleting' ? 'Deleting...' : 'Yes, delete'}
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} disabled={isBusy}
                  style={{ fontSize: 12, color: 'var(--text,#e4e4e7)', background: 'transparent', border: '1px solid var(--border,#2a2f37)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}

        {syncNote && (
          <div style={{ fontSize: 12, color: '#86efac', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 6, padding: '6px 10px' }}>
            {syncNote}
          </div>
        )}

        <label style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted, #94a3b8)' }}>Diagram (WSD / PlantUML)</label>
        {/* The placeholder used to be the full 12-line SAMPLE diagram. In a
            monospace textarea a complete diagram reads as typed content even in
            placeholder grey — you could not tell the field was empty, and the
            "insert sample" button below looked like it would duplicate what was
            already there. SAMPLE itself stays; that button still inserts it. */}
        <textarea aria-label="Diagram draft" value={diagram} onChange={(e) => setDiagram(e.target.value)} className="spec-input"
          placeholder="Paste a PlantUML or .wsd diagram here — or use 'Insert sample' below."
          rows={12} style={{ ...ta, flex: '1 1 auto', minHeight: 220 }} />
        <button type="button" onClick={() => setDiagram(SAMPLE)} style={{ alignSelf: 'flex-start', fontSize: 12, fontWeight: 600, color: '#a5b4fc', background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.35)', borderRadius: 6, cursor: 'pointer', padding: '4px 10px' }}>Insert sample</button>

        <details className="editor-options"><summary>Specific instructions (optional)</summary>
        <label style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted, #94a3b8)' }}>Specific instructions (optional)</label>
        <textarea aria-label="Specific instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="The 'why' & rules that don't fit in the diagram — error handling, conventions, constraints. Folded into generated tasks." rows={4} style={{ ...ta, minHeight: 80, fontFamily: 'inherit' }} />
        </details>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            Type:
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ background: 'var(--bg,#0b0d10)', color: 'var(--text,#e4e4e7)', border: '1px solid var(--border,#2a2f37)', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}>
              <option value="auto">Auto-detect</option>
              <option value="sequence">Sequence</option>
              <option value="class">Class</option>
            </select>
          </label>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={emitTasks} onChange={(e) => setEmitTasks(e.target.checked)} />
            Create tasks for missing code
          </label>
        </div>

        <div className="editor-actions">
          <button className="ui-button ui-button--primary" type="button" onClick={submit} disabled={isBusy || !diagram.trim()}
            title="Deterministic: parse + overlay against the code graph (fast, offline)">
            {status === 'sending' ? 'Working…' : 'Import & compare'}
          </button>
          <button className="ui-button" type="button" onClick={buildWithClaude} disabled={isBusy || !diagram.trim()}
            title="Hybrid: Claude binds with judgment, interprets relations, and plans Tasks/Knowledge from the overlay + your instructions">
            {status === 'waiting' ? 'Claude…' : '🚀 Build with Claude'}
          </button>
          <button className="ui-button" type="button" onClick={reset} disabled={isBusy}>
            Discard draft
          </button>
          {errorMsg && <span style={{ fontSize: 12, color: '#ef4444' }}>{errorMsg}</span>}
        </div>
      </div>

      {/* ── Right: overlay result ── */}
      <div style={panel}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>🔍 Overlay vs. code</h2>

        {!result ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 32, color: 'var(--muted, #94a3b8)', fontSize: 14, border: '1px dashed var(--border, #2a2f37)', borderRadius: 8, background: 'rgba(255,255,255,0.02)' }}>
            Import a diagram on the left — the conformance overlay appears here.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
              <span style={{ padding: '3px 9px', borderRadius: 999, background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.35)', color: '#a5b4fc' }}>
                {result.imported && result.imported.kind} · {result.specId}
              </span>
            </div>

            {result.workerSummary && (
              <div style={{ padding: 12, background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.3)', borderRadius: 8, fontSize: 13, lineHeight: 1.5 }}>
                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: '#c4b5fd', marginBottom: 6 }}>🚀 Claude — what was built</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{result.workerSummary}</div>
              </div>
            )}

            {unbound.length > 0 && (
              <div style={{ padding: 10, borderRadius: 8, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', fontSize: 12 }}>
                <strong style={{ color: '#fca5a5' }}>Unbound (not errors — confirm a binding):</strong>{' '}
                {unbound.join(', ')}
              </div>
            )}

            <RegionList title="✅ Conforms" items={regions.conforms} color="#22c55e" />
            <RegionList title="❌ Missing" items={regions.missing} color="#ef4444" />
            <RegionList title="⚠ Extra (undocumented)" items={regions.extra} color="#f59e0b" />

            {emitted.length > 0 && (
              <div style={{ padding: 10, borderRadius: 8, background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)', fontSize: 12 }}>
                <strong style={{ color: '#86efac' }}>Created {emitted.length} task(s):</strong>
                {emitted.map((t, i) => (
                  <div key={i} style={{ fontFamily: 'monospace', fontSize: 11, marginTop: 2 }}>{t.call || t.gap} <span style={{ opacity: 0.6 }}>#{t.taskId}</span></div>
                ))}
              </div>
            )}

            {result.subgraph && result.subgraph.nodes.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted, #94a3b8)' }}>
                  Spec subgraph · {result.subgraph.nodes.length} nodes
                </div>
                <SpecSubgraph nodes={result.subgraph.nodes} edges={result.subgraph.edges} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * DiagramsTab — the saved-diagram library as a stand-alone tab. Lists every
 * imported diagram (newest first, from /api/spec/list) and, on click, hands the
 * specId up so App can switch to the Spec tab and reopen it + its overlay in the
 * graph. Read-only; the Spec tab still owns importing/overlaying.
 */
export function DiagramsTab({ db, onOpen }) {
  const [specs, setSpecs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const dbQuery = db ? `?db=${encodeURIComponent(db)}` : '';

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    fetch(`${BRIDGE_URL}/api/spec/list${dbQuery}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (alive) setSpecs(Array.isArray(d.specs) ? d.specs : []); })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [dbQuery]);

  return (
    <div style={{ height: '100%', boxSizing: 'border-box', padding: 24, overflow: 'auto', background: 'var(--bg, #0b0d10)', color: 'var(--text, #e4e4e7)' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>📚 Saved diagrams</h2>
          <span style={{ fontSize: 12, color: 'var(--muted, #94a3b8)' }}>{specs.length} total</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted, #94a3b8)' }}>
          Every diagram imported in the Spec tab. Click one to reopen it and its overlay in the graph — no re-run needed.
        </div>
        {loading && <div style={{ color: 'var(--muted, #94a3b8)', fontSize: 13 }}>Loading…</div>}
        {error && <div style={{ color: '#ef4444', fontSize: 13 }}>Couldn't load: {error}</div>}
        {!loading && !error && specs.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted, #94a3b8)', fontSize: 14, border: '1px dashed var(--border, #2a2f37)', borderRadius: 10, background: 'rgba(255,255,255,0.02)' }}>
            No saved diagrams yet. Go to the <strong>📐 Spec</strong> tab and import a PlantUML / .wsd diagram — it'll show up here.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {specs.map((s) => (
            <button key={s.specId} type="button" onClick={() => onOpen && onOpen(s.specId)}
              title="Open this diagram + overlay in the Spec view"
              style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 14px', border: '1px solid var(--border, #2a2f37)', borderRadius: 10, background: 'var(--surface, #14171c)', cursor: 'pointer', textAlign: 'left', color: 'var(--text, #e4e4e7)', fontFamily: 'inherit' }}>
              <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, color: '#a5b4fc', background: 'rgba(99,102,241,0.15)', padding: '2px 8px', borderRadius: 5, textTransform: 'uppercase' }}>{s.kind || s.label}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14 }}>{s.title}</span>
              <span style={{ flexShrink: 0, fontSize: 12, color: 'var(--muted, #94a3b8)' }}>{s.children} nodes</span>
              <span style={{ flexShrink: 0, fontSize: 16, color: 'var(--muted, #94a3b8)' }}>›</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
