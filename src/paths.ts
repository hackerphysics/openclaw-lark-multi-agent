import { homedir } from "os";
import { resolve } from "path";

/**
 * Runtime state defaults to the user's home directory but can be overridden
 * for packaged deployments, tests, containers, or systemd installations.
 */
export function getStateDir(): string {
  return resolve(process.env.OPENCLAW_LARK_MULTI_AGENT_STATE_DIR || resolve(homedir(), ".openclaw/openclaw-lark-multi-agent"));
}

export function getBridgeAttachmentsDir(): string {
  return resolve(process.env.OPENCLAW_LARK_MULTI_AGENT_ATTACHMENTS_DIR || resolve(getStateDir(), "attachments"));
}
