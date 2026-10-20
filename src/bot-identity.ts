import * as lark from "@larksuiteoapi/node-sdk";
import type { BotConfig } from "./config.js";

/** Includes SDK authentication requests, not just the final bot-info HTTP call.
 * A separate transport keeps the identity deadline away from normal sends. */
export async function requestBotIdentity(config: BotConfig, signal: AbortSignal, timeout: number): Promise<unknown> {
  const request = (options: any) => lark.defaultHttpInstance.request({ ...options, timeout, signal } as any);
  const transport: any = { request };
  for (const method of ["get", "delete", "head", "options"]) {
    transport[method] = (url: string, options: any) => request({ ...options, method, url });
  }
  for (const method of ["post", "put", "patch"]) {
    transport[method] = (url: string, data: any, options: any) => request({ ...options, method, url, data });
  }
  const client = new lark.Client({ appId: config.appId, appSecret: config.appSecret,
    appType: lark.AppType.SelfBuild, httpInstance: transport });
  return client.request({ method: "GET", url: "/open-apis/bot/v3/info/" });
}

/** Only original-account API evidence establishes identity. Names never do. */
export function trustedBotOpenId(response: any, appId: string): string | null {
  if (response?.code !== undefined && response.code !== 0) return null;
  const bot = response?.bot ?? response?.data?.bot;
  if (bot?.app_id !== undefined && bot.app_id !== appId) return null;
  return typeof bot?.open_id === "string" && /^ou_[a-zA-Z0-9]+$/.test(bot.open_id) ? bot.open_id : null;
}
