import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";

describe("development file selection survives asynchronous upload limits", () => {
  for (const [path, expected] of [
    ["development-document-fields.tsx", 1],
    ["digital-development-execution-panel.tsx", 2],
  ] as const) {
    it(path, async () => {
      const source = ts.createSourceFile(path, readFileSync(`apps/web/src/${path}`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const handlers: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "input") {
          const attributes = node.attributes.properties;
          const file = attributes.some(a => ts.isJsxAttribute(a) && a.name.getText(source) === "type" && a.initializer && ts.isStringLiteral(a.initializer) && a.initializer.text === "file");
          if (file) for (const a of attributes) {
            if (ts.isJsxAttribute(a) && a.name.getText(source) === "onChange" && a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression) handlers.push(a.initializer.expression.getText(source));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(handlers).toHaveLength(expected);
      for (const handler of handlers) {
        const first = new File(["png"], "style.png", { type: "image/png" });
        const second = new File(["pdf"], "craft.pdf", { type: "application/pdf" });
        const liveFiles = [first, second];
        const input = { files: liveFiles, set value(_value: string) { liveFiles.length = 0; } };
        let release!: () => void;
        const limits = new Promise<void>(resolve => { release = resolve; });
        const uploaded: File[] = [];
        let pending: Promise<void> | undefined;
        const upload = (files: ArrayLike<File>) => {
          pending = (async () => { await limits; uploaded.push(...Array.from(files)); })();
          return pending;
        };
        const onChange = new Function("upload", `return (${handler})`)(upload);
        onChange({ target: input, currentTarget: input });
        expect(liveFiles).toHaveLength(0);
        expect(uploaded).toHaveLength(0);
        release();
        await pending;
        expect(uploaded).toEqual([first, second]);
      }
    });
  }
});
