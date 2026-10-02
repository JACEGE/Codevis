import { useEffect, useRef, useState } from 'react';
import BRIDGE_URL from '../bridgeUrl';
import useTheme from '../hooks/useTheme';
import { terminalTheme } from '../theme/tokens';

const DARK_TERMINAL_THEME = terminalTheme('dark');
const LIGHT_TERMINAL_THEME = terminalTheme('light');

export default function TerminalPanel() {
  const [theme] = useTheme();
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const [status, setStatus] = useState('checking');

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme = theme === 'dark' ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
  }, [theme]);

  useEffect(() => {
    let term, fitAddon, ws, ro, reconnectTimer;
    let disposed = false;
    const controller = new AbortController();

    async function init() {
      try {
        const bridgeStatus = await fetch(`${BRIDGE_URL}/api/status`, { signal: controller.signal }).then((response) => response.json());
        if (disposed) return;
        if (!bridgeStatus.webShellEnabled) {
          setStatus('disabled');
          return;
        }
        const { Terminal } = await import('@xterm/xterm');
        const { FitAddon } = await import('@xterm/addon-fit');
        await import('@xterm/xterm/css/xterm.css');
        let WebLinksAddon;
        try {
          ({ WebLinksAddon } = await import('@xterm/addon-web-links'));
        } catch (_) { /* optional addon */ }
        if (disposed) return;

        term = new Terminal({
          theme: theme === 'dark' ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
          fontSize: 13,
          lineHeight: 1.2,
          cursorBlink: true,
          cursorStyle: 'bar',
        });

        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        try {
          if (WebLinksAddon) term.loadAddon(new WebLinksAddon());
        } catch (_) { /* optional addon */ }

        term.open(containerRef.current);
        fitAddon.fit();
        termRef.current = term;

        // Register onData ONCE — sends to whatever ws is current
        term.onData(data => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(data);
        });

        // Ctrl+Shift+C = copy, Ctrl+Shift+V = paste (Linux-friendly)
        term.attachCustomKeyEventHandler((ev) => {
          if (ev.ctrlKey && ev.shiftKey && ev.key === 'C') {
            ev.preventDefault();
            const sel = term.getSelection();
            if (sel) navigator.clipboard.writeText(sel);
            return false;
          }
          if (ev.ctrlKey && ev.shiftKey && ev.key === 'V') {
            ev.preventDefault();
            navigator.clipboard.readText().then(t => { if (t) term.paste(t); });
            return false;
          }
          return true;
        });

        // WebSocket to bridge terminal endpoint. Derived from BRIDGE_URL rather
        // than hardcoded, so a second project's dashboard does not open a
        // terminal into the first project's bridge.
        function connect() {
          if (disposed) return;
          ws = new WebSocket(BRIDGE_URL.replace(/^http/, 'ws') + '/terminal');
          wsRef.current = ws;

          ws.onopen = () => { if (!disposed) setStatus('connected'); };
          ws.onclose = () => {
            if (disposed) return;
            setStatus('disconnected');
            reconnectTimer = setTimeout(connect, 3000);
          };
          ws.onerror = () => { if (!disposed) setStatus('error'); };
          ws.onmessage = (e) => { if (!disposed) term.write(e.data); };
        }
        connect();

        // Auto-resize
        ro = new ResizeObserver(() => {
          if (disposed) return;
          fitAddon.fit();
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        });
        ro.observe(containerRef.current);

      } catch (err) {
        if (disposed) return;
        setStatus('error');
        console.error('[TerminalPanel] Init failed:', err);
      }
    }

    init();

    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(reconnectTimer);
      if (ws) ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      ws?.close();
      ro?.disconnect();
      term?.dispose();
      if (termRef.current === term) termRef.current = null;
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, []);

  const statusDot = status === 'connected' ? "var(--success)" : status === 'checking' ? "var(--warning)" : "var(--danger)";

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 12px',
        borderBottom: "1px solid var(--border)",
        fontSize: 12, color: "var(--muted)",
        background: "var(--surface)",
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: statusDot, display: 'inline-block'
        }} />
        <span style={{ fontWeight: 600, color: "var(--text)" }}>Terminal</span>
        <span>{status}</span>
      </div>
      {status === 'disabled' && (
        <div style={{ padding: 16, color: "var(--muted)", fontSize: 13 }}>
          Browser shell is off. Restart with <code>codevis dashboard --web-shell</code> to enable it for this run.
        </div>
      )}
      <div ref={containerRef} style={{ flex: 1, overflow: 'hidden', display: status === 'disabled' ? 'none' : 'block' }}
        onClick={() => termRef.current?.focus()} />
    </div>
  );
}
