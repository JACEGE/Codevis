import { createRequire } from "module";

const { normalizeWorkspaceName, publicWorkspaceName } = createRequire(import.meta.url)("../../lib/workspace-names.cjs");

/**
 * Structural stand-in for the driver surface `server/ladybug-driver.cjs`
 * implements. It replaces the `neo4j-driver` types, which are gone along with
 * the package — the compat client is the only backend.
 */
export interface GraphDriver {
    session(...args: any[]): any;
    close(): Promise<void>;
}

export interface WorkspaceConfig {
    sourceDir: string | string[];
    exclude?: string[];
    dbUri: string;
    /** Pre-rename name, still read so older generated configs keep working. */
    neo4jUri?: string;
    auth: { user: string; pass: string };
}

export interface ServerContext {
    targetDriver: GraphDriver;
    metaDriver: GraphDriver;
    targetWorkspace: WorkspaceConfig;
    metaWorkspace: WorkspaceConfig;
    /** Experimental graph locks are opt-in per project. */
    lockingEnabled: boolean;
    defaultAgentId?: string;
}

export type ToolHandler = (
    args: Record<string, any>,
    ctx: ServerContext
) => Promise<{ content: { type: string; text: string }[] }>;

export interface ToolModule {
    definitions: any[];
    handlers: Record<string, ToolHandler>;
}

/** Safely convert a driver Integer wrapper (or plain number) to a JS number. */
export function graphInt(val: any): number {
    if (val == null) return 0;
    if (typeof val.toNumber === "function") return val.toNumber();
    if (typeof val === "number") return val;
    return 0;
}

/**
 * Die MCP-Antworthuelle.
 *
 * Stand viermal wortgleich im Code (spec-, diagram-, ros- und idea-tools), und
 * in einer der vier hiess die Fehlervariante `fail` statt `err`. Genau so
 * überlebt eine Kopie ein Sammel-Refactoring: die Suche nach `function err`
 * findet drei Stellen, die vierte bleibt stehen und driftet.
 */
export function mcpOk(obj: any) {
    return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

export function mcpErr(message: string) {
    return { content: [{ type: "text", text: JSON.stringify({ status: "ERROR", error: message }) }], isError: true } as any;
}

/**
 * Welche der beiden Datenbanken ein Aufruf meint.
 *
 * Es gab drei Fassungen davon, und zwei trugen den Kommentar "Same db
 * resolution as the spec tools", ohne es zu sein: die Spec-Variante
 * kleinschreibt den Wert und akzeptiert `codevis` als oeffentlichen Namen für
 * die Meta-Datenbank, die anderen beiden nicht. `db: "Meta"` oder
 * `db: "codevis"` landete dort also in der ZIELdatenbank -- ohne Fehler, ohne
 * Hinweis, und beim Schreiben in der falschen.
 *
 * Der Standard unterscheidet sich bewusst und bleibt ein Parameter: Spec-Werk-
 * zeuge arbeiten am Projekt, ROS- und Diagramm-Werkzeuge an der Zieldatenbank.
 * Alles andere -- Kleinschreibung, akzeptierte Namen, Reihenfolge von Argument
 * und Umgebungsvariable -- ist jetzt für alle gleich.
 */
export function pickDbDriver(
    ctx: ServerContext,
    args: Record<string, any>,
    fallback: string = "project"
): GraphDriver {
    return pickDbName(args, fallback) === "codevis_db" ? ctx.metaDriver : ctx.targetDriver;
}

export function pickDbName(args: Record<string, any>, fallback: string = "project_db"): string {
    return publicWorkspaceName(normalizeWorkspaceName(args?.db || process.env.CODEVIS_SPEC_DB, fallback));
}
