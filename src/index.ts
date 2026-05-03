import { loadConfig } from "./config.js";
import { OpenClawClient } from "./openclaw-client.js";
import { MessageStore } from "./message-store.js";
import { FeishuBot } from "./feishu-bot.js";
import { mkdirSync } from "fs";
import { resolve } from "path";

async function main() {
  const configPath = process.argv[2];
  const config = loadConfig(configPath);

  console.log("=== Lark Multi-Agent ===");
  console.log(`OpenClaw: ${config.openclaw.baseUrl}`);
  console.log(
    `Bots: ${config.bots.map((b) => `${b.name}(${b.model})`).join(", ")}`
  );
  console.log("");

  // Init data dir & store
  const dataDir = resolve(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });
  const store = new MessageStore(resolve(dataDir, "messages.db"));

  const openclawClient = new OpenClawClient(config.openclaw);

  // Start all bots
  const bots: FeishuBot[] = [];
  for (const botConfig of config.bots) {
    const bot = new FeishuBot(botConfig, openclawClient, store);
    bots.push(bot);
    await bot.start();
  }

  console.log(`\nAll ${bots.length} bots started. Waiting for messages...`);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
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
