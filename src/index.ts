import { loadConfig } from "./config.js";
import { OpenClawClient } from "./openclaw-client.js";
import { MessageStore } from "./message-store.js";
import { FeishuBot } from "./feishu-bot.js";
import { mkdirSync } from "fs";
import { dirname, resolve } from "path";

async function main() {
  const configPath = process.argv[2];
  const config = loadConfig(configPath);

  console.log("=== Lark Multi-Agent ===");
  console.log(`OpenClaw: ${config.openclaw.baseUrl}`);
  console.log(
    `Bots: ${config.bots.map((b) => `${b.name}(${b.model})`).join(", ")}`
  );
  console.log("");

  // Init data dir & store. Runtime state should live next to config by default,
  // not next to deployable program files. Override with LMA_DATA_DIR if needed.
  const resolvedConfigPath = configPath ? resolve(configPath) : resolve(process.cwd(), "config.json");
  const dataDir = process.env.LMA_DATA_DIR
    ? resolve(process.env.LMA_DATA_DIR)
    : resolve(dirname(resolvedConfigPath), "data");
  mkdirSync(dataDir, { recursive: true });
  console.log(`Data dir: ${dataDir}`);
  const store = new MessageStore(resolve(dataDir, "messages.db"));

  // Connect to OpenClaw Gateway via WebSocket
  const openclawClient = new OpenClawClient(config.openclaw);
  await openclawClient.connect();

  // Two-phase startup: register all bots first, then start WS connections
  const bots: FeishuBot[] = [];
  for (const botConfig of config.bots) {
    const bot = new FeishuBot(botConfig, openclawClient, store, config.adminOpenId);
    bots.push(bot);
    bot.register(); // Phase 1: register to allBots map
  }
  for (const bot of bots) {
    await bot.start(); // Phase 2: start WS connections
  }

  console.log(`\nAll ${bots.length} bots started. Waiting for messages...`);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    openclawClient.disconnect();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
