/**
 * Die EINE Farbtabelle für Knotentypen.
 *
 * Vorher gab es zwei: NODE_COLORS in GraphScene (was gezeichnet wird) und
 * NODE_TYPES in GraphFilter (was die Legende behauptet). Sie sind
 * auseinandergelaufen — Epic stand nur in einer davon und wurde im Graphen grau
 * gerendert, während der Filter einen roten Punkt zeigte. Zwei Tabellen für
 * dieselbe Aussage driften immer; deshalb hier eine.
 *
 * Wer eine Farbe ändert, ändert sie damit an beiden Stellen gleichzeitig. Das
 * ist der ganze Zweck der Datei.
 */

// Muss mit SPEC_LABELS in server/bridge.js übereinstimmen. Die Bridge stempelt
// zusätzlich ein synthetisches 'Spec'-Label auf jeden dieser Knoten, damit der
// Filter EINEN Schalter hat und nicht fünfzehn.
export const SPEC_LABELS = [
    'SpecClassDiagram', 'SpecClass', 'SpecMethod', 'SpecField', 'SpecRelation',
    'SpecSequence', 'SpecParticipant', 'SpecMessage',
    'SpecUseCaseDiagram', 'SpecUseCase', 'SpecActor', 'SpecAssoc',
    'SpecActivityDiagram', 'SpecProcess', 'SpecAction',
];
export const SPEC_LABEL_SET = new Set(SPEC_LABELS);

export const NODE_COLORS = {
    Function: '#0ea5e9',    // sky blue
    Component: '#8b5cf6',   // violet
    Class: '#f97316',       // orange
    File: '#64748b',        // slate
    State: '#10b981',       // emerald
    Module: '#ec4899',      // pink
    Endpoint: '#f59e0b',    // amber
    Variable: '#ef4444',    // red
    // Rückgabewerte hängen an Funktionen und stehen im Graphen meist direkt
    // neben deren Variablen. Ein eigener Ton, damit man sie auseinanderhält,
    // aber in derselben warmen Familie — sie gehören zusammen.
    ReturnValue: '#fb923c', // amber-orange
    Task: '#6366f1',        // indigo
    // Pastellrot, bewusst AUSSERHALB des Task-Indigo. War mal #818cf8 — eine
    // Stufe heller als Task — mit dem Argument "gleicher Farbton heißt Behälter
    // dieser Knoten". In der Szene verliert das Argument: unter hunderten Knoten
    // ging ein Epic in seinen Tasks unter, und die Drahtgitter-Form trennt erst,
    // wenn man direkt draufzoomt. Nachbar zur Rose/Koralle-Familie der
    // Spec-Knoten — die treffen sich selten, weil die Spec-Ebene per Default aus
    // ist. Kippt dieser Default, müssen die beiden auseinander.
    Epic: '#fca5a5',
    Knowledge: '#14b8a6',   // teal
    Annotation: '#7c3aed',  // purple — reviewable semantic metadata, not code fact
    Idea: '#c084fc',        // helles violett — noch keine Task, aber schon etwas
    BraindumpSession: '#f472b6', // pink — das "Buch", zu dem ein Braindump wird
    Effect: '#a78bfa',      // light violet
    DOMElement: '#fb923c',  // light orange
    Topic: '#38bdf8',       // light blue
    Service: '#facc15',     // gelb — ROS-Service
    Action: '#eab308',      // dunkleres gelb — ROS-Action, Nachbar von Service
    HTTPHandler: '#f472b6', // light pink
    ArrowFunction: '#22d3ee', // cyan
    ControlFlow: '#9ca3af', // light gray
    // Import/Export-Symbole und externe Basisklassen: alles, was auf etwas
    // außerhalb der eigenen Datei zeigt, in einem gedeckten Blaugrau.
    ImportedSymbol: '#7dd3fc',
    ExportedSymbol: '#60a5fa',
    ExternalBase: '#94a3b8',
    // Statement-Ebene. Absichtlich alle in einer gedeckten Familie: das sind
    // Struktur-Details, keine Domänenknoten, und sie sollen den Graphen nicht
    // farblich dominieren.
    ReturnStatement: '#818cf8',
    ContinueStatement: '#a5b4fc',
    BreakStatement: '#c7d2fe',
    ThrowStatement: '#fda4af',
    ASTNode: '#cbd5e1',
    // Importierte Diagramme — eine Rose/Koralle-Familie, von keinem Code-Knoten
    // benutzt. Eine SpecClass trägt meist DENSELBEN NAMEN wie die Code-Klasse,
    // die sie beschreibt; der Unterschied muss also über das Aussehen getragen
    // werden, nicht über den Text. Der Container bekommt den kräftigsten Ton,
    // die Member den blassesten.
    Spec: '#f43f5e',        // der Sammel-Schalter im Filter
    SpecClassDiagram: '#f43f5e', SpecSequence: '#f43f5e',
    SpecUseCaseDiagram: '#f43f5e', SpecActivityDiagram: '#f43f5e',
    SpecClass: '#fb7185', SpecParticipant: '#fb7185',
    SpecUseCase: '#fb7185', SpecProcess: '#fb7185', SpecActor: '#fb7185',
    SpecMethod: '#fda4af', SpecField: '#fecdd3',
    SpecMessage: '#fda4af', SpecAction: '#fda4af',
    SpecRelation: '#e879f9', SpecAssoc: '#e879f9',
    default: '#94a3b8'      // gray
};

