import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("N01 image and wage integrity", () => {
  it("requires a ready image in both the service and database transition", async () => {
    const [service, v2Submission, migration, castRepairMigration, form] = await Promise.all([
      readFile("apps/api/src/rework/service.ts", "utf8"),
      readFile("apps/api/src/rework/v2-submission-service.ts", "utf8"),
      readFile("apps/api/migrations/0068_n01_image_and_wage_integrity.sql", "utf8"),
      readFile("apps/api/migrations/0069_rework_image_submission_uuid_cast.sql", "utf8"),
      readFile("apps/web/src/rework-v2-form.tsx", "utf8"),
    ]);

    expect(service).toContain('"REWORK_IMAGE_REQUIRED"');
    expect(v2Submission).toContain('"REWORK_IMAGE_REQUIRED"');
    expect(v2Submission).toContain("至少上传 1 张验货或问题图片");
    expect(v2Submission).toContain("image/jpeg");
    expect(migration).toContain("guard_rework_submission_requires_image");
    expect(migration).toContain("attachment.status='ready'");
    expect(migration).toContain("attachment.mime_type IN ('image/jpeg','image/png','image/webp')");
    expect(castRepairMigration).toContain("guard_rework_submission_requires_image");
    expect(castRepairMigration).toContain("attachment.entity_id=NEW.rework_order_id::text");
    expect(form).toContain('accept="image/*"');
    expect(form).toContain("availableImageCount <= 0");
    expect(form).toContain("请至少上传 1 张返工报告图片。");
  });

  it("uses the N07 completion coefficient everywhere a temporary wage coefficient is displayed", async () => {
    const [review, wages, exportService, reports] = await Promise.all([
      readFile("apps/api/src/rework/whole-order-review-service.ts", "utf8"),
      readFile("apps/api/src/wages/wage-service.ts", "utf8"),
      readFile("apps/api/src/wages/wage-export-service.ts", "utf8"),
      readFile("apps/web/src/reporting/report-center-page.tsx", "utf8"),
    ]);

    expect(review).toContain("report.actual_quantity*item.unit_price*");
    expect(review).toContain("member.person_type_snapshot='temporary'");
    expect(review).not.toContain("rework_external_responsibility");
    expect(wages).toContain("rework_tail_completion_coefficients");
    expect(wages).not.toContain("rework_tail_temporary_wage_coefficients");
    expect(exportService).toContain("rework_tail_completion_coefficients");
    expect(exportService).not.toContain("rework_tail_temporary_wage_coefficients");
    expect(reports).toContain("snapshotBusinessValue = businessValue");
    expect(reports).not.toContain("Math.round(numeric)");
  });
});
