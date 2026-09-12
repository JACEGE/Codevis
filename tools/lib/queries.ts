/**
 * queries.ts — re-exports PREDEFINED_QUERIES from the shared CJS module.
 *
 * The canonical list lives in scripts/predefined-queries.cjs so that both
 * the MCP server (TypeScript, tsx) and the bridge (CommonJS) can require()
 * the same file. Having the data here as a TypeScript copy would mean two
 * lists that silently diverge whenever someone adds a query to one but not
 * the other.
 *
 * createRequire(import.meta.url) is the standard ESM way to call require()
 * from within an ES module. tsx supports this without any build step.
 */

import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PREDEFINED_QUERIES: _queries } = _require('../../scripts/predefined-queries.cjs') as {
    PREDEFINED_QUERIES: Array<{ name: string; description: string; query: string }>;
};

export const PREDEFINED_QUERIES: Array<{ name: string; description: string; query: string }> = _queries;
