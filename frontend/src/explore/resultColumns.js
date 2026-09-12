const INTERNAL_COLUMNS = new Set(['uid', 'uids', 'id', 'nodeid', 'elementid', 'ipv6', 'ipv6s']);
const PRIMARY_COLUMNS = ['name', 'entrypoint', 'function', 'title', 'file', 'path'];

export function resultColumns(row, showIdentifiers = false) {
    const keys = Object.keys(row || {});
    const identifiers = keys.filter(key => INTERNAL_COLUMNS.has(key.toLowerCase()));
    const visible = keys.filter(key => !identifiers.includes(key));
    visible.sort((a, b) => {
        const rank = key => { const index = PRIMARY_COLUMNS.indexOf(key.toLowerCase()); return index < 0 ? PRIMARY_COLUMNS.length : index; };
        return rank(a) - rank(b);
    });
    return { columns: showIdentifiers || !visible.length ? [...visible, ...identifiers] : visible, hasIdentifiers: identifiers.length > 0 };
}
