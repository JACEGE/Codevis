import { useState, useEffect, useRef, useCallback } from 'react';

import BRIDGE_URL from '../bridgeUrl';
import loadMermaid, { isChunkLoadError } from '../lib/loadMermaid';

/**
 * RosTab — the ROS 2 architecture, read live out of the code graph.
 *
 * Shows the generated class diagram three ways: rendered, as PlantUML source,
 * and as a plain interface table. All three come from ONE request — the bridge
 * returns both renderings of the same model, so switching views never re-queries
 * the graph and the code you download always matches the picture you saw.
 *
 * Rendering is Mermaid, client-side. PlantUML has no browser renderer (it needs
 * a server or the JAR), and shipping the diagram off to plantuml.com to get a
 * picture back would leak the architecture of a private codebase to a third
 * party. So: Mermaid draws, PlantUML is what you download — it is the format
 * `import_spec` reads back for drift checking.
 */

const CARD = {
  background: 'var(--panel, #0f172a)',
  border: '1px solid var(--border, #1e293b)',
  borderRadius: 8,
};

const LABEL = {
  fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
  letterSpacing: 0.5, color: 'var(--muted, #94a3b8)',
};

function btn(active) {
  return {
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    borderRadius: 6,
    border: `1px solid ${active ? '#6366f1' : 'var(--border, #1e293b)'}`,
    background: active ? '#6366f1' : 'transparent',
    color: active ? '#fff' : 'var(--muted, #94a3b8)',
  };
}

const KIND_COLOR = { topic: '#0ea5e9', service: '#f59e0b', action: '#a855f7' };

