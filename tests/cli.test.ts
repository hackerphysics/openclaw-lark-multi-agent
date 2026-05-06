import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist", "cli.js");

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("CLI", () => {
  it("prints help", () => {
    const out = run(["--help"]);
    expect(out).toContain("openclaw-lark-multi-agent init");
    expect(out).toContain("install-systemd");
  });

  it("initializes state dir with sample config", () => {
    const dir = mkdtempSync(join(tmpdir(), "olma-cli-"));
    try {
      const state = join(dir, "state");
      const out = run(["init", "--state-dir", state]);
      expect(out).toContain("Created config");
      const config = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
      expect(config.openclaw.token).toBe("YOUR_OPENCLAW_GATEWAY_TOKEN");
      expect(config.bots[0].appSecret).toBe("YOUR_LARK_APP_SECRET");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doctor reports config and data paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "olma-cli-"));
    try {
      const state = join(dir, "state");
      run(["init", "--state-dir", state]);
      const out = run(["doctor", "--state-dir", state]);
      expect(out).toContain("Config:");
      expect(out).toContain("OK");
      expect(out).toContain("Node:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
