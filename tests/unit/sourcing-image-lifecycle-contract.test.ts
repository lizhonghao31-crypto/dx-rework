import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("sourcing image lifecycle parity", () => {
  it("uses one role-aware audited endpoint without moving the workflow", async () => {
    const [contract, routes, service] = await Promise.all([
      readFile("packages/contracts/src/sourcing.ts", "utf8"),
      readFile("apps/api/src/sourcing/sourcing-routes.ts", "utf8"),
      readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8"),
    ]);
    expect(contract).toContain("SOURCING_IMAGE_SUPPLEMENT_ROLES");
    expect(contract).toContain("SupplementSourcingImagesSchema");
    expect(routes).toContain("/sourcing/cases/:sourcingCaseId/supplemental-images");
    expect(routes).toContain('authorizationCapability: "tools:user"');
    expect(service).toContain('scope = "sourcing.attachments.supplement"');
    expect(service).toContain('action: "sourcing.attachments.supplement"');
    expect(service).toContain("uploaded_by=$2");
    expect(service).toContain("entity_type IS NULL AND entity_id IS NULL");
    expect(service).toContain("MAX_SOURCING_ATTACHMENTS");
    const supplement = service.slice(service.indexOf("async supplementImages"), service.indexOf("async listTimeline"));
    expect(supplement).not.toContain("sourcing_case_transitions");
  });

  it("binds create and supplement images only through matching immutable audit evidence", async () => {
    const [migration, manifest, service] = await Promise.all([
      readFile("apps/api/migrations/0125_sourcing_image_supplement.sql", "utf8"),
      readFile("apps/api/src/platform/migration-manifest.json", "utf8"),
      readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8"),
    ]);
    expect(migration).toContain("guard_sourcing_attachment_binding");
    expect(migration).toContain("bound sourcing evidence is immutable");
    expect(migration).toContain("event.after_state->'attachmentIds'");
    expect(migration).toContain("event.actor_id=NEW.uploaded_by");
    expect(migration).toContain("event.action='sourcing.case.create'");
    expect(migration).toContain("event.action='sourcing.attachments.supplement'");
    expect(manifest).toContain('"0125_sourcing_image_supplement"');
    expect(service).toContain("dx_rework.sourcing_event_id");
    expect(service).toContain("dx_rework.sourcing_request_id");
  });

  it("reuses the same resilient image pipeline for create and both supplement entry points", async () => {
    const [page, sourcingUploader, reworkUploader] = await Promise.all([
      readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8"),
      readFile("apps/web/src/sourcing-image-supplement-uploader.tsx", "utf8"),
      readFile("apps/web/src/order-image-supplement-uploader.tsx", "utf8"),
    ]);
    for (const source of [page, sourcingUploader, reworkUploader]) {
      expect(source).toContain("isImageUploadCandidate");
      expect(source).toContain("prepareImageUploadCandidate");
      expect(source).toContain("uploadImageWithNormalizationRetry");
      expect(source).toContain("measureAttachmentUploadStage");
      expect(source).toContain('accept="image/*"');
    }
    expect(page).toContain("<SourcingImageSupplementUploader");
    expect(page).toContain("currentAttachmentCount={attachments.length}");
  });

  it("restores local create drafts and blocks sourcing mobile deep links without building mobile UI", async () => {
    const page = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(page).toContain("LOCAL_SOURCING_DRAFT_KEY");
    expect(page).toContain("readLocalSourcingDraft");
    expect(page).toContain("clearLocalSourcingDraft");
    expect(page).toContain("保存草稿");
    expect(page).toContain('window.matchMedia("(max-width: 800px)")');
    expect(page).toContain("报价选厂移动端尚未建设");
  });
});
