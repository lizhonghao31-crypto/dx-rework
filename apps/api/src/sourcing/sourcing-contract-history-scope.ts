/** Explicit business-approved historical scope. No date/style-number expansion. */
export const contractHistoryBaselines = Object.freeze([
  { caseId: "46983c93-bb0c-4a28-b23c-4531feb4ad41", documentId: "14cdb30d-d148-4cd7-a9ac-6b65be5f61d0", version: 2 },
  { caseId: "cb942dbe-d6b2-43b2-9f48-3933566b7cf0", documentId: "1e4c3ec5-d2ec-4404-aa7f-fef33262ac3c", version: 3 },
  { caseId: "edfb86e9-9206-419d-8faf-ca11cb7c88ac", documentId: "aff97855-53bc-4692-9c9b-b925fa80ebff", version: 3 },
]);

export function contractHistoryBaseline(caseId: string) {
  return contractHistoryBaselines.find(item => item.caseId === caseId);
}
