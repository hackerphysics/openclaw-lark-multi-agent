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
    expect(out).toContain("lma init");
    expect(out).toContain("install-systemd");
    expect(out).toContain("install-steer-plugin");
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

  it("install-steer-plugin reports a distinct 'could not start' error when the openclaw binary cannot be spawned", () => {
    // Regression guard for the Windows bug: execFileSync could not exec a .cmd
    // shim without shell:true, so the subprocess never started and no output
    // from openclaw itself was ever produced (silent "exit 1"). Pointing
    // OPENCLAW_BIN at a nonexistent binary reproduces a real spawn failure on
    // any platform; the CLI must surface it distinctly, not a generic failure.
    try {
      run(["install-steer-plugin"], { OPENCLAW_BIN: "olma-definitely-not-a-real-binary-xyz" });
      expect.fail("expected install-steer-plugin to exit non-zero");
    } catch (err: any) {
      const output = `${err.stdout || ""}${err.stderr || ""}`;
      expect(output).toContain("Could not start");
      expect(output).toContain("olma-definitely-not-a-real-binary-xyz");
    }
  });
});
