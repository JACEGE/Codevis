export function upsertById(items, item, key) {
  const index = items.findIndex((entry) => entry[key] === item[key]);
  if (index < 0) return [...items, item];
  return items.map((entry, i) => (i === index ? { ...entry, ...item } : entry));
}

export function removeById(items, id, key) {
  return items.filter((entry) => entry[key] !== id);
}

export function matchesWorkspace(event, db) {
  const aliases = { target: 'project_db', project: 'project_db', tool: 'project_db', meta: 'codevis_db', codevis: 'codevis_db' };
  return Boolean(event?.db) && (aliases[event.db] || event.db) === (aliases[db] || db);
}

let nextRequest = 0;
export function workspaceRequestId() { return `work-${++nextRequest}`; }
