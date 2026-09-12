/**
 * rowIdentity — welche Werte einer Abfragezeile einen Knoten adressieren.
 *
 * Eigenes Modul (und nicht mehr in ExploreTab.jsx), weil genau hier ein Fehler
 * nichts kaputtmacht, sondern nur still weniger anzeigt: eine unerkannte
 * Identität heißt „not representable" — die Zeile steht da, der Knopf „Show"
 * fehlt, und der Abfragegraph bleibt leer. Als reines JS ist es aus
 * tests/explore-row-identity.test.js heraus prüfbar; .jsx kann node:test nicht
 * laden.
 */

// Eine ausgeschriebene CodeVis-Identität: acht Hex-Gruppen. Über den WERT
// erkannt, nicht über den Spaltennamen, damit `RETURN a.ipv6 AS caller,
// b.ipv6 AS callee` beide Enden der Beziehung auf den Schirm bringt. Nur die
// Spalte namens `ipv6` zu lesen war der Grund, warum eine Kantenabfrage einen
// Endpunkt zeichnete und keine Kante.
export const IPV6_RE = /^[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){7}$/i;

// Eine uid — `elementId(n)` — ist der Primärschlüssel und adressiert damit
// genau einen Knoten. ipv6 kollidiert: derselbe Wert benennt ein Dutzend
// Knoten in fremden Verzeichnissen, und eine darauf gestützte Abfrage zieht
// sie alle mit.
//
// Es gibt ZWEI Formen, und nur die erste zu kennen war ein stiller, breiter
// Fehler. Was der Builder schreibt, leitet seine uid aus Label und
// Merge-Schlüsseln ab: `File||path=src/app.py`. Alles zur Laufzeit Angelegte —
// Task, Idea, Epic, Knowledge und jeder Spec*-Knoten — bekommt sie dagegen aus
// dem CREATE-Pfad: Präfix plus Sequenznummer, `task:259`, `specmethod:5538`.
// Gemessen: eine Abfrage auf einen SpecMethod lieferte ihre Zeile und meldete
// sie im selben Atemzug als nicht darstellbar.
export const UID_RE = /^[A-Za-z0-9_]+\|\|/;
export const UID_SEQ_RE = /^[a-z][a-z0-9_]*:\d+$/;

// Spalten, die eine Identität SIND, wie der Wert auch aussieht. Eine dritte
// uid-Form würde sonst dasselbe Loch neu aufreissen; die Abfrage zu fragen,
// wie sie die Spalte genannt hat, veraltet nicht.
export const ID_COLUMNS = new Set(['uid', 'uids', 'elementid', 'nodeid']);

/** Jede Identität einer Zeile, aus jeder Spalte, auch aus collect()-Listen. */
export function rowKeys(row) {
    const ipv6s = [];
    const uids = [];
    for (const [column, value] of Object.entries(row || {})) {
        const named = ID_COLUMNS.has(String(column).toLowerCase());
        const candidates = Array.isArray(value) ? value : [value];
        for (const c of candidates) {
            if (typeof c !== 'string') continue;
            // uids gehen unverändert durch — ein Knoten, der nach einem
            // Ausdruck benannt ist, darf auf ein Leerzeichen enden, und es
            // wegzuschneiden löst nichts.
            if (IPV6_RE.test(c.trim())) ipv6s.push(c.trim());
            else if (named || UID_RE.test(c) || UID_SEQ_RE.test(c)) uids.push(c);
        }
    }
    return { ipv6s, uids };
}

/** Beide Schlüsselarten in einer Liste — für „steht diese Zeile im Bild?". */
export function rowIpv6s(row) {
    const { ipv6s, uids } = rowKeys(row);
    return [...uids, ...ipv6s];
}
