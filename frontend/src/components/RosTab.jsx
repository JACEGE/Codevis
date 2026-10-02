import { useState, useEffect, useRef, useCallback } from 'react';

import BRIDGE_URL from '../bridgeUrl';
import loadMermaid, { isChunkLoadError, withMermaidTheme } from '../lib/loadMermaid';
import useTheme from '../hooks/useTheme';
import DiagramViewport from './DiagramViewport';
import { buttonStyle } from '../theme/tokens';
import KIND_COLOR from '../../../scripts/diagram/interface-colors.json';

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
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 8,
};

const LABEL = {
  fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
  letterSpacing: 0.5, color: "var(--muted)",
};

function btn(active) {
  return buttonStyle('default', active);
}

// The diagram generator and this legend import the same semantic colours.

// What each kind is, and what its two ends are called. A topic is one-way and
// many-to-many; a service is a single request/response; an action is a
// long-running goal with feedback and a result.
const KINDS = {
  topic: { label: 'Topic', icon: '◆', what: 'one-way messages, any number of senders and receivers', provide: 'Publisher', consume: 'Subscriber' },
  service: { label: 'Service', icon: '⇄', what: 'one request, one response', provide: 'Server', consume: 'Client' },
  action: { label: 'Action', icon: '▶', what: 'long-running goal with feedback and a result', provide: 'Action server', consume: 'Action client' },
};

function Legend() {
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: "var(--muted)" }} aria-label="Legend">
      {Object.entries(KINDS).map(([kind, k]) => (
        <span key={kind} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 14, height: 14, borderRadius: 3, border: `3px solid ${KIND_COLOR[kind]}` }} aria-hidden="true" />
          <strong style={{ color: 'var(--text)' }}>{k.icon} {k.label}</strong>
          <span>{k.what} · {k.provide} → {k.consume}</span>
        </span>
      ))}
    </div>
  );
}

/** One endpoint: which class (and ROS node) in which method, at which file:line. */
function Endpoint({ edge, node }) {
  const where = edge.file ? `${edge.file}${edge.line ? `:${edge.line}` : ''}` : null;
  return (
    <div style={{ padding: '6px 0', borderTop: "1px solid var(--border)", fontSize: 12, lineHeight: 1.5 }}>
      <div>
        <strong style={{ color: "var(--fg)" }}>{node?.name || edge.nodeId}</strong>
        {node?.kind === 'file' ? <span style={{ color: "var(--muted)" }}> (file)</span> : null}
        {node?.nodeName ? <span style={{ color: "var(--muted)" }}> · node <code>{node.nodeName}</code></span> : null}
        {edge.viaFunction ? <span style={{ color: "var(--muted)" }}> · in <code>{edge.viaFunction}()</code></span> : null}
        {edge.callback ? <span style={{ color: "var(--muted)" }}> · callback <code>{edge.callback}</code></span> : null}
      </div>
      {where && (
        <button type="button" title="Copy file:line"
          onClick={() => navigator.clipboard?.writeText(where)}
          style={{ all: 'unset', cursor: 'copy', fontFamily: 'ui-monospace, monospace', fontSize: 11, color: "var(--muted)", overflowWrap: 'anywhere' }}>
          {where}
        </button>
      )}
    </div>
  );
}

/**
 * Every interface with both of its ends, named for its kind (Publisher /
 * Subscriber, Server / Client) and located: class, ROS node, method, file:line.
 */
