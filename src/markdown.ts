const MARKDOWN_STYLE_MARKERS = {
  bold: { open: "**", close: "**" },
  italic: { open: "_", close: "_" },
  strikethrough: { open: "~~", close: "~~" },
  code: { open: "`", close: "`" },
  code_block: { open: "```\n", close: "```" },
};

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

type ProtectedBlock = { token: string; text: string };

function protectCodeBlocks(text: string): { text: string; blocks: ProtectedBlock[] } {
  const blocks: ProtectedBlock[] = [];
  const protectedText = text.replace(/(^|\n)(`{3,})([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, (match, prefix = "") => {
    const block = match.slice(String(prefix).length);
    const token = `___LMA_CB_${blocks.length}___`;
    blocks.push({ token, text: block });
    return `${prefix}${token}`;
  });
  return { text: protectedText, blocks };
}

function restoreCodeBlocks(text: string, blocks: ProtectedBlock[], cardVersion = 2): string {
  let restored = text;
  for (const { token, text: block } of blocks) {
    restored = restored.replace(token, cardVersion >= 2 ? `\n<br>\n${block}\n<br>\n` : block);
  }
  return restored;
}

function stripInvalidImageKeys(text: string): string {
  if (!text.includes("![")) return text;
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (String(value).startsWith("img_")) return fullMatch;
    return "";
  });
}

function optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  try {
    const protectedResult = protectCodeBlocks(text);
    let r = protectedResult.text;

    const hasH1toH3 = /^#{1,3} /m.test(text);
    if (hasH1toH3) {
      r = r.replace(/^#{2,6} (.+)$/gm, "##### $1");
      r = r.replace(/^# (.+)$/gm, "#### $1");
    }

    if (cardVersion >= 2) {
      r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, "$1\n<br>\n$2");
      r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, "$1\n\n$2");
      r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, "\n\n<br>\n\n$1");
      r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, (match, _table, offset) => {
        const after = r.slice(offset + match.length).replace(/^\n+/, "");
        if (!after || /^(---|#{4,5} |\*\*)/.test(after)) return match;
        return `${match}\n<br>\n`;
      });
      r = r.replace(/^((?!#{4,5} )(?!\*\*).+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n$3");
      r = r.replace(/^(\*\*.+)\n\n(<br>)\n\n(\|)/gm, "$1\n$2\n\n$3");
      r = r.replace(/(\|[^\n]*\n)\n(<br>\n)((?!#{4,5} )(?!\*\*))/gm, "$1$2$3");
    }

    r = restoreCodeBlocks(r, protectedResult.blocks, cardVersion);
    r = r.replace(/\n{3,}/g, "\n\n");
    return stripInvalidImageKeys(r);
  } catch {
    return text;
  }
}

function isMarkdownTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").length >= 2;
}

function splitMarkdownTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function formatTableAsCodeBlock(lines: string[]): string {
  const rows = lines.filter((line) => !isMarkdownTableSeparator(line)).map(splitMarkdownTableRow);
  if (rows.length === 0) return lines.join("\n");
  const width = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: width }, (_, i) => Math.max(...rows.map((row) => row[i]?.length ?? 0), 1));
  const renderedRows = rows.map((row, rowIndex) => {
    const rendered = widths.map((w, i) => (row[i] ?? "").padEnd(w)).join("  ").trimEnd();
    if (rowIndex === 0 && rows.length > 1) {
      const sep = widths.map((w) => "─".repeat(w)).join("  ");
      return `${rendered}\n${sep}`;
    }
    return rendered;
  });
  return `\n\`\`\`\n${renderedRows.join("\n")}\n\`\`\`\n`;
}

function convertMarkdownTables(markdown: string): string {
  const { text, blocks } = protectCodeBlocks(markdown);
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (i + 1 < lines.length && isMarkdownTableRow(lines[i]) && isMarkdownTableSeparator(lines[i + 1])) {
      const tableLines = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && isMarkdownTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      out.push(formatTableAsCodeBlock(tableLines));
      continue;
    }
    out.push(lines[i]);
    i++;
  }

  return restoreCodeBlocks(out.join("\n"), blocks, 1);
}

type FeishuMarkdownElement = {
  tag: "markdown";
  content: string;
};

type FeishuTableElement = {
  tag: "table";
  page_size?: number;
  row_height?: "low";
  header_style?: Record<string, unknown>;
  columns: Array<{
    name: string;
    display_name: string;
    data_type: "lark_md";
    width?: string;
    vertical_align?: "top" | "center" | "bottom";
    horizontal_align?: "left" | "center" | "right";
  }>;
  rows: Array<Record<string, string>>;
};

export type FeishuCardElement = FeishuMarkdownElement | FeishuTableElement;

function buildTableElement(lines: string[], index: number): FeishuTableElement | null {
  const rows = lines.filter((line) => !isMarkdownTableSeparator(line)).map(splitMarkdownTableRow);
  if (rows.length < 2) return null;
  const headers = rows[0];
  if (headers.length === 0) return null;
  const width = Math.min(Math.max(...rows.map((row) => row.length)), 50);
  const columns = Array.from({ length: width }, (_, i) => ({
    name: `c${index}_${i}`,
    display_name: headers[i] || `列 ${i + 1}`,
    data_type: "lark_md" as const,
    width: "auto",
    vertical_align: "top" as const,
    horizontal_align: "left" as const,
  }));
  const dataRows = rows.slice(1).map((row) => {
    const item: Record<string, string> = {};
    for (let i = 0; i < columns.length; i++) item[columns[i].name] = row[i] || "";
    return item;
  });
  return {
    tag: "table",
    page_size: Math.min(Math.max(dataRows.length, 1), 10),
    header_style: {
      text_align: "left",
      text_size: "normal",
      background_style: "grey",
      text_color: "default",
      bold: true,
      lines: 2,
    },
    columns,
    rows: dataRows,
  };
}

function pushMarkdownElement(elements: FeishuCardElement[], text: string): void {
  const content = optimizeMarkdownStyle(text.trim(), 2).trim();
  if (!content) return;
  elements.push({ tag: "markdown", content });
}

export function buildFeishuCardElements(markdown: string): FeishuCardElement[] {
  const { text, blocks } = protectCodeBlocks(markdown);
  const lines = text.split("\n");
  const elements: FeishuCardElement[] = [];
  const buffer: string[] = [];
  let tableCount = 0;
  let i = 0;

  while (i < lines.length) {
    if (i + 1 < lines.length && isMarkdownTableRow(lines[i]) && isMarkdownTableSeparator(lines[i + 1])) {
      const tableLines = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && isMarkdownTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      pushMarkdownElement(elements, restoreCodeBlocks(buffer.join("\n"), blocks, 1));
      buffer.length = 0;
      // Feishu cards support up to 5 table components per card. Fall back to a
      // readable code-block table after that instead of sending an invalid card.
      if (tableCount < 5) {
        const table = buildTableElement(tableLines, tableCount);
        if (table) {
          elements.push(table);
          tableCount++;
        } else {
          buffer.push(formatTableAsCodeBlock(tableLines));
        }
      } else {
        buffer.push(formatTableAsCodeBlock(tableLines));
      }
      continue;
    }
    buffer.push(lines[i]);
    i++;
  }

  pushMarkdownElement(elements, restoreCodeBlocks(buffer.join("\n"), blocks, 1));
  return elements.length > 0 ? elements : [{ tag: "markdown", content: "" }];
}

export function prepareMarkdownForFeishu(text: string): string {
  return optimizeMarkdownStyle(convertMarkdownTables(text), 2);
}

export const __test__ = { convertMarkdownTables, optimizeMarkdownStyle, buildTableElement };
