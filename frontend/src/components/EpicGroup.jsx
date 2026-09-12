/**
 * Ein Epic als Gruppe INNERHALB einer Kanban-Spalte.
 *
 * Der Epic erscheint in jeder Spalte, in der er mindestens einen Task liegen
 * hat — jedes Mal mit demselben Kopf, aber nur mit den Tasks dieses Status.
 * Damit IST die Spalte der Status: die Karten drin brauchen kein eigenes
 * Status-Badge, und eine Karte von der einen Epic-Gruppe in die andere zu
 * ziehen ändert ihren Status, ohne die Zugehörigkeit anzufassen.
 *
 * Die Alternative wäre ein Container außerhalb der Spalten gewesen. Der
 * verdrängt das Board: vier Epics als volle Zeilen schoben die Status-Spalten
 * nach unten aus dem Bild. Epics bündeln — sie sind kein zweites Board.
 *
 * Karten werden als children hereingereicht, damit sie EXAKT dieselbe
 * Task-Karte sind wie außerhalb der Gruppe. Eine zweite Kartenvariante hier
 * wäre binnen zweier Änderungen von der echten abgewichen.
 */
export default function EpicGroup({
    group,
    epic,
    accent,
    collapsed,
    onToggle,
    onDropTask,
    onMoveEpic,
    onOpenEpic,
    // Alle Tasks des Epics, spaltenübergreifend — nicht nur die in dieser Gruppe.
    epicTaskIds = [],
    allSelected = false,
    someSelected = false,
    onToggleSelection,
    draggedTask,
    draggedEpicId,
    onEpicDragStart,
    onEpicDragEnd,
    children,
}) {
    // Ein Task, der schon in dieser Gruppe steckt, ist kein Neuzugang — sonst
    // würde jedes Ziehen innerhalb derselben Spalte ein Schreiben auslösen.
    const isForeign = draggedTask && !group.taskIds.includes(draggedTask.taskId);
    const isDraggingThisEpic = draggedEpicId === group.epicId;

    return (
        <div
            style={{
                border: `1px solid ${accent}`,
                borderLeft: `3px solid ${accent}`,
                borderRadius: 6,
                background: accent + '10',
                padding: 4,
                marginBottom: 6,
                opacity: isDraggingThisEpic ? 0.4 : 1,
            }}
            onDragOver={(e) => {
                if (!isForeign) return;
                // stopPropagation, sonst nimmt die Spalte darunter den Drop an
                // und der Task landet neben der Gruppe statt darin.
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(e) => {
                if (!isForeign) return;
                e.preventDefault();
                e.stopPropagation();
                const taskId = e.dataTransfer.getData('text/plain');
                if (taskId) onDropTask(taskId);
            }}
        >
            <div
                draggable
                onDragStart={(e) => {
                    onEpicDragStart(group.epicId);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', '');
                }}
                onDragEnd={onEpicDragEnd}
                // KEIN onDoubleClick zum Verschieben. Hier stand einmal eins —
                // und ein einzelner Klick auf den Kopf hat fünf Tasks von 'done'
                // zurück auf 'review' geschrieben, ohne Rueckfrage und ohne dass
                // man sah, was passiert. Eine Geste, die den Status eines ganzen
                // Blocks umschreibt, muss das Ziehen sein: sie hat ein sichtbares
                // Ziel und man kann sie unterwegs abbrechen.
                title="Dragging moves the whole epic, with all its tasks, to another column"
                style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    padding: '3px 4px', cursor: 'grab',
                }}
            >
                <button
                    onClick={(e) => { e.stopPropagation(); onToggle(group.epicId, !collapsed); }}
                    style={{
                        border: 'none', background: 'transparent', cursor: 'pointer',
                        fontSize: 10, color: '#6b7394', padding: 0, width: 12,
                    }}
                >{collapsed ? '▸' : '▾'}</button>
                {/* Waehlt ALLE Tasks des Epics aus, auch die in anderen Spalten —
                    sonst muesste man den Epic spaltenweise zusammenklicken, um ihn
                    als Ganzes zu verschieben. Die Bulk-Leiste oben uebernimmt dann
                    den Rest. Indeterminate geht in React nur imperativ ueber ref. */}
                {epicTaskIds.length > 0 && (
                    <input
                        type="checkbox"
                        checked={allSelected}
                        ref={el => { if (el) el.indeterminate = someSelected; }}
                        onChange={() => onToggleSelection(epicTaskIds)}
                        onClick={e => e.stopPropagation()}
                        title={allSelected
                            ? `Clear selection (${epicTaskIds.length} tasks)`
                            : `Select all ${epicTaskIds.length} tasks in this epic`}
                        style={{ cursor: 'pointer', flexShrink: 0, margin: 0 }}
                    />
                )}
                <span style={{ color: accent, fontSize: 11, lineHeight: 1 }}>⬡</span>
                {/* Titel oeffnet die Epic-Detailansicht. Nur der Titel, nicht die
                    ganze Kopfzeile: die traegt das Ziehen, und ein Klick auf den
                    Klapppfeil oder den Zaehler soll nichts oeffnen. */}
                <span
                    onClick={(e) => { e.stopPropagation(); onOpenEpic(group.epicId); }}
                    title="Open epic"
                    style={{
                        flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, color: '#1a1a1a',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        cursor: 'pointer', textDecoration: 'underline',
                        textDecorationColor: accent, textUnderlineOffset: 2,
                    }}
                >{epic ? epic.title : group.epicTitle}</span>
                <span style={{
                    fontSize: 10, color: '#6b7394', fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                }}>
                    {/* Wie viele der Tasks HIER liegen, und wie viele das Epic
                        insgesamt hat — sonst liest sich "2" wie das ganze Epic. */}
                    {group.tasks.length}{epic?.progress ? ` / ${epic.progress.total}` : ''}
                </span>
            </div>

            {!collapsed && children}
        </div>
    );
}
