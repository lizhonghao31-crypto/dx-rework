import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import ts from "typescript";

describe("shared sample uploader submission contract", () => {
  it("requires every production uploader consumer to report unfinished files", async () => {
    let consumers = 0;
    for (const path of ["sample-create-page.tsx", "sample-workflow-page.tsx", "sample-disposal-page.tsx"]) {
      const source = await readFile(`apps/web/src/${path}`, "utf8");
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === "SampleImageUpload") {
          consumers += 1;
          expect(node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText(ast) === "onPending")).toBe(true);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(consumers).toBe(7);
  });

  it("keeps retry controls usable while guarding return, batch return and maintenance submits", async () => {
    const workflow = await readFile("apps/web/src/sample-workflow-page.tsx", "utf8");
    const disposal = await readFile("apps/web/src/sample-disposal-page.tsx", "utf8");
    expect(workflow).toContain("if(!data||action.busy||uploading||pendingUploads>0)return");
    expect(workflow).toContain("if(action.busy||uploading||pendingUploads>0)return");
    expect(disposal).toContain("if(action.busy||uploading||hasPendingUploads)return");
    expect(disposal).toContain('onPendingUpload("finance",count)');
    expect(disposal).toContain('onPendingUpload("proof",count)');
    expect(workflow).toContain("disabled={action.busy||uploading} onBusy={setUploading} onPending={setPendingUploads}");
    expect(disposal).toContain("disabled={action.busy||uploading} onBusy={onUploadBusy}");
  });
});
