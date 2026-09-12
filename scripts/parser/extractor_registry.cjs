"use strict";

const { validateExtractorConfig, describeExtractor } = require("./extractor_contract.cjs");

function createExtractorRegistry(backing = {}) {
    const configs = backing;
    for (const config of new Set(Object.values(configs))) Object.freeze(config);
    const register = (extension, config, { aliases = [], replace = false } = {}) => {
        const errors = validateExtractorConfig(extension, config);
        if (errors.length) {
            const error = new Error(`Invalid CodeVis extractor configuration:\n- ${errors.join("\n- ")}`);
            error.code = "INVALID_EXTRACTOR_CONFIG"; error.validationErrors = errors; throw error;
        }
        if (configs[extension] && !replace) throw new Error(`Extractor '${extension}' is already registered.`);
        configs[extension] = Object.freeze({ ...config });
        for (const alias of aliases) {
            if (!/^\.[a-z0-9]+$/i.test(alias)) throw new Error(`Invalid extractor alias '${alias}'.`);
            if (configs[alias] && !replace) throw new Error(`Extractor alias '${alias}' is already registered.`);
            configs[alias] = configs[extension];
        }
        return configs[extension];
    };
    const get = (extension) => configs[extension] || null;
    const extensions = () => Object.keys(configs).sort();
    const capabilities = () => Object.fromEntries(extensions().map((extension) => [extension, describeExtractor(extension, configs[extension])]));
    return Object.freeze({ register, get, extensions, capabilities });
}

module.exports = { createExtractorRegistry };
