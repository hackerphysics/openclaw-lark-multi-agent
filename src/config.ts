import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { normalizeLocale, type Locale } from "./i18n.js";

export interface BotConfig {
  name: string;
  appId: string;
  appSecret: string;
  model: string;
  locale?: Locale;
}

export interface OpenClawConfig {
  baseUrl: string;
  token: string;
}

export interface AppConfig {
  openclaw: OpenClawConfig;
  bots: BotConfig[];
  /** Optional Feishu/Lark open_id for model-drift notifications */
  adminOpenId?: string;
  /** Default UI/prompt language. Bot-level locale overrides this. */
  locale?: Locale;
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

  config.locale = normalizeLocale(config.locale);
  for (const bot of config.bots) {
    bot.locale = normalizeLocale(bot.locale || config.locale);
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

/**
 * Persist a single bot's model into config.json without touching any other
 * field. Reads the file, mutates only the target bot's `model`, and writes it
 * back. Never replaces the whole config blindly.
 */
export function persistBotModel(configPath: string, botName: string, model: string): void {
  const resolved = resolve(configPath);
  const raw = readFileSync(resolved, "utf-8");
  const json = JSON.parse(raw);
  if (!Array.isArray(json.bots)) throw new Error("config.json has no bots array");
  const bot = json.bots.find((b: any) => b && b.name === botName);
  if (!bot) throw new Error(`Bot "${botName}" not found in config.json`);
  bot.model = model;
  writeFileSync(resolved, JSON.stringify(json, null, 2) + "\n", "utf-8");
}
