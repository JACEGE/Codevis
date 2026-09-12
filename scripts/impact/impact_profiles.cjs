"use strict";

const { DEFAULT_RELATIONS } = require("./impact_service.cjs");

const PROFILES = Object.freeze({
    fast: Object.freeze({
        description: "Immediate dependants for interactive use on large graphs.",
        direction: "in", depth: 1, maxNodes: 100, maxPathsPerNode: 1,
        relations: Object.freeze(["CALLS", "CALLS_CONDITIONALLY", "PASSES_CALLBACK", "RENDERS", "AFFECTS", "APPLIES_TO", "REALIZED_BY"]),
    }),
    balanced: Object.freeze({
        description: "Default review radius with multiple evidence paths.",
        direction: "in", depth: 2, maxNodes: 200, maxPathsPerNode: 3,
        relations: DEFAULT_RELATIONS,
    }),
    deep: Object.freeze({
        description: "Broader architecture review; slower and more likely to truncate.",
        direction: "both", depth: 4, maxNodes: 1000, maxPathsPerNode: 5,
        relations: DEFAULT_RELATIONS,
    }),
});

function resolveImpactOptions(options = {}) {
    const profileName = options.profile || "balanced";
    const profile = PROFILES[profileName];
    if (!profile) throw new Error(`Unknown impact profile '${profileName}'. Use fast, balanced, or deep.`);
    const resolved = { ...profile, ...options, profile: profileName };
    resolved.relations = [...(options.relations || profile.relations)];
    delete resolved.description;
    return resolved;
}

module.exports = { PROFILES, resolveImpactOptions };
