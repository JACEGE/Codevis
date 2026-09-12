export function indexTasksByStatus(tasks, columnKeys, fallbackStatus = 'backlog') {
    const indexed = Object.fromEntries(columnKeys.map((key) => [key, []]));
    for (const task of tasks) {
        const bucket = indexed[task.status] || indexed[fallbackStatus];
        if (bucket) bucket.push(task);
    }
    return indexed;
}

export function groupTasksByEpic(tasks) {
    const free = [];
    const byEpic = new Map();

    for (const task of tasks) {
        if (!task.epicId) {
            free.push(task);
            continue;
        }
        if (!byEpic.has(task.epicId)) {
            byEpic.set(task.epicId, {
                epicId: task.epicId,
                epicTitle: task.epicTitle,
                tasks: [],
            });
        }
        byEpic.get(task.epicId).tasks.push(task);
    }

    const groups = [...byEpic.values()];
    for (const group of groups) {
        group.tasks.sort((a, b) => (a.seqIndex ?? Number.MAX_SAFE_INTEGER)
            - (b.seqIndex ?? Number.MAX_SAFE_INTEGER));
        group.taskIds = group.tasks.map((task) => task.taskId);
    }
    return { free, groups };
}

export function getEpicSelection(tasks, epicId, selectedTaskIds) {
    const ids = tasks.filter((task) => task.epicId === epicId).map((task) => task.taskId);
    const selectedCount = ids.filter((id) => selectedTaskIds.has(id)).length;
    return {
        all: ids.length > 0 && selectedCount === ids.length,
        some: selectedCount > 0 && selectedCount < ids.length,
    };
}
