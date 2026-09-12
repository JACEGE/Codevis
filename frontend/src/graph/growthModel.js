export function partitionVisibleLinks(links, visibleNodeIds) {
    const visible = [];
    const pending = [];
    for (const link of links) {
        const source = link.source?.id ?? link.source;
        const target = link.target?.id ?? link.target;
        if (visibleNodeIds.has(source) && visibleNodeIds.has(target)) visible.push(link);
        else pending.push(link);
    }
    return { visible, pending };
}
