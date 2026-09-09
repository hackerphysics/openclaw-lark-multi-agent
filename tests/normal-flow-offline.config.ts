import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", setupFiles: ["tests/normal-flow-offline-guard.ts"], include: ["tests/**/*.test.ts"], testTimeout: 15000, hookTimeout: 10000 } });
