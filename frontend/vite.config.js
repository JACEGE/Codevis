import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { createRequire } from 'module';

// The bridge's port is DERIVED from the project path (4000 + hash), so it
// differs per project — for this one it is 4362, not 4000. In production the
// bridge serves this bundle and same-origin settles it, but the dev server is a
// different origin and has to be told. Take the number from the same module the
// bridge itself uses; deriving it a second time here is how it drifts.
const require = createRequire(import.meta.url);
const { BRIDGE_PORT, HOST } = require('../server/codevis-paths.cjs');

// Published as an env var rather than via `define`: Vite does NOT apply
// `define` substitutions to app source in dev (verified — the identifier comes
// through untouched, which would be a ReferenceError in the browser).
// VITE_-prefixed process.env entries are picked up by loadEnv and inlined into
// import.meta.env.
//
// SERVE ONLY. On `build` this must stay unset: the bridge serves the bundle
// itself, so production resolves to window.location.origin — whichever host and
// port that bridge happens to run on. Baking this machine's 4362 into the build
// would pin every deployment to this developer's port.
//
// An externally set VITE_BRIDGE_URL always wins, for pointing the UI at a
// bridge other than this project's.
export default defineConfig(({ command }) => {
    if (command === 'serve' && !process.env.VITE_BRIDGE_URL) {
        const host = HOST === '127.0.0.1' ? 'localhost' : HOST;
        process.env.VITE_BRIDGE_URL = `http://${host}:${BRIDGE_PORT}`;
    }
    return {
        plugins: [react()],
        resolve: {
            dedupe: ['three']
        },
        build: {
            rollupOptions: {
                output: {
                    manualChunks(id) {
                        const moduleId = id.replaceAll('\\', '/');
                        if (/\/node_modules\/(?:react|react-dom|scheduler)\//.test(moduleId)) return 'react-vendor';
                        if (moduleId.includes('/node_modules/three/')) return 'three-vendor';
                        if (/\/node_modules\/(?:react-force-graph-[23]d|force-graph|3d-force-graph|three-forcegraph|d3-force-3d|d3-quadtree|d3-dispatch|d3-timer|kapsule)\//.test(moduleId)) return 'graph-vendor';
                        if (/\/node_modules\/(?:socket\.io-client|engine\.io-client|socket\.io-parser|engine\.io-parser)\//.test(moduleId)) return 'realtime-vendor';
                        if (/\/node_modules\/(?:marked|dompurify)\//.test(moduleId)) return 'docs-vendor';
                    },
                },
            },
        },
        server: {
            port: 5173,
            open: true
        }
    };
});
