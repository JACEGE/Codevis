"use strict";

const QUERY_FIELDS = Object.freeze([
    "funcQuery", "callQuery", "classQuery", "stateQuery", "returnQuery", "importQuery", "requireQuery",
    "jsxQuery", "jsxComponentQuery", "jsxPropQuery", "httpQuery", "hookEffectQuery", "classInheritanceQuery",
    "instantiationQuery", "aliasQuery", "callbackQuery", "conditionalCallQuery", "asyncChainQuery",
    "namedImportQuery", "namedExportQuery", "reactWrapperQuery", "jsxSpreadQuery", "useContextQuery",
    "controlFlowQuery", "statementQuery", "variableQuery", "astQuery", "attributeTypeQuery", "moduleAliasQuery",
    "decoratorQuery", "typeRefQuery", "rosTopicQuery", "rosInterfaceQuery", "rosNodeNameQuery",
]);
const ALLOWED_FIELDS = new Set(["wasm", "rosLang", ...QUERY_FIELDS]);

function describeExtractor(extension, config) {
    const capabilities = {};
    for (const field of QUERY_FIELDS) capabilities[field.replace(/Query$/, "")] = Boolean(config[field]);
    return { extension, wasm: config.wasm, capabilities };
}

function validateExtractorConfig(extension, config) {
    const errors = [];
    if (!/^\.[a-z0-9]+$/i.test(extension)) errors.push("extension must start with a dot and contain letters or digits");
    if (!config || typeof config !== "object" || Array.isArray(config)) return [`${extension}: configuration must be an object`];
    if (typeof config.wasm !== "string" || !config.wasm.trim()) errors.push("wasm must be a non-empty string");
    if (![config.astQuery, config.funcQuery, config.callQuery].some((query) => typeof query === "string" && query.trim())) {
        errors.push("at least one of astQuery, funcQuery, or callQuery must be non-empty");
    }
    for (const [key, value] of Object.entries(config)) {
        if (!ALLOWED_FIELDS.has(key)) errors.push(`unknown field '${key}'`);
        else if (QUERY_FIELDS.includes(key) && value != null && typeof value !== "string") errors.push(`${key} must be a string or null`);
    }
    return errors.map((error) => `${extension}: ${error}`);
}

function validateExtractorConfigs(configs) {
    const errors = [];
    const descriptions = {};
    for (const [extension, config] of Object.entries(configs || {})) {
        errors.push(...validateExtractorConfig(extension, config));
        descriptions[extension] = describeExtractor(extension, config || {});
    }
    if (errors.length) {
        const error = new Error(`Invalid CodeVis extractor configuration:\n- ${errors.join("\n- ")}`);
        error.code = "INVALID_EXTRACTOR_CONFIG";
        error.validationErrors = errors;
        throw error;
    }
    return descriptions;
}

module.exports = { ALLOWED_FIELDS, QUERY_FIELDS, describeExtractor, validateExtractorConfig, validateExtractorConfigs };
