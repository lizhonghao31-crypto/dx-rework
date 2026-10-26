/** Stable business-window identity: changing a standard is not another assignment or batch. */
export function slaNotificationWindow(row: {
    entered_at: Date | string | null;
    sla_basis?: unknown;
}) {
    const basis = row.sla_basis as {
        basis?: unknown;
        targets?: {
            lineId: string;
            sent: boolean;
        }[];
    } | null | undefined;
    return JSON.stringify([row.entered_at ? new Date(row.entered_at).toISOString() : null,
        basis?.basis ?? (basis?.targets ? basis.targets.filter(t => !t.sent).map(t => t.lineId).sort() : null)]);
}
