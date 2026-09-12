import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

import BRIDGE_URL from '../bridgeUrl';
import { colorForNode } from '../nodePalette';
import useSessionDraft from '../hooks/useSessionDraft';
import useRequestLifetime from '../hooks/useRequestLifetime';
import { matchesWorkspace } from '../kanban/realtimeModel';

// Die Kategorie-Regel für Knowledge-Knoten stand nur hier und fehlte in
// colorForNode — derselbe Knoten war in diesem Panel eingefärbt und im Graphen
// grau. Sie ist jetzt Teil der Palette, also braucht dieser Tab keine eigene
// Fassung mehr.
const pickNodeColor = colorForNode;

/**
 * Mini force-graph of the generated subgraph. Nodes are clickable; the
 * selected node's full text (description / content / workInstructions)
 * renders in the detail card below the canvas.
 */
function BrainSubgraph({ nodes, edges, selectedId, onSelect }) {
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 400, h: 320 });

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
    links: (edges || []).map((e) => ({ source: e.src ?? e.source, target: e.tgt ?? e.target, relType: e.type ?? e.relType })),
  }), [nodes, edges]);

  const paintNode = useCallback((node, ctx, scale) => {
    const color = pickNodeColor(node);
    const isSel = node.id === selectedId;
    const r = isSel ? 7 : 5;
    const isTask = (node.labels || []).includes('Task');

    ctx.save();
    if (isSel) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
    }
    ctx.fillStyle = color;
    ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = isSel ? 1.5 : 0.5;
    ctx.beginPath();
    if (isTask) {
      // Diamond = Task (mirrors the main graph's shape coding)
      ctx.moveTo(node.x, node.y - r);
      ctx.lineTo(node.x + r, node.y);
      ctx.lineTo(node.x, node.y + r);
      ctx.lineTo(node.x - r, node.y);
      ctx.closePath();
    } else {
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    }
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    const label = String(node.name || node.taskId || node.id);
    const short = label.length > 28 ? label.slice(0, 27) + '…' : label;
    const fontSize = Math.max(3, 11 / scale);
    ctx.font = `500 ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = isSel ? '#ffffff' : 'rgba(228,228,231,0.85)';
    ctx.fillText(short, node.x, node.y + r + 2 / scale);
    ctx.restore();
  }, [selectedId]);

  return (
    <div ref={wrapRef} style={{ flex: '1 1 auto', minHeight: 240, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border, #2a2f37)', background: '#0b0e1a' }}>
      <ForceGraph2D
        width={size.w}
        height={size.h}
        graphData={graphData}
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={(node, color, ctx) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x, node.y, 10, 0, 2 * Math.PI);
          ctx.fill();
        }}
        linkColor={() => 'rgba(148,163,184,0.45)'}
        linkWidth={1.2}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={1}
        onNodeClick={(node) => onSelect && onSelect(node.id)}
        cooldownTicks={120}
        d3VelocityDecay={0.35}
        backgroundColor="#0b0e1a"
      />
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    idle: { label: 'Ready', color: '#94a3b8' },
    saving: { label: 'Saving...', color: '#0ea5e9' },
    saved: { label: 'Saved', color: '#22c55e' },
    sending: { label: 'Sending to Claude...', color: '#0ea5e9' },
    waiting: { label: 'Claude is thinking...', color: '#a855f7' },
    done: { label: 'Done', color: '#22c55e' },
    error: { label: 'Error', color: '#ef4444' },
  };
  const cfg = map[status] || map.idle;
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderRadius: 999,
        background: 'rgba(255,255,255,0.04)',
        border: `1px solid ${cfg.color}55`,
        color: cfg.color,
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: cfg.color,
          boxShadow: `0 0 6px ${cfg.color}`,
        }}
      />
      {cfg.label}
    </div>
  );
}

/**
 * BrainTab — Phase 2 UI skeleton.
 * Linke Spalte: Mikro + Textarea + Speichern.
 * Rechte Spalte: Placeholder für Subgraph-Preview (Phase 3 füllt die Mindmap).
 */
export default function BrainTab({ socket, db = 'project_db' }) {
  const lifetime = useRequestLifetime(db);
  const writeRequest = useRef(0);
  const draftRevision = useRef(0);
  const activeRun = useRef(null);
  const [text, setDraftText] = useSessionDraft(`codevis.draft.brain.${db}`, '');
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState('idle');
  const setText = useCallback(value => {
    draftRevision.current++;
    setDraftText(value);
    setStatus(s => s === 'saved' ? 'idle' : s);
  }, [setDraftText]);
  const [brainResult, setBrainResult] = useState(null);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [savedSessionId, setSavedSessionId] = useState(null);
  const recognitionRef = useRef(null);
  const wantsRecordingRef = useRef(false);
  const recognitionRestartRef = useRef(null);
  const finalTranscriptRef = useRef('');
  const textareaRef = useRef(null);

  const SpeechRecognition =
    typeof window !== 'undefined'
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : null;
  const supportsSpeech = !!SpeechRecognition;

  // Subscribe to brain:result socket events
  useEffect(() => {
    if (!socket) return;
    const handler = (data) => {
      if (!matchesWorkspace(data, db) || !activeRun.current
        || data.runId !== activeRun.current.runId || activeRun.current.token !== lifetime.current) return;
      activeRun.current = null;
      setBrainResult(data);
      setSelectedNodeId(null);
      setErrorMsg(data.error ? data.summary || 'Generation failed' : null);
      setStatus(data.error ? 'error' : 'done');
    };
    socket.on('brain:result', handler);
    return () => {
      socket.off('brain:result', handler);
    };
  }, [socket, db]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 600)}px`;
  }, [text]);

  const startRecording = useCallback(() => {
    if (!supportsSpeech) return;
    setErrorMsg(null);
    wantsRecordingRef.current = true;
    try {
      const recognition = new SpeechRecognition();
      recognition.lang = 'de-DE';
      recognition.continuous = true;
      recognition.interimResults = true;

      finalTranscriptRef.current = text ? text + ' ' : '';

      recognition.onresult = (event) => {
        let interim = '';
        let final = finalTranscriptRef.current;
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = result[0].transcript;
          if (result.isFinal) {
            final += transcript + ' ';
          } else {
            interim += transcript;
          }
        }
        finalTranscriptRef.current = final;
        setText((final + interim).trimStart());
      };

      recognition.onerror = (event) => {
        console.error('[Brain] speech recognition error:', event.error);
        // Chrome reports `no-speech` between utterances. That is not fatal for
        // a continuous braindump; onend below starts a fresh recognition turn.
        if (event.error === 'no-speech') return;

        wantsRecordingRef.current = false;
        const messages = {
          'not-allowed': 'Microphone access was denied. Allow it in the browser site settings and try again.',
          'service-not-allowed': 'Speech recognition is disabled by the browser or system policy.',
          'audio-capture': 'No usable microphone was found. Check the selected input device.',
          network: 'The browser speech service is unavailable. Check the connection and try again.',
          aborted: 'Speech recognition was aborted by the browser. Please try again.',
        };
        setErrorMsg(messages[event.error] || `Speech recognition failed (${event.error}).`);
        setRecording(false);
      };

      recognition.onend = () => {
        if (!wantsRecordingRef.current) {
          setRecording(false);
          return;
        }
        // Web Speech sessions can end after a pause even with continuous=true.
        // Restarting keeps the microphone button active until the user stops it.
        recognitionRestartRef.current = window.setTimeout(() => {
          if (!wantsRecordingRef.current) return;
          try {
            recognition.start();
          } catch (e) {
            wantsRecordingRef.current = false;
            setRecording(false);
            setErrorMsg('Speech recognition stopped unexpectedly. Please try again.');
            console.error('[Brain] failed to restart recognition:', e);
          }
        }, 250);
      };

      recognitionRef.current = recognition;
      recognition.start();
      setRecording(true);
    } catch (e) {
      console.error('[Brain] failed to start recognition:', e);
      wantsRecordingRef.current = false;
      setErrorMsg('Could not start the microphone. Check the browser permission and input device.');
      setRecording(false);
    }
  }, [SpeechRecognition, supportsSpeech, text]);

  const stopRecording = useCallback(() => {
    wantsRecordingRef.current = false;
    if (recognitionRestartRef.current != null) {
      window.clearTimeout(recognitionRestartRef.current);
      recognitionRestartRef.current = null;
    }
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        console.warn('[Brain] stop failed:', e);
      }
    }
    setRecording(false);
  }, []);

  useEffect(() => () => {
    wantsRecordingRef.current = false;
    if (recognitionRestartRef.current != null) window.clearTimeout(recognitionRestartRef.current);
    try { recognitionRef.current?.abort(); } catch { /* already stopped */ }
  }, []);

  // Save: nur in DB, KEIN Channel-Push.
  const saveOnly = useCallback(async () => {
    if (!text.trim()) return;
    const token = lifetime.current, request = ++writeRequest.current, revision = draftRevision.current;
    setStatus('saving');
    setErrorMsg(null);
    try {
      const res = await fetch(`${BRIDGE_URL}/api/brain/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, push: false, db }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => ({}));
      if (lifetime.current !== token || writeRequest.current !== request) return;
      if (data.sessionId) setSavedSessionId(data.sessionId);
      setStatus(draftRevision.current === revision ? 'saved' : 'idle');
    } catch (e) {
      if (lifetime.current !== token || writeRequest.current !== request) return;
      console.error('[Brain] save failed:', e);
      setErrorMsg(e.message || 'Unknown error');
      setStatus('error');
    }
  }, [text, db]);

  // Send: die Bridge spawnt einen headless `claude -p`-Worker, der den Braindump
  // in einen verlinkten Subgraphen verwandelt. Ergebnis kommt per 'brain:result'.
  const sendToClaude = useCallback(async () => {
    if (!text.trim() && !savedSessionId) return;
    const token = lifetime.current, request = ++writeRequest.current;
    const run = { runId: crypto.randomUUID(), token };
    activeRun.current = run;
    setStatus('sending');
    setErrorMsg(null);
    setBrainResult(null);
    try {
      const res = await fetch(`${BRIDGE_URL}/api/brain/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, push: true, sessionId: savedSessionId, db, runId: run.runId }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      const data = await res.json().catch(() => ({}));
      if (lifetime.current !== token || writeRequest.current !== request) return;
      if (data.sessionId) setSavedSessionId(data.sessionId);
      if (activeRun.current === run) setStatus('waiting');
    } catch (e) {
      if (lifetime.current !== token || writeRequest.current !== request || activeRun.current !== run) return;
      activeRun.current = null;
      console.error('[Brain] send failed:', e);
      setErrorMsg(e.message || 'Unknown error');
      setStatus('error');
    }
  }, [text, savedSessionId, db]);

  const clearAll = useCallback(() => {
    writeRequest.current++;
    activeRun.current = null;
    setText('');
    setBrainResult(null);
    setSavedSessionId(null);
    setStatus('idle');
    setErrorMsg(null);
    finalTranscriptRef.current = '';
  }, []);

  const isSaving = status === 'saving';
  const isSending = status === 'sending';
  const isBusy = isSaving || isSending || status === 'waiting';

  return (
    <div className="editor-workspace"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
        gap: 16,
        padding: 16,
        height: '100%',
        boxSizing: 'border-box',
        background: 'var(--bg, #0b0d10)',
        color: 'var(--text, #e4e4e7)',
        overflow: 'hidden',
      }}
    >
      {/* ───── Linke Spalte: Braindump ───── */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 16,
          background: 'var(--surface, #14171c)',
          border: '1px solid var(--border, #2a2f37)',
          borderRadius: 12,
          minHeight: 0,
          overflow: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>🧠 Braindump</h2>
          <StatusPill status={status} />
        </div>

        {/* Mikro */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: 12,
            padding: '8px 0',
          }}
        >
          {!supportsSpeech ? (
            <div
              style={{
                fontSize: 12,
                color: '#f59e0b',
                background: 'rgba(245, 158, 11, 0.08)',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                borderRadius: 8,
                padding: '8px 12px',
              }}
            >
              ⚠ Speech API only in Chrome/Edge — please type instead
            </div>
          ) : (
            <button className="ui-button recording-button"
              type="button"
              onClick={recording ? stopRecording : startRecording}
              aria-label={recording ? 'Stop recording' : 'Start recording'}
              aria-pressed={recording}
            >
              {recording ? 'Stop recording' : 'Start recording'}
            </button>
          )}
        </div>



        {/* Textarea */}
        <textarea
          aria-label="Braindump draft"
          ref={textareaRef}
          value={text}
          // Typing invalidates the "saved" confirmation: what is in the box is
          // no longer what was stored. 'saving'/'sending'/'waiting' are left
          // alone — those describe a request in flight, not the text.
          onChange={(e) => setText(e.target.value)}
          placeholder="Speak or type a braindump … ideas, TODOs, open questions, anything."
          rows={10}
          style={{
            flex: '1 1 auto',
            minHeight: 200,
            maxHeight: 600,
            resize: 'vertical',
            padding: 12,
            fontSize: 14,
            lineHeight: 1.5,
            fontFamily: 'inherit',
            background: 'var(--bg, #0b0d10)',
            color: 'var(--text, #e4e4e7)',
            border: '1px solid var(--border, #2a2f37)',
            borderRadius: 8,
            boxSizing: 'border-box',
          }}
        />

        {/* Action row */}
        <div className="editor-actions">
          <button className="ui-button ui-button--primary"
            type="button"
            onClick={saveOnly}
            disabled={isBusy || !text.trim()}
            // Its counterpart already explained itself on hover; this one did
            // not, which left the difference between the two buttons to be
            // guessed from their labels alone.
            title="Stores the text as a session. Creates NO nodes in the graph."
          >
            {isSaving ? 'Saving…' : 'Save note'}
          </button>
          <button className="ui-button"
            type="button"
            onClick={sendToClaude}
            disabled={isBusy || (!text.trim() && !savedSessionId)}
            title="Claude turns the braindump into a linked subgraph (knowledge + tasks)"
          >
            {isSending ? 'Sending…' : 'Generate linked items'}
          </button>
          <button className="ui-button"
            type="button"
            onClick={clearAll}
            disabled={isBusy}
          >
            Discard draft
          </button>
          {/* A successful Save left only a bare session id behind, which reads
              as metadata rather than as confirmation that anything happened. */}
          {status === 'saved' && (
            <span style={{ fontSize: 12, fontWeight: 600, color: '#16a34a' }}>
              ✓ Saved
            </span>
          )}
          {savedSessionId && (
            <span style={{ fontSize: 11, color: 'var(--muted, #94a3b8)', fontFamily: 'monospace' }}>
              📁 {savedSessionId}
            </span>
          )}
          {errorMsg && (
            <span style={{ fontSize: 12, color: '#ef4444' }}>{errorMsg}</span>
          )}
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--muted, #94a3b8)' }}>
          Save note stores your text. Generate linked items uses Claude Code to create knowledge and tasks.
          Drafts are kept in this browser tab when you switch views.
        </p>
      </div>

      {/* ───── Rechte Spalte: Subgraph-Preview ───── */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 16,
          background: 'var(--surface, #14171c)',
          border: '1px solid var(--border, #2a2f37)',
          borderRadius: 12,
          minHeight: 0,
          overflow: 'auto',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>🌐 Generated subgraph</h2>

        {!brainResult ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              padding: 32,
              color: 'var(--muted, #94a3b8)',
              fontSize: 14,
              border: '1px dashed var(--border, #2a2f37)',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.02)',
            }}
          >
            {/* Two states share this box, and the text used to describe neither
                correctly: it named Save as the action that produces nodes, but
                Save posts with push:false and deliberately creates none. Only
                "Send to Claude" starts the worker whose result lands here. */}
            {status === 'waiting'
              ? '⏳ Claude is building the subgraph…'
              : 'Choose Generate linked items to see knowledge and tasks here. Save note stores your text.'}
          </div>
        ) : (
          <>
            {/* Summary card */}
            {brainResult.summary && (
              <div
                style={{
                  padding: 12,
                  background: 'rgba(99, 102, 241, 0.08)',
                  border: '1px solid rgba(99, 102, 241, 0.3)',
                  borderRadius: 8,
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    color: '#a5b4fc',
                    marginBottom: 6,
                  }}
                >
                  Summary
                </div>
                <div>{brainResult.summary}</div>
              </div>
            )}

            {/* Generated subgraph as a clickable mini force-graph */}
            {(brainResult.nodes || []).length > 0 ? (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted, #94a3b8)' }}>
                  {brainResult.nodes.length} nodes · {(brainResult.edges || []).length} edges — click a node for details
                </div>
                <BrainSubgraph
                  nodes={brainResult.nodes}
                  edges={brainResult.edges || []}
                  selectedId={selectedNodeId}
                  onSelect={setSelectedNodeId}
                />
                {(() => {
                  const sel = (brainResult.nodes || []).find((n) => n.id === selectedNodeId);
                  if (!sel) {
                    return (
                      <div style={{ fontSize: 12, color: 'var(--muted, #94a3b8)', fontStyle: 'italic', padding: '4px 2px' }}>
                        Click a node in the graph to see its full text.
                      </div>
                    );
                  }
                  const color = pickNodeColor(sel);
                  const bodyText = sel.content || sel.description || '';
                  return (
                    <div style={{
                      padding: 12, borderRadius: 8, fontSize: 13, lineHeight: 1.55,
                      background: `${color}11`, border: `1px solid ${color}44`,
                      maxHeight: 220, overflow: 'auto', flexShrink: 0,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, boxShadow: `0 0 6px ${color}` }} />
                        <strong style={{ fontSize: 14 }}>{sel.name || sel.taskId}</strong>
                        {(sel.labels || []).map((l) => (
                          <span key={l} style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', padding: '1px 7px', borderRadius: 999, background: `${color}22`, color, border: `1px solid ${color}55` }}>{l}</span>
                        ))}
                        {sel.priority && <span style={{ fontSize: 10, color: '#f59e0b' }}>{sel.priority}</span>}
                        {sel.status && <span style={{ fontSize: 10, color: '#94a3b8' }}>{sel.status}</span>}
                        {sel.taskId && <span style={{ fontSize: 10, color: 'var(--muted, #94a3b8)', fontFamily: 'monospace' }}>#{sel.taskId}</span>}
                      </div>
                      {bodyText
                        ? <div style={{ whiteSpace: 'pre-wrap' }}>{bodyText}</div>
                        : <div style={{ fontStyle: 'italic', color: 'var(--muted, #94a3b8)' }}>No text stored on this node.</div>}
                      {sel.workInstructions && (
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${color}33` }}>
                          <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color, marginBottom: 4 }}>Work instructions</div>
                          <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{sel.workInstructions}</div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--muted, #94a3b8)', fontStyle: 'italic' }}>
                No nodes created.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
