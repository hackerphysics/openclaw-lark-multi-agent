import { readFileSync } from "fs";
import { resolve } from "path";

export interface BotConfig {
  name: string;
  appId: string;
  appSecret: string;
  model: string;
}

export interface OpenClawConfig {
  baseUrl: string;
  token: string;
}

export interface AppConfig {
  openclaw: OpenClawConfig;
  bots: BotConfig[];
  /** Stephen's open_id for model-drift notifications */
  adminOpenId?: string;
}

export function loadConfig(path?: string): AppConfig {
  const configPath = path || resolve(process.cwd(), "config.json");
  const raw = readFileSync(configPath, "utf-8");
  const config: AppConfig = JSON.parse(raw);

  if (!config.openclaw?.baseUrl || !config.openclaw?.token) {
    throw new Error("Missing openclaw.baseUrl or openclaw.token in config");
  }
  if (!config.bots || config.bots.length === 0) {
    throw new Error("No bots configured");
  }
  for (const bot of config.bots) {
    if (!bot.appId || !bot.appSecret || !bot.model) {
      throw new Error(`Bot "${bot.name}" missing appId, appSecret, or model`);
    }
  }

  // Validate uniqueness
  const names = config.bots.map((b) => b.name);
  const appIds = config.bots.map((b) => b.appId);
  if (new Set(names).size !== names.length) {
    throw new Error(`Duplicate bot names detected: ${names.join(", ")}`);
  }
  if (new Set(appIds).size !== appIds.length) {
    throw new Error(`Duplicate bot appIds detected`);
  }

  return config;
}
