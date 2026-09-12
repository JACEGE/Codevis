/**
 * GraphDetailSlider — Segmented control for choosing the graph detail level.
 *
 * Props:
 *   level         — 1 | 2 | 3  (current detail level)
 *   onLevelChange — (newLevel: 1|2|3) => void
 *
 * Level meanings:
 *   1 "Architektur"  — functions, files, components, states, tasks  (~930 nodes)
 *   2 "+ Atomar"     — adds variables, control-flow, statements      (~6k nodes)
 *   3 "Voll atomar"  — adds raw AST tokens                          (~26k nodes)
 */

// Labels name what you GET, not the internal granularity. They used to read
// "+ Atomic" and "Full atomic" — jargon for AST depth that says nothing about
// what appears on screen or what it costs.
const LEVELS = [
  { value: 1, label: 'Architecture' },
  { value: 2, label: '+ Code detail' },
  { value: 3, label: '+ Syntax tree' },
];

// No absolute node counts here. They used to read "~900 / ~6k / ~26k" — numbers
// from whichever project someone had open when they wrote them, wrong for every
// other one and by now wrong for this one too (3k / 25k / 139k). The real figure
// for the graph in front of you is one line further down, under the budget
// slider: "Loadable at this level: N". That one cannot go stale.
const HINTS = {
  1: 'Functions, files, components, tasks — the fast overview',
  2: 'Adds variables, control flow and statements — many times larger',
  3: '⚠ Adds every syntax-tree node. Dwarfs the rest; the first load is slow',
};

const ACCENT = '#6366f1';

// `embedded` drops the card chrome and the heading: inside the Settings tab the
// surrounding section already provides both, and a card within a card reads as
// two separate controls.
export default function GraphDetailSlider({ level, onLevelChange, embedded = false }) {
  return (
    <div
      style={embedded ? {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontSize: 12,
        userSelect: 'none',
      } : {
        display: 'inline-flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 10px',
        background: 'var(--surface, #ffffff)',
        border: '1px solid var(--border, #e0e0e0)',
        borderRadius: 8,
        fontSize: 12,
        userSelect: 'none',
        minWidth: 260,
      }}
    >
      {/* Label row */}
      {!embedded && (
        <div style={{ fontWeight: 600, color: 'var(--text, #1a1a1a)', marginBottom: 2 }}>
          Detail level
        </div>
      )}

      {/* Segmented control */}
      <div
        style={{
          display: 'flex',
          borderRadius: 6,
          overflow: 'hidden',
          border: '1px solid var(--border, #e0e0e0)',
        }}
      >
        {LEVELS.map(({ value, label }, idx) => {
          const active = value === level;
          return (
            <button
              key={value}
              aria-pressed={active}
              onClick={() => onLevelChange(value)}
              title={HINTS[value]}
              style={{
                flex: 1,
                minHeight: 34,
                padding: '6px 5px',
                fontSize: 12,
                fontWeight: active ? 700 : 400,
                cursor: 'pointer',
                border: 'none',
                borderLeft: idx > 0 ? '1px solid var(--border, #e0e0e0)' : 'none',
                borderRadius: 0,
                background: active ? ACCENT : 'var(--surface, #ffffff)',
                color: active ? '#ffffff' : 'var(--muted, #888)',
                transition: 'background 0.15s, color 0.15s',
                whiteSpace: 'nowrap',
                outline: 'none',
              }}
              onMouseEnter={e => {
                if (!active) {
                  e.currentTarget.style.background = '#f0f0ff';
                  e.currentTarget.style.color = ACCENT;
                }
              }}
              onMouseLeave={e => {
                if (!active) {
                  e.currentTarget.style.background = 'var(--surface, #ffffff)';
                  e.currentTarget.style.color = 'var(--muted, #888)';
                }
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Hint text */}
      <div
        style={{
          fontSize: 12,
          color: level === 3 ? '#e67e22' : 'var(--muted, #888)',
          fontStyle: 'italic',
          minHeight: 14,
          lineHeight: 1.4,
        }}
      >
        {HINTS[level]}
      </div>
    </div>
  );
}
