export function applyOptimisticUpdate(updates, previous, patch, operation) {
    const item = { ...previous, ...patch };
    updates.set(item, { previous, patch, operation });
    return item;
}

// Only objects created by this editor have a history. A replacement from the
// server is authoritative and must never be rolled back by an older request.
export function reconcileOptimisticUpdate(updates, item) {
    function resolve(current) {
        const update = updates.get(current);
        if (!update) return { item: current, pending: false };
        const previous = resolve(update.previous);
        if (update.operation.state === 'failed') return previous;
        const next = previous.item === update.previous ? current : { ...previous.item, ...update.patch };
        const pending = previous.pending || update.operation.state === 'pending';
        if (pending) updates.set(next, { ...update, previous: previous.item });
        else updates.delete(next);
        return { item: next, pending };
    }
    return resolve(item).item;
}
