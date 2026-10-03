import { createRequire } from "module";

const paths = createRequire(import.meta.url)("../../server/codevis-paths.cjs");

// The analysed project's root, resolved the same way everywhere: the same
// canonical spelling codevis-paths gives it (including Windows short paths).
// The variable is read on each call, so a test or a server that sets it after
// this module loaded still gets the right root; callers that keep the result
// in a module constant do not. Without it, codevis-paths searches upward from
// cwd for the project config. Falling back to the CodeVis package directory
// (as several handlers did) sent edits, backups and diagram output into the
// CodeVis install when the MCP server ran without CODEVIS_PROJECT_DIR.
export function projectRoot(): string {
    const fromEnv = process.env.CODEVIS_PROJECT_DIR;
    return fromEnv ? paths.canonicalize(fromEnv) : paths.PROJECT_ROOT;
}
