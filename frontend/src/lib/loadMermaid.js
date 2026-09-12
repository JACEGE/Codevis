/**
 * Der eine Mermaid-Ladepfad der App.
 *
 * Vorher gab es zwei: ClassDiagramTab hatte einen memoisierten Singleton,
 * RosTab importierte inline in jedem Effect und rief `mermaid.initialize()` bei
 * jedem Render erneut auf — genau das, wovor der Kommentar im anderen Tab
 * warnte. initialize() setzt Mermaids interne Registry zurück; ein Render, der
 * gerade läuft, kommt danach leer zurück.
 *
 * Warum überhaupt dynamisch: Mermaid zieht cytoscape, katex und pro Diagrammtyp
 * einen Renderer nach. Statisch importiert landet das im Hauptbundle und wird
 * von jedem geladen, der diese Tabs nie öffnet.
 */

let mermaidPromise = null;

/**
 * Frontmatter zählt nur ganz vorne.
 *
 * Die Generatoren schreiben `---\ntitle: …\n---` in die ersten drei Zeilen.
 * Mermaid sucht diesen Block mit einem an den Textanfang gebundenen Ausdruck —
 * derselbe wie hier. Steht etwas davor, und sei es eine einzige Direktive, wird
 * der Block nicht mehr als Frontmatter erkannt: die drei Striche bleiben im
 * Diagrammtext stehen, `classDiagram` ist nicht mehr das erste Wort, und die
 * Typerkennung scheitert. Das trifft dann JEDES Diagramm, auch ein völlig
 * korrektes.
 */
const FRONT_MATTER = /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/s;

/**
 * Setzt eine Theme-Direktive so in die Quelle, dass ein vorhandener
 * Frontmatter-Block vorne stehen bleibt.
 */
export function withMermaidTheme(source, theme) {
    const directive = `%%{init: {'theme':'${theme}'}}%%\n`;
    const m = FRONT_MATTER.exec(source);
    if (!m) return directive + source;
    return source.slice(0, m[0].length) + directive + source.slice(m[0].length);
}

/**
 * Ein Chunk-Ladefehler ist KEIN Diagrammfehler.
 *
 * Nach einem Rebuild trägt der Mermaid-Chunk einen neuen Hash. Ein Tab, der
 * über den Build hinweg offen war, fordert den alten an und bekommt ihn nicht
 * mehr. Bisher landete die rohe Browsermeldung im Fehlertext des Tabs — das
 * liest sich wie ein kaputtes Diagramm, obwohl nur die Seite veraltet ist.
 * Deshalb wird der Fall markiert, damit die Tabs "neu laden" anbieten können
 * statt eine Bibliotheksmeldung zu zeigen.
 */
const CHUNK_LOAD_PATTERNS = [
    /Failed to fetch dynamically imported module/i,
    /Importing a module script failed/i,
    /error loading dynamically imported module/i,
];

export function isChunkLoadError(err) {
    if (!err) return false;
    if (err.code === 'CHUNK_LOAD_ERROR') return true;
    const msg = String(err.message || err);
    return CHUNK_LOAD_PATTERNS.some((re) => re.test(msg));
}

export default function loadMermaid() {
    if (!mermaidPromise) {
        mermaidPromise = import('mermaid')
            .then((mod) => {
                const mermaid = mod.default;
                // Genau einmal. Beide Tabs teilen sich diese Konfiguration;
                // maxTextSize stammt aus RosTab, dessen Architekturdiagramme
                // den Standardwert reissen.
                mermaid.initialize({
                    startOnLoad: false,
                    theme: 'dark',
                    securityLevel: 'strict',
                    maxTextSize: 500000,
                    class: { useMaxWidth: false },
                    /**
                     * Keine Bomben-Grafik.
                     *
                     * Beide Tabs rufen render() ohne Zielelement auf, also legt
                     * Mermaid sich ein temporäres <div> an document.body. Bei
                     * einem Parse-Fehler zeichnet es dort sein Fehlerdiagramm —
                     * die Bombe — und wirft, BEVOR es aufräumt. Das Ding bleibt
                     * also am Seitenende hängen, pro Fehlversuch eines mehr,
                     * außerhalb jedes React-Baums. Mit dieser Option räumt
                     * Mermaid auf und wirft nur; die Tabs zeigen den Fehler
                     * selbst an, an der Stelle, an der er hingehört.
                     */
                    suppressErrorRendering: true,
                });
                return mermaid;
            })
            .catch((err) => {
                // Den fehlgeschlagenen Versuch NICHT zwischenspeichern — sonst
                // scheitert jeder spätere Aufruf an derselben alten Ablehnung,
                // auch wenn der Chunk inzwischen wieder erreichbar wäre.
                mermaidPromise = null;
                if (isChunkLoadError(err)) {
                    const e = new Error('The app has been rebuilt — this page is still running the old build.');
                    e.code = 'CHUNK_LOAD_ERROR';
                    e.cause = err;
                    throw e;
                }
                throw err;
            });
    }
    return mermaidPromise;
}