/**
 * Farbe für ein Label, das hier nicht steht.
 *
 * Ein neues Label im Builder soll nicht dazu führen, dass hunderte Knoten grau
 * werden und im Filter nicht von den anderen grauen zu unterscheiden sind.
 * Deterministisch aus dem Namen, damit dasselbe Label über Sitzungen und über
 * Filter und Szene hinweg dieselbe Farbe hat. Die Sättigung ist bewusst
 * gedämpft: eine unbekannte Farbe soll auffindbar sein, aber nicht so aussehen,
 * als hätte jemand sie gewählt.
 */
function hashedColor(label) {
    let h = 0;
    for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360}, 45%, 62%)`;
}

/** Farbe für ein einzelnes Label. */
export function colorForLabel(label, palette = NODE_COLORS) {
    if (!label) return NODE_COLORS.default;
    return palette[label] || NODE_COLORS[label] || hashedColor(label);
}

/**
 * Farbe für einen Knoten: das erste Label, für das es eine explizite Farbe
 * gibt. Ein Knoten trägt mehrere Labels, und die Reihenfolge im Array ist die
 * des Builders — bekannte Farben haben deshalb Vorrang vor der Reihenfolge.
 */
export function colorForNode(node, palette = NODE_COLORS) {
    const labels = node?.labels || [];
    for (const l of labels) if (palette[l]) return palette[l];
    for (const l of labels) if (NODE_COLORS[l]) return NODE_COLORS[l];
    // Ein Knowledge-Knoten trägt seine Kategorie ('architecture', 'testing', …)
    // als eigenes Feld statt als Label. BrainTab kannte diese Regel und der
    // Graph nicht: derselbe Knoten war im einen Panel eingefärbt und im anderen
    // grau. Farbe ist hier keine Dekoration, sondern die Zuordnung, nach der man
    // im Bild sucht — sie muss überall dieselbe sein.
    if (node?.category && palette[node.category]) return palette[node.category];
    if (node?.category && NODE_COLORS[node.category]) return NODE_COLORS[node.category];
    return labels.length ? hashedColor(labels[0]) : NODE_COLORS.default;
}

// ── Farben für unbekannte Labels: berechnet, nicht ausgewürfelt ──────────────
//
// Die Tabelle oben ist der ANKER — was dort steht, bleibt, weil man sich Farben
// merkt und ein Umlernen bei jedem Rebuild teurer ist als jede Optimierung.
// Alles, was der Builder NEU dazubekommt, wird hier zugewiesen, und zwar nach
// der einzigen Regel, die im Graphen zählt: möglichst weit weg von den Typen,
// mit denen der neue Typ tatsächlich Kanten teilt. Zwei Typen, die nie
// nebeneinander liegen, dürfen sich ähnlich sehen — die sieht man nie zusammen.
//
// Der Abstand wird in OKLab gemessen, nicht in RGB. RGB-Abstand hat mit dem,
// was das Auge trennt, wenig zu tun: #808080 und #888888 liegen in RGB weiter
// auseinander als Gelb und Weiß.

const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin2s = (c) => {
    c = Math.max(0, Math.min(1, c));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
};

function hexToOklab(hex) {
    const h = String(hex).replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => s2lin(parseInt(h.slice(i, i + 2), 16) / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

function oklchToHex(L, C, hueDeg) {
    const a = C * Math.cos((hueDeg * Math.PI) / 180);
    const b = C * Math.sin((hueDeg * Math.PI) / 180);
    const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s_ = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    const rgb = [
        +4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
        -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
        -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
    ];
    return '#' + rgb.map((c) => Math.round(lin2s(c) * 255).toString(16).padStart(2, '0')).join('');
}

/** Wahrnehmungsabstand zweier Farben, OKLab ×100. Unter ~15 wird es eng. */
function deltaE(hexA, hexB) {
    const a = hexToOklab(hexA), b = hexToOklab(hexB);
    return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// Der Vorrat, aus dem neue Labels bedient werden. Bewusst ein Ring aus
// gleichmäßig verteilten Farbtönen auf zwei Helligkeiten statt einer Handliste:
// eine Handliste ist irgendwann leer, ein Ring nicht. Helligkeit und Sättigung
// liegen im Band, das auf hellem WIE dunklem Hintergrund noch trägt — außerhalb
// davon ist eine Farbe entweder Grau oder Neon.
const CANDIDATES = [];
for (const L of [0.62, 0.74, 0.52]) {
    for (let hue = 0; hue < 360; hue += 15) CANDIDATES.push(oklchToHex(L, 0.14, hue));
}

/**
 * Weist jedem Label eine Farbe zu: Anker, wo es einen gibt, sonst berechnet.
 *
 * `adjacency` ist {label: {nachbarLabel: kantenzahl}} — welche Typen im Graphen
 * überhaupt aneinandergrenzen. Genau das ist der Maßstab: ein Typ muss sich von
 * seinen NACHBARN unterscheiden, nicht von allen 26 Labels der Datenbank. Der
 * Versuch, alle gleichzeitig auseinanderzuhalten, ist nachweislich unlösbar —
 * jenseits von etwa acht Farben gibt es keine Palette, die das leistet. Die
 * Nachbarschaft macht die Aufgabe wieder lösbar, weil sie die richtige ist.
 *
 * Deterministisch: gleiche Eingabe, gleiche Ausgabe. Labels werden sortiert
 * verarbeitet, damit eine Farbe nicht bei jedem Reload springt — eine Farbe,
 * die sich ändert, ist als Merkmal wertlos.
 */
export function buildPalette(labels = [], adjacency = {}) {
    const out = {};
    const unanchored = [];
    for (const label of labels) {
        if (NODE_COLORS[label]) out[label] = NODE_COLORS[label];
        else unanchored.push(label);
    }
    // Häufigste Nachbarschaft zuerst: wer viele Kanten hat, hat die engeren
    // Nebenbedingungen und soll die freie Auswahl bekommen, solange es sie gibt.
    const weight = (l) => Object.values(adjacency[l] || {}).reduce((s, n) => s + n, 0);
    unanchored.sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));

    for (const label of unanchored) {
        const neighbours = adjacency[label] || {};
        let best = null, bestScore = -Infinity;
        for (const cand of CANDIDATES) {
            // Abstand zu den Nachbarn, gewichtet mit der Kantenzahl: ein
            // Zusammenfall mit einem Typ, der 5000 Kanten teilt, wiegt schwerer
            // als einer mit sechs.
            let score = Infinity;
            for (const [other, count] of Object.entries(neighbours)) {
                const c = out[other] || NODE_COLORS[other];
                if (!c) continue;
                score = Math.min(score, deltaE(cand, c) * Math.log10(10 + count));
            }
            // Ohne Nachbarn (oder als Gleichstand-Entscheid) zählt der Abstand
            // zu allem, was schon vergeben ist — sonst bekämen zwei isolierte
            // neue Typen dieselbe Farbe.
            let free = Infinity;
            for (const c of Object.values(out)) free = Math.min(free, deltaE(cand, c));
            const total = Number.isFinite(score) ? score + free * 0.25 : free;
            if (total > bestScore) { bestScore = total; best = cand; }
        }
        out[label] = best || NODE_COLORS.default;
    }
    return out;
}

// Anzeigenamen, wo das nackte Label im Filter schlecht liest. Alles, was hier
// nicht steht, wird unverändert angezeigt — ein neues Label bekommt dadurch
// automatisch eine brauchbare Zeile statt gar keiner.
const DISPLAY_NAMES = {
    Function: 'Functions', Component: 'Components', Class: 'Classes',
    Task: 'Tasks', Epic: 'Epics', Endpoint: 'Endpoints', Variable: 'Variables',
    ReturnValue: 'Return Values',
    Effect: 'Effects', File: 'Files', Module: 'Modules', Topic: 'Topics',
    Idea: 'Ideas', Annotation: 'Annotations', Service: 'Services', Action: 'Actions',
    DOMElement: 'DOM Elements', ArrowFunction: 'Arrow Fns',
    ControlFlow: 'Control Flow', BraindumpSession: 'Braindumps',
    ImportedSymbol: 'Imported Symbols', ExportedSymbol: 'Exported Symbols',
    ExternalBase: 'External Bases',
    ReturnStatement: 'return', ContinueStatement: 'continue',
    BreakStatement: 'break', ThrowStatement: 'throw',
    ASTNode: 'AST Nodes', Spec: 'Spec Diagrams',
};

export function displayNameForLabel(label) {
    return DISPLAY_NAMES[label] || label;
}

// Typen, die beim ersten Laden AUS sind. Das ist keine Geschmacksfrage,
// sondern eine über die Knotenzahl: beide bringen so viele Knoten mit, dass sie
// das Budget an sich ziehen und der Rest des Graphen verschwindet.
//
// Die Liste muss mit `hiddenTypes` in server/bridge.js übereinstimmen —
// widersprechen sich die beiden, kostet jeder Seitenaufruf einen vollen
// Reload, nur um den Server zu korrigieren.
export const DEFAULT_OFF = ['Spec', 'ASTNode'];
