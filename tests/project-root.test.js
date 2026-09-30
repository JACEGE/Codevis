const assert = require("node:assert/strict");
const path = require("node:path");
const { after, it } = require("node:test");
require("../lib/tsx-userinfo-preload.cjs");
const { register } = require("tsx/cjs/api");

const unregister = register();
after(() => unregister());

// Handlers fell back to the CodeVis package directory when CODEVIS_PROJECT_DIR
// was unset, so edits and backups landed in the install instead of the project.
it("tool handlers resolve the project like codevis-paths, never the package", () => {
    const { projectRoot } = require("../tools/lib/project-root.ts");
    const paths = require("../server/codevis-paths.cjs");
    const previous = process.env.CODEVIS_PROJECT_DIR;
    try {
        delete process.env.CODEVIS_PROJECT_DIR;
        assert.equal(projectRoot(), paths.PROJECT_ROOT);
        process.env.CODEVIS_PROJECT_DIR = path.resolve("/somewhere/project");
        assert.equal(projectRoot(), path.resolve("/somewhere/project"));
    } finally {
        if (previous === undefined) delete process.env.CODEVIS_PROJECT_DIR;
        else process.env.CODEVIS_PROJECT_DIR = previous;
    }
});
