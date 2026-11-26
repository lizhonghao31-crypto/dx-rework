import { normalizeSourcingContractSnapshotImages, renderSourcingContractPdf, type ContractPdfSnapshot } from "./sourcing-contract-pdf.js";

// Only the already-resolved snapshot travels across IPC. This child never
// connects to PostgreSQL or object storage.
process.once("message", async (snapshot: ContractPdfSnapshot) => {
  try {
    process.send?.({ pdf: await renderSourcingContractPdf(await normalizeSourcingContractSnapshotImages(snapshot)) });
  } catch {
    process.send?.({ failed: true });
  } finally {
    process.disconnect?.();
  }
});
