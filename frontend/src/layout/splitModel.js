export function parseSplit(value, fallback = 0.5) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0.1 && parsed < 0.95 ? parsed : fallback;
}

export function clampSplit(value) {
    return Math.min(0.9, Math.max(0.1, value));
}
