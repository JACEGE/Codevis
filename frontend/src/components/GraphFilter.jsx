import { useState, useMemo, useRef, useEffect } from 'react';
import {
  colorForLabel, displayNameForLabel, SPEC_LABEL_SET, DEFAULT_OFF,
} from '../nodePalette';

/**
 * Der Ausgangszustand, bevor die erste Bridge-Antwort da ist.
 *
 * Bewusst DÜNN: nur was aus ist. Ein Label, das hier nicht steht, gilt in
 * App.jsx als sichtbar (`l in visMap`), und die Bridge bekommt aus diesem
 * Objekt ihre `hiddenTypes` — eine ausgeschriebene Allowlist hätte genau das
 * Problem, das dieses Panel hatte: jeder Typ, an den beim Schreiben niemand
 * gedacht hat, wäre unsichtbar UND unschaltbar gewesen.
 */
export const DEFAULT_TYPE_VISIBILITY = Object.fromEntries(
  DEFAULT_OFF.map((k) => [k, false])
);

/**
 * The control for how much graph there is, and of what.
 *
 * Everything in here is CONTROLLED — the budget and the isolated-node switch
 * live in App, because the Settings panel offers the same budget and two
 * components each owning their own copy is how you get two sliders that
 * disagree. What the filter still owns is the type checkboxes, which nothing
 * else shows.
 *
 * The numbers next to the checkboxes come from the database census the bridge
 * ships with the graph, NOT from the nodes on screen. A type that was switched
 * off has zero nodes loaded, and a checkbox reading "0" next to a type that has
 * 904 of them in the project is worse than no number at all.
 *
 * Und die LISTE selbst kommt aus derselben Quelle. Sie war einmal hartcodiert,
 * und das ging so aus, wie es ausgehen muss: der Filter zeigte 'Components'
 * (null Knoten in dieser DB, React-Komponenten liegen als Function drin) und
 * kannte 'Idea', 'ImportedSymbol', 'Service' oder 'BraindumpSession' nicht,
 * obwohl sie im Graphen sichtbar waren. Wenn die Bridge ohnehin sagt, WIE VIELE
 * es von jedem Typ gibt, dann sagt sie damit auch, WELCHE Typen es gibt.
 */
