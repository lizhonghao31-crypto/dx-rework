import { expect, it } from 'vitest';
import { slaNotificationWindow } from '../../apps/api/src/production-platform/sla-notification-window.js';
it('keeps the same native window across new configuration references and preserves distinct batches', () => {
    const original = { entered_at: '2026-10-26T00:00:00Z', sla_basis: { snapshotId: 'old', seconds: 3600, basis: ['physical-batch-a'] } };
    expect(slaNotificationWindow(original)).toBe(slaNotificationWindow({ ...original, sla_basis: { ...original.sla_basis, snapshotId: 'new', seconds: 7200 } }));
    expect(slaNotificationWindow(original)).not.toBe(slaNotificationWindow({ ...original, sla_basis: { basis: ['physical-batch-b'] } }));
    expect(slaNotificationWindow(original)).not.toBe(slaNotificationWindow({ ...original, entered_at: '2026-10-26T01:00:00Z' }));
});
it('changes the ship-sample window only when the remaining PO scope changes, not its configured offset', () => {
    const before = { entered_at: null, sla_basis: { targets: [{ lineId: 'a', sent: false, dueAt: 'old' }, { lineId: 'b', sent: false, dueAt: 'old' }] } };
    expect(slaNotificationWindow(before)).toBe(slaNotificationWindow({ entered_at: null, sla_basis: { targets: [{ lineId: 'b', sent: false, dueAt: 'new' }, { lineId: 'a', sent: false, dueAt: 'new' }] } }));
    expect(slaNotificationWindow(before)).not.toBe(slaNotificationWindow({ entered_at: null, sla_basis: { targets: [{ lineId: 'a', sent: true }, { lineId: 'b', sent: false }] } }));
});
