#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { startApp } from "./index.js";

const APP_NAME = "openclaw-lark-multi-agent";
const HOME_DIR = homedir() || process.env.HOME || process.cwd();
const DEFAULT_STATE_DIR = resolve(HOME_DIR, ".openclaw", APP_NAME);
const DEFAULT_CONFIG_PATH = resolve(DEFAULT_STATE_DIR, "config.json");

function usage(exitCode = 0): never {
  console.log(`OpenClaw Lark Multi-Agent

Usage:
  ${APP_NAME} start [config]
  ${APP_NAME} init [--state-dir DIR] [--force]
  ${APP_NAME} install-systemd [--user|--system] [--state-dir DIR] [--no-restart]
  ${APP_NAME} install-windows-service [--state-dir DIR] [--no-start]
  ${APP_NAME} doctor [--state-dir DIR]
  ${APP_NAME} --help

Examples:
  ${APP_NAME} init
  ${APP_NAME} start ~/.openclaw/${APP_NAME}/config.json
  ${APP_NAME} install-systemd --user
  ${APP_NAME} install-windows-service
`);
  process.exit(exitCode);
}

function takeOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(idx, 2);
  return value;
}

function hasFlag(args: string[], name: string): boolean {
  const idx = args.indexOf(name);
  if (idx < 0) return false;
  args.splice(idx, 1);
  return true;
}

function sampleConfig(): string {
  return JSON.stringify({
    openclaw: {
      baseUrl: "http://127.0.0.1:18789",
      token: "YOUR_OPENCLAW_GATEWAY_TOKEN",
    },
    bots: [
      {
        name: "GPT",
        appId: "cli_xxx",
        appSecret: "YOUR_LARK_APP_SECRET",
        model: "github-copilot/gpt-5.5",
      },
      {
        name: "Gemini",
        appId: "cli_yyy",
        appSecret: "YOUR_LARK_APP_SECRET",
        model: "github-copilot/gemini-3.1-pro-preview",
      },
    ],
  }, null, 2) + "\n";
}

function ensureState(stateDir: string, force = false) {
  const configPath = resolve(stateDir, "config.json");
  const dataDir = resolve(stateDir, "data");
  mkdirSync(dataDir, { recursive: true });
  if (existsSync(configPath) && !force) {
    console.log(`Config already exists: ${configPath}`);
  } else {
    writeFileSync(configPath, sampleConfig(), { mode: 0o600 });
    console.log(`Created config: ${configPath}`);
  }
  console.log(`Data dir: ${dataDir}`);
  return { configPath, dataDir };
}

function cmdInit(args: string[]) {
  const stateDir = resolve(takeOption(args, "--state-dir") || DEFAULT_STATE_DIR);
  const force = hasFlag(args, "--force");
  if (args.length > 0) throw new Error(`Unknown init arguments: ${args.join(" ")}`);
  ensureState(stateDir, force);
  console.log("Next: edit config.json and fill in your OpenClaw token and Lark app credentials.");
}

function buildUnit(params: { mode: "user" | "system"; configPath: string; stateDir: string }) {
  const nodeBin = process.execPath;
  const cliPath = fileURLToPath(import.meta.url);
  const userLine = params.mode === "system" ? `User=${process.env.USER || "YOUR_USERNAME"}\n` : "";
  return `[Unit]
Description=OpenClaw Lark Multi-Agent - Multi-bot bridge for OpenClaw
After=network.target
Wants=network-online.target

[Service]
Type=simple
${userLine}ExecStart=${nodeBin} ${cliPath} start ${params.configPath}
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=LMA_DATA_DIR=${resolve(params.stateDir, "data")}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${APP_NAME}

[Install]
WantedBy=${params.mode === "system" ? "multi-user.target" : "default.target"}
`;
}

function run(cmd: string, args: string[]) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

function runSudo(args: string[]) {
  run("sudo", args);
}

