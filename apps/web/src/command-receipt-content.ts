import {
  applyInstructionSourceReview, InstructionDocumentSchema, InstructionDateRequestSchema,
  PublishInstructionSchema, ReviewInstructionSourceSchema, SaveInstructionSchema,
  type InstructionSheet,
} from '@dx-rework/contracts/production-instruction';

// Compare JSON facts without depending on object-key serialization order.
export function sameReceiptContent(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)])) : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Called only for a write acknowledgement. GET projections deliberately keep
 * their historical read compatibility and cannot confirm an unknown command. */
export function instructionCommandMatches(value: InstructionSheet, before: InstructionSheet,
  path: string, method: string, body: unknown): boolean {
  try {
    if (value.order.productionOrderId !== before.order.productionOrderId) return false;
    if (path === '' && method === 'PUT') {
      const input = SaveInstructionSchema.parse(body);
      return value.version === input.expectedVersion + 1 && value.order.version === input.orderVersion
        && value.sourceRound === before.sourceRound
        && sameReceiptContent(InstructionDocumentSchema.parse(value.document), input.document);
    }
    if (path === '/publish' && method === 'POST') {
      const input = PublishInstructionSchema.parse(body);
      return value.version === input.expectedVersion && value.publishedVersion === input.expectedVersion
        && value.versions.includes(input.expectedVersion) && value.order.version === input.orderVersion
        && value.sourceRound === before.sourceRound && sameReceiptContent(value.document, before.document);
    }
    if (path === '/source-review' && method === 'POST') {
      const input = ReviewInstructionSourceSchema.parse(body), comparison = before.sourceComparison;
      if (!comparison || input.sourceRound !== comparison.sourceRound || input.sourceVersion !== comparison.sourceVersion
        || value.version !== input.expectedVersion + 1 || value.order.version !== input.orderVersion
        || value.sourceRound !== input.sourceRound || value.sourceReview?.sourceRound !== input.sourceRound
        || value.sourceReview?.sourceVersion !== input.sourceVersion
        || value.sourceReview?.instructionVersion !== value.version
        || !sameReceiptContent(value.sourceReview.decisions, input.decisions)) return false;
      const expected = applyInstructionSourceReview(input.document, comparison.proposed, input.decisions, comparison.before);
      // The shared review function may generate fresh measurement row IDs for
      // collisions. Check their ordered substantive values, not random UUIDs.
      const facts = (document: typeof expected) => input.decisions.some(item => item.group === 'measurements' && item.action === 'adopt')
        ? { ...document, measurements: document.measurements.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id'))) } : document;
      return sameReceiptContent(facts(InstructionDocumentSchema.parse(value.document)), facts(expected));
    }
    if (path === '/date-requests' && method === 'POST') {
      const input = InstructionDateRequestSchema.parse(body);
      return value.dateRequests.some(request => request.source === 'po'
        && !before.dateRequests.some(old => old.requestId === request.requestId)
        && request.reason === input.reason && ['待批准', '已批准', '已驳回'].includes(request.status)
        && sameReceiptContent([...request.changes].map(({ lineId, expectedVersion, date }) => ({ lineId, expectedVersion, date })).sort((a,b) => a.lineId.localeCompare(b.lineId)),
          [...input.changes].sort((a,b) => a.lineId.localeCompare(b.lineId))));
    }
    const decision = path.match(/^\/date-requests\/([^/]+)\/decision$/);
    if (decision && method === 'POST' && typeof (body as { approved?: unknown })?.approved === 'boolean') {
      const approved = (body as { approved: boolean }).approved;
      const original = before.dateRequests.find(item => item.requestId === decision[1]);
      const saved = value.dateRequests.find(item => item.requestId === decision[1]);
      return Boolean(original && original.status === '待批准' && saved && saved.status === (approved ? '已批准' : '已驳回')
        && saved.decidedAt && Number.isFinite(Date.parse(saved.decidedAt))
        && saved.reason === original.reason && sameReceiptContent(saved.changes, original.changes)
        && (!approved || saved.changes.every(change => value.customerPoDates?.some(line => line.lineId === change.lineId
          && line.date === change.date && line.version === change.expectedVersion + 1))));
    }
    return false;
  } catch { return false; }
}
