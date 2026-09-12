'use strict';

const crypto = require('node:crypto');

const ANNOTATION_STATUSES = new Set(['proposed', 'accepted', 'rejected']);
const SOURCE_KINDS = new Set(['llm', 'human', 'import']);

function boundedScore(value, fallback, field) {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 1) {
        const error = new Error(`${field} must be a number between 0 and 1`);
        error.code = 'INVALID_ANNOTATION';
        throw error;
    }
    return number;
}

function normalizeInput(input = {}) {
    const targetUid = typeof input.targetNode === 'string' && input.targetNode.trim()
        ? input.targetNode : null;
    const tag = String(input.tag || '').trim().toLowerCase();
    const evidence = String(input.evidence || '').trim();
    const sourceKind = SOURCE_KINDS.has(input.sourceKind) ? input.sourceKind : 'llm';
    if (!targetUid) throw Object.assign(new Error('targetNode is required'), { code: 'INVALID_ANNOTATION' });
    if (!tag || tag.length > 80 || !/^[a-z0-9][a-z0-9._:/-]*$/.test(tag)) {
        throw Object.assign(new Error('tag must be 1-80 lowercase letters, numbers, dot, underscore, colon, slash or dash'), { code: 'INVALID_ANNOTATION' });
    }
    if (evidence.length < 3 || evidence.length > 2000) {
        throw Object.assign(new Error('evidence must contain 3-2000 characters'), { code: 'INVALID_ANNOTATION' });
    }
    return {
        targetUid,
        tag,
        evidence,
        sourceKind,
        confidence: boundedScore(input.confidence, 0.5, 'confidence'),
        weight: boundedScore(input.weight, 0.5, 'weight'),
        model: String(input.model || '').trim().slice(0, 160) || null,
        createdBy: String(input.createdBy || input.model || sourceKind).trim().slice(0, 160),
    };
}

function row(record) {
    const number = (key) => {
        const value = record.get(key);
        return value?.toNumber?.() ?? value ?? null;
    };
    return {
        id: String(record.get('id')),
        annotationId: record.get('annotationId'),
        targetNode: record.get('targetUid'),
        targetName: record.get('targetName') || null,
        targetFile: record.get('targetFile') || null,
        targetMissing: record.get('resolvedTargetUid') === null,
        tag: record.get('tag'),
        evidence: record.get('evidence'),
        confidence: number('confidence'),
        weight: number('weight'),
        sourceKind: record.get('sourceKind'),
        model: record.get('model') || null,
        status: record.get('status'),
        createdBy: record.get('createdBy'),
        createdAt: number('createdAt'),
        updatedAt: number('updatedAt'),
    };
}

const RETURN_FIELDS = `elementId(a) AS id, a.annotationId AS annotationId,
    a.targetUid AS targetUid, elementId(target) AS resolvedTargetUid,
    target.name AS targetName, target.file AS targetFile,
    a.tag AS tag, a.evidence AS evidence, a.confidence AS confidence,
    a.weight AS weight, a.sourceKind AS sourceKind, a.model AS model,
    a.status AS status, a.createdBy AS createdBy,
    a.createdAt AS createdAt, a.updatedAt AS updatedAt`;

async function createAnnotation(session, input) {
    const data = normalizeInput(input);
    const annotationId = `annotation-${crypto.randomUUID()}`;
    const uid = `Annotation||id=${annotationId}`;
    const result = await session.run(`
        MATCH (target) WHERE elementId(target) = $targetUid
        CREATE (a:Annotation {
            uid: $uid, annotationId: $annotationId, name: $tag, tag: $tag,
            evidence: $evidence, confidence: $confidence, weight: $weight,
            sourceKind: $sourceKind, model: $model, targetUid: $targetUid,
            status: 'proposed', createdBy: $createdBy,
            createdAt: timestamp(), updatedAt: timestamp()
        })
        CREATE (a)-[:ANNOTATES]->(target)
        RETURN ${RETURN_FIELDS}
    `, { ...data, uid, annotationId });
    if (!result.records.length) {
        const error = new Error(`Annotation target not found: ${data.targetUid}`);
        error.code = 'NODE_NOT_FOUND';
        throw error;
    }
    return row(result.records[0]);
}

async function listAnnotations(session, input = {}) {
    const targetNode = typeof input.targetNode === 'string' && input.targetNode.trim()
        ? input.targetNode : null;
    const status = ANNOTATION_STATUSES.has(input.status) ? input.status : null;
    const limit = Math.max(1, Math.min(500, Math.floor(Number(input.limit) || 100)));
    const result = await session.run(`
        MATCH (a:Annotation)
        WHERE ($targetUid IS NULL OR a.targetUid = $targetUid)
          AND ($status IS NULL OR a.status = $status)
        OPTIONAL MATCH (a)-[:ANNOTATES]->(target)
        RETURN ${RETURN_FIELDS}
        ORDER BY a.updatedAt DESC
        LIMIT ${limit}
    `, { targetUid: targetNode, status });
    return result.records.map(row);
}

async function updateAnnotationStatus(session, annotationId, status, updatedBy = 'user') {
    if (!ANNOTATION_STATUSES.has(status)) {
        const error = new Error(`status must be one of: ${[...ANNOTATION_STATUSES].join(', ')}`);
        error.code = 'INVALID_ANNOTATION';
        throw error;
    }
    const result = await session.run(`
        MATCH (a:Annotation {annotationId: $annotationId})
        SET a.status = $status, a.updatedBy = $updatedBy, a.updatedAt = timestamp()
        WITH a
        OPTIONAL MATCH (a)-[:ANNOTATES]->(target)
        RETURN ${RETURN_FIELDS}
    `, { annotationId: String(annotationId), status, updatedBy: String(updatedBy || 'user') });
    if (!result.records.length) {
        const error = new Error(`Annotation not found: ${annotationId}`);
        error.code = 'ANNOTATION_NOT_FOUND';
        throw error;
    }
    return row(result.records[0]);
}

async function relinkAnnotations(session) {
    const result = await session.run(`
        MATCH (a:Annotation), (target)
        WHERE a.targetUid IS NOT NULL AND elementId(target) = a.targetUid
        MERGE (a)-[:ANNOTATES]->(target)
        RETURN count(a) AS linked
    `);
    return result.records[0]?.get('linked')?.toNumber?.()
        ?? Number(result.records[0]?.get('linked') || 0);
}

module.exports = {
    ANNOTATION_STATUSES,
    createAnnotation,
    listAnnotations,
    normalizeInput,
    relinkAnnotations,
    updateAnnotationStatus,
};
