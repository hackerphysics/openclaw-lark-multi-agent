import { homedir } from "os";
import { dirname, resolve } from "path";

/**
 * Runtime state defaults to the user's home directory but can be overridden
 * for packaged deployments, tests, containers, or systemd installations.
 */
export function getStateDir(): string {
  // Windows services often run as LocalSystem, where homedir() resolves to
  // C:\\Windows\\System32\\config\\systemprofile. When the installer supplies
  // LMA_DATA_DIR, derive the state dir from it instead of falling back to that
  // service profile home.
  if (process.env.OPENCLAW_LARK_MULTI_AGENT_STATE_DIR) return resolve(process.env.OPENCLAW_LARK_MULTI_AGENT_STATE_DIR);
  if (process.env.LMA_DATA_DIR) return dirname(resolve(process.env.LMA_DATA_DIR));
  return resolve(homedir(), ".openclaw/openclaw-lark-multi-agent");
}

export function getDataDir(): string {
  return resolve(process.env.LMA_DATA_DIR || resolve(getStateDir(), "data"));
}

export function getBridgeAttachmentsDir(): string {
  return resolve(process.env.OPENCLAW_LARK_MULTI_AGENT_ATTACHMENTS_DIR || resolve(getStateDir(), "attachments"));
}

export function getOpenClawWorkspaceDir(): string {
  // Prefer the explicit OpenClaw workspace when provided. Otherwise derive it
  // from the LMA state dir instead of homedir(); Windows services may run as
  // LocalSystem, whose homedir is C:\\Windows\\System32\\config\\systemprofile.
  return resolve(process.env.OPENCLAW_WORKSPACE_DIR || resolve(dirname(getStateDir()), "workspace"));
}

export function getLmaMediaDir(): string {
  // Feishu-downloaded media should live inside the OpenClaw workspace so agent
  // tools such as read/image can access it on both Linux and Windows services.
  return resolve(process.env.OPENCLAW_LARK_MULTI_AGENT_MEDIA_DIR || resolve(getOpenClawWorkspaceDir(), ".lma-media"));
}

export function getBridgeAttachmentAllowedRoots(): string[] {
  const roots = [getBridgeAttachmentsDir(), getOpenClawWorkspaceDir(), getLmaMediaDir()];
  const extra = process.env.OPENCLAW_LARK_MULTI_AGENT_ATTACHMENT_ALLOW_ROOTS || "";
  for (const part of extra.split(",")) {
    const trimmed = part.trim();
    if (trimmed) roots.push(resolve(trimmed));
  }
  return Array.from(new Set(roots.map((root) => resolve(root))));
}