function cmdInstallSystemd(args: string[]) {
  const mode: "user" | "system" = hasFlag(args, "--system") ? "system" : "user";
  hasFlag(args, "--user");
  const noRestart = hasFlag(args, "--no-restart");
  const stateDir = resolve(takeOption(args, "--state-dir") || DEFAULT_STATE_DIR);
  if (args.length > 0) throw new Error(`Unknown install-systemd arguments: ${args.join(" ")}`);

  const { configPath } = ensureState(stateDir, false);
  const unit = buildUnit({ mode, configPath, stateDir });
  if (mode === "system") {
    const tmp = `/tmp/${APP_NAME}.service`;
    writeFileSync(tmp, unit);
    runSudo(["install", "-m", "0644", tmp, `/etc/systemd/system/${APP_NAME}.service`]);
    runSudo(["systemctl", "daemon-reload"]);
    runSudo(["systemctl", "enable", `${APP_NAME}.service`]);
    if (!noRestart) runSudo(["systemctl", "restart", `${APP_NAME}.service`]);
    console.log(`Installed system service: ${APP_NAME}.service`);
  } else {
    const unitDir = resolve(HOME_DIR, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    const unitPath = resolve(unitDir, `${APP_NAME}.service`);
    writeFileSync(unitPath, unit);
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", `${APP_NAME}.service`]);
    if (!noRestart) run("systemctl", ["--user", "restart", `${APP_NAME}.service`]);
    console.log(`Installed user service: ${unitPath}`);
  }
}

function cmdInstallWindowsService(args: string[]) {
  const noStart = hasFlag(args, "--no-start");
  const stateDir = resolve(takeOption(args, "--state-dir") || DEFAULT_STATE_DIR);
  if (args.length > 0) throw new Error(`Unknown install-windows-service arguments: ${args.join(" ")}`);
  if (process.platform !== "win32") {
    console.log("install-windows-service is intended for Windows. On Linux, use install-systemd.");
  }
  const { configPath, dataDir } = ensureState(stateDir, false);
  const cliPath = fileURLToPath(import.meta.url);
  run("nssm", ["install", APP_NAME, process.execPath, cliPath, "start", configPath]);
  run("nssm", ["set", APP_NAME, "AppDirectory", dirname(cliPath)]);
  run("nssm", ["set", APP_NAME, "AppEnvironmentExtra", `NODE_ENV=production`, `LMA_DATA_DIR=${dataDir}`]);
  run("nssm", ["set", APP_NAME, "AppStdout", resolve(stateDir, "stdout.log")]);
  run("nssm", ["set", APP_NAME, "AppStderr", resolve(stateDir, "stderr.log")]);
  run("nssm", ["set", APP_NAME, "AppRotateFiles", "1"]);
  run("nssm", ["set", APP_NAME, "AppRotateBytes", "10485760"]);
  run("nssm", ["set", APP_NAME, "Start", "SERVICE_AUTO_START"]);
  if (!noStart) run("nssm", ["start", APP_NAME]);
  console.log(`Installed Windows service: ${APP_NAME}`);
}

function cmdDoctor(args: string[]) {
  const stateDir = resolve(takeOption(args, "--state-dir") || DEFAULT_STATE_DIR);
  if (args.length > 0) throw new Error(`Unknown doctor arguments: ${args.join(" ")}`);
  const configPath = resolve(stateDir, "config.json");
  console.log(`State dir:  ${stateDir}`);
  console.log(`Config:     ${configPath} ${existsSync(configPath) ? "OK" : "MISSING"}`);
  console.log(`Data dir:   ${resolve(stateDir, "data")} ${existsSync(resolve(stateDir, "data")) ? "OK" : "MISSING"}`);
  console.log(`Node:       ${process.version}`);
  console.log(`Platform:   ${process.platform}`);
  console.log(`CLI:        ${fileURLToPath(import.meta.url)}`);
}

async function main() {
  const [cmd = "--help", ...args] = process.argv.slice(2);
  if (cmd === "--help" || cmd === "-h") usage(0);
  if (cmd === "init") return cmdInit(args);
  if (cmd === "install-systemd") return cmdInstallSystemd(args);
  if (cmd === "install-windows-service") return cmdInstallWindowsService(args);
  if (cmd === "doctor") return cmdDoctor(args);
  if (cmd === "start") {
    const configPath = args[0] ? resolve(args[0]) : DEFAULT_CONFIG_PATH;
    return startApp(configPath);
  }
  usage(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
