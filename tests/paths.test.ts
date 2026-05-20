import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadPaths() {
  vi.resetModules();
  const mod = await import("../src/paths.js");
  return mod as typeof import("../src/paths.js");
}

describe("paths", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("derives state dir from LMA_DATA_DIR for Windows service/system profiles", async () => {
    delete process.env.OPENCLAW_LARK_MULTI_AGENT_STATE_DIR;
    delete process.env.OPENCLAW_WORKSPACE_DIR;
    process.env.LMA_DATA_DIR = "C:/OpenClaw/state/openclaw-lark-multi-agent/data";
    const paths = await loadPaths();
    expect(paths.getStateDir()).toMatch(/C:[/\\]OpenClaw[/\\]state[/\\]openclaw-lark-multi-agent$/);
    expect(paths.getDataDir()).toMatch(/C:[/\\]OpenClaw[/\\]state[/\\]openclaw-lark-multi-agent[/\\]data$/);
  });

  it("derives default workspace from state dir instead of service homedir", async () => {
    delete process.env.OPENCLAW_LARK_MULTI_AGENT_STATE_DIR;
    delete process.env.OPENCLAW_WORKSPACE_DIR;
    delete process.env.OPENCLAW_LARK_MULTI_AGENT_MEDIA_DIR;
    process.env.LMA_DATA_DIR = "C:/Users/Stephen/.openclaw/openclaw-lark-multi-agent/data";
    const paths = await loadPaths();
    expect(paths.getOpenClawWorkspaceDir()).toMatch(/C:[/\\]Users[/\\]Stephen[/\\]\.openclaw[/\\]workspace$/);
    expect(paths.getLmaMediaDir()).toMatch(/C:[/\\]Users[/\\]Stephen[/\\]\.openclaw[/\\]workspace[/\\]\.lma-media$/);
  });

  it("lets explicit state/workspace/media dirs override derived defaults", async () => {
    process.env.OPENCLAW_LARK_MULTI_AGENT_STATE_DIR = "D:/explicit/state";
    process.env.LMA_DATA_DIR = "C:/ignored/data";
    process.env.OPENCLAW_WORKSPACE_DIR = "E:/workspace";
    process.env.OPENCLAW_LARK_MULTI_AGENT_MEDIA_DIR = "F:/media";
    const paths = await loadPaths();
    expect(paths.getStateDir()).toMatch(/D:[/\\]explicit[/\\]state$/);
    expect(paths.getDataDir()).toMatch(/C:[/\\]ignored[/\\]data$/);
    expect(paths.getOpenClawWorkspaceDir()).toMatch(/E:[/\\]workspace$/);
    expect(paths.getLmaMediaDir()).toMatch(/F:[/\\]media$/);
  });
});
