import { createWebUrls } from "../url-contract.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

const needsSpreadsheetTextGuard = (value: string): boolean => {
  // Numeric business values are data, not formulas. Everything else with a
  // formula prefix (including whitespace/control bypasses) is literal text.
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value);
  const prefix = [...value].find(character => character.trim().length > 0 && character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127);
  return !numeric && ((prefix !== undefined && "=+-@".includes(prefix)) || /^[\t\r\n]/.test(value));
};

export const escapeCell = (value: string): string => {
  // Double original apostrophes so importing the spreadsheet text convention
  // can remove exactly one guard without renaming an existing business value.
  if (value.startsWith("'") || needsSpreadsheetTextGuard(value)) value = `'${value}`;
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
};

async function authorizeDataExport(): Promise<void> {
  const response = await fetch(apiUrl("access/data-export/authorize"), {
    method: "POST",
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("当前角色未获得数据导出授权");
}

const triggerCsvDownload = (
  filename: string,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): void => {
  const text = [headers, ...rows]
    .map((row) => row.map((cell) => escapeCell(String(cell ?? ""))).join(","))
    .join("\r\n");
  const blob = new Blob(["\uFEFF", text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
};

export function downloadCsv(filename: string, headers: readonly string[], rows: readonly (readonly string[])[]): void {
  const blankImportTemplate = rows.length === 0 && filename.endsWith("批量导入模板.csv");
  if (blankImportTemplate) {
    triggerCsvDownload(filename, headers, rows);
    return;
  }
  void authorizeDataExport()
    .then(() => triggerCsvDownload(filename, headers, rows))
    .catch((error: unknown) => {
      console.warn("Data export denied", error);
    });
}

export function parseCsv(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const pushCell = () => {
    const literal = cell.startsWith("''") || (cell.startsWith("'") && needsSpreadsheetTextGuard(cell.slice(1)))
      ? cell.slice(1)
      : cell;
    row.push(literal);
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    if (row.some((value) => value.trim().length > 0)) rows.push(row);
    row = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell.length === 0) {
      quoted = true;
      continue;
    }
    if (char === ",") {
      pushCell();
      continue;
    }
    if (char === "\n") {
      if (cell.endsWith("\r")) cell = cell.slice(0, -1);
      pushRow();
      continue;
    }
    cell += char;
  }

  if (cell.length > 0 || row.length > 0) pushRow();
  return rows;
}
