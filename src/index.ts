import { loadConfig } from "./config.js";
import { OpenClawClient } from "./openclaw-client.js";
import { FeishuBot } from "./feishu-bot.js";

async function main() {
  const configPath = process.argv[2];
  const config = loadConfig(configPath);

  console.log("=== Feishu Multi-Bot Proxy ===");
  console.log(`OpenClaw: ${config.openclaw.baseUrl}`);
  console.log(`Bots: ${config.bots.map((b) => `${b.name}(${b.model})`).join(", ")}`);
  console.log("");

  const openclawClient = new OpenClawClient(config.openclaw);

  // Start all bots
  const bots: FeishuBot[] = [];
  for (const botConfig of config.bots) {
    const bot = new FeishuBot(botConfig, openclawClient);
    bots.push(bot);
    await bot.start();
  }

  console.log(`\nAll ${bots.length} bots started. Waiting for messages...`);

  // Keep alive
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    console.log("\nShutting down...");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
