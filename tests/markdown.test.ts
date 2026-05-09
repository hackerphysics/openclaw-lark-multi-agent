import { describe, expect, it } from "vitest";
import { buildFeishuCardElements, prepareMarkdownForFeishu, __test__ } from "../src/markdown.js";

describe("prepareMarkdownForFeishu", () => {
  it("downgrades headings for Feishu card rendering", () => {
    const result = prepareMarkdownForFeishu("# H1\n## H2\n### H3");
    expect(result).toContain("#### H1");
    expect(result).toContain("##### H2");
    expect(result).toContain("##### H3");
  });

  it("converts GitHub pipe tables to code blocks", () => {
    const result = prepareMarkdownForFeishu("| 对比 | Skill | MCP |\n|------|-------|-----|\n| 协议 | HTTP | 标准协议 |\n| 可移植性 | OpenClaw | 多客户端 |");
    expect(result).not.toContain("|------|-------|-----|");
    expect(result).toContain("```");
    expect(result).toContain("对比");
    expect(result).toContain("Skill");
    expect(result).toContain("MCP");
    expect(result).toContain("标准协议");
  });

  it("does not convert tables inside fenced code blocks", () => {
    const markdown = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
    expect(__test__.convertMarkdownTables(markdown)).toBe(markdown);
  });

  it("builds native Feishu table elements for pipe tables", () => {
    const elements = buildFeishuCardElements("## 表格\n\n| 功能 | 状态 |\n|------|------|\n| 标题 | 正常 |\n| 表格 | 待验证 |\n\n结束");
    expect(elements).toHaveLength(3);
    expect(elements[0]).toMatchObject({ tag: "markdown" });
    expect(elements[1]).toMatchObject({
      tag: "table",
      columns: [
        expect.objectContaining({ display_name: "功能", data_type: "lark_md" }),
        expect.objectContaining({ display_name: "状态", data_type: "lark_md" }),
      ],
      rows: [
        expect.objectContaining({ c0_0: "标题", c0_1: "正常" }),
        expect.objectContaining({ c0_0: "表格", c0_1: "待验证" }),
      ],
    });
    expect(elements[2]).toMatchObject({ tag: "markdown", content: "结束" });
  });
});
