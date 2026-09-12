/**
 * Where the bridge lives.
 *
 * In production the bridge *serves this bundle*, so its API and socket are on
 * the same origin by definition — whatever host/port that particular bridge was
 * started on. Hardcoding :4000 (as every component used to) breaks the moment a
 * second project runs its own dashboard: project B's UI would talk to project
 * A's bridge and silently show A's graph.
 *
 * In dev the Vite server (:5173) is a different origin from the bridge, so it
 * has to be told where the bridge is. That value is NOT a constant: the port is
 * derived from the project path, so it differs per project (4362 here, not
 * 4000). vite.config.js sets VITE_BRIDGE_URL from the very same
 * server/codevis-paths.cjs the bridge binds with, so the two cannot disagree.
 *
 * This line used to read 'http://localhost:4000' — directly below the comment
 * above warning against hardcoding exactly that. The dev dashboard therefore
 * could never reach the bridge and always showed a connection error, no matter
 * what was running. If you are tempted to inline a port here again, that is the
 * bug, not the fix.
 */
const BRIDGE_URL =
  import.meta.env.VITE_BRIDGE_URL ||
  window.location.origin;

export default BRIDGE_URL;
export { BRIDGE_URL };