export default function GraphFilter({
  visible = DEFAULT_TYPE_VISIBILITY,
  onVisibleChange,
  typeCounts = {},
  palette = undefined,
  levelLabels = null,
  budget,
  onBudgetChange,
  loadable = 0,
  dbTotal = 0,
  isolatedCount = 0,
  includeIsolated = false,
  onIncludeIsolatedChange,
  pending = false,
  embedded = false,
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = event => {
      if (event.type === 'keydown') {
        if (event.key !== 'Escape') return;
        triggerRef.current?.focus();
      } else if (containerRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', dismiss);
    return () => {
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('pointerdown', dismiss);
    };
  }, [open]);

  /**
   * Die Checkbox-Zeilen: was die aktuelle Detailstufe laden kann, geschnitten
   * mit dem, wovon die Datenbank überhaupt etwas hat.
   *
   * Typen mit null Knoten fliegen raus — eine Checkbox für etwas, das es in
   * diesem Projekt nicht gibt, ist kein Feature, sondern eine Behauptung. Die
   * fünfzehn Spec*-Labels werden zu EINER Zeile zusammengefasst; die Bridge
   * stempelt dafür ein synthetisches 'Spec' auf jeden davon und liefert dessen
   * Summe im Census mit.
   *
   * Sortiert nach Häufigkeit, nicht alphabetisch: die Reihenfolge beantwortet
   * damit nebenbei die Frage, warum der Graph so aussieht, wie er aussieht —
   * der Typ, der das Budget frisst, steht oben.
   */
  const types = useMemo(() => {
    const source = levelLabels?.length ? levelLabels : Object.keys(typeCounts);
    const keys = new Set();
    let specTotal = 0;
    for (const label of source) {
      if (SPEC_LABEL_SET.has(label)) { specTotal += typeCounts[label] || 0; continue; }
      if (label === 'Spec') continue;   // kommt unten aus der Summe
      if ((typeCounts[label] || 0) > 0) keys.add(label);
    }
    const rows = Array.from(keys).map((key) => ({
      key,
      label: displayNameForLabel(key),
      color: colorForLabel(key, palette),
      count: typeCounts[key] || 0,
    }));
    // Die Bridge zählt 'Spec' selbst zusammen; die Summe hier ist der Rückfall,
    // falls dieses Feld einmal fehlt.
    const spec = typeCounts.Spec || specTotal;
    if (spec > 0) {
      rows.push({ key: 'Spec', label: displayNameForLabel('Spec'), color: colorForLabel('Spec', palette), count: spec });
    }
    return rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [levelLabels, typeCounts, palette]);

  // Wie viele Typen die Detailstufe kennt, aber diese DB nicht hat. Ohne diese
  // Zeile wäre "keine Checkbox" nicht von "Typ existiert nicht" zu trennen.
  const emptyTypes = useMemo(() => {
    if (!levelLabels?.length) return 0;
    return levelLabels.filter(
      (l) => !SPEC_LABEL_SET.has(l) && !(typeCounts[l] > 0)
    ).length;
  }, [levelLabels, typeCounts]);

  // The ceiling is what the level COULD load with nothing switched off, not
  // what is loaded right now. Using the loaded count would make the slider sit
  // permanently at its own maximum: every value you pick becomes the new total.
  const total = Number.isFinite(Number(loadable)) ? Math.max(0, Math.floor(Number(loadable))) : 0;
  // The shared state uses 0 for an uncapped budget. Never turn that sentinel
  // into an invented node count, and keep budgets below ten representable.
  const unlimited = !(budget > 0) || !Number.isFinite(Number(budget));
  const current = unlimited ? total : Math.min(Math.max(1, Math.floor(budget)), total);
  const allLoaded = unlimited || current === total;

  // Ein Typ, von dem die Sichtbarkeitskarte nichts weiß, ist AN. Das ist
  // dieselbe Regel wie in App.jsx und in der Bridge (die eine Hidden-Liste
  // führt, keine Allowlist) — ein neues Label des Builders taucht dadurch auf,
  // statt still zu verschwinden.
  const isOn = (key) => visible[key] !== false;

  const toggle = (key) => {
    const next = { ...visible, [key]: !isOn(key) };
    onVisibleChange?.(next);
  };

  const allChecked = types.length > 0 && types.every(t => isOn(t.key));
  const someChecked = types.some(t => isOn(t.key));

  const toggleAll = () => {
    const nextState = !allChecked;
    // Only toggle this level's displayed rows; preserve preferences for other
    // levels (in particular AST types that are hidden by default).
    const next = { ...visible, ...Object.fromEntries(types.map(t => [t.key, nextState])) };
    onVisibleChange?.(next);
  };

  return (
    <div ref={containerRef} className={embedded ? 'graph-filter' : undefined} style={{
      // Keep the recovery control above GraphEmptyState. Turning off the last
      // visible type legitimately produces an empty graph, but must never hide
      // the only control that can bring it back.
      position: embedded ? 'relative' : 'absolute', top: embedded ? undefined : 12, right: embedded ? undefined : 12, zIndex: 120,
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
    }}>
      <button
        ref={triggerRef} type="button" aria-expanded={open} aria-controls="graph-filter-options"
        onClick={() => setOpen(!open)}
        style={{
          background: 'var(--surface, #fff)', border: '1px solid var(--border, #e0e0e0)',
          borderRadius: 6, padding: '6px 12px', cursor: 'pointer',
          fontSize: 12, color: 'var(--text, #1a1a1a)', fontWeight: 600,
        }}
      >
        Filter {pending ? '…' : ''} {open ? '▲' : '▼'}
      </button>
      {open && (
        <div id="graph-filter-options" className={embedded ? 'graph-filter-options' : undefined} style={{
          marginTop: 4, background: 'color-mix(in srgb, var(--surface) 96%, transparent)', color: 'var(--text)',
          border: '1px solid var(--border, #e0e0e0)', borderRadius: 8,
          padding: 10, fontSize: 12, minWidth: 250,
          maxHeight: '70vh', overflowY: 'auto',
        }}>
          <div style={{
            paddingBottom: 8, marginBottom: 8,
            borderBottom: '1px solid var(--border, #e0e0e0)',
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontWeight: 600, marginBottom: 4,
            }}>
              <span>Node Budget</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted, #888)' }}>
                {allLoaded ? `all ${total}` : `${current} / ${total}`}
              </span>
            </div>
            <input
              type="range"
              aria-label="Node budget"
              min={total > 0 ? 1 : 0}
              max={total}
              step={1}
              disabled={total === 0}
              value={current}
              onChange={(e) => {
                if (total === 0) return;
                const value = Number(e.target.value);
                onBudgetChange?.(value >= total ? 0 : value);
              }}
              style={{ width: '100%' }}
            />
            <button type="button" aria-label="Load all nodes"
              title="Remove the node budget, including for future graph growth"
              disabled={unlimited} onClick={() => onBudgetChange?.(0)}
              style={{ background: 'var(--surface)', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: 4, padding: '3px 8px',
                cursor: unlimited ? 'default' : 'pointer' }}>
              All
            </button>
            {/* Says what the number means, and what it is a fraction OF. The
                slider used to report "500 / 500" because it measured itself
                against the nodes it had already limited. */}
            <div style={{ fontSize: 10.5, color: 'var(--text-muted, #888)', marginTop: 3, lineHeight: 1.4 }}>
              Loadable at this level: {total}
              {dbTotal ? ` · in the database: ${dbTotal}` : ''}
              <br />
              The budget is spent along the edges — a type you switch off hands
              its share to the others.
            </div>
          </div>

          {/* Nodes with no edge at all. A walk along edges can never reach them,
              so they need their own way in — and they are the interesting ones
              (potential dead code, endpoints nothing statically routes to). */}
          <label style={{
            display: 'flex', alignItems: 'center', gap: 6,
            marginBottom: 8, paddingBottom: 8, cursor: isolatedCount ? 'pointer' : 'default',
            borderBottom: '1px solid var(--border, #e0e0e0)',
            opacity: isolatedCount ? 1 : 0.45,
          }}>
            <input
              type="checkbox"
              checked={includeIsolated}
              disabled={!isolatedCount}
              onChange={(e) => onIncludeIsolatedChange?.(e.target.checked)}
            />
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              border: '1.5px solid #94a3b8', display: 'inline-block',
            }} />
            <span style={{ flex: 1 }}>No connections</span>
            <span style={{
              fontSize: 10, color: 'var(--text-muted, #888)',
              fontVariantNumeric: 'tabular-nums',
            }}>{isolatedCount}</span>
          </label>

          <label style={{
            display: 'flex', alignItems: 'center', gap: 6,
            marginBottom: 8, paddingBottom: 8, cursor: 'pointer',
            borderBottom: '1px solid var(--border, #e0e0e0)',
            fontWeight: 600,
          }}>
            <input
              type="checkbox"
              checked={allChecked}
              ref={input => { if (input) input.indeterminate = someChecked && !allChecked; }}
              onChange={toggleAll}
            />
            Select all / none
          </label>
          {types.map(t => {
            const isVisible = isOn(t.key);
            const total = t.count;
            return (
              <label
                key={t.key}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  cursor: 'pointer', marginBottom: 4,
                  opacity: isVisible ? 1 : 0.4,
                }}
              >
                <input
                  type="checkbox"
                  checked={isVisible}
                  onChange={() => toggle(t.key)}
                  style={{ accentColor: t.color }}
                />
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: t.color, display: 'inline-block',
                }} />
                <span style={{ flex: 1 }}>{t.label}</span>
                <span style={{
                  fontSize: 10, color: 'var(--text-muted, #888)',
                  fontVariantNumeric: 'tabular-nums',
                }}>{total != null ? total : ''}</span>
              </label>
            );
          })}
          {/* "Keine Checkbox" und "Typ existiert hier nicht" sind sonst
              dasselbe Bild. Diese Zeile trennt die beiden. */}
          {emptyTypes > 0 && (
            <div style={{
              fontSize: 10, color: 'var(--text-muted, #888)',
              marginTop: 6, paddingTop: 6,
              borderTop: '1px solid var(--border, #e0e0e0)',
            }}>
              This level knows {emptyTypes} more types — this database has no
              nodes of any of them.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
