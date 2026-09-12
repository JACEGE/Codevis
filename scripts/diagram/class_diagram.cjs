/**
 * class_diagram.cjs — the one entry point consumers use.
 *
 * Exists so the MCP handler and the bridge endpoint do not each re-implement
 * "read the model, then render it", and so a caller that needs two formats
 * (the bridge returns PlantUML *and* Mermaid in one response) reads the graph
 * once instead of twice.
 */

"use strict";

const { readClassModel } = require("./class_model.cjs");
const { renderClassDiagram } = require("./class_render.cjs");

/**
 * Read the class model and render it.
 * @returns {Promise<{diagram: string, stats: object, model: object}>}
 */
async function generateClassDiagram(session, opts = {}) {
    const model = await readClassModel(session, opts);
    return { diagram: renderClassDiagram(model, opts), stats: model.stats, model };
}

module.exports = { readClassModel, renderClassDiagram, generateClassDiagram };
