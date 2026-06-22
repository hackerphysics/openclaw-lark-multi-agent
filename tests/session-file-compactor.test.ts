import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { toolTrimCompactFile, resolveSessionFilePath } from "../src/session-file-compactor.js";

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "lma-compactor-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

function line(obj: any): string { return JSON.stringify(obj); }

describe("toolTrimCompactFile", () => {
  it("drops toolResults, strips toolCalls but keeps assistant text, fixes stopReason", () => {
    const d = tmp();
    const f = join(d, "s.jsonl");
    const content = [
      line({ type: "message", message: { role: "user", content: [{ type: "text", text: "帮我改代码" }] } }),
      // assistant with text + toolCall (the common "thinking out loud while acting")
      line({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [
        { type: "text", text: "查一下，稍等。" },
        { type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
      ] } }),
      // toolResult -> dropped
      line({ type: "message", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "x".repeat(5000) }] } }),
      // assistant with ONLY a toolCall -> whole line dropped
      line({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [
        { type: "toolCall", id: "tc2", name: "exec", arguments: {} },
      ] } }),
      line({ type: "message", message: { role: "toolResult", toolCallId: "tc2", content: [{ type: "text", text: "y".repeat(5000) }] } }),
      // final assistant text
      line({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "改好了。" }] } }),
    ].join("\n") + "\n";
    writeFileSync(f, content);

    const r = toolTrimCompactFile(f, 0); // keep no recent tool calls -> trim all
    expect(r.ok).toBe(true);
    expect(r.removedToolResults).toBe(2);
    expect(r.strippedToolCalls).toBe(1);
    expect(r.removedEmptyAssistants).toBe(1);
    expect(r.backupPath && existsSync(r.backupPath)).toBeTruthy();

    const outLines = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    // user + assistant(text only) + final assistant = 3 lines
    expect(outLines).toHaveLength(3);
    const roles = outLines.map((d) => d.message.role);
    expect(roles).toEqual(["user", "assistant", "assistant"]);
    // The kept assistant retains its text and no longer has a toolCall.
    const kept = outLines[1].message;
    expect(kept.content.some((p: any) => p.type === "toolCall")).toBe(false);
    expect(kept.content.some((p: any) => p.type === "text" && p.text === "查一下，稍等。")).toBe(true);
    // stopReason fixed away from toolUse.
    expect(kept.stopReason).toBe("stop");
    // No toolResult remains.
    expect(outLines.some((d) => d.message.role === "toolResult")).toBe(false);
  });

  it("reduces a tool-heavy transcript substantially", () => {
    const d = tmp();
    const f = join(d, "s.jsonl");
    const rows: string[] = [line({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })];
    for (let i = 0; i < 50; i++) {
      rows.push(line({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [
        { type: "text", text: `step ${i}` },
        { type: "toolCall", id: `t${i}`, name: "read", arguments: { path: `f${i}` } },
      ] } }));
      rows.push(line({ type: "message", message: { role: "toolResult", toolCallId: `t${i}`, content: [{ type: "text", text: "Z".repeat(2000) }] } }));
    }
    writeFileSync(f, rows.join("\n") + "\n");
    const before = readFileSync(f, "utf8").length;
    const r = toolTrimCompactFile(f);
    expect(r.ok).toBe(true);
    const after = readFileSync(f, "utf8").length;
    expect(after).toBeLessThan(before * 0.3); // >70% reduction (toolResults are the bulk)
  });

  it("keeps the most recent N tool calls (and their results) intact", () => {
    const d = tmp();
    const f = join(d, "s.jsonl");
    const rows: string[] = [line({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })];
    for (let i = 0; i < 5; i++) {
      rows.push(line({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [
        { type: "text", text: `step ${i}` },
        { type: "toolCall", id: `t${i}`, name: "read", arguments: { path: `f${i}` } },
      ] } }));
      rows.push(line({ type: "message", message: { role: "toolResult", toolCallId: `t${i}`, content: [{ type: "text", text: "R".repeat(1000) }] } }));
    }
    writeFileSync(f, rows.join("\n") + "\n");

    const r = toolTrimCompactFile(f, 2); // keep last 2 tool calls (t3, t4)
    expect(r.ok).toBe(true);
    const out = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    // The two most-recent toolResults (t3, t4) survive; earlier ones (t0-t2) gone.
    const toolResultIds = out.filter((d) => d.message.role === "toolResult").map((d) => d.message.toolCallId);
    expect(toolResultIds.sort()).toEqual(["t3", "t4"]);
    // The recent assistant toolCalls (t3, t4) are kept on their assistant lines.
    const keptToolCallIds = out.flatMap((d) => Array.isArray(d.message.content)
      ? d.message.content.filter((p: any) => p.type === "toolCall").map((p: any) => p.id) : []);
    expect(keptToolCallIds.sort()).toEqual(["t3", "t4"]);
    expect(r.keptRecentToolCalls).toBe(2);
    // Earlier assistant lines kept their TEXT (step 0-2) even though toolCall stripped.
    const texts = out.flatMap((d) => Array.isArray(d.message.content)
      ? d.message.content.filter((p: any) => p.type === "text").map((p: any) => p.text) : []);
    expect(texts).toContain("step 0");
    expect(texts).toContain("step 4");
  });

  it("is a no-op (still ok) when there is no tool content", () => {
    const d = tmp();
    const f = join(d, "s.jsonl");
    const content = [
      line({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      line({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hello" }] } }),
    ].join("\n") + "\n";
    writeFileSync(f, content);
    const r = toolTrimCompactFile(f);
    expect(r.ok).toBe(true);
    // No backup needed for a no-op.
    expect(r.backupPath).toBeUndefined();
    // File unchanged (still 2 lines).
    expect(readFileSync(f, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("returns not-ok when the file is missing", () => {
    const r = toolTrimCompactFile("/no/such/file.jsonl");
    expect(r.ok).toBe(false);
  });

  it("preserves non-message lines (session/custom/thinking_level_change)", () => {
    const d = tmp();
    const f = join(d, "s.jsonl");
    const content = [
      line({ type: "session", id: "s1" }),
      line({ type: "thinking_level_change", level: "medium" }),
      line({ type: "message", message: { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "r" }] } }),
      line({ type: "custom", data: { x: 1 } }),
    ].join("\n") + "\n";
    writeFileSync(f, content);
    const r = toolTrimCompactFile(f);
    expect(r.ok).toBe(true);
    const out = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(out.map((d) => d.type)).toEqual(["session", "thinking_level_change", "custom"]);
  });
});

describe("resolveSessionFilePath", () => {
  it("builds <home>/agents/<agentId>/sessions/<sessionId>.jsonl and requires the file to exist", () => {
    const d = tmp();
    const agentDir = join(d, "agents", "main", "sessions");
    const sid = "abcd-1234";
    // not existing yet
    expect(resolveSessionFilePath("agent:main:lma-x", sid, d)).toBeNull();
    // create it
    const { mkdirSync } = require("fs");
    mkdirSync(agentDir, { recursive: true });
    const f = join(agentDir, `${sid}.jsonl`);
    writeFileSync(f, "{}\n");
    expect(resolveSessionFilePath("agent:main:lma-x", sid, d)).toBe(f);
  });

  it("derives a non-main agentId from the session key", () => {
    const d = tmp();
    const { mkdirSync } = require("fs");
    const agentDir = join(d, "agents", "phonon", "sessions");
    mkdirSync(agentDir, { recursive: true });
    const sid = "zzz";
    const f = join(agentDir, `${sid}.jsonl`);
    writeFileSync(f, "{}\n");
    expect(resolveSessionFilePath("agent:phonon:lma-y", sid, d)).toBe(f);
  });
});