function Connections({ data, filter }) {
  const nodeById = new Map((data.nodes || []).map((n) => [n.id, n]));
  const q = filter.trim().toLowerCase();
  const interfaces = (data.interfaces || []).filter((i) => {
    if (!q) return true;
    const ends = (data.edges || []).filter((e) => e.iface === i.name).map((e) => `${nodeById.get(e.nodeId)?.name} ${e.file} ${e.viaFunction}`);
    return [i.name, i.kind, i.msgType, ...ends].join(' ').toLowerCase().includes(q);
  });
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 420px), 1fr))', gap: 10, padding: 12 }}>
      {interfaces.map((i) => {
        const kind = KINDS[i.kind] || KINDS.topic;
        const seen = new Set();
        const ends = (data.edges || []).filter((e) => e.iface === i.name).filter((e) => {
          const key = `${e.nodeId}|${e.relType}|${e.file}|${e.line}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const column = (direction, title) => {
          const list = ends.filter((e) => e.direction === direction);
          return (
            <div style={{ minWidth: 0 }}>
              <div style={{ ...LABEL, marginBottom: 2 }}>{title} ({list.length})</div>
              {list.length ? list.map((e, n) => <Endpoint key={n} edge={e} node={nodeById.get(e.nodeId)} />)
                : <div style={{ fontSize: 12, color: "var(--warning)", paddingTop: 6 }}>none in the code</div>}
            </div>
          );
        };
        return (
          <section key={i.name} style={{ ...CARD, padding: 12, borderLeft: `4px solid ${KIND_COLOR[i.kind] || "var(--muted)"}` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={{ color: KIND_COLOR[i.kind], fontWeight: 700, fontSize: 12 }}>{kind.icon} {kind.label.toUpperCase()}</span>
              <code style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{i.name}</code>
              {i.dynamic && <span style={{ color: "var(--warning)", fontSize: 11 }} title="Name only known at runtime">⚠ runtime name</span>}
              <span style={{ fontSize: 11, color: "var(--muted)" }}>{i.msgType || 'type unknown'}</span>
            </div>
            {i.aliases?.length > 0 && (
              <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 6 }}>also written in code as: {i.aliases.join(', ')}</div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {column('provide', kind.provide + 's')}
              {column('consume', kind.consume + 's')}
            </div>
          </section>
        );
      })}
      {!interfaces.length && <div style={{ fontSize: 13, color: "var(--muted)" }}>Nothing matches “{filter}”.</div>}
    </div>
  );
}

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
  const [error, setError] = useState(null);
  const [svg, setSvg] = useState(null);
  const [theme] = useTheme();
  const idRef = useRef(`ros-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let cancelled = false;
    if (!source) return;
    (async () => {
      try {
        const mermaid = await loadMermaid();
        // Theme per diagram, as in ClassDiagramTab: the loader is shared.
        const themed = withMermaidTheme(source, theme === 'dark' ? 'dark' : 'default');
        const { svg: rendered } = await mermaid.render(idRef.current, themed);
        if (cancelled) return;
        // Kept in state and written by the effect below: while the error block
        // is shown the container is unmounted, so writing ref.current here
        // left the next valid diagram blank.
        setError(null);
        setSvg(rendered);
        if (onSvg) onSvg(rendered);
      } catch (e) {
        if (cancelled) return;
        setSvg(null);
        if (onSvg) onSvg(null);
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
  }, [source, onSvg, theme]);

  if (error && error.stale) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: "var(--fg)" }}>
        <strong>The app has been rebuilt.</strong>
        <div style={{ marginTop: 8, color: "var(--muted)" }}>
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
      <div style={{ padding: 16, color: "var(--danger)", fontSize: 13 }}>
        <strong>Rendering failed:</strong> {error.message}
        <div style={{ marginTop: 8, color: "var(--muted)" }}>
          The PlantUML source is unaffected — view and download it via “Code”.
        </div>
      </div>
    );
  }

  // Pan and zoom (wheel, drag, fit) like the class diagram; the old scroll box
  // could not zoom at all.
  return (
    <DiagramViewport svg={svg} resetKey={source}
      style={{ flex: 1, minHeight: 420, height: '100%', borderRadius: 8, background: "var(--surface)" }} />
  );
}

export default function RosTab({ db }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('idle');
  const [errorMsg, setErrorMsg] = useState(null);
  const [view, setView] = useState('rendered');
  const [onlyConnected, setOnlyConnected] = useState(false);
  const [showInheritance, setShowInheritance] = useState(true);
  const [filter, setFilter] = useState('');
  // State, not a ref: the download button must re-render when a diagram
  // arrives or fails. setSvg is also a stable onSvg callback, so parent
  // re-renders no longer restart the Mermaid render.
  const [svg, setSvg] = useState(null);

  // Only the latest request may write state: quick filter toggles otherwise let
  // a slower, older response land last and disagree with the checkboxes.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestSeq.current;
    const current = () => request === requestSeq.current;
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
      const body = await res.json();
      if (!current()) return;
      setData(body);
      setStatus('done');
    } catch (e) {
      if (!current()) return;
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
        <p style={{ margin: '6px 0 0', fontSize: 13, color: "var(--muted)" }}>
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
          {[['rendered', '🖼 Diagram'], ['connections', '🔗 Who talks to whom'], ['plantuml', '📄 PlantUML'], ['mermaid', '📄 Mermaid']].map(
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
              disabled={!svg}
              title={svg ? 'Rendered diagram as SVG' : 'Open the rendered view first'}
              onClick={() => svg && download('ros_architecture.svg', svg, 'image/svg+xml')}
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
              <span style={{ color: "var(--muted)" }}>{label}</span>{' '}
              <strong style={{ fontSize: 14 }}>{n}</strong>
            </div>
          ))}
          {stats.dynamicNames > 0 && (
            <div style={{ ...CARD, padding: '6px 12px', fontSize: 12, borderColor: "var(--warning)" }}>
              <span style={{ color: "var(--warning)" }}>
                {stats.dynamicNames} name(s) only known at runtime
              </span>
            </div>
          )}
        </div>
      )}

      {errorMsg && (
        <div style={{ ...CARD, padding: 12, borderColor: "var(--danger)", color: "var(--danger)", fontSize: 13 }}>
          {errorMsg}
        </div>
      )}

      {empty && (
        <div style={{ ...CARD, padding: 16, fontSize: 13, color: "var(--muted)" }}>
          <strong style={{ color: "var(--fg)" }}>No ROS interfaces in the graph.</strong>
          <div style={{ marginTop: 6 }}>
            Does <code>codevis build</code> cover the ROS sources? The ROS layer is created
            while parsing — without a build made after this feature landed, it stays empty.
          </div>
        </div>
      )}

      {/* ── content ── */}
      {data && !empty && (view === 'rendered' || view === 'connections') && <Legend />}
      {data && !empty && (
        <div style={{ ...CARD, flex: 1, minHeight: 420, display: 'flex', flexDirection: 'column', overflow: view === 'rendered' ? 'hidden' : 'auto' }}>
          {view === 'rendered' && (
            <MermaidView source={data.mermaid} onSvg={setSvg} />
          )}

          {view === 'connections' && (
            <>
              <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by topic, class, file or method"
                aria-label="Filter connections"
                style={{ margin: '12px 12px 0', padding: '6px 10px', fontSize: 12, borderRadius: 6,
                  border: "1px solid var(--border)", background: 'transparent', color: 'inherit' }} />
              <Connections data={data} filter={filter} />
            </>
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
        </div>
      )}
    </div>
  );
}