/** Trigger a browser download for generated text without touching the server. */
function download(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick — revoking synchronously can cancel the download
  // in Safari before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Mermaid renderer. Die Bibliothek kommt aus ../lib/loadMermaid.js — demselben
 * Loader, den auch ClassDiagramTab nutzt. Hier stand vorher ein eigener inline
 * Import, der mermaid.initialize() bei JEDEM Render erneut aufrief; das setzt
 * Mermaids interne Registry zurück und ein laufender Render kommt leer zurück.
 */
function MermaidView({ source, onSvg }) {
  const ref = useRef(null);
  const [error, setError] = useState(null);
  const idRef = useRef(`ros-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let cancelled = false;
    if (!source) return;
    (async () => {
      try {
        const mermaid = await loadMermaid();
        const { svg } = await mermaid.render(idRef.current, source);
        if (cancelled) return;
        setError(null);
        if (ref.current) ref.current.innerHTML = svg;
        if (onSvg) onSvg(svg);
      } catch (e) {
        if (cancelled) return;
        // A diagram that mermaid cannot parse must not blank the tab — the
        // PlantUML source is still valid and still downloadable. Ein
        // Chunk-Ladefehler ist dagegen gar kein Diagrammfehler.
        setError({
          message: e?.message || 'Mermaid could not render the diagram',
          stale: isChunkLoadError(e),
        });
      }
    })();
    return () => { cancelled = true; };
  }, [source, onSvg]);

  if (error && error.stale) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg, #e2e8f0)' }}>
        <strong>The app has been rebuilt.</strong>
        <div style={{ marginTop: 8, color: 'var(--muted, #94a3b8)' }}>
          This page is still running the old build and can no longer load the
          diagram code.
        </div>
        <button style={{ ...btn(false), marginTop: 10 }} onClick={() => window.location.reload()}>
          ↻ Reload page
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 16, color: '#f87171', fontSize: 13 }}>
        <strong>Rendering failed:</strong> {error.message}
        <div style={{ marginTop: 8, color: 'var(--muted, #94a3b8)' }}>
          The PlantUML source is unaffected — view and download it via “Code”.
        </div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      style={{ padding: 16, overflow: 'auto', minHeight: 200, textAlign: 'center' }}
    />
  );
}

export default function RosTab({ db }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('idle');
  const [errorMsg, setErrorMsg] = useState(null);
  const [view, setView] = useState('rendered');
  const [onlyConnected, setOnlyConnected] = useState(false);
  const [showInheritance, setShowInheritance] = useState(true);
  const svgRef = useRef(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setErrorMsg(null);
    try {
      const params = new URLSearchParams();
      if (db) params.set('db', db);
      params.set('onlyConnected', String(onlyConnected));
      params.set('showInheritance', String(showInheritance));
      const res = await fetch(`${BRIDGE_URL}/api/ros/diagram?${params}`);
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
      setStatus('done');
    } catch (e) {
      setErrorMsg(e.message || 'Unknown error');
      setStatus('error');
    }
  }, [db, onlyConnected, showInheritance]);

  useEffect(() => { load(); }, [load]);

  const stats = data?.stats;
  const empty = status === 'done' && stats && stats.rosNodes === 0 && stats.edges === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', overflow: 'auto' }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18 }}>🤖 ROS 2 architecture</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted, #94a3b8)' }}>
          Derived from the code graph: node classes, topics, services and actions.
          No separate model — what you see here is what the code says.
        </p>
      </div>

      {/* ── controls ── */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={load} style={btn(false)} disabled={status === 'loading'}>
          {status === 'loading' ? '⏳ Loading…' : '↻ Reload'}
        </button>
        <div style={{ display: 'flex', gap: 4 }}>
          {[['rendered', '🖼 Rendered'], ['plantuml', '📄 PlantUML'], ['mermaid', '📄 Mermaid'], ['table', '📋 Table']].map(
            ([key, label]) => (
              <button key={key} onClick={() => setView(key)} style={btn(view === key)}>{label}</button>
            )
          )}
        </div>
        <label style={{ ...LABEL, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyConnected} onChange={(e) => setOnlyConnected(e.target.checked)} />
          only connected
        </label>
        <label style={{ ...LABEL, display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={showInheritance} onChange={(e) => setShowInheritance(e.target.checked)} />
          inheritance
        </label>

        <div style={{ flex: 1 }} />

        {data && !empty && (
          <div style={{ display: 'flex', gap: 4 }}>
            <button style={btn(false)} onClick={() => download('ros_architecture.puml', data.plantuml)}>
              ⬇ .puml
            </button>
            <button style={btn(false)} onClick={() => download('ros_architecture.mmd', data.mermaid)}>
              ⬇ .mmd
            </button>
            <button
              style={btn(false)}
              disabled={!svgRef.current}
              title={svgRef.current ? 'Rendered diagram as SVG' : 'Open the rendered view first'}
              onClick={() => svgRef.current && download('ros_architecture.svg', svgRef.current, 'image/svg+xml')}
            >
              ⬇ .svg
            </button>
          </div>
        )}
      </div>

      {/* ── stats ── */}
      {stats && !empty && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            ['Nodes', stats.rosNodes], ['Topics', stats.topics],
            ['Services', stats.services], ['Actions', stats.actions],
            ['Connections', stats.edges],
          ].map(([label, n]) => (
            <div key={label} style={{ ...CARD, padding: '6px 12px', fontSize: 12 }}>
              <span style={{ color: 'var(--muted, #94a3b8)' }}>{label}</span>{' '}
              <strong style={{ fontSize: 14 }}>{n}</strong>
            </div>
          ))}
          {stats.dynamicNames > 0 && (
            <div style={{ ...CARD, padding: '6px 12px', fontSize: 12, borderColor: '#f59e0b' }}>
              <span style={{ color: '#f59e0b' }}>
                {stats.dynamicNames} name(s) only known at runtime
              </span>
            </div>
          )}
        </div>
      )}

      {errorMsg && (
        <div style={{ ...CARD, padding: 12, borderColor: '#ef4444', color: '#f87171', fontSize: 13 }}>
          {errorMsg}
        </div>
      )}

      {empty && (
        <div style={{ ...CARD, padding: 16, fontSize: 13, color: 'var(--muted, #94a3b8)' }}>
          <strong style={{ color: 'var(--fg, #e2e8f0)' }}>No ROS interfaces in the graph.</strong>
          <div style={{ marginTop: 6 }}>
            Does <code>codevis build</code> cover the ROS sources? The ROS layer is created
            while parsing — without a build made after this feature landed, it stays empty.
          </div>
        </div>
      )}

      {/* ── content ── */}
      {data && !empty && (
        <div style={{ ...CARD, flex: 1, minHeight: 300, overflow: 'auto' }}>
          {view === 'rendered' && (
            <MermaidView source={data.mermaid} onSvg={(svg) => { svgRef.current = svg; }} />
          )}

          {(view === 'plantuml' || view === 'mermaid') && (
            <div style={{ position: 'relative' }}>
              <button
                style={{ ...btn(false), position: 'absolute', top: 8, right: 8 }}
                onClick={() => navigator.clipboard?.writeText(view === 'plantuml' ? data.plantuml : data.mermaid)}
              >
                📋 Copy
              </button>
              <pre style={{
                margin: 0, padding: 16, fontSize: 12, lineHeight: 1.5,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                whiteSpace: 'pre', overflow: 'auto',
              }}>
                {view === 'plantuml' ? data.plantuml : data.mermaid}
              </pre>
            </div>
          )}

          {view === 'table' && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--muted, #94a3b8)' }}>
                  {['Kind', 'Name', 'Type', 'Provides', 'Consumes'].map((h) => (
                    <th key={h} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border, #1e293b)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data.interfaces || []).map((i) => {
                  const nodeName = (id) => (data.nodes || []).find((n) => n.id === id)?.name || id;
                  const mine = (data.edges || []).filter((e) => e.iface === i.name);
                  return (
                    <tr key={i.name} style={{ borderBottom: '1px solid var(--border, #1e293b)' }}>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{
                          color: KIND_COLOR[i.kind] || '#94a3b8', fontWeight: 600,
                        }}>{i.kind}</span>
                      </td>
                      <td style={{ padding: '8px 12px', fontFamily: 'ui-monospace, monospace' }}>
                        {i.name}
                        {i.dynamic && <span style={{ color: '#f59e0b' }} title="Name only known at runtime"> ⚠</span>}
                        {i.aliases?.length > 0 && (
                          <div style={{ fontSize: 10, color: 'var(--muted, #94a3b8)' }}>
                            also in code as: {i.aliases.join(', ')}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--muted, #94a3b8)' }}>{i.msgType || '—'}</td>
                      <td style={{ padding: '8px 12px' }}>
                        {[...new Set(mine.filter((e) => e.direction === 'provide').map((e) => nodeName(e.nodeId)))].join(', ') || '—'}
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        {[...new Set(mine.filter((e) => e.direction === 'consume').map((e) => nodeName(e.nodeId)))].join(', ') || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
